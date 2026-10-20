// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

// Private human sign-in for a remote SSApp. The agent's own Ninja MCP server (or the separate
// "human" credential) serves SSApp's viewer on the person's computer; the host worker forwards
// only the viewer's fixed endpoints to SSApp. SSApp's viewer token stays on the host, and the
// viewer link, pictures and input never pass through MCP tool results, so a model never sees
// them. Agents are paused for the whole takeover.

const http = require('node:http');
const crypto = require('node:crypto');
const { error } = require('./ssapp-worker');

const PAGES = {
  viewer: 'text/html; charset=utf-8',
  'viewer.js': 'application/javascript; charset=utf-8',
  'viewer.css': 'text/css; charset=utf-8'
};
const PAGE_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_REPLY_BYTES = 9 * 1024 * 1024;
const HUMAN_OPS = new Set(['human_page', 'human_instance', 'human_start', 'human_command', 'human_suspend', 'human_finish']);

function local(origin, method, pathname, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(`${origin}${pathname}`, { method, timeout: 35000,
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const parts = []; let size = 0;
      res.on('data', (part) => { size += part.length; if (size > (raw ? MAX_PAGE_BYTES : MAX_REPLY_BYTES)) res.destroy(error('ssapp_reply_too_large')); else parts.push(part); });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (raw) return resolve({ status: res.statusCode, text });
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (_) { reject(error('invalid_ssapp_reply')); }
      });
    });
    req.on('timeout', () => req.destroy(error('SSAPP_TIMEOUT', 'SSApp did not answer. Check the picture before repeating an action.')));
    req.on('error', reject);
    req.end(data);
  });
}

