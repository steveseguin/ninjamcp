'use strict';

// Private human sign-in through the SSApp bridge, using a fake SSApp HTTP API, a fake SSApp MCP
// adapter, and the simulated network. Checks the safety rules rather than the real app UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { BridgeSession } = require('../scripts/lib/bridge-session');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');
const { BrowserRpcWorker, BrowserRpcClient, seal } = require('../scripts/lib/browser-rpc');
const { SsappController, RPC_OPTIONS } = require('../scripts/lib/ssapp-worker');
const { SsappHumanHost, startHumanViewer } = require('../scripts/lib/ssapp-human');
const { startClient } = require('../scripts/vdo-mcp-ssapp');

const FAKE_MCP = `
const readline = require('node:readline');
const tools = [
  { name: 'ssapp_get_human_control_status', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'ssapp_show_source_for_human', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  { name: 'ssapp_list_sources', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'ssapp_stop_source', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }
];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send(message.id, { serverInfo: { name: 'social-stream-ninja', version: '1.5.0' }, instructions: 'fake' });
  if (message.method === 'tools/list') return send(message.id, { tools });
  if (message.params.name === 'ssapp_get_human_control_status') {
    const status = await (await fetch(process.env.SSAPP_CONTROL_URL + '/api/v1/human/status')).json();
    const structuredContent = { ok: true, result: status };
    return send(message.id, { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
  }
  send(message.id, { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: message.params.name }) }], structuredContent: { ok: true, tool: message.params.name } });
});
`;

function fakeSsapp() {
  const state = { instanceId: crypto.randomUUID(), session: null, paused: false, commands: [], suspends: 0, finishes: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const status = () => ({ state: state.session ? 'active' : state.paused ? 'suspended' : 'idle', automationPaused: state.paused });
      if (req.url === '/api/v1/instance') {
        const reply = () => send(200, { ok: true, instanceId: state.instanceId, apiVersion: '1.6.0', humanControl: status() });
        if (state.holdInstance) { const hold = state.holdInstance; delete state.holdInstance; return hold(reply); }
        return reply();
      }
      if (req.url === '/api/v1/human/viewer') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>viewer</title>'); }
      if (req.url === '/api/v1/human/status') return send(200, { ok: true, payload: status() });
      if (req.headers['x-ssapp-instance-id'] !== state.instanceId) return send(409, { ok: false, error: { code: 'SSAPP_INSTANCE_REQUIRED' } });
      if (req.url === '/api/v1/human/start') {
        state.session = crypto.randomBytes(16).toString('hex');
        state.paused = true;
        return send(200, { ok: true, payload: { ...status(), token: state.session, expiresAt: Date.now() + 120000, deadline: Date.now() + 1800000 } });
      }
      if (!state.session || req.headers['x-ssapp-human-token'] !== state.session) return send(403, { ok: false, error: { code: 'HUMAN_CONTROL_UNAUTHORIZED', message: 'Take control again' } });
      const value = JSON.parse(body || '{}');
      if (req.url === '/api/v1/human/command') {
        state.commands.push(value);
        if (value.action === 'captureBrowserScreenshot') return send(200, { ok: true, payload: { targetId: 'wc:1', screenshotId: 's1', width: 800, height: 600, mimeType: 'image/jpeg', dataBase64: Buffer.alloc(150000, 7).toString('base64'), page: { redactedUrl: 'https://accounts.example.com/' } } });
        return send(200, { ok: true, payload: { action: value.action } });
      }
      if (req.url === '/api/v1/human/suspend') { state.suspends++; state.session = null; return send(200, { ok: true, payload: status() }); }
      if (req.url === '/api/v1/human/finish') { state.finishes++; state.session = null; state.paused = false; return send(200, { ok: true, payload: status() }); }
      send(404, { ok: false });
    });
  });
  return { server, state, get instanceId() { return state.instanceId; } };
}

const until = async (check, label, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`timed out: ${label}`);
};

