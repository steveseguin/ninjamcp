#!/usr/bin/env node
// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { loadConfig: loadBrowserConfig, makeSession } = require('./vdo-mcp-browser');
const { BrowserRpcWorker, BrowserRpcClient } = require('./lib/browser-rpc');
const { SsappController, RPC_OPTIONS, controlOrigin, validateCommand } = require('./lib/ssapp-worker');
const { McpStdioParser, writeMcpMessage } = require('./lib/mcp-stdio-parser');
const { saveSettingsExport } = require('./lib/ssapp-export');
const { SsappHumanHost, startHumanViewer } = require('./lib/ssapp-human');

const managementTool = (name, description, properties = {}, required = []) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const MANAGEMENT = [
  managementTool('ninja_ssapp_save_settings_export', 'Save an owned SSApp settings export on this agent computer. Verifies size and SHA-256 and never overwrites an existing file. Parent directory must exist and support hard links. Returns metadata only; backup may contain credentials.', {
    artifactId: { type: 'string', pattern: '^export_[a-f0-9]{32}$' }, destination: { type: 'string', minLength: 1 }
  }, ['artifactId', 'destination']),
  managementTool('ninja_ssapp_status', 'Discover the remote SSApp instance, versions, permissions, control owner and whether a person has private control (human_control). After an app restart or a person handing control back, list fresh targets and claim control again.'),
  managementTool('ninja_ssapp_claim', 'Claim or renew control of this SSApp instance for this MCP connection. Other agents can observe. Reconcile uncertain outcomes before using reconciled: true.', {
    ttl_ms: { type: 'integer', minimum: 1000, maximum: 120000 }, reconciled: { type: 'boolean' }
  }),
  managementTool('ninja_ssapp_release', 'Release control for another agent. An already executing action may finish.'),
  managementTool('ninja_ssapp_result', 'Read a retained transport result by request_id. Unknown does not mean an action failed; inspect SSApp before retrying.', { request_id: { type: 'string' } }, ['request_id']),
  managementTool('ninja_ssapp_request_human', 'Ask the person to do a private step in SSApp themselves, such as signing in, MFA or a CAPTCHA. Shows them a private viewer through this MCP client, or opens it in their browser on this computer. You never see the link, pictures or what they type, and automation pauses while they have control. Never ask for passwords.', {
    reason: { type: 'string', minLength: 1, maxLength: 160, description: 'Shown to the person, e.g. "Sign in to YouTube in the YouTube source window."' }
  }, ['reason']),
  managementTool('ninja_ssapp_wait_for_human', 'Wait without polling until the person hands control back, or until wait_seconds passes. After returned_control, claim control again and list targets.', {
    wait_seconds: { type: 'integer', minimum: 1, maximum: 600 }
  }, ['wait_seconds'])
];
const HUMAN_TOOLS = new Set(['ninja_ssapp_request_human', 'ninja_ssapp_wait_for_human']);
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function loadConfig(file) {
  const config = loadBrowserConfig(file);
  if (config.backend !== 'ssapp') throw new Error('Use an SSApp configuration generated with vdon-mcp-ssapp --setup');
  if (config.clients) {
    if (!config.ssapp) throw new Error('Configure the local SSApp MCP command on the host');
    validateCommand(config.ssapp);
    controlOrigin(config.ssapp.controlUrl);
    for (const value of Object.values(config.clients)) {
      if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== 'string' || !tool.startsWith('ssapp_')))) throw new Error('Client tools must be an array of ssapp_* tool names');
      if (value.allowHostFiles !== undefined && typeof value.allowHostFiles !== 'boolean') throw new Error('allowHostFiles must be a boolean');
      if (value.allowSettingsExport !== undefined && typeof value.allowSettingsExport !== 'boolean') throw new Error('allowSettingsExport must be a boolean');
    }
  }
  return config;
}