class SsappHumanHost {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.origin = controller.origin;
    this.forget = options.forget || (() => {});
    this.session = null;
    controller.onInstanceChange = () => this.end(false);
  }

  privateHeaders() {
    return { 'x-ssapp-instance-id': this.session.instanceId, 'x-ssapp-human-token': this.session.token };
  }

  end(finished) {
    const client = this.session?.client;
    this.session = null;
    if (client) this.forget(client, HUMAN_OPS);
    if (finished) this.controller.resumeAfterHuman();
  }

  async releaseIfIdle() {
    // A failed takeover must not leave agents blocked when SSApp itself is not paused.
    try {
      const status = await local(this.origin, 'GET', '/api/v1/human/status');
      if (status.json?.payload?.automationPaused === false) this.controller.human = false;
    } catch (_) { /* Stay paused when the state cannot be confirmed. */ }
  }

  async execute(client, role, op, args = {}, request = {}) {
    if (!this.controller.mayTakeOver(client)) throw error('human_control_not_permitted', 'This credential cannot open the private viewer. Use a controller allowed ssapp_show_source_for_human, or the human credential, with SSApp 0.4.40 or newer.');
    if (op === 'human_page') {
      if (!Object.hasOwn(PAGES, args.name)) throw error('unknown_viewer_page');
      const page = await local(this.origin, 'GET', `/api/v1/human/${args.name}`, { raw: true });
      if (page.status !== 200) throw error('viewer_unavailable', 'Use SSApp 0.4.40 / API 1.6.0 or newer with Local AI / Automation enabled.');
      return { status: 200, contentType: PAGES[args.name], body: page.text };
    }
    if (op === 'human_instance') {
      const instance = await local(this.origin, 'GET', '/api/v1/instance');
      return { status: instance.status, json: instance.json };
    }
    if (op === 'human_start') {
      if (args.confirm !== true) throw error('CONFIRMATION_REQUIRED', 'Taking private control requires confirm: true.');
      // Reconcile a restarted app before granting a new viewer. Otherwise the next
      // agent discovery would discard this new grant as part of the old instance.
      const instance = await this.controller.ensure();
      if (!instance) throw error('SSAPP_UNREACHABLE', 'Start SSApp before taking private control.');
      if (this.session && this.session.client !== client) throw error('HUMAN_CONTROL_BUSY', 'Another person already has private control.');
      // An agent's person cannot take over from another agent's active task; the human credential can.
      const lease = this.controller.lease;
      if (role !== 'human' && lease && lease.expires > Date.now() && lease.owner !== client) throw error('app_already_claimed', 'Another agent has control. Wait until it releases, then try again.');
      // Stop agent control first; SSApp drains anything already dispatched before granting input.
      this.controller.pauseForHuman();
      const started = await local(this.origin, 'POST', '/api/v1/human/start', { body: { confirm: true }, headers: { 'x-ssapp-instance-id': instance.instanceId } });
      const payload = started.json?.payload;
      if (started.status !== 200 || !started.json?.ok || typeof payload?.token !== 'string') {
        await this.releaseIfIdle();
        return { status: started.status, json: started.json };
      }
      if (this.session) this.forget(this.session.client, HUMAN_OPS);
      this.session = { client, token: payload.token, instanceId: instance.instanceId, peer: request.peer };
      const { token, ...visible } = payload;
      return { status: 200, json: { ...started.json, payload: visible } };
    }
    if (!['human_command', 'human_suspend', 'human_finish'].includes(op)) throw error('unknown_human_operation');
    if (!this.session || this.session.client !== client) {
      return { status: 403, json: { ok: false, error: { code: 'HUMAN_CONTROL_UNAUTHORIZED', message: 'Take private control again.' } } };
    }
    // Track the actual authenticated connection, including a switch to HTTP.
    // A WebRTC peer may not yet have a stream name in the general peer catalog.
    if (request.peer) this.session.peer = request.peer;
    const pathname = op === 'human_command' ? '/api/v1/human/command' : op === 'human_suspend' ? '/api/v1/human/suspend' : '/api/v1/human/finish';
    const body = op === 'human_command' ? { action: args.action, value: args.value || {} } : { confirm: args.confirm === true };
    let reply;
    try { reply = await local(this.origin, 'POST', pathname, { body, headers: this.privateHeaders() }); }
    catch (failure) {
      if (op === 'human_command') throw failure;
      return { status: 502, json: { ok: false, error: { code: failure.code || 'SSAPP_UNREACHABLE', message: 'SSApp did not confirm. Automation stays paused.' } } };
    }
    const code = reply.json?.error?.code;
    if (reply.status === 200 && reply.json?.ok && op !== 'human_command') this.end(op === 'human_finish');
    else if (['HUMAN_CONTROL_UNAUTHORIZED', 'HUMAN_CONTROL_EXPIRED', 'SSAPP_INSTANCE_CHANGED'].includes(code)) this.end(false);
    return { status: reply.status, json: reply.json };
  }

  // The person's connection dropped: revoke the viewer and keep automation paused.
  async disconnect() {
    if (!this.session) return;
    const headers = this.privateHeaders();
    this.end(false);
    await local(this.origin, 'POST', '/api/v1/human/suspend', { body: { confirm: true }, headers }).catch(() => {});
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (part) => { size += part.length; if (size > limit) { reject(error('body_too_large')); req.destroy(); } else parts.push(part); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (_) { reject(error('invalid_json')); } });
    req.on('error', reject);
  });
}

