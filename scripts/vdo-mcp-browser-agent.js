#!/usr/bin/env node
// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { loadConfig, makeSession } = require('./vdo-mcp-browser');
const { BrowserRpcClient } = require('./lib/browser-rpc');
const { BrowserVoiceAgent, MODEL } = require('./lib/browser-agent');

async function startOperator(config, options = {}) {
  if (config.clients) throw new Error('Use an individual agent JSON file, not worker.json');
  const token = crypto.randomBytes(32).toString('hex');
  const session = options.session || makeSession(config, false);
  const rpc = options.rpc || new BrowserRpcClient(session, config);
  const assets = path.join(__dirname, '..', 'assets', 'browser-agent');
  const files = new Map([
    ['/', [path.join(assets, 'index.html'), 'text/html; charset=utf-8']],
    ['/client.js', [path.join(assets, 'client.js'), 'text/javascript; charset=utf-8']],
    ['/audio-worklet.js', [path.join(assets, 'audio-worklet.js'), 'text/javascript; charset=utf-8']],
    ['/sdk.js', [require.resolve('@vdoninja/sdk/browser'), 'text/javascript; charset=utf-8']]
  ]);
  let origin, client, agent, connecting, microphone = false, closed = false;
  const send = (event) => {
    if (!client || client.readyState !== 1) return;
    if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, 'Operator connection too slow'); return; }
    client.send(JSON.stringify(event));
  };
  const ensureWorker = () => {
    if (!connecting) connecting = session.start().then(() => rpc.connect()).catch((error) => { connecting = null; throw error; });
    return connecting;
  };
  const server = http.createServer((req, res) => {
    if (req.headers.host !== new URL(origin).host || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'" });
    fs.createReadStream(file[0]).on('error', () => res.destroy()).pipe(res);
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, origin); } catch (_) { socket.destroy(); return; }
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || url.pathname !== '/operator' || url.searchParams.get('token') !== token || client) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    client = ws;
    const voice = new BrowserVoiceAgent(rpc, { apiKey: options.apiKey || process.env.OPENAI_API_KEY, model: options.model || process.env.VDON_BROWSER_MODEL || MODEL,
      emit: (event) => { if (client === ws) send(event); }, connectSocket: options.connectSocket });
    agent = voice;
    send({ type: 'hello', worker: config.worker, provider: 'OpenAI', model: agent.model, key_available: !!agent.apiKey, transport: config.connection.transport || 'webrtc' });
    let commands = Promise.resolve();
    let count = 0;
    let commandEpoch = 0;
    ws.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'audio') { if (microphone) voice.audio(event.data); return; }
      if (event.type === 'playback') { voice.truncate(event); return; }
      // Stop and sharing controls take effect immediately, even during a tool call.
      if (event.type === 'interrupt') { commandEpoch++; voice.interrupt(event); return; }
      if (event.type === 'stop') { commandEpoch++; microphone = false; voice.stop(); return; }
      if (event.type === 'permissions') {
        microphone = !!event.microphone;
        if (!microphone) voice.send({ type: 'input_audio_buffer.clear' });
        voice.permissions({ share: event.share, control: event.control });
        send({ type: 'sharing', microphone, frames: voice.share, control: voice.control, recipient: 'OpenAI' });
        return;
      }
      if (count >= 8) { send({ type: 'error', message: 'Too many pending operator actions' }); return; }
      count++;
      const epoch = commandEpoch;
      commands = commands.then(async () => {
        if (client !== ws || closed || epoch !== commandEpoch) return;
        if (event.type === 'start') { await ensureWorker(); if (client === ws && epoch === commandEpoch) await voice.start(); }
        else if (event.type === 'text') voice.text(event.text);
        else if (event.type === 'frame') { await ensureWorker(); if (client === ws && epoch === commandEpoch) await voice.captureFrame(); }
        else if (event.type === 'watch') {
          await ensureWorker();
          if (client !== ws || epoch !== commandEpoch) return;
          const media = await rpc.request('media');
          if (client === ws && epoch === commandEpoch) send({ type: 'media', ...media });
        } else if (event.type === 'check') {
          const hello = await ensureWorker();
          if (client === ws && epoch === commandEpoch) send({ type: 'worker', ok: true, role: hello.role, route: hello.route });
        }
      }).catch((error) => { if (client === ws) send({ type: 'error', message: error.message }); }).finally(() => { count--; });
    });
    ws.on('close', () => {
      commandEpoch++; voice.stop(); microphone = false;
      if (client === ws) client = null;
    });
    ws.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      closed = true;
      if (agent) { await agent.stop(); await agent.toolChain; }
      if (client) client.terminate();
      wss.close(); rpc.close();
      await session.stop();
      await new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); });
    })();
    return closePromise;
  };
  return { url: `${origin}/#${token}`, origin, close, rpc, session };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('vdon-mcp-browser-agent --config <agent.json>\nOPENAI_API_KEY stays in this local process. Open the printed private loopback URL.'); return; }
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Use --config <agent.json>');
  const service = await startOperator(loadConfig(args[1]));
  console.log(`Open this private operator page on this computer:\n${service.url}`);
  const shutdown = () => service.close().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { startOperator };
