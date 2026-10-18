// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('node:crypto');
const MAGIC = 'ninja_browser_v1';
const MAX_RESULT = 2 * 1024 * 1024;
const PART_BYTES = 24000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keyBytes(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('Browser keys must be 32 random bytes encoded as 64 hex characters');
  return Buffer.from(key, 'hex');
}

// Independent, per-client encryption: another room member cannot read or forge browser operations.
function seal(key, worker, client, direction, value, magic = MAGIC) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([magic, worker, client, direction])));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { browser: magic, worker, client, direction, box: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64') };
}

function open(key, packet, magic = MAGIC) {
  if (!packet || packet.browser !== magic || typeof packet.box !== 'string' || packet.box.length > 65000) throw new Error('Invalid browser packet');
  const bytes = Buffer.from(packet.box, 'base64');
  if (bytes.length < 29) throw new Error('Invalid browser packet');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify([magic, packet.worker, packet.client, packet.direction])));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

class BrowserRpcWorker {
  constructor(session, config, execute, options = {}) {
    this.options = options;
    this.magic = options.magic || MAGIC;
    this.maxResult = options.maxResult || MAX_RESULT;
    this.session = session;
    this.worker = config.worker;
    this.clients = config.clients;
    this.execute = execute;
    this.boot = crypto.randomUUID();
    this.records = new Map();
    this.cacheBytes = 0;
    this.queued = 0;
    this.chain = Promise.resolve();
    this.closed = false;
    this.listener = (event) => { this.receive(event).catch(() => {}); };
    session.on('event', this.listener);
  }

  async receive(event) {
    const packet = event.data;
    if (this.closed || event.type !== 'data_received' || !event.uuid || !packet || packet.browser !== this.magic || packet.worker !== this.worker || packet.direction !== 'request') return;
    if (!Object.hasOwn(this.clients, packet.client)) return;
    const identity = this.clients[packet.client];
    let request;
    try { request = open(identity.key, packet, this.magic); } catch (_) { return; }
    const now = Date.now();
    if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.id) || !Number.isSafeInteger(request.deadline) || request.deadline < now || request.deadline > now + 65000) return;
    if (request.op !== 'hello' && request.boot !== this.boot) {
      await this.reply(packet.client, event.uuid, request.id, { error: 'worker_restarted', boot: this.boot });
      return;
    }
    if (this.options.onAuthenticated) this.options.onAuthenticated(packet.client, event);
    for (const [id, record] of this.records) {
      if (record.until < now && record.result) { this.cacheBytes -= record.bytes; this.records.delete(id); }
    }
    const id = `${packet.client}:${request.id}`;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.records.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return this.reply(packet.client, event.uuid, request.id, { error: 'request_id_conflict' });
      if (previous.result && !previous.sending) {
        previous.sending = true;
        try { await this.reply(packet.client, event.uuid, request.id, previous.result); } finally { previous.sending = false; }
      }
      return;
    }
    if (this.queued >= 16 || this.records.size >= 1024 || this.cacheBytes > 30 * 1024 * 1024) {
      // Leave the request pending until capacity returns or its deadline expires.
      // Do not report rejection while a replay could still be admitted later.
      return;
    }
    const record = { fingerprint, until: request.deadline + 120000, result: null, bytes: 0, sending: false };
    this.records.set(id, record);
    this.queued++;
    const run = async () => {
      let result;
      try {
        if (this.closed || Date.now() > request.deadline) throw new Error('request_expired');
        if (request.op === 'hello') result = { boot: this.boot, role: identity.role, worker: this.worker };
        else if (request.op === 'result') {
          const found = this.records.get(`${packet.client}:${request.args && request.args.request_id}`);
          result = found && found.result ? { status: 'completed', result: found.result } : { status: 'unknown' };
        } else result = await this.execute(packet.client, identity.role, request.op, request.args || {}, { ...request, peer: event.uuid });
      } catch (error) { result = this.options.errorCodes ? { error: error.code || error.message, message: error.message } : { error: error.message }; }
      if (Buffer.byteLength(JSON.stringify(result)) > this.maxResult) result = { error: 'result_too_large', execution: 'completed' };
      record.result = result;
      record.bytes = Buffer.byteLength(JSON.stringify(result));
      this.cacheBytes += record.bytes;
      this.queued--;
      record.sending = true;
      try { await this.reply(packet.client, event.uuid, request.id, result); } finally { record.sending = false; }
    };
    if (this.options.parallel) run().catch(() => {});
    else this.chain = this.chain.then(run, run).catch(() => {});
  }

  async reply(client, uuid, id, result) {
    const bytes = Buffer.from(JSON.stringify(result));
    const count = Math.ceil(bytes.length / PART_BYTES);
    for (let part = 0; part < count && !this.closed; part++) {
      const packet = seal(this.clients[client].key, this.worker, client, 'response', {
        id, boot: this.boot, part, count, data: bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES).toString('base64')
      }, this.magic);
      let sent = this.session.send(packet, uuid);
      if (!sent && this.options.backpressure) {
        const until = Date.now() + 1000;
        while (!sent && !this.closed && Date.now() < until) {
          await delay(50);
          sent = this.session.send(packet, uuid);
        }
      }
      if (!sent) return;
      // Bound queued bytes on HTTP and avoid monopolizing a data channel.
      if (count > 1) await delay(12);
    }
  }

  close() { this.closed = true; this.session.off('event', this.listener); }
}

