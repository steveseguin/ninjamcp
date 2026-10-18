// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { McpStdioParser } = require('./mcp-stdio-parser');

class ChromeMcp {
  constructor(entry, endpoint) {
    this.pending = new Map();
    this.nextId = 0;
    this.failed = false;
    this.child = spawn(process.execPath, [entry, `--ws-endpoint=${endpoint}`, '--page-id-routing=true',
      '--javascript-evaluation=false', '--file-navigations=false', '--no-usage-statistics', '--no-performance-crux'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, UV_THREADPOOL_SIZE: '2', CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }
    });
    const parser = new McpStdioParser({ maxMessageBytes: 4 * 1024 * 1024 });
    this.child.stdout.on('data', (chunk) => {
      parser.push(chunk);
      if (parser.buffer.length > 4 * 1024 * 1024) this.fail(new Error('Browser MCP response too large'));
    });
    // The child may log page details: keep stdout exclusively for the outer MCP protocol.
    this.child.stderr.on('data', () => {});
    parser.on('error', () => this.fail(new Error('Invalid browser MCP response')));
    parser.on('message', ({ message }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Browser MCP stopped; restart the worker')));
    this.child.stdin.on('error', (error) => this.fail(error));
  }

  fail(error) {
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.failed) return Promise.reject(new Error('Browser backend unavailable; restart the worker'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Do not start another action while a timed-out command may still be running.
        this.fail(new Error('Browser operation outcome unknown; restart the worker'));
        this.child.kill();
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async start() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ninja-browser-worker', version: '0.4.3' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await this.request('tools/list');
    for (const name of ['list_pages', 'take_snapshot', 'take_screenshot', 'navigate_page', 'click', 'fill', 'press_key']) {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool || (name !== 'list_pages' && !tool.inputSchema.required.includes('pageId'))) throw new Error(`Incompatible Chrome MCP tool: ${name}`);
    }
  }

  call(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.fail(new Error('Browser worker closed')); this.child.kill(); }
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('invalid_arguments');
}

class BrowserController {
  constructor(backend, pages = [1]) {
    this.backend = backend;
    this.pages = new Set(pages);
    this.leases = new Map();
    this.snapshots = new Map();
    this.generation = 0;
  }

  revoke(pageId) {
    this.leases.delete(pageId);
    this.invalidate(pageId);
  }

  invalidate(pageId) {
    for (const [id, snapshot] of this.snapshots) if (snapshot.pageId === pageId) this.snapshots.delete(id);
  }

