'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { startStreamableHttpServer } = require('../scripts/vdo-mcp-streamable-http');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function postJson(url, payload, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    body = { parse_error: error.message, raw: text };
  }
  return { status: res.status, body };
}

function requestWithHost(url, host, token) {
  return new Promise((resolve, reject) => {
    const headers = { host, 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }));
  });
}

async function run() {
  const token = 'test_token_123';
  const logger = () => {};
  let svc;
  try {
    svc = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      endpointPath: '/mcp',
      bearerToken: token,
      sdkFactory: createFakeSDKFactory(),
      logger
    });
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      console.log(`mcp-http-smoke.test.js skipped (${error.code}: listen not permitted in this environment)`);
      return;
    }
    throw error;
  }

  try {
    assert.ok(/:\d+\/mcp$/.test(svc.endpointUrl), 'endpoint should include resolved port');

    for (const authToken of [undefined, token]) {
      for (const malformedHost of ['[', 'localhost:invalid']) {
        const malformed = await requestWithHost(svc.endpointUrl, malformedHost, authToken);
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.error, 'invalid_url');

        // A malformed request must not stop the server or bypass normal auth.
        const valid = await requestWithHost(svc.endpointUrl, 'localhost', authToken);
        assert.equal(valid.status, authToken ? 200 : 401);
        if (authToken) assert.deepEqual(valid.body.result, {});
      }
    }

    const unauthorized = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    });
    assert.equal(unauthorized.status, 401);

    const init = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    }, token);
    assert.equal(init.status, 200);
    assert.ok(init.body.result);

    const tools = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {}
    }, token);
    assert.equal(tools.status, 200);
    assert.ok(Array.isArray(tools.body.result.tools));
    assert.ok(tools.body.result.tools.some((tool) => tool.name === 'vdo_capabilities'));

    const connectA = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'vdo_connect',
        arguments: {
          room: 'http_room',
          stream_id: 'http_agent_a'
        }
      }
    }, token);
    assert.equal(connectA.status, 200);
    const sessionA = connectA.body.result.structuredContent.session_id;
    assert.ok(sessionA);

    const connectB = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'vdo_connect',
        arguments: {
          room: 'http_room',
          stream_id: 'http_agent_b',
          target_stream_id: 'http_agent_a'
        }
      }
    }, token);
    assert.equal(connectB.status, 200);
    const sessionB = connectB.body.result.structuredContent.session_id;
    assert.ok(sessionB);

    const send = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'vdo_send',
        arguments: {
          session_id: sessionA,
          data: { msg: 'hello-http' }
        }
      }
    }, token);
    assert.equal(send.status, 200);
    assert.equal(send.body.result.structuredContent.ok, true);

    const receive = await postJson(svc.endpointUrl, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'vdo_receive',
        arguments: {
          session_id: sessionB,
          wait_ms: 1000,
          max_events: 100
        }
      }
    }, token);
    assert.equal(receive.status, 200);
    const events = receive.body.result.structuredContent.events || [];
    assert.ok(events.some((event) => event.type === 'data_received' && event.data && event.data.msg === 'hello-http'));

    const batch = await postJson(svc.endpointUrl, [
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'vdo_status',
          arguments: { session_id: sessionA }
        }
      },
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'vdo_disconnect',
          arguments: { session_id: sessionA }
        }
      },
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'vdo_disconnect',
          arguments: { session_id: sessionB }
        }
      }
    ], token);
    assert.equal(batch.status, 200);
    assert.ok(Array.isArray(batch.body));
    assert.equal(batch.body.length, 3);
  } finally {
    await svc.close();
  }

  let restrictedSvc;
  try {
    restrictedSvc = await startStreamableHttpServer({
      host: '127.0.0.1',
      port: 0,
      endpointPath: '/mcp',
      bearerToken: token,
      mcpServer: new VdoMcpServer({
        sdkFactory: createFakeSDKFactory(),
        toolProfile: 'core',
        logger
      }),
      logger
    });
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      console.log(`mcp-http-smoke.test.js restricted-profile segment skipped (${error.code}: listen not permitted in this environment)`);
      console.log('mcp-http-smoke.test.js passed');
      return;
    }
    throw error;
  }

  try {
    const toolsRestricted = await postJson(restrictedSvc.endpointUrl, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/list',
      params: {}
    }, token);
    assert.equal(toolsRestricted.status, 200);
    const restrictedNames = toolsRestricted.body.result.tools.map((tool) => tool.name);
    assert.ok(restrictedNames.includes('vdo_connect'));
    assert.ok(restrictedNames.includes('vdo_capabilities'));
    assert.equal(restrictedNames.includes('vdo_file_send'), false);
    assert.equal(toolsRestricted.body.result._meta.tool_profile, 'core');

    const blocked = await postJson(restrictedSvc.endpointUrl, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'vdo_state_get',
        arguments: {}
      }
    }, token);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.result.isError, true);
    assert.equal(blocked.body.result.structuredContent.error.type, 'validation_error');
    assert.match(blocked.body.result.structuredContent.error.message, /disabled by tool profile 'core'/);
  } finally {
    await restrictedSvc.close();
  }

  await testCloseDrainsDispatch(false);
  await testCloseDrainsDispatch(true);
  await testRelayTransport();
  console.log('mcp-http-smoke.test.js passed');
}

