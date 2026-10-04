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

  console.log('mcp-http-smoke.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

