// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { McpStdioParser } = require('./mcp-stdio-parser');

const RPC_OPTIONS = { magic: 'ninja_ssapp_v1', maxResult: 10 * 1024 * 1024, parallel: true, backpressure: true, errorCodes: true,
  replayableRead: (request) => request.op === 'call' && request.args?.name === 'ssapp_read_settings_export',
  timeoutMessage: 'Inspect ninja_ssapp_result and the current app before repeating an action.' };
const error = (code, message) => Object.assign(new Error(message || code), { code });

function controlOrigin(value = 'http://127.0.0.1:17777') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error('invalid_control_url', 'SSApp must use an http://127.0.0.1:PORT origin');
  return url.origin;
}

function appInstance(origin) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/v1/instance`, { timeout: 2000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { data += part; if (data.length > 16000) res.destroy(error('invalid_instance')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (res.statusCode !== 200 || !/^[a-f0-9-]{36}$/i.test(value.instanceId)) throw error('instance_binding_required', 'Start SSApp with API 1.4.1 or newer and enable Local AI / Automation');
          resolve(value);
        } catch (failure) { reject(failure); }
      });
    });
    req.on('timeout', () => req.destroy(error('SSAPP_UNREACHABLE')));
    req.on('error', reject);
  });
}

function validateCommand(settings) {
  if (!settings || !path.isAbsolute(settings.command || '') || !Array.isArray(settings.args) || settings.args.some((arg) => typeof arg !== 'string')) throw error('invalid_mcp_command', 'Set an absolute host MCP executable and its argument array');
}

class LocalMcp {
  constructor(settings, instanceId) {
    validateCommand(settings);
    this.pending = new Map(); this.nextId = 0; this.failed = false;
    this.child = spawn(settings.command, settings.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: settings.cwd,
      env: { ...process.env, ...(settings.env || {}), UV_THREADPOOL_SIZE: '2', SSAPP_CONTROL_URL: controlOrigin(settings.controlUrl),
        SSAPP_EXPECTED_INSTANCE_ID: instanceId || 'offline', SSAPP_MCP_REQUEST_TIMEOUT_MS: '35000' } });
    this.child.stderr.on('data', () => {});
    const parser = new McpStdioParser({ maxMessageBytes: RPC_OPTIONS.maxResult });
    parser.on('message', ({ message }) => {
      if (message.method && message.id === undefined) { if (this.onNotification) this.onNotification(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(error('local_mcp_error', message.error.message));
      else pending.resolve(message.result);
    });
    parser.on('error', () => this.fail(error('invalid_mcp_response')));
    this.child.stdout.on('data', (chunk) => { parser.push(chunk); if (parser.buffer.length > RPC_OPTIONS.maxResult) this.fail(error('mcp_response_too_large')); });
    this.child.on('error', (failure) => this.fail(failure));
    this.child.on('exit', () => this.fail(error('local_mcp_closed')));
    this.child.stdin.on('error', (failure) => this.fail(failure));
  }
  fail(failure) {
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(failure); }
    this.pending.clear();
  }
  request(method, params = {}) {
    if (this.failed) return Promise.reject(error('local_mcp_closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(error('local_mcp_timeout', 'Local MCP outcome unknown. Inspect SSApp before resuming control.')); this.child.kill(); }, 38000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start() {
    this.info = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ninja-ssapp-host', version: '0.4.3' } });
    if (this.info.serverInfo?.name !== 'social-stream-ninja') throw error('wrong_mcp_backend', 'Configure SSApp\'s own MCP connector');
    const version = String(this.info.serverInfo.version).split('.').map(Number);
    if (!(version[0] > 1 || version[0] === 1 && (version[1] > 3 || version[1] === 3 && version[2] >= 1))) throw error('instance_binding_required', 'Use SSApp MCP adapter 1.3.1 or newer for remote access');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.catalog = await this.request('tools/list');
    if (!Array.isArray(this.catalog.tools) || this.catalog.tools.some((tool) => !tool.name.startsWith('ssapp_'))) throw error('invalid_ssapp_catalog');
  }
  async close() {
    this.fail(error('local_mcp_closed'));
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

class SsappController {
  constructor(config) {
    this.config = config;
    this.origin = controlOrigin(config.ssapp.controlUrl);
    this.instance = null; this.lastInstanceId = null; this.local = null; this.checking = null; this.lease = null;
    this.generation = 0; this.mutations = Promise.resolve(); this.queued = 0; this.closed = false; this.uncertain = false;
    this.discovered = new Map();
    this.exports = new Map();
  }
  revoke() { this.lease = null; this.generation++; }
  async ensure() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let instance = null;
      try { instance = await appInstance(this.origin); } catch (_) { /* Offline discovery still exposes the local tool catalog. */ }
      if (this.closed) throw error('worker_closed');
      if (this.instance?.instanceId !== instance?.instanceId) { this.revoke(); this.discovered.clear(); }
      // A temporary API outage does not resolve a previously dispatched action.
      if (instance && instance.instanceId !== this.lastInstanceId) { this.uncertain = false; this.lastInstanceId = instance.instanceId; this.exports.clear(); }
      if (!this.local || this.local.failed || this.instance?.instanceId !== instance?.instanceId) {
        if (this.local) await this.local.close();
        this.instance = instance;
        this.local = new LocalMcp(this.config.ssapp, instance?.instanceId);
        try { await this.local.start(); } catch (failure) { await this.local.close(); throw failure; }
      }
      this.instance = instance;
      return instance;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  allowed(client, tool) {
    const identity = this.config.clients[client];
    if (['ssapp_export_settings_backup', 'ssapp_read_settings_export', 'ssapp_release_settings_export'].includes(tool.name)
      && (identity.role !== 'controller' || identity.allowSettingsExport !== true)) return false;
    return (!identity.tools || identity.tools.includes(tool.name)) && (identity.role === 'controller' || tool.annotations?.readOnlyHint === true);
  }
  async discovery(client) {
    await this.ensure();
    if (this.instance) this.discovered.set(client, this.instance.instanceId);
    const identity = this.config.clients[client];
    return { backend: 'ssapp', contract: 1, instance: this.instance, serverInfo: this.local.info.serverInfo,
      instructions: this.local.info.instructions, role: identity.role, allowHostFiles: identity.allowHostFiles === true,
      allowSettingsExport: identity.role === 'controller' && identity.allowSettingsExport === true,
      catalog: { ...this.local.catalog, tools: this.local.catalog.tools.filter((tool) => this.allowed(client, tool)) },
      lease: this.lease && this.lease.expires > Date.now() ? { owner: this.lease.owner, expires: this.lease.expires } : null,
      uncertain: this.uncertain, limits: { result_bytes: RPC_OPTIONS.maxResult, request_envelope_bytes: 65000, timeout_ms: 60000 }, live_frames: false };
  }
  checkLease(client, args) {
    if (!this.lease || this.lease.owner !== client || this.lease.token !== args.lease || this.lease.expires <= Date.now()) throw error('valid_app_lease_required');
  }
  async execute(client, role, op, args, request) {
    if (op === 'discover') return this.discovery(client);
    if (op === 'release') { this.checkLease(client, args); this.revoke(); return { released: true }; }
    await this.ensure();
    if (this.closed || Date.now() >= request.deadline) throw error('request_expired');
    if (this.instance && (args.instance !== this.instance.instanceId || this.discovered.get(client) !== this.instance.instanceId)) throw error('fresh_app_discovery_required', 'Call ninja_ssapp_status, discover targets, and claim control again');
    if (op === 'claim') {
      if (!this.instance) throw error('SSAPP_UNREACHABLE', 'Start SSApp with API 1.4.1 or newer and enable Local AI / Automation');
      if (role !== 'controller') throw error('observer_cannot_control');
      const ttl = args.ttl_ms === undefined ? 60000 : args.ttl_ms;
      if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 120000) throw error('invalid_lease_duration');
      if (this.uncertain && args.reconciled !== true) throw error('execution_uncertain', 'Inspect the app and operation result, then claim with reconciled: true to resume');
      if (this.lease && this.lease.expires > Date.now() && (this.lease.owner !== client || this.lease.token !== args.lease)) throw error('app_already_claimed');
      this.uncertain = false;
      this.lease = { owner: client, token: this.lease?.expires > Date.now() ? this.lease.token : crypto.randomUUID(), expires: Date.now() + ttl };
      return { lease: this.lease.token, expires: this.lease.expires, instance: this.instance.instanceId };
    }
    if (op !== 'call') throw error('unknown_ssapp_operation');
    const tool = this.local.catalog.tools.find((item) => item.name === args.name);
    if (!tool || !this.allowed(client, tool)) throw error('tool_not_permitted');
    for (const [id, entry] of this.exports) if (entry.expires <= Date.now()) this.exports.delete(id);
    if (['ssapp_read_settings_export', 'ssapp_release_settings_export'].includes(args.name)
      && this.exports.get(args.arguments?.artifactId)?.owner !== client) throw error('export_not_owned');
    const mutation = tool.annotations?.readOnlyHint !== true;
    if (mutation) { if (!this.instance) throw error('SSAPP_UNREACHABLE'); this.checkLease(client, args); }
    if (args.name === 'ssapp_browser_frame_stream') throw error('remote_frames_unavailable', 'Use ssapp_browser_screenshot; local stream URLs cannot be used remotely');
    if ((args.name === 'ssapp_browser_choose_files' || args.name === 'ssapp_respond_to_app_dialog' && args.arguments?.paths?.length) && this.config.clients[client].allowHostFiles !== true) throw error('host_file_access_disabled');
    const generation = this.generation;
    const dispatch = async () => {
      if (this.closed || generation !== this.generation || Date.now() >= request.deadline) throw error('request_revoked_or_expired');
      if (mutation) this.checkLease(client, args);
      // The local adapter sends the app-instance condition with every HTTP request,
      // including capability checks. A restart between checks cannot admit input.
      let result;
      try { result = await this.local.request('tools/call', { name: args.name, arguments: args.arguments || {} }); }
      catch (failure) { if (mutation) { this.uncertain = true; this.revoke(); } throw failure; }
      const code = result.structuredContent?.error?.code;
      if (mutation && ['SSAPP_UNREACHABLE', 'SSAPP_TIMEOUT'].includes(code)) { this.uncertain = true; this.revoke(); }
      if (code === 'SSAPP_INSTANCE_CHANGED') { this.revoke(); this.discovered.clear(); }
      if (!result.isError && result.structuredContent?.ok === true) {
        const exported = result.structuredContent.result?.payload;
        if (args.name === 'ssapp_export_settings_backup' && exported?.artifactId) {
          this.exports.set(exported.artifactId, { owner: client, expires: Date.parse(exported.expiresAt) });
        }
        if (args.name === 'ssapp_release_settings_export') this.exports.delete(args.arguments.artifactId);
      }
      return { result };
    };
    // Observations and prompt recovery must remain usable during long waits or a
    // blocked renderer. Ordinary mutations retain one queue and one controller.
    if (!mutation || args.name === 'ssapp_respond_to_app_dialog') return dispatch();
    if (this.queued >= 8) throw error('mutation_queue_full');
    this.queued++;
    const pending = this.mutations.then(dispatch, dispatch);
    this.mutations = pending.catch(() => {});
    try { return await pending; } finally { this.queued--; }
  }
  async close() { this.closed = true; this.revoke(); if (this.checking) await this.checking.catch(() => {}); if (this.local) await this.local.close(); }
}

module.exports = { RPC_OPTIONS, LocalMcp, SsappController, controlOrigin, appInstance, validateCommand };