// The person's browser: keeps the one-time cookie and sends the page's own origin.
function personBrowser(url) {
  const base = url.replace(/\/human\/viewer$/, '');
  const origin = new URL(url).origin;
  let cookie = '';
  return {
    async open() {
      const res = await fetch(url, { headers: cookie ? { cookie } : {} });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return res;
    },
    get: (pathname) => fetch(`${base}${pathname}`, { headers: { cookie } }),
    post: (pathname, body, headers = {}) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie, ...headers }, body: JSON.stringify(body) })
  };
}

// A minimal MCP client speaking newline-delimited JSON-RPC to startClient.
function mcpPipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffer = '', id = 0;
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  const take = async (match, label) => {
    let found;
    await until(() => { const i = messages.findIndex(match); if (i >= 0) found = messages.splice(i, 1)[0]; return !!found; }, label, 8000);
    return found;
  };
  const send = (message) => input.write(JSON.stringify(message) + '\n');
  const request = (method, params) => { const n = ++id; send({ jsonrpc: '2.0', id: n, method, params }); return take((m) => m.id === n && m.method === undefined, method); };
  const tool = async (name, args = {}) => {
    const reply = await request('tools/call', { name, arguments: args });
    return { reply, value: JSON.parse(reply.result.content[0].text) };
  };
  return { input, output, messages, take, send, request, tool };
}

function checkReplyAssembly() {
  const session = new (require('node:events'))();
  session.config = { transport: 'webrtc' };
  const config = { worker: 'frames', client: 'human', key: crypto.randomBytes(32).toString('hex') };
  const client = new BrowserRpcClient(session, config, RPC_OPTIONS);
  let result;
  const reset = () => { result = undefined; client.pending.set('frame', { parts: new Map(), resolve: value => { result = value; } }); };
  const oldFrame = { picture: 'A'.repeat(40000), screenshotId: 'old' };
  const newFrame = { picture: 'B'.repeat(40000), screenshotId: 'new' };
  const part = (frame, index, options = {}) => {
    const bytes = Buffer.from(JSON.stringify(frame));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const data = Buffer.from(bytes.subarray(index * 24000, (index + 1) * 24000));
    if (options.corrupt) data[50] = 67;
    client.receive({ type: 'data_received', data: seal(config.key, config.worker, config.client, 'response', {
      id: 'frame', boot: 'boot', part: index, count: 2, data: data.toString('base64'),
      ...(options.legacy ? {} : { digest })
    }, RPC_OPTIONS.magic) });
  };
  reset();
  part(oldFrame, 0); // One fragment is lost; a retry captures a different frame.
  part(newFrame, 1);
  assert.equal(result, undefined, 'fragments from different screenshots must not complete a reply');
  part(newFrame, 0);
  assert.deepEqual(result, newFrame);
  reset();
  part(newFrame, 0, { corrupt: true }); part(newFrame, 1);
  assert.equal(result, undefined, 'a complete reply must match its digest');
  part(newFrame, 0); part(newFrame, 1);
  assert.deepEqual(result, newFrame);
  reset();
  part(oldFrame, 1, { legacy: true }); part(oldFrame, 0, { legacy: true });
  assert.deepEqual(result, oldFrame, 'existing workers without reply digests remain compatible');
  client.pending.clear(); client.close();
}