// Runs on the person's computer. Serves SSApp's viewer on a private loopback URL and carries
// its requests to the host over the encrypted Ninja MCP connection. Each link opens once: the
// first browser to load it receives a cookie that every later request needs.
async function startHumanViewer(rpc, options = {}) {
  let prefix = null, claim = null, claimed = false;
  const pages = new Map();
  let viewerToken = null;
  let origin;
  const ended = (finished) => { viewerToken = null; if (options.onEnd) options.onEnd(finished); };
  const call = async (op, args, timeout = 30000) => {
    const reply = await rpc.request(op, args, timeout);
    if (reply.error === 'worker_restarted') return { status: 409, json: { ok: false, error: { code: 'HUMAN_CONTROL_UNAUTHORIZED', message: 'The SSApp host restarted. Take private control again.' } } };
    if (reply.error === 'outcome_unknown') return { status: 504, json: { ok: false, error: { code: 'BRIDGE_OUTCOME_UNKNOWN', message: 'No reply from the SSApp host. Check the picture before repeating an action.' } } };
    if (reply.error) return { status: 502, json: { ok: false, error: { code: reply.error, message: reply.message || reply.error } } };
    return reply;
  };
  const same = (value, expected) => {
    if (!expected || typeof value !== 'string') return false;
    const a = Buffer.from(value), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const cookie = (req) => String(req.headers.cookie || '').split(/;\s*/).find((part) => part.startsWith('ninja_viewer='))?.slice(13);
  const server = http.createServer(async (req, res) => {
    try {
      if (!prefix || req.headers.host !== new URL(origin).host || !req.url.startsWith(`${prefix}/`)) { res.writeHead(404); res.end(); return; }
      const pathname = req.url.slice(prefix.length).split('?')[0];
      if (!same(cookie(req), claim)) {
        if (claimed || req.method !== 'GET' || pathname !== '/api/v1/human/viewer') {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('This private link was already opened. Ask the AI for a new one.'); return;
        }
        claimed = true;
        res.setHeader('set-cookie', `ninja_viewer=${claim}; Path=${prefix}/; HttpOnly; SameSite=Strict`);
      }
      if (req.method === 'GET' && pathname.startsWith('/api/v1/human/') && Object.hasOwn(PAGES, pathname.slice(14))) {
        const name = pathname.slice(14);
        if (!pages.has(name)) {
          const page = await call('human_page', { name });
          if (page.status !== 200) return json(res, page.status, page.json);
          pages.set(name, page);
        }
        res.writeHead(200, { ...PAGE_HEADERS, 'content-type': pages.get(name).contentType });
        res.end(pages.get(name).body);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/v1/instance') {
        const reply = await call('human_instance', {});
        return json(res, reply.status, reply.json);
      }
      // Only this page may drive the bridge: other sites and local programs lack the origin and token.
      if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
      const body = await readBody(req, 160 * 1024);
      if (pathname === '/api/v1/human/start') {
        const reply = await call('human_start', { confirm: body.confirm === true });
        if (reply.status === 200 && reply.json?.ok) {
          viewerToken = crypto.randomBytes(32).toString('base64url');
          reply.json.payload = { ...reply.json.payload, token: viewerToken };
          if (options.onStart) options.onStart();
        }
        return json(res, reply.status, reply.json);
      }
      const op = { '/api/v1/human/command': 'human_command', '/api/v1/human/suspend': 'human_suspend', '/api/v1/human/finish': 'human_finish' }[pathname];
      if (!op) { res.writeHead(404); res.end(); return; }
      if (!same(req.headers['x-ssapp-human-token'], viewerToken)) return json(res, 403, { ok: false, error: { code: 'HUMAN_CONTROL_UNAUTHORIZED', message: 'Take private control again.' } });
      const reply = await call(op, op === 'human_command' ? { action: body.action, value: body.value } : { confirm: body.confirm === true });
      if (op !== 'human_command' && reply.status === 200 && reply.json?.ok) ended(op === 'human_finish');
      else if (['HUMAN_CONTROL_UNAUTHORIZED', 'HUMAN_CONTROL_EXPIRED'].includes(reply.json?.error?.code) && viewerToken) ended(false);
      return json(res, reply.status, reply.json);
    } catch (failure) {
      if (!res.headersSent) json(res, 400, { ok: false, error: { code: failure.code || 'INVALID_REQUEST', message: failure.code ? failure.message : 'Invalid viewer request.' } });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  // Closing a viewer keeps automation paused, like closing SSApp's own viewer.
  const suspend = async () => {
    if (!viewerToken) return;
    ended(false);
    await rpc.request('human_suspend', { confirm: true }, 8000).catch(() => {});
  };
  return {
    active: () => viewerToken !== null,
    // A new link replaces the old one; a tab still holding control is suspended first.
    async issue() {
      await suspend();
      prefix = `/${crypto.randomBytes(18).toString('base64url')}`;
      claim = crypto.randomBytes(32).toString('base64url'); claimed = false;
      return `${origin}${prefix}/api/v1/human/viewer`;
    },
    retire() { if (!viewerToken) prefix = claim = null; },
    async close() {
      await suspend();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}

module.exports = { SsappHumanHost, startHumanViewer };
