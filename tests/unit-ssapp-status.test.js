'use strict';

const assert = require('node:assert/strict');
const { SsappClient } = require('../scripts/vdo-mcp-ssapp');

async function run() {
  const discovery = {
    backend: 'ssapp',
    contract: 1,
    instance: { instanceId: 'instance-1', ssappVersion: '0.4.39', apiVersion: '1.5.0' },
    serverInfo: { name: 'social-stream-ninja', version: '1.4.0' },
    instructions: 'x'.repeat(5000),
    role: 'controller',
    lease: null,
    catalog: { tools: Array.from({ length: 50 }, (_, i) => ({ name: `ssapp_tool_${i}`, inputSchema: { type: 'object' } })) }
  };
  const client = Object.create(SsappClient.prototype);
  client.discovery = null;
  client.lease = null;
  client.connect = async () => {};
  client.rpc = { request: async (method) => (method === 'discover' ? discovery : { error: 'unexpected' }) };

  const status = await client.call('ninja_ssapp_status');
  assert.equal(status.catalog, undefined, 'status must not repeat the tool catalog');
  assert.equal(status.instructions, undefined, 'status must not repeat initialize instructions');
  assert.equal(status.tool_count, 50);
  assert.equal(status.role, 'controller');
  assert.equal(status.instance.instanceId, 'instance-1');
  assert.ok(JSON.stringify(status).length < 1000, 'status should stay compact');
  assert.equal(client.discovery.catalog.tools.length, 50, 'the client keeps the full discovery for tools/list');

  console.log('unit-ssapp-status.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