async function startWorker(config) {
  if (!config.clients || config.backend !== 'ssapp') throw new Error('Use the SSApp worker.json on the host');
  const session = makeSession(config, true);
  const controller = new SsappController(config);
  const callers = new Map();
  const routes = () => session.sessions ? Array.from(session.sessions.values()) : [session];
  let human;
  const rpc = new BrowserRpcWorker(session, config, (client, role, op, args, request) => (String(op).startsWith('human_')
    ? human.execute(client, role, op, args, request) : controller.execute(client, role, op, args, request)), { ...RPC_OPTIONS,
    onAuthenticated: (client, event) => {
      const peer = routes().flatMap((route) => route.listSyncPeers()).find((peer) => event.uuid === peer.uuid || event.uuid.endsWith(':' + peer.uuid));
      if (peer?.stream_id) callers.set(client, peer.stream_id);
    } });
  human = new SsappHumanHost(controller, { forget: (client, ops) => rpc.forget(client, ops) });
  const connected = (client) => {
    const stream = callers.get(client);
    return !stream || routes().some((route) => route.listSyncPeers().some((peer) => peer.stream_id === stream && route.hasOpenDataChannel(peer.uuid)));
  };
  const humanConnected = () => {
    const peer = human.session?.peer;
    if (!peer) return false;
    if (!session.sessions) return session.hasOpenDataChannel(peer);
    const colon = peer.indexOf(':');
    return session.sessions.get(peer.slice(0, colon))?.hasOpenDataChannel(peer.slice(colon + 1)) === true;
  };
  let humanMissing = 0;
  const disconnectCheck = setInterval(() => {
    const owner = controller.lease?.owner;
    if (owner && !connected(owner)) controller.revoke();
    // A person's viewer that disappears for a few seconds is suspended; automation stays paused.
    humanMissing = human.session && !humanConnected() ? humanMissing + 1 : 0;
    if (humanMissing >= 4) { humanMissing = 0; human.disconnect().catch(() => {}); }
  }, 1000);
  disconnectCheck.unref();
  let closing;
  const close = () => closing || (closing = (async () => { clearInterval(disconnectCheck); await human.disconnect().catch(() => {}); rpc.close(); const stopping = controller.close(); await session.stop(); await stopping; })());
  try { await controller.ensure(); await session.start(); } catch (failure) { await close(); throw failure; }
  return { session, rpc, controller, human, close };
}

class SsappClient {
  constructor(config, options = {}) {
    this.config = config;
    this.session = options.session || makeSession(config, false);
    this.rpc = new BrowserRpcClient(this.session, config, RPC_OPTIONS);
    this.discovery = null; this.lease = null; this.connecting = null;
  }
  async connect() {
    if (!this.connecting) this.connecting = this.session.start().then(() => this.rpc.connect()).catch((failure) => { this.connecting = null; throw failure; });
    await this.connecting;
  }
  async discover() {
    await this.connect();
    const value = await this.rpc.request('discover', {}, 60000);
    if (value.error) throw new Error(value.error);
    if (value.backend !== 'ssapp' || value.contract !== 1) throw new Error('Incompatible remote SSApp worker');
    if (value.instance?.instanceId !== this.discovery?.instance?.instanceId) this.lease = null;
    this.discovery = value;
    return value;
  }
  async call(name, args = {}) {
    if (!this.discovery) await this.discover();
    if (name === 'ninja_ssapp_status') {
      // tools/list already carries the catalog and initialize the instructions; repeating them here cost ~17K tokens per call.
      const { catalog, instructions, ...status } = await this.discover();
      return { ...status, tool_count: catalog?.tools?.length || 0 };
    }
    if (name === 'ninja_ssapp_save_settings_export') return saveSettingsExport(this, args);
    const common = { instance: this.discovery.instance?.instanceId, lease: this.lease };
    let response;
    if (name === 'ninja_ssapp_claim') {
      response = await this.rpc.request('claim', { ...args, ...common }, 60000);
      if (response.lease) this.lease = response.lease;
    } else if (name === 'ninja_ssapp_release') {
      response = await this.rpc.request('release', common, 60000); this.lease = null;
    } else if (name === 'ninja_ssapp_result') response = await this.rpc.request('result', args, 60000);
    else response = await this.rpc.request('call', { ...common, name, arguments: args }, 60000);
    if (['worker_restarted', 'fresh_app_discovery_required', 'valid_app_lease_required'].includes(response.error)) this.lease = null;
    return response;
  }
  async close() {
    if (this.lease) await this.rpc.request('release', { lease: this.lease }, 3000).catch(() => {});
    this.lease = null; this.rpc.close(); await this.session.stop();
  }
}