  async execute(client, role, op, args) {
    if (op === 'tabs') {
      exactKeys(args, []);
      const raw = await this.backend.call('list_pages', {});
      const result = { content: [{ type: 'text', text: (raw.content || []).filter((item) => item.type === 'text').map((item) => item.text.split('\n').filter((line) => {
        const match = /^(\d+): /.exec(line);
        return match && this.pages.has(Number(match[1]));
      }).join('\n')).join('\n') }], isError: raw.isError };
      return { result, leases: Array.from(this.leases, ([pageId, lease]) => ({ pageId, owner: lease.owner, generation: lease.generation, expires: lease.expires })).filter((lease) => lease.expires > Date.now()) };
    }
    if (!Number.isSafeInteger(args.pageId) || args.pageId < 0) throw new Error('pageId_required');
    const pageId = args.pageId;
    if (!this.pages.has(pageId)) throw new Error('page_not_shared');
    if (op === 'observe') {
      exactKeys(args, ['pageId', 'screenshot']);
      if (args.screenshot !== undefined && typeof args.screenshot !== 'boolean') throw new Error('invalid_screenshot');
      const result = await this.backend.call(args.screenshot ? 'take_screenshot' : 'take_snapshot', args.screenshot
        ? { pageId, format: 'jpeg', quality: 55, fullPage: false }
        : { pageId });
      if (result.isError) return { result };
      const snapshot = crypto.randomUUID();
      // Chrome MCP's accessibility UIDs belong to its latest snapshot for this tab.
      if (!args.screenshot) {
        this.invalidate(pageId);
        if (this.snapshots.size >= 128) this.snapshots.delete(this.snapshots.keys().next().value);
        this.snapshots.set(snapshot, { client, pageId, expires: Date.now() + 30000 });
      }
      return { result, snapshot: args.screenshot ? null : snapshot, captured_at: new Date().toISOString() };
    }
    if (role !== 'controller') throw new Error('observer_cannot_control');
    const lease = this.leases.get(pageId);
    if (op === 'claim') {
      exactKeys(args, ['pageId', 'ttl_ms', 'lease']);
      const ttl = args.ttl_ms === undefined ? 60000 : args.ttl_ms;
      if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 120000) throw new Error('ttl_ms_must_be_1000_to_120000');
      if (lease && lease.expires > Date.now()) {
        if (lease.owner !== client || args.lease !== lease.token) throw new Error('tab_already_claimed');
        lease.expires = Date.now() + ttl;
        return { lease: lease.token, generation: lease.generation, expires: lease.expires };
      }
      if (this.leases.size >= 128) {
        for (const [id, value] of this.leases) if (value.expires <= Date.now()) this.leases.delete(id);
        if (this.leases.size >= 128) throw new Error('too_many_leases');
      }
      this.invalidate(pageId);
      const next = { owner: client, token: crypto.randomUUID(), generation: ++this.generation, expires: Date.now() + ttl };
      this.leases.set(pageId, next);
      return { lease: next.token, generation: next.generation, expires: next.expires };
    }
    if (!lease || lease.owner !== client || lease.token !== args.lease || lease.expires <= Date.now()) throw new Error('valid_tab_lease_required');
    if (op === 'release') {
      exactKeys(args, ['pageId', 'lease']);
      this.revoke(pageId);
      return { released: true };
    }
    if (op !== 'call') throw new Error('unknown_browser_operation');
    exactKeys(args, ['pageId', 'lease', 'snapshot', 'action', 'url', 'uid', 'value', 'key']);
    const allowed = { navigate: ['url'], click: ['uid'], fill: ['uid', 'value'], key: ['key'] };
    if (!Object.hasOwn(allowed, args.action)) throw new Error('action_not_allowed');
    exactKeys(args, ['pageId', 'lease', 'snapshot', 'action', ...allowed[args.action]]);
    for (const field of allowed[args.action]) if (typeof args[field] !== 'string' || args[field].length > 16000) throw new Error(`invalid_${field}`);
    if (args.action !== 'navigate') {
      const snapshot = this.snapshots.get(args.snapshot);
      if (!snapshot || snapshot.client !== client || snapshot.pageId !== pageId || snapshot.expires < Date.now()) throw new Error('fresh_snapshot_required');
    }
    let tool, params = { pageId };
    if (args.action === 'navigate') {
      const url = new URL(args.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('http_or_https_url_required');
      tool = 'navigate_page'; params.url = url.href; params.timeout = 15000;
    } else if (args.action === 'click') { tool = 'click'; params.uid = args.uid; }
    else if (args.action === 'fill') { tool = 'fill'; params.uid = args.uid; params.value = args.value; }
    else {
      // Do not expose browser shortcuts (address bar, DevTools, file picker).
      if (!['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(args.key)) throw new Error('key_not_allowed');
      tool = 'press_key'; params.key = args.key;
    }
    this.invalidate(pageId);
    return { result: await this.backend.call(tool, params), observed_after_action: false };
  }
}

async function launchBrowser(config) {
  // Optional peers keep browser dependencies out of ordinary room-only installations.
  const roots = [config.dependencies || process.cwd(), path.join(__dirname, '..', '..')];
  const resolve = (name) => require.resolve(name, { paths: roots });
  const chromePackage = resolve('chrome-devtools-mcp/package.json');
  const version = require(chromePackage).version;
  if (version !== '1.11.0') throw new Error('Install chrome-devtools-mcp@1.11.0 for this worker');
  const puppeteer = require(resolve('puppeteer-core'));
  const captureTitle = `ninja_capture_${crypto.randomBytes(24).toString('hex')}`;
  const mediaEnabled = !!(config.media && config.media.enabled === true);
  const browser = await puppeteer.launch({
    ...(config.executable ? { executablePath: config.executable } : { channel: 'chrome' }),
    headless: true, defaultViewport: { width: 1280, height: 720 },
    ...(mediaEnabled ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
    args: ['--renderer-process-limit=2', '--num-raster-threads=2', ...(mediaEnabled ? [`--auto-select-tab-capture-source-by-title=${captureTitle}`, '--autoplay-policy=no-user-gesture-required'] : [])],
    env: { ...process.env, UV_THREADPOOL_SIZE: '2' }
  });
  let backend, media;
  try {
    // The endpoint is loopback-only and never appears in remote results.
    backend = new ChromeMcp(path.join(path.dirname(chromePackage), 'build/src/bin/chrome-devtools-mcp.js'), browser.wsEndpoint());
    await backend.start();
    const listed = await backend.call('list_pages', {});
    const pages = (listed.content || []).filter((item) => item.type === 'text').flatMap((item) => Array.from(item.text.matchAll(/^(\d+): /gm), (match) => Number(match[1])));
    if (pages.length !== 1) throw new Error('Expected one isolated browser tab');
    const target = (await browser.pages())[0];
    let mediaError;
    if (mediaEnabled) {
      try { media = await require('./browser-media').startBrowserMedia(browser, target, captureTitle, config.media); }
      catch (error) { mediaError = error.message; }
    }
    return { browser, backend, pages, target, media,
      mediaStatus: async () => media ? media.status() : { enabled: false, ...(mediaError ? { error: mediaError, action: 'Use browser_observe screenshots or restart the worker after restoring WebRTC media connectivity.' } : {}) },
      close: async () => { backend.close(); try { if (media) await media.close(); } finally { await browser.close(); } } };
  } catch (error) { if (backend) backend.close(); if (media) await media.close(); await browser.close(); throw error; }
}

module.exports = { ChromeMcp, BrowserController, launchBrowser };
