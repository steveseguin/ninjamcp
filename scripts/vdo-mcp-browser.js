#!/usr/bin/env node
// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { BridgeSession } = require('./lib/bridge-session');
const { BrowserRpcWorker, BrowserRpcClient, keyBytes } = require('./lib/browser-rpc');
const { BrowserController, launchBrowser } = require('./lib/browser-worker');
const { McpStdioParser, writeMcpMessage } = require('./lib/mcp-stdio-parser');

const pageId = { type: 'integer', minimum: 0 };
const lease = { type: 'string' };
function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const TOOLS = [
  tool('browser_tabs', 'List remote tabs and current control leases.', {}),
  tool('browser_media', 'Get live tab audio/video status and private viewer credentials when the host enables media. Use screenshots when WebRTC media is unavailable. Protect the returned viewing link.', {}),
  tool('browser_observe', 'Read a fresh accessibility snapshot with element UIDs, or a JPEG screenshot. Take a new snapshot after claiming control and after each action.', { pageId, screenshot: { type: 'boolean' } }, ['pageId']),
  tool('browser_claim', 'Claim one tab for up to 120 seconds. Pass the current lease to renew it. Other agents may observe while you control.', { pageId, ttl_ms: { type: 'integer', minimum: 1000, maximum: 120000 }, lease }, ['pageId']),
  tool('browser_release', 'Release a tab for another controller.', { pageId, lease }, ['pageId', 'lease']),
  tool('browser_call', 'Navigate, click, fill, or press a page key. Requires a tab lease; input actions also require a fresh snapshot token. Never repeat an uncertain action before reconciling its result.', {
    pageId, lease, snapshot: { type: 'string' }, action: { type: 'string', enum: ['navigate', 'click', 'fill', 'key'] },
    url: { type: 'string' }, uid: { type: 'string' }, value: { type: 'string' }, key: { type: 'string' }
  }, ['pageId', 'lease', 'action']),
  tool('browser_result', 'Look up a recent request by its request_id. Unknown is not evidence that an action did not execute; inspect the page before deciding what to do next.', { request_id: { type: 'string' } }, ['request_id'])
];

function loadConfig(file) {
  if (!file) throw new Error('Use --config <file>, or set VDON_BROWSER_CONFIG. Run --init <directory> to create credentials.');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.worker || '')) throw new Error('Invalid worker ID');
  if (!config.connection || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.connection.room || '')) throw new Error('A connection.room is required');
  if (config.clients) {
    if (!Object.keys(config.clients).length || Object.keys(config.clients).length > 32) throw new Error('Configure 1 to 32 browser clients');
    const keys = new Set();
    for (const [id, value] of Object.entries(config.clients)) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !['controller', 'observer'].includes(value.role)) throw new Error('Invalid browser client');
      keyBytes(value.key);
      if (keys.has(value.key.toLowerCase())) throw new Error('Each browser client needs a unique key');
      keys.add(value.key.toLowerCase());
    }
  } else {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.client || '')) throw new Error('Invalid browser client ID');
    keyBytes(config.key);
  }
  return config;
}

function makeSession(config, worker) {
  const sessionConfig = {
    ...config.connection,
    relayUrl: process.env.VDON_MCP_RELAY_URL || config.connection.relayUrl,
    relayToken: process.env.VDON_MCP_RELAY_TOKEN || config.connection.relayToken,
    relayKey: process.env.VDON_MCP_RELAY_KEY || config.connection.relayKey,
    streamID: worker ? config.worker : `${config.client}_${crypto.randomBytes(6).toString('hex')}`,
    targetStreamID: worker ? null : config.worker,
    maxQueueSize: 32
  };
  if (sessionConfig.transport === 'auto') {
    const { BrowserRoutes } = require('./lib/browser-routes');
    return new BrowserRoutes(sessionConfig);
  }
  return new BridgeSession(sessionConfig);
}

function initConfigs(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const connection = { room: `browser_${crypto.randomBytes(12).toString('hex')}`, transport: 'webrtc' };
  const worker = `chrome_${crypto.randomBytes(6).toString('hex')}`;
  const clients = {};
  const files = [];
  for (const [client, role] of [['agent1', 'controller'], ['agent2', 'controller'], ['viewer', 'observer']]) {
    const key = crypto.randomBytes(32).toString('hex');
    clients[client] = { role, key };
    files.push([`${client}.json`, { worker, client, key, connection }]);
  }
  files.push(['worker.json', { worker, clients, connection }]);
  for (const [file] of files) if (fs.existsSync(path.join(directory, file))) throw new Error(`${file} already exists; choose a new directory`);
  for (const [file, value] of files) fs.writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stderr.write(`Created worker.json, agent1.json, agent2.json, and viewer.json in ${path.resolve(directory)}. Keep these credentials private.\n`);
}

async function startWorker(config) {
  if (!config.clients) throw new Error('Worker mode requires worker.json');
  const session = makeSession(config, true);
  const runtime = await launchBrowser(config);
  const controller = new BrowserController(runtime.backend, runtime.pages);
  runtime.target.on('framenavigated', (frame) => { if (frame === runtime.target.mainFrame()) controller.invalidate(runtime.pages[0]); });
  const rpc = new BrowserRpcWorker(session, config, (client, role, op, args) => {
    if (op === 'media') return runtime.mediaStatus();
    return controller.execute(client, role, op, args);
  });
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      rpc.close();
      try { await session.stop(); } finally { await runtime.close(); }
    })();
    return closePromise;
  };
  try { await session.start(); } catch (error) { await close(); throw error; }
  return { session, rpc, controller, runtime, close };
}