async function run() {
  checkReplyAssembly();
  const ssapp = fakeSsapp();
  await new Promise((resolve) => ssapp.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${ssapp.server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninja-ssapp-human-'));
  const adapter = path.join(dir, 'fake-mcp.js');
  fs.writeFileSync(adapter, FAKE_MCP);
  const key = () => crypto.randomBytes(32).toString('hex');
  const clients = {
    agent1: { role: 'controller', key: key() }, agent2: { role: 'controller', key: key() },
    watch: { role: 'observer', key: key() }, limited: { role: 'controller', tools: ['ssapp_list_sources'], key: key() },
    human: { role: 'human', key: key() }
  };
  const workerConfig = { worker: 'ssapp_test', clients, ssapp: { command: process.execPath, args: [adapter], controlUrl: origin } };
  const sdkFactory = createFakeSDKFactory();
  const session = (streamID, targetStreamID) => new BridgeSession({ room: 'ssapp_human_room', streamID, targetStreamID, reconnectDelayMs: 30, maxReconnectDelayMs: 60, heartbeatMs: 1000 }, { sdkFactory });
  const workerSession = session('ssapp_test');
  const controller = new SsappController(workerConfig);
  let human;
  const rpc = new BrowserRpcWorker(workerSession, workerConfig, (client, role, op, args, request) => (op.startsWith('human_')
    ? human.execute(client, role, op, args, request) : controller.execute(client, role, op, args, request)), RPC_OPTIONS);
  human = new SsappHumanHost(controller, { forget: (client, ops) => rpc.forget(client, ops) });
  const sessions = [workerSession];
  const clientFor = (client) => {
    const s = session(`${client}_peer`, 'ssapp_test');
    sessions.push(s);
    return new BrowserRpcClient(s, { worker: 'ssapp_test', client, key: clients[client].key }, RPC_OPTIONS);
  };
  const mcps = [];
  const mcpFor = async (client, initialize, options = {}) => {
    const pipe = mcpPipe();
    const s = session(`${client}_mcp`, 'ssapp_test');
    sessions.push(s);
    pipe.service = await startClient({ backend: 'ssapp', worker: 'ssapp_test', client, key: clients[client].key }, pipe.input, pipe.output, { ...options, session: s });
    mcps.push(pipe.service);
    pipe.init = await pipe.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, ...initialize });
    return pipe;
  };
  let viewer;
  try {
    await controller.ensure();
    for (const s of sessions) await s.start();
    const agent = clientFor('agent1');
    const watch = clientFor('watch');
    const limited = clientFor('limited');
    const personRpc = clientFor('human');
    for (const s of sessions.slice(1)) await s.start();
    await until(() => sessions.slice(1).every((s) => s.getStatus().connected && s.getStatus().peer_count > 0), 'peers connected');

    const discover = () => agent.request('discover', {}, 5000);
    const call = (name, args = {}, extra = {}) => agent.request('call', { name, arguments: args, instance: ssapp.instanceId, ...extra }, 5000);
    const first = await discover();
    assert.equal(first.human_control, 'idle');
    assert.equal(first.human_viewer, true, 'a full controller may offer the viewer to its person');
    assert.equal((await watch.request('discover', {}, 5000)).human_viewer, false);
    const lease = (await agent.request('claim', { instance: ssapp.instanceId }, 5000)).lease;
    assert.ok(lease, 'agent can claim before a takeover');

    // Observers and controllers without ssapp_show_source_for_human cannot open the viewer;
    // the human credential cannot use agent tools.
    assert.equal((await watch.request('human_start', { confirm: true }, 5000)).error, 'human_control_not_permitted');
    assert.equal((await limited.request('human_page', { name: 'viewer' }, 5000)).error, 'human_control_not_permitted');
    assert.equal((await personRpc.request('claim', { instance: ssapp.instanceId }, 5000)).error, 'human_viewer_only');
    assert.equal((await personRpc.request('discover', {}, 5000)).catalog.tools.length, 0, 'the person gets no agent tools');

    viewer = await startHumanViewer(personRpc);
    const url = await viewer.issue();
    const viewerOrigin = new URL(url).origin;
    const person = personBrowser(url);
    const post = person.post;

    assert.equal((await fetch(`${viewerOrigin}/api/v1/human/viewer`)).status, 404, 'the viewer needs its private path');
    const page = await person.open();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(url)).status, 403, 'the link opens once; another browser is refused');
    assert.equal((await person.open()).status, 200, 'the person can reload');
    const instance = await (await person.get('/instance')).json();
    assert.equal(instance.instanceId, ssapp.instanceId);

    const foreign = await post('/human/start', { confirm: true }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403, 'other sites cannot start a takeover');
    assert.equal(ssapp.state.session, null);

    // The person's human credential overrides an agent's lease.
    const started = await (await post('/human/start', { confirm: true })).json();
    assert.equal(started.ok, true);
    assert.ok(ssapp.state.session, 'SSApp granted a viewer session');
    assert.notEqual(started.payload.token, ssapp.state.session, 'SSApp\'s token never leaves the host');
    assert.equal(controller.human, true);

    // Agents are stopped while the person has control; only the status tool still works.
    assert.equal((await call('ssapp_list_sources')).error, 'HUMAN_CONTROL_ACTIVE');
    assert.equal((await agent.request('claim', { instance: ssapp.instanceId, lease }, 5000)).error, 'HUMAN_CONTROL_ACTIVE');
    const status = await call('ssapp_get_human_control_status');
    assert.equal(status.result.structuredContent.result.payload.state, 'active');
    assert.equal((await discover()).human_control, 'active');

    const token = started.payload.token;
    assert.equal((await post('/human/command', { action: 'listBrowserTargets', value: {} }, { 'x-ssapp-human-token': 'wrong' })).status, 403);
    const shot = await (await post('/human/command', { action: 'captureBrowserScreenshot', value: { targetId: 'wc:1' } }, { 'x-ssapp-human-token': token })).json();
    assert.equal(shot.payload.dataBase64.length, 200000, 'a large picture arrives intact over the encrypted link');
    const typed = await (await post('/human/command', { action: 'browserInput', value: { targetId: 'wc:1', screenshotId: 's1', actions: [{ action: 'type', text: 'private text' }], confirm: true } }, { 'x-ssapp-human-token': token })).json();
    assert.equal(typed.ok, true);
    assert.equal(ssapp.state.commands.filter((c) => c.action === 'browserInput').length, 1, 'input reaches SSApp exactly once');

    // Handback: agents must discover again and take a new lease.
    const done = await (await post('/human/finish', { confirm: true }, { 'x-ssapp-human-token': token })).json();
    assert.equal(done.ok, true);
    assert.equal(controller.human, false);
    assert.equal((await post('/human/command', { action: 'listBrowserTargets', value: {} }, { 'x-ssapp-human-token': token })).status, 403, 'the old viewer token stops working');
    assert.equal((await call('ssapp_list_sources')).error, 'fresh_app_discovery_required');
    await discover();
    assert.ok((await agent.request('claim', { instance: ssapp.instanceId }, 5000)).lease, 'agent claims again after handback');

    // Both requests can await the same instance lookup. The person's continuation
    // pauses control first, so the waiting agent must recheck before granting a lease.
    let instanceReply;
    ssapp.state.holdInstance = (reply) => { instanceReply = reply; };
    const taking = personRpc.request('human_start', { confirm: true }, 5000);
    await until(() => instanceReply, 'takeover awaiting instance lookup');
    const claiming = controller.execute('agent1', 'controller', 'claim',
      { instance: ssapp.instanceId, lease: controller.lease.token }, { deadline: Date.now() + 5000 });
    const rejectedClaim = assert.rejects(claiming, { code: 'HUMAN_CONTROL_ACTIVE' });
    instanceReply();
    assert.equal((await taking).json.ok, true);
    await rejectedClaim;
    assert.equal(controller.lease, null, 'a pending claim cannot recreate a lease after takeover');
    assert.equal((await personRpc.request('human_finish', { confirm: true }, 5000)).json.ok, true);
    await discover();

    // Losing the person's connection suspends the viewer and keeps agents paused.
    assert.equal((await (await post('/human/start', { confirm: true })).json()).ok, true);
    await human.disconnect();
    assert.equal(ssapp.state.suspends, 1);
    assert.equal(controller.human, true, 'automation stays paused until an explicit handback');
    assert.equal((await call('ssapp_list_sources')).error, 'HUMAN_CONTROL_ACTIVE');

    // A fresh bridge must inherit a pause that is still held by the running app.
    const restartedController = new SsappController(workerConfig);
    try {
      await restartedController.discovery('agent1');
      assert.equal(restartedController.human, true, 'bridge restart preserves the SSApp private pause');
      await assert.rejects(restartedController.execute('agent1', 'controller', 'claim',
        { instance: ssapp.instanceId }, { deadline: Date.now() + 5000 }), { code: 'HUMAN_CONTROL_ACTIVE' });
    } finally { await restartedController.close(); }

    for (const leaked of [JSON.stringify(started), JSON.stringify(status), JSON.stringify(await discover())]) {
      assert.ok(!leaked.includes(ssapp.state.session || 'never'), 'no reply carries the SSApp token');
    }

    // An SSApp restart ends the takeover: the new instance is not paused and old grants are invalid.
    assert.equal((await (await post('/human/start', { confirm: true })).json()).ok, true);
    Object.assign(ssapp.state, { instanceId: crypto.randomUUID(), session: null, paused: false });
    await controller.ensure();
    assert.equal(controller.human, false, 'a restarted SSApp releases the bridge hold');
    assert.equal(human.session, null, 'the old viewer grant is dropped');

    // A person can reconnect before any agent discovers the restarted app.
    Object.assign(ssapp.state, { instanceId: crypto.randomUUID(), session: null, paused: false });
    assert.equal((await (await post('/human/start', { confirm: true })).json()).ok, true);
    const freshGrant = human.session;
    assert.equal((await discover()).human_control, 'active');
    assert.equal(human.session, freshGrant, 'agent discovery preserves the new viewer grant');
    assert.equal((await call('ssapp_list_sources')).error, 'HUMAN_CONTROL_ACTIVE');
    await viewer.close(); viewer = null;
    agent.close();

    // MCP-native sign-in: the agent's own MCP server shows the person a private link through the
    // MCP client (URL elicitation). The link never appears in a tool result.
    const mcp = await mcpFor('agent2', { capabilities: { elicitation: { url: {} } } });
    assert.equal(mcp.init.result.protocolVersion, '2025-11-25');
    assert.match(mcp.init.result.instructions, /ninja_ssapp_request_human/);
    const names = (await mcp.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(names.includes('ninja_ssapp_request_human') && names.includes('ninja_ssapp_wait_for_human'));
    assert.equal((await mcp.tool('ninja_ssapp_request_human', { reason: ' ' })).value.error.code, 'invalid_arguments');

    const offering = mcp.tool('ninja_ssapp_request_human', { reason: 'Sign in to YouTube in the YouTube source window.' });
    const ask = await mcp.take((m) => m.method === 'elicitation/create', 'elicitation');
    assert.equal(ask.params.mode, 'url');
    assert.match(ask.params.message, /Sign in to YouTube/);
    const link = ask.params.url;
    assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{24}\/api\/v1\/human\/viewer$/);
    mcp.send({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept' } });
    const offered = await offering;
    assert.equal(offered.value.delivered, 'mcp_client');
    assert.ok(!JSON.stringify(offered.reply).includes(new URL(link).pathname.split('/')[1]), 'the model never sees the link');

    const browser = personBrowser(link);
    assert.equal((await browser.open()).status, 200);
    const grant = await (await browser.post('/human/start', { confirm: true })).json();
    assert.equal(grant.ok, true, 'the person takes control through the agent\'s own connection');
    const blocked = await mcp.tool('ninja_ssapp_claim');
    assert.equal(blocked.reply.result.isError, true);
    assert.equal(blocked.value.error.code, 'HUMAN_CONTROL_ACTIVE', 'the agent is paused while its person has control');
    const shot2 = await (await browser.post('/human/command', { action: 'captureBrowserScreenshot', value: { targetId: 'wc:1' } }, { 'x-ssapp-human-token': grant.payload.token })).json();
    assert.equal(shot2.ok, true);
    const waiting = mcp.tool('ninja_ssapp_wait_for_human', { wait_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await (await browser.post('/human/finish', { confirm: true }, { 'x-ssapp-human-token': grant.payload.token })).json()).ok, true);
    const waited = await waiting;
    assert.equal(waited.value.person, 'returned_control');
    const complete = await mcp.take((m) => m.method === 'notifications/elicitation/complete', 'completion');
    assert.equal(complete.params.elicitationId, ask.params.elicitationId);
    const claimed = await mcp.tool('ninja_ssapp_claim');
    assert.ok(claimed.value.lease, 'the agent claims straight after handback');
    for (const text of mcp.messages.concat([offered.reply, waited.reply, claimed.reply]).map((m) => JSON.stringify(m))) {
      assert.ok(!text.includes(grant.payload.token), 'no tool result carries the viewer token');
    }

    // Declining in the MCP client retires the link.
    const declining = mcp.tool('ninja_ssapp_request_human', { reason: 'Approve the YouTube sign-in prompt.' });
    const ask2 = await mcp.take((m) => m.method === 'elicitation/create', 'second elicitation');
    mcp.send({ jsonrpc: '2.0', id: ask2.id, result: { action: 'decline' } });
    assert.equal((await declining).value.person, 'declined');
    assert.equal((await fetch(ask2.params.url)).status, 404, 'a declined link stops working');

    // Closing the AI client while its person has control suspends the viewer; automation stays paused.
    const reoffer = mcp.tool('ninja_ssapp_request_human', { reason: 'Finish signing in.' });
    const ask3 = await mcp.take((m) => m.method === 'elicitation/create', 'third elicitation');
    mcp.send({ jsonrpc: '2.0', id: ask3.id, result: { action: 'accept' } });
    await reoffer;
    const browser3 = personBrowser(ask3.params.url);
    await browser3.open();
    assert.equal((await (await browser3.post('/human/start', { confirm: true })).json()).ok, true);
    const suspends = ssapp.state.suspends;
    await mcp.service.close();
    assert.equal(ssapp.state.suspends, suspends + 1);
    assert.equal(controller.human, true);
    assert.equal(ssapp.state.paused, true);

    // Clients without URL elicitation get the viewer opened in the local browser instead.
    const opened = [];
    const plain = await mcpFor('agent1', { capabilities: {} }, { openBrowser: (value) => opened.push(value) });
    const fallback = await plain.tool('ninja_ssapp_request_human', { reason: 'Sign in to Twitch.' });
    assert.equal(fallback.value.delivered, 'browser');
    assert.equal(opened.length, 1);
    assert.ok(!JSON.stringify(fallback.reply).includes(new URL(opened[0]).pathname.split('/')[1]));
    const browser4 = personBrowser(opened[0]);
    await browser4.open();
    const grant4 = await (await browser4.post('/human/start', { confirm: true })).json();
    assert.equal(grant4.ok, true, 'the paused app accepts a new takeover');
    assert.equal((await (await browser4.post('/human/finish', { confirm: true }, { 'x-ssapp-human-token': grant4.payload.token })).json()).ok, true);
    assert.equal((await plain.tool('ninja_ssapp_wait_for_human', { wait_seconds: 5 })).value.person, 'returned_control');
    assert.equal(controller.human, false);

    // Observers are not offered the tools.
    const observer = await mcpFor('watch', { capabilities: { elicitation: { url: {} } } });
    const observerTools = (await observer.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!observerTools.includes('ninja_ssapp_request_human'));
    assert.doesNotMatch(observer.init.result.instructions, /ninja_ssapp_request_human/);
    console.log('mcp-ssapp-human.test.js passed');
  } finally {
    if (viewer) await viewer.close();
    for (const service of mcps) await service.close().catch(() => {});
    rpc.close();
    await controller.close();
    for (const s of sessions) await s.stop();
    ssapp.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