function mcpResult(response, discovery) {
  const metadata = { backend: 'ssapp', request_id: response.request_id, route: response.route, instanceId: discovery?.instance?.instanceId };
  if (Array.isArray(response.result?.content) && !response.error) return { ...response.result, _meta: { ...response.result._meta, ninja: metadata } };
  if (!response.error) return { content: [{ type: 'text', text: JSON.stringify(response) }], _meta: { ninja: metadata } };
  const structuredContent = { ok: false, ssappVersion: discovery?.instance?.ssappVersion || 'unknown', apiVersion: discovery?.instance?.apiVersion || 'unknown',
    error: { code: response.error, message: response.message || response.error, ...(response.execution ? { execution: response.execution } : {}) } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, _meta: { ninja: metadata } };
}

function openBrowser(url) {
  const [command, args, options] = process.platform === 'win32' ? ['cmd', ['/c', `start "" "${url}"`], { windowsVerbatimArguments: true }]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {}];
  try { spawn(command, args, { ...options, stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch (_) { /* The printed link still works. */ }
}
const hasScreen = () => process.platform === 'win32' || process.platform === 'darwin' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

async function startClient(config, input = process.stdin, output = process.stdout, options = {}) {
  if (config.clients) throw new Error('Use an individual agent JSON file');
  const client = new SsappClient(config, { session: options.session });
  const parser = new McpStdioParser({ maxMessageBytes: 65536 });
  const active = new Set(); let closed = false, closing;
  let capabilities = {};
  // Requests this server sends to the MCP client, such as showing the person a private link.
  const outgoing = new Map(); let outgoingId = 0;
  const ask = (method, params, ms) => new Promise((resolve) => {
    const id = `ninja-${++outgoingId}`;
    const finish = (message) => { clearTimeout(timer); outgoing.delete(id); resolve(message); };
    const timer = setTimeout(() => finish({ error: { code: -32001, message: 'No answer' } }), ms);
    outgoing.set(id, finish);
    writeMcpMessage(output, { jsonrpc: '2.0', id, method, params }, parser.mode);
  });

  // The private viewer runs inside this MCP server, on the person's computer. Its link goes to the
  // person through the MCP client or their browser, never into a tool result.
  let viewerReady = null, person = 'none', elicitationId = null;
  const waiters = new Set();
  const setPerson = (state) => {
    person = state;
    if (state === 'returned_control' && elicitationId) {
      writeMcpMessage(output, { jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } }, parser.mode);
      elicitationId = null;
    }
    for (const wake of waiters) wake();
  };
  const requestHuman = async (args) => {
    const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : '';
    if (!reason || reason.length > 160) return { error: 'invalid_arguments', message: 'Give a short reason the person will see.' };
    const discovery = await client.discover();
    if (!discovery.human_viewer) return { error: 'human_control_not_permitted', message: 'This agent cannot offer the private viewer. It needs a controller allowed ssapp_show_source_for_human and SSApp 0.4.40 or newer.' };
    const viaClient = !!capabilities.elicitation?.url;
    const open = options.openBrowser || (hasScreen() ? openBrowser : null);
    if (!viaClient && !open) return { error: 'no_screen_here', message: 'This MCP server has no screen for the viewer. The person can run vdon-mcp-ssapp --human --config <their human.json> on their own computer.' };
    if (!viewerReady) viewerReady = startHumanViewer(client.rpc, { onStart: () => setPerson('in_control'), onEnd: (finished) => setPerson(finished ? 'returned_control' : 'paused') });
    let viewer;
    try { viewer = await viewerReady; } catch (failure) { viewerReady = null; throw failure; }
    const url = await viewer.issue();
    setPerson('offered');
    if (viaClient) {
      elicitationId = crypto.randomUUID();
      const answer = await ask('elicitation/create', { mode: 'url', elicitationId, url,
        message: `${reason} Open SSApp's private viewer on this computer and choose Take control. The AI is paused and cannot see it. Choose Done when finished.` }, 300000);
      const action = answer.result?.action;
      if (action !== 'accept') {
        viewer.retire(); elicitationId = null; setPerson('none');
        return { ok: false, person: action === 'decline' ? 'declined' : action === 'cancel' ? 'cancelled' : 'no_answer', next: 'The person did not open the viewer. Ask them before offering it again.' };
      }
    } else open(url);
    return { ok: true, delivered: viaClient ? 'mcp_client' : 'browser', person: 'offered', next: 'Tell the person in one sentence what to do, then call ninja_ssapp_wait_for_human.' };
  };
  const waitForHuman = async (args) => {
    const seconds = args.wait_seconds;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) return { error: 'invalid_arguments', message: 'wait_seconds must be 1 to 600.' };
    const deadline = Date.now() + seconds * 1000;
    let ssapp = null;
    while (!closed) {
      if (person !== 'returned_control') {
        // SSApp's own status also covers a person using the separate human credential.
        let response = await client.call('ssapp_get_human_control_status');
        if (response.error === 'fresh_app_discovery_required') { await client.discover(); response = await client.call('ssapp_get_human_control_status'); }
        ssapp = response.result?.structuredContent?.result?.payload || null;
        if (person === 'none' && ssapp?.automationPaused === false) break;
      }
      if (person === 'returned_control' || Date.now() >= deadline) break;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(3000, deadline - Date.now()));
        waiters.add(done);
      });
    }
    const outcome = person === 'none' ? (ssapp?.automationPaused === false ? 'idle' : ssapp?.state || 'unknown') : person;
    if (['returned_control', 'idle'].includes(outcome)) {
      person = 'none';
      if (!closed) await client.discover();
      return { ok: true, person: outcome, next: 'Claim control again and list targets before continuing.' };
    }
    return { ok: true, person: outcome, next: outcome === 'paused' ? 'The person paused without handing back, so automation stays paused. Ask them to choose Done.' : 'The person has not handed back yet. Wait again or ask them.' };
  };

  const dispatch = async (message, mode) => {
    if (closed || !message || message.jsonrpc !== '2.0' || message.id === undefined) return;
    const reply = (value) => writeMcpMessage(output, { jsonrpc: '2.0', id: message.id, ...value }, mode);
    if (active.size >= 12) return reply({ error: { code: -32000, message: 'Too many pending requests' } });
    try {
      if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        capabilities = message.params?.capabilities || {};
        const discovery = await client.discover();
        const human = discovery.human_viewer ? 'When a site needs the person (sign-in, MFA, CAPTCHA), call ninja_ssapp_request_human with a short reason, tell them what to do, then call ninja_ssapp_wait_for_human. Never ask for passwords or the viewer link. While they have control, other calls return HUMAN_CONTROL_ACTIVE. ' : '';
        return reply({ result: { protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: discovery.serverInfo,
          instructions: 'These SSApp tools operate the remote host. Call ninja_ssapp_status and list targets; claim control before mutations and release after the task. Keep ssapp_* arguments unchanged. Host file paths refer to that computer. ' + human + discovery.instructions,
          _meta: { ninja: { backend: 'ssapp', instance: discovery.instance } } } });
      }
      if (message.method === 'ping') return reply({ result: {} });
      if (message.method === 'tools/list') {
        const discovery = await client.discover();
        const management = MANAGEMENT.filter((tool) => discovery.human_viewer || !HUMAN_TOOLS.has(tool.name));
        return reply({ result: { ...discovery.catalog, tools: [...management, ...discovery.catalog.tools] } });
      }
      if (message.method !== 'tools/call') return reply({ error: { code: -32601, message: 'Method not found' } });
      const params = message.params || {};
      if (typeof params.name !== 'string' || params.arguments && (typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return reply({ error: { code: -32602, message: 'Invalid tool arguments' } });
      const response = params.name === 'ninja_ssapp_request_human' ? await requestHuman(params.arguments || {})
        : params.name === 'ninja_ssapp_wait_for_human' ? await waitForHuman(params.arguments || {})
          : await client.call(params.name, params.arguments || {});
      reply({ result: mcpResult(response, client.discovery) });
    } catch (failure) {
      if (message.method !== 'tools/call') return reply({ error: { code: -32000, message: failure.message } });
      reply({ result: mcpResult({ error: failure.code || 'ninja_ssapp_error', message: failure.message }, client.discovery) });
    }
  };
  parser.on('message', ({ message, mode }) => {
    if (message && message.method === undefined && outgoing.has(message.id)) return outgoing.get(message.id)(message);
    const pending = dispatch(message, mode); active.add(pending); pending.finally(() => active.delete(pending));
  });
  parser.on('error', () => writeMcpMessage(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP request' } }, parser.mode));
  const close = () => closing || (closing = (async () => {
    closed = true;
    for (const finish of outgoing.values()) finish({ error: { code: -32000, message: 'Closed' } });
    for (const wake of waiters) wake();
    const releasing = client.lease ? client.rpc.request('release', { lease: client.lease }, 3000).catch(() => {}) : Promise.resolve();
    await Promise.allSettled([...active, releasing]);
    // Closing the AI client closes its viewer too; a person still in control is suspended and automation stays paused.
    if (viewerReady) await viewerReady.then((viewer) => viewer.close(), () => {});
    await client.close();
  })());
  input.on('data', (chunk) => { parser.push(chunk); if (parser.buffer.length > 65536) { parser.buffer = Buffer.alloc(0); close().catch(() => {}); } });
  return { client, close };
}

// The person's side of a private sign-in: a local viewer page carried to the host over the encrypted link.
async function startHuman(config, options = {}) {
  if (config.clients) throw new Error('Use the human.json credential, not worker.json');
  const session = makeSession(config, false);
  const rpc = new BrowserRpcClient(session, config, RPC_OPTIONS);
  let viewer;
  try {
    await session.start();
    const hello = await rpc.connect();
    if (hello.role !== 'human') throw new Error('This is an agent credential. Use human.json from the SSApp setup to open the private viewer.');
    viewer = await startHumanViewer(rpc, {
      onStart: () => console.error('Private control active. AI automation on the SSApp host is paused.'),
      onEnd: (finished) => console.error(finished ? 'Control returned to the AI.' : 'Disconnected. AI automation stays paused until you take control again and choose Done.')
    });
    viewer.url = await viewer.issue();
  } catch (failure) { rpc.close(); await session.stop(); throw failure; }
  console.error(`Private SSApp viewer for ${config.worker}. The link opens once, on this computer only:\n${viewer.url}\nPress Ctrl+C to close. Closing keeps the AI paused until you choose Done.`);
  if (options.open) openBrowser(viewer.url);
  return { viewer, close: async () => { await viewer.close(); rpc.close(); await session.stop(); } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('vdon-mcp-ssapp --setup <private-directory> --adapter-config <copied-mcp.json> [--transport webrtc|http|auto] [--relay-config <relay.json>]\nvdon-mcp-ssapp --worker --config <worker.json>\nvdon-mcp-ssapp --config <agent1.json>\nvdon-mcp-ssapp --doctor --config <agent1.json>\nvdon-mcp-ssapp --human --config <human.json> [--no-open]'); return;
  }
  if (args[0] === '--setup') {
    const directory = args[1]; const options = { backend: 'ssapp' }; let adapterFile;
    if (!directory || directory.startsWith('--')) throw new Error('Choose a private setup directory');
    for (let i = 2; i < args.length; i += 2) {
      if (!args[i + 1]) throw new Error(`Missing value for ${args[i]}`);
      if (args[i] === '--transport') options.transport = args[i + 1];
      else if (args[i] === '--relay-config') options.relayConfig = args[i + 1];
      else if (args[i] === '--adapter-config') adapterFile = args[i + 1];
      else throw new Error(`Unknown option ${args[i]}`);
    }
    if (!adapterFile) throw new Error('Save SSApp\'s copied MCP setup to a private file and pass --adapter-config');
    const adapter = JSON.parse(fs.readFileSync(adapterFile, 'utf8'));
    const entries = adapter.mcpServers ? Object.values(adapter.mcpServers) : [adapter];
    if (entries.length !== 1) throw new Error('Adapter configuration must contain exactly one SSApp MCP command');
    options.ssapp = { ...entries[0], controlUrl: controlOrigin(entries[0].env?.SSAPP_CONTROL_URL) };
    validateCommand(options.ssapp);
    const result = require('./lib/browser-setup').createSetup(directory, options);
    console.error(`Created private SSApp credentials in ${result.directory}. Start the host with --worker --config worker.json; give each agent only its own JSON file. ` +
      'A controller agent shows its person the private sign-in viewer itself. Keep human.json only for a person at a different computer from the agent: they run vdon-mcp-ssapp --human --config human.json there.'); return;
  }
  const worker = args[0] === '--worker', doctor = args[0] === '--doctor', human = args[0] === '--human';
  if (worker || doctor || human) args.shift();
  const noOpen = args.indexOf('--no-open');
  if (human && noOpen >= 0) args.splice(noOpen, 1);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Use --config <file>');
  const config = loadConfig(args[1]);
  if (doctor) {
    if (config.clients) throw new Error('Use an individual agent JSON file for --doctor');
    const client = new SsappClient(config);
    let connected = false;
    try {
      const d = await client.discover(); connected = !!d.instance;
      console.log(JSON.stringify({ ok: connected, backend: d.backend, app: d.instance, mcp: d.serverInfo, role: d.role, tools: d.catalog.tools.length, route: d.route,
        ...(connected ? {} : { action: 'Start SSApp with API 1.4.1 or newer and enable Local AI / Automation.' }) }, null, 2));
    }
    finally { await client.close(); }
    process.exit(connected ? 0 : 1);
  }
  const service = worker ? await startWorker(config) : human ? await startHuman(config, { open: noOpen < 0 }) : await startClient(config);
  const shutdown = () => service.close().then(() => process.stdout.write('', () => process.exit(0)), (failure) => { console.error(failure.message); process.exit(1); });
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (human) return;
  if (worker) {
    console.error('SSApp bridge running. Enter revoke to release control, or stop to disconnect the bridge.');
    const terminal = readline.createInterface({ input: process.stdin });
    terminal.on('line', (line) => { if (line.trim() === 'revoke') { service.controller.revoke(); console.error('Control revoked. An already executing action may finish.'); } if (line.trim() === 'stop') { terminal.close(); shutdown(); } });
    terminal.on('SIGINT', shutdown);
  } else { process.stdin.once('end', shutdown); process.stdin.once('close', shutdown); }
}

if (require.main === module) main().catch((failure) => { console.error(failure.message); process.exitCode = 1; });
module.exports = { MANAGEMENT, loadConfig, startWorker, SsappClient, startClient, startHuman, mcpResult };