async function testRelayTransport() {
  const crypto = require('node:crypto');
  const Module = require('node:module');
  const { startRelayServer } = require('../scripts/vdo-mcp-relay');
  const { HttpRelayTransport, validateRelayConfig } = require('../scripts/lib/http-relay-transport');
  const originalLoad = Module._load;
  let sdkLoads = 0;
  Module._load = function(request, ...rest) {
    if (/vdoninja.*sdk|wrtc|node-datachannel/.test(request)) {
      sdkLoads += 1;
      throw new Error('WebRTC deliberately unavailable');
    }
    return originalLoad.call(this, request, ...rest);
  };
  const token = crypto.randomBytes(32).toString('hex');
  const key = crypto.randomBytes(32).toString('hex');
  const relay = await startRelayServer({ token, port: 0 });
  const server = new VdoMcpServer({ logger: () => {} });
  const url = `http://127.0.0.1:${relay.port}`;
  const config = { relayUrl: url, relayToken: token, relayKey: key, room: 'http_test' };
  const connect = {
    room: config.room, transport: 'http', relay_url: url, relay_token: token, relay_key: key,
    join_token_secret: crypto.randomBytes(32).toString('hex'), enforce_join_token: true, require_session_mac: true
  };
  const until = async (predicate, label, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(label);
  };
  let rejected;
  try {
    for (const invalid of [
      { relayUrl: 'http://example.com' }, { relayUrl: `${url}/secret` },
      { relayUrl: 'https://user:pass@example.com' }, { relayKey: 'weak' }, { relayToken: 'short' }
    ]) assert.throws(() => validateRelayConfig({ ...config, ...invalid }));
    assert.throws(() => server.parseConnectConfig({ ...connect, password: false }), /WebRTC-only/);
    assert.throws(() => server.parseConnectConfig({ room: 'r', relay_url: url }), /require transport/);

    rejected = new HttpRelayTransport({ ...config, relayToken: 'x'.repeat(64) });
    await assert.rejects(rejected.connect(), /401/);
    const a = await server.callTool('vdo_connect', { ...connect, stream_id: 'alpha', allow_peer_stream_ids: ['beta'] });
    const b = await server.callTool('vdo_connect', { ...connect, stream_id: 'beta', target_stream_id: 'alpha' });
    assert.equal(a.connected, true);
    assert.equal(a.transport, 'http');
    assert.equal(a.host, url);
    assert.equal(JSON.stringify(a).includes(token), false, 'access token must not appear in tool output');
    assert.equal(JSON.stringify(a).includes(key), false, 'encryption key must not appear in tool output');
    const sa = server.sessions.get(a.session_id);
    const sb = server.sessions.get(b.session_id);
    const eventsA = [], eventsB = [];
    sa.on('event', (event) => eventsA.push(event));
    sb.on('event', (event) => eventsB.push(event));
    await until(() => sa.sharedKeys.has(sb.sdk.uuid) && sb.sharedKeys.has(sa.sdk.uuid), 'HTTP peers must complete authenticated handshake');

    const c = await server.callTool('vdo_connect', { ...connect, stream_id: 'gamma' });
    const sc = server.sessions.get(c.session_id);
    const eventsC = [];
    sc.on('event', (event) => eventsC.push(event));
    await until(() => sc.connectedPeers.has(sa.sdk.uuid), 'third peer must discover the room');
    await server.callTool('vdo_send', { session_id: c.session_id, target: sa.sdk.uuid, data: { blocked: true } });
    await until(() => eventsA.some((event) => event.type === 'protocol_auth_failed' && event.stream_id === 'gamma'), 'allowlist must reject relay messages');
    assert.equal(eventsA.some((event) => event.data && event.data.blocked), false);

    const sent = await server.callTool('vdo_send', { session_id: a.session_id, target: 'beta', data: { text: 'same text', id: 1 } });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivery_stage, 'queued');
    const sent2 = await server.callTool('vdo_send', { session_id: a.session_id, target: 'beta', data: { text: 'same text', id: 2 } });
    assert.notEqual(sent.message_id, sent2.message_id);
    await until(() => eventsB.filter((event) => event.data && event.data.text === 'same text').length === 2, 'both distinct messages must arrive');
    await until(() => eventsA.some((event) => event.type === 'relay_receipt' && event.message_id === sent.message_id && event.stage === 'relay_accepted'), 'relay acceptance receipt must correlate to send');
    assert.deepEqual(eventsB.filter((event) => event.data && event.data.text === 'same text').map((event) => event.data.id), [1, 2]);
    assert.equal(eventsC.some((event) => event.data && event.data.text === 'same text'), false, 'targeted messages must not be delivered to other room members');

    // Commit the first POST but lose its response. Retrying the same encrypted
    // event must not duplicate delivery, and must not conflate identical text.
    const request = sa.sdk.request.bind(sa.sdk);
    let loseResponse = true;
    sa.sdk.request = async (method, search, body) => {
      const result = await request(method, search, body);
      if (method === 'POST' && loseResponse) { loseResponse = false; throw new Error('lost POST response'); }
      return result;
    };
    await server.callTool('vdo_send', { session_id: a.session_id, target: 'beta', data: { retry: 'one delivery' } });
    await until(() => eventsB.some((event) => event.data && event.data.retry), 'retry must arrive');
    await until(() => !sa.sdk.pending.length, 'send queue must drain after retry');
    assert.equal(eventsB.filter((event) => event.data && event.data.retry).length, 1);
    sa.sdk.request = request;

    await server.callTool('vdo_state_set', { session_id: a.session_id, key: 'task', value: 'review', target: sb.sdk.uuid });
    await until(() => sb.getStateValue('task') === 'review', 'shared state must cross HTTP');
    const payload = crypto.randomBytes(270000);
    const file = await server.callTool('vdo_file_send', {
      session_id: a.session_id, target: 'beta', transfer_id: 'relay-file', data_base64: payload.toString('base64'),
      chunk_bytes: 256 * 1024, ack_timeout_ms: 1000
    });
    assert.equal(file.transfer.status, 'completed');
    const received = await server.callTool('vdo_file_receive', { session_id: b.session_id, transfer_id: 'relay-file', encoding: 'base64' });
    assert.equal(received.data_base64, payload.toString('base64'));

    const box = sa.sdk.seal('data', { secret: 'never plaintext on relay' }, sb.sdk.uuid);
    assert.equal(JSON.stringify(box).includes('never plaintext'), false);
    const tampered = { ...box, id: crypto.randomUUID() };
    assert.throws(() => sb.sdk.open(tampered), 'message ID must be authenticated');
    const wrongRoom = new HttpRelayTransport({ ...config, room: 'different_room' });
    try { assert.throws(() => wrongRoom.open(box), 'ciphertext must be bound to its room'); } finally { wrongRoom.disconnect(); }
    const bytes = Buffer.from(box.box, 'base64');
    bytes[bytes.length - 1] ^= 1;
    await request('POST', '', { ...box, box: bytes.toString('base64') });
    await until(() => eventsB.some((event) => event.type === 'relay_message_rejected'), 'tampered ciphertext must be rejected');
    assert.equal(eventsB.some((event) => event.data && event.data.secret), false);

    // Replay continues after a transient read failure without new identities.
    const uuid = sb.sdk.uuid;
    for (const req of sb.sdk.requests) if (req.method === 'GET') req.destroy(new Error('temporary network loss'));
    await until(() => !sb.sdk.connected, 'reader must report loss');
    await server.callTool('vdo_send', { session_id: a.session_id, target: 'beta', data: { reconnect: true } });
    await until(() => eventsB.some((event) => event.data && event.data.reconnect), 'reader must resume retained events');
    assert.equal(sb.sdk.uuid, uuid);
    assert.equal(eventsB.filter((event) => event.data && event.data.reconnect).length, 1);

    // An invalid/expired cursor is surfaced, rather than claiming complete delivery.
    sb.sdk.cursor = `${crypto.randomUUID()}:0`;
    for (const req of sb.sdk.requests) if (req.method === 'GET') req.destroy(new Error('resume with expired cursor'));
    await until(() => eventsB.some((event) => event.type === 'relay_history_lost'), 'expired replay must be visible');
    await until(() => sb.sdk.connected && sb.sharedKeys.has(sa.sdk.uuid), 'peers must recover after replay gap');
    assert.equal(sdkLoads, 0, 'HTTP mode must never load the WebRTC SDK');
  } finally {
    if (rejected) rejected.disconnect();
    await server.shutdownAll();
    await relay.close();
    Module._load = originalLoad;
  }
}

