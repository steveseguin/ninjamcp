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
  console.log('mcp-http-smoke.test.js passed');
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
