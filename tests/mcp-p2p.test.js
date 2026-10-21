'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PassThrough } = require('node:stream');
const { P2pMcpServer, parseP2pArgs, buildP2pTools } = require('../scripts/vdo-mcp-p2p');
const { runMcpStdioLoop, buildTools } = require('../scripts/vdo-mcp-server');
const { McpStdioParser, writeMcpMessage } = require('../scripts/lib/mcp-stdio-parser');

async function run() {
  const root = process.env.NINJA_P2P_TEST_ROOT || path.dirname(require.resolve('@vdoninja/ninja-p2p/package.json'));
  const api = await import(pathToFileURL(path.join(root, 'dist/agent-state.js')));
  const { createEnvelope } = await import(pathToFileURL(path.join(root, 'dist/protocol.js')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-p2p-'));
  try {
    const session = { room: 'fixture', streamId: 'mcp', name: 'MCP', role: 'agent', stateDir: dir,
      pid: process.pid, connected: true, skills: [], topics: [], agentProfile: null,
      sharedFolders: [], startedAt: Date.now(), updatedAt: Date.now() };
    api.writeAgentSession(dir, session);
    api.writePeersSnapshot(dir, [{ streamId: 'reviewer', name: 'Reviewer', connected: true }]);
    const config = { stateDir: dir, loadStateApi: async () => api, logger: () => {} };
    const server = new P2pMcpServer(config);
    assert.equal((await server.callTool('p2p_status', {})).streamId, 'mcp');
    assert.equal((await server.callTool('p2p_peers', {})).peers[0].streamId, 'reviewer');
    const sender = { streamId: 'reviewer', instanceId: 'instance', name: 'Reviewer', role: 'agent' };
    const first = createEnvelope(sender, 'chat', { text: 'same text' });
    const second = createEnvelope(sender, 'chat', { text: 'same text' });
    second.ts = first.ts + 1;
    api.storeInboxMessage(dir, first); api.storeInboxMessage(dir, second);
    assert.deepEqual((await server.callTool('p2p_read', {})).messages.map(x => x.envelope.id), [first.id, second.id]);
    assert.equal(api.listInboxMessages(dir).length, 2, 'peek retains pending mail');
    const taken = await server.callTool('p2p_take', { limit: 1 });
    assert.equal(taken.messages[0].envelope.id, first.id);
    assert.equal(api.takeInboxMessages(dir, 1)[0].envelope.id, second.id, 'CLI and MCP share the same inbox');
    assert.equal((await server.callTool('p2p_read', {})).messages.length, 0);
    const sent = await server.callTool('p2p_handoff', { peer: 'reviewer', request: 'Review only' });
    assert.equal(sent.status, 'queued');
    const queued = api.listQueuedAgentActions(dir)[0].action;
    assert.equal(queued.id, sent.request_id); assert.equal(queued.kind, 'handoff');
    assert.equal((await server.callTool('p2p_receipt', { peer: 'reviewer', request_id: sent.request_id })).status, 'queued');
    const response = createEnvelope(sender, 'command_response', { requestId: sent.request_id, ok: true, result: { reviewed: true } }, { to: 'mcp' });
    api.storeInboxMessage(dir, response);
    const receipt = await server.callTool('p2p_receipt', { peer: 'reviewer', request_id: sent.request_id });
    assert.equal(receipt.status, 'responded'); assert.equal(receipt.receipts[0].id, response.id);
    assert.equal(api.listInboxMessages(dir).length, 1, 'receipt never consumes the response');
    await server.callTool('p2p_respond', { peer: 'reviewer', request_id: first.id, result: { accepted: false } });
    assert.equal(api.listQueuedAgentActions(dir)[1].action.requestId, first.id);
    const resumed = new P2pMcpServer(config);
    assert.equal((await resumed.callTool('p2p_status', {})).outbox[0].id, sent.request_id);
    const readOnly = new P2pMcpServer({ ...config, readOnly: true });
    for (const name of ['p2p_take', 'p2p_handoff', 'p2p_respond']) await assert.rejects(readOnly.callTool(name, {}), /disabled/);
    for (const [name, args] of [['vdo_connect', { room: 'other' }], ['p2p_status', { state_dir: '..' }], ['p2p_read', { limit: 0 }], ['p2p_read', { limit: 51 }], ['p2p_handoff', { peer: 'reviewer', request: '' }], ['p2p_respond', { peer: 'reviewer', request_id: first.id }]]) await assert.rejects(server.callTool(name, args));
    assert.equal(api.listQueuedAgentActions(dir).length, 2, 'invalid and disabled calls have no effects');
    api.writeAgentSession(dir, { ...session, room: 'different' });
    await assert.rejects(server.callTool('p2p_status', {}), /identity.*changed/);
    api.writeAgentSession(dir, session);
    assert.throws(() => parseP2pArgs(['--id', '../escape']));
    assert.throws(() => parseP2pArgs(['--id', 'a', '--state-dir', dir]));
    assert.throws(() => parseP2pArgs(['--state-dir', dir, '--state-dir', dir]));
    assert.equal(parseP2pArgs(['--id', 'a'], { HOME: dir }).stateDir, path.join(dir, '.ninja-p2p', 'a'));
    assert(!buildTools().some(t => t.name.startsWith('p2p_')), 'default tool list stays unchanged');
    assert.equal(buildP2pTools(true).length, 4);
    for (const mode of ['line', 'framed']) {
      const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
      const received = [], parser = new McpStdioParser();
      parser.on('message', item => received.push(item)); output.on('data', data => parser.push(data));
      runMcpStdioLoop({ input, output, errorOutput: errors, exitOnClose: false,
        serverFactory: options => new P2pMcpServer({ ...options, ...config }) });
      writeMcpMessage(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, mode);
      writeMcpMessage(input, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, mode);
      writeMcpMessage(input, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'p2p_status', arguments: {} } }, mode);
      for (let i = 0; i < 100 && received.length < 3; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(received.length, 3); assert(received.every(item => item.mode === mode));
      assert.equal(received[0].message.result.serverInfo.name, 'ninja-p2p-mcp');
      assert.equal(received[1].message.result.tools.length, 7);
      assert.equal(received[2].message.result.isError, false);
      input.end();
    }
    console.log('mcp-p2p.test.js passed: actual sidecar API, shared inbox, receipts, restart, read-only, identity binding and both stdio formats');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