async function startClient(config, input = process.stdin, output = process.stdout) {
  if (config.clients) throw new Error('Client mode requires an individual agent credential file');
  const session = makeSession(config, false);
  const rpc = new BrowserRpcClient(session, config);
  const parser = new McpStdioParser({ maxMessageBytes: 65536 });
  let connecting;
  let closed = false;
  let closePromise;
  let inFlight = 0;
  const close = () => {
    if (!closePromise) {
      closed = true;
      rpc.close();
      closePromise = session.stop();
    }
    return closePromise;
  };
  const dispatch = async (message, mode) => {
    if (closed) return;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    if (message.id === undefined) return;
    const reply = (value) => writeMcpMessage(output, { jsonrpc: '2.0', id: message.id, ...value }, mode);
    if (inFlight >= 16) return reply({ error: { code: -32000, message: 'Too many pending requests' } });
    inFlight++;
    try {
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ninja-browser', version: '0.4.3' } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: TOOLS };
      else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params || {};
        const definition = TOOLS.find((entry) => entry.name === name);
        if (!definition) throw new Error('Unknown browser tool');
        if (!connecting) connecting = session.start().then(() => rpc.connect()).catch((error) => { connecting = null; throw error; });
        await connecting;
        const response = await rpc.request(name.slice('browser_'.length), args);
        const { result: contentResult, ...metadata } = response;
        const hasContent = contentResult && Array.isArray(contentResult.content);
        result = { content: [{ type: 'text', text: JSON.stringify(hasContent ? metadata : response) }, ...(hasContent ? contentResult.content : [])],
          isError: !!response.error || !!(contentResult && contentResult.isError) };
      } else return reply({ error: { code: -32601, message: 'Method not found' } });
      reply({ result });
    } catch (error) { reply({ result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
    finally { inFlight--; }
  };
  parser.on('message', ({ message, mode }) => { dispatch(message, mode).catch(() => {}); });
  parser.on('error', () => writeMcpMessage(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP request' } }, parser.mode));
  input.on('data', (chunk) => { parser.push(chunk); if (parser.buffer.length > 65536) { parser.buffer = Buffer.alloc(0); close().catch(() => {}); } });
  input.on('end', () => { close().catch(() => {}); });
  input.on('close', () => { close().catch(() => {}); });
  return { session, rpc, close };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--init' && args.length === 2) return initConfigs(args[1]);
  if (args[0] === '--setup') {
    const directory = args[1];
    if (!directory || directory.startsWith('--')) throw new Error('--setup requires a private directory');
    const options = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--media') options.media = true;
      else if (args[i] === '--transport' && args[i + 1]) options.transport = args[++i];
      else if (args[i] === '--relay-config' && args[i + 1]) options.relayConfig = args[++i];
      else throw new Error(`Unknown setup option: ${args[i]}`);
    }
    return require('./lib/browser-setup').guidedSetup(directory, options);
  }
  const diagnostic = args[0] === '--doctor';
  if (diagnostic) args.shift();
  const worker = args[0] === '--worker';
  if (worker) args.shift();
  if (args.includes('--help')) {
    process.stdout.write('vdon-mcp-browser --setup <private-directory> [--transport webrtc|http|auto] [--relay-config <relay.json>] [--media]\nvdon-mcp-browser --doctor --config <worker-or-agent.json>\nvdon-mcp-browser --worker --config <worker.json>\nvdon-mcp-browser --config <agent1.json>\n');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Expected --config <file>');
  const config = loadConfig(args[1] || process.env.VDON_BROWSER_CONFIG);
  if (diagnostic) {
    const result = await require('./lib/browser-setup').doctor(config, makeSession);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => process.exit(result.ok ? 0 : 1));
    return;
  }
  const service = worker ? await startWorker(config) : await startClient(config);
  const shutdown = () => service.close().then(() => process.exit(0), (error) => { process.stderr.write(error.message + '\n'); process.exit(1); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (!worker) {
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
  }
  if (worker) {
    process.stderr.write(`Browser worker ${config.worker} is running over ${config.connection.transport || 'webrtc'}. Enter "revoke <pageId>" to revoke a tab lease; "stop" or Ctrl+C stops the browser.\n`);
    {
      const terminal = readline.createInterface({ input: process.stdin });
      terminal.on('line', (line) => {
        const match = /^revoke (\d+)$/.exec(line.trim());
        if (match) { service.controller.revoke(Number(match[1])); process.stderr.write('Lease revoked. An action already executing may finish.\n'); }
        if (line.trim() === 'stop') { terminal.close(); shutdown(); }
      });
      terminal.on('SIGINT', () => { terminal.close(); shutdown(); });
      process.once('SIGINT', () => terminal.close());
      process.once('SIGTERM', () => terminal.close());
    }
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { TOOLS, loadConfig, makeSession, initConfigs, startWorker, startClient };