async function testCloseDrainsDispatch(disconnectClient) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const mcp = new VdoMcpServer({ sdkFactory: createFakeSDKFactory(), logger: () => {} });
  let shutdownCalls = 0;
  const shutdown = mcp.shutdownAll.bind(mcp);
  mcp.shutdownAll = async () => {
    shutdownCalls += 1;
    return shutdown();
  };
  const dispatch = mcp.dispatchMessage.bind(mcp);
  const sessions = [];
  let signalFinished;
  const finished = new Promise((resolve) => { signalFinished = resolve; });
  mcp.dispatchMessage = async (body) => {
    signalStarted();
    await gate;
    try {
      await dispatch(body);
      sessions.push(...mcp.sessions.values());
    } finally {
      signalFinished();
    }
  };
  const svc = await startStreamableHttpServer({ host: '127.0.0.1', port: 0, mcpServer: mcp, logger: () => {} });
  const request = http.request(svc.endpointUrl, { method: 'POST', agent: false });
  const response = new Promise((resolve, reject) => {
    request.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text)));
      res.on('error', reject);
    });
    request.on('error', (error) => disconnectClient ? resolve(null) : reject(error));
  });
  request.end(JSON.stringify({
    jsonrpc: '2.0', id: 30, method: 'tools/call',
    params: { name: 'vdo_connect', arguments: { room: 'http_close_room', stream_id: 'http_close_peer' } }
  }));
  let closing;
  try {
    await started;
    if (disconnectClient) request.destroy();
    let closed = false;
    const firstClose = svc.close();
    closing = firstClose.then(() => { closed = true; });
    const closingAgain = svc.close();
    assert.equal(closingAgain, firstClose, 'concurrent close calls must share completion');
    // A disconnected socket can finish closing while its dispatch is still queued.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, false, 'close must await accepted dispatch even after client disconnect');
    assert.equal(svc.server.listening, false, 'close must immediately stop new connections');
    release();
    const result = await response;
    if (!disconnectClient) assert.equal(result.result.structuredContent.ok, true);
    await Promise.all([closing, closingAgain, finished]);
    assert.equal(sessions.length, 1, 'accepted connect must complete');
    assert.equal(mcp.sessions.size, 0, 'close must clean up sessions created by accepted dispatch');
    assert.equal(sessions[0].sdk, null, 'close must stop the created SDK');
    await svc.close();
    assert.equal(shutdownCalls, 1, 'repeated close must not repeat cleanup');
  } finally {
    release();
    request.destroy();
    await finished;
    if (closing) await closing;
    await svc.close();
    await mcp.shutdownAll();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