class BrowserRpcClient {
  constructor(session, config, options = {}) {
    this.options = options;
    this.magic = options.magic || MAGIC;
    this.maxResult = options.maxResult || MAX_RESULT;
    keyBytes(config.key);
    this.session = session;
    this.config = config;
    this.boot = null;
    this.pending = new Map();
    this.listener = (event) => this.receive(event);
    session.on('event', this.listener);
  }

  receive(event) {
    const p = event.data;
    if (event.type !== 'data_received' || !p || p.browser !== this.magic || p.worker !== this.config.worker || p.client !== this.config.client || p.direction !== 'response') return;
    let value;
    try { value = open(this.config.key, p, this.magic); } catch (_) { return; }
    const pending = this.pending.get(value.id);
    if (!pending || !Number.isInteger(value.count) || value.count < 1 || value.count > Math.ceil(this.maxResult / PART_BYTES) || !Number.isInteger(value.part) || value.part < 0 || value.part >= value.count || typeof value.data !== 'string' || value.data.length > 32000) return;
    if (pending.count && (pending.count !== value.count || pending.boot !== value.boot)) return;
    pending.count = value.count;
    pending.boot = value.boot;
    pending.parts.set(value.part, Buffer.from(value.data, 'base64'));
    if (pending.parts.size === value.count) {
      try {
        const bytes = Buffer.concat(Array.from({ length: value.count }, (_, i) => pending.parts.get(i)));
        if (bytes.length > this.maxResult) return;
        const result = JSON.parse(bytes.toString('utf8'));
        pending.route = event.route || this.session.config.transport;
        if (this.session.markResponse) this.session.markResponse(value.id, event.route);
        pending.resolve(result);
      } catch (_) { /* An incomplete or invalid result is never treated as success. */ }
    }
  }

  async request(op, args = {}, timeoutMs = 30000) {
    if (this.pending.size >= 16) throw new Error('Too many pending browser requests');
    if (op !== 'hello' && !this.boot) await this.connect();
    const id = crypto.randomUUID();
    const request = { id, boot: this.boot, deadline: Date.now() + timeoutMs, op, args };
    const packet = seal(this.config.key, this.config.worker, this.config.client, 'request', request, this.magic);
    if (packet.box.length > 65000) throw new Error('Browser request too large');
    let timer, retry;
    try {
      const result = await new Promise((resolve) => {
        this.pending.set(id, { resolve, parts: new Map() });
        let attempt = 0;
        const send = () => {
          if (this.session.sendRequest) return this.session.sendRequest(packet, this.config.worker, { id, attempt: attempt++ });
          return this.session.send(packet, this.config.worker);
        };
        send();
        retry = setInterval(send, 2000);
        timer = setTimeout(() => resolve({ error: 'outcome_unknown', request_id: id, message: this.options.timeoutMessage || 'Inspect browser_result and current page before repeating an action.' }), timeoutMs);
      });
      if (result.error === 'worker_restarted') this.boot = null;
      return { ...result, request_id: id, route: this.pending.get(id)?.route || null };
    } finally {
      clearInterval(retry); clearTimeout(timer); this.pending.delete(id);
      if (this.session.finishRequest) this.session.finishRequest(id);
    }
  }

  async connect() {
    const result = await this.request('hello');
    if (result.error) throw new Error(result.error);
    this.boot = result.boot;
    return result;
  }

  close() {
    this.session.off('event', this.listener);
    for (const [id, p] of this.pending) p.resolve({ error: 'outcome_unknown', request_id: id });
  }
}

module.exports = { BrowserRpcWorker, BrowserRpcClient, keyBytes, seal, open };
