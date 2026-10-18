// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const EventEmitter = require('node:events');
const { BridgeSession } = require('./bridge-session');

// One browser RPC worker owns authentication, leases and deduplication above
// both routes. Switching routes never creates a second execution authority.
class BrowserRoutes extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.sessions = new Map();
    this.requests = new Map();
    this.lastReplyRoute = null;
    this.preferHttpUntil = 0;
    this.running = false;
    this.probing = false;
    this.createSession = options.createSession || ((value) => new BridgeSession(value));
    for (const transport of ['webrtc', 'http']) {
      const session = this.createSession({ ...config, transport });
      const listener = (event) => this.emit('event', { ...event, route: transport,
        ...(event.uuid ? { uuid: `${transport}:${event.uuid}` } : {}) });
      session.on('event', listener);
      this.sessions.set(transport, session);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.probeTimer = setInterval(() => this.retryView(), 5000);
    this.probeTimer.unref();
    for (const [route, session] of this.sessions) {
      const pending = session.start().catch(() => {});
      if (route === 'http') await pending;
    }
  }

  available(route, target) {
    return !!this.peer(route, target);
  }

  peer(route, target) {
    const session = this.sessions.get(route);
    return session.listSyncPeers()
      .filter((peer) => peer.stream_id === target && session.hasOpenDataChannel(peer.uuid))
      .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))[0];
  }

  retryView() {
    const target = this.config.targetStreamID;
    const rtc = this.sessions.get('webrtc');
    if (!this.running || !target || this.probing || rtc.connecting || rtc.state !== 'connected' ||
        !rtc.sdk || this.available('webrtc', target)) return;
    // The worker may return with a new peer UUID while signaling stays connected.
    // Refresh only this browser client's intended view; HTTP continues meanwhile.
    this.probing = true;
    rtc.sdk.view(target, { audio: false, video: false }).catch(() => {}).finally(() => { this.probing = false; });
  }

  sendRequest(packet, target, { id, attempt }) {
    if (!this.running) return false;
    const previous = this.requests.get(id);
    const preferred = Date.now() < this.preferHttpUntil ? 'http' : 'webrtc';
    let choices = [preferred, preferred === 'webrtc' ? 'http' : 'webrtc'];
    if (attempt > 0 && previous) {
      choices = [previous === 'webrtc' ? 'http' : 'webrtc', previous];
      if (previous === 'webrtc') this.preferHttpUntil = Date.now() + 30000;
    }
    for (const route of choices) {
      const peer = this.peer(route, target);
      if (!peer) continue;
      if (this.sessions.get(route).send(packet, { uuid: peer.uuid })) {
        if (this.requests.size >= 128) this.requests.delete(this.requests.keys().next().value);
        this.requests.set(id, route);
        this.emit('event', { type: 'browser_route_sent', route, request_id: id, stage: 'queued' });
        return true;
      }
    }
    return false;
  }

  markResponse(id, route) {
    this.lastReplyRoute = route;
    this.requests.delete(id);
    if (route === 'webrtc') this.preferHttpUntil = 0;
    this.emit('event', { type: 'browser_route_reply', route, request_id: id, stage: 'peer_response' });
  }

  finishRequest(id) { this.requests.delete(id); }

  send(packet, target) {
    if (!this.running) return false;
    if (typeof target === 'string') {
      const colon = target.indexOf(':');
      const session = this.sessions.get(target.slice(0, colon));
      if (session) return session.send(packet, { uuid: target.slice(colon + 1) });
    }
    return false;
  }

  getStatus() {
    return { transport: 'auto', last_reply_route: this.lastReplyRoute,
      routes: Array.from(this.sessions, ([transport, session]) => ({ transport,
        state: session.state, peers: session.listSyncPeers().filter((peer) => session.hasOpenDataChannel(peer.uuid)).length,
        error: session.lastError || null })) };
  }

  async stop() {
    this.running = false;
    clearInterval(this.probeTimer);
    this.requests.clear();
    await Promise.allSettled(Array.from(this.sessions.values(), (session) => session.stop()));
  }
}

module.exports = { BrowserRoutes };
