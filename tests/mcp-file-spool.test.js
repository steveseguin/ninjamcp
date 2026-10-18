'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run() {
  const spoolDir = path.join(os.tmpdir(), `mcp-spool-test-${Date.now()}`);
  const outPath = path.join(spoolDir, 'out.bin');

  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const a = await server.callTool('vdo_connect', {
      room: 'spool_room',
      stream_id: 'spool_a'
    });

    const b = await server.callTool('vdo_connect', {
      room: 'spool_room',
      stream_id: 'spool_b',
      target_stream_id: 'spool_a',
      file_spool_dir: spoolDir,
      file_spool_threshold_bytes: 1024,
      keep_spool_files: true
    });

    const payload = Buffer.from('spool-data-'.repeat(4000), 'utf8');
    const send = await server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: 'spool_case_1',
      data_base64: payload.toString('base64'),
      chunk_bytes: 2048,
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(send.ok, true);
    assert.equal(send.transfer.status, 'completed');

    const transfers = await server.callTool('vdo_file_transfers', {
      session_id: b.session_id,
      direction: 'incoming'
    });

    const incoming = transfers.incoming.find((item) => item.transfer_id === 'spool_case_1');
    assert.ok(incoming, 'incoming transfer should exist');
    assert.equal(incoming.spooled, true, 'incoming transfer should be spooled');
    assert.ok(incoming.spool_path && incoming.spool_path.startsWith(spoolDir));
    assert.equal(fs.existsSync(incoming.spool_path), true);

    const saved = await server.callTool('vdo_file_save', {
      session_id: b.session_id,
      transfer_id: 'spool_case_1',
      output_path: outPath,
      overwrite: true
    });

    assert.equal(saved.ok, true);
    const onDisk = fs.readFileSync(outPath);
    assert.equal(sha256(onDisk), sha256(payload));

    const readBack = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'spool_case_1',
      encoding: 'base64'
    });
    assert.equal(Buffer.from(readBack.data_base64, 'base64').length, payload.length);

  } finally {
    await server.shutdownAll();
    try {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    } catch (error) {
      // ignore cleanup failures
    }
  }
}

async function repeatedCompletionRetentionTest() {
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-retention-'));
  const server = new VdoMcpServer({ sdkFactory: createFakeSDKFactory(), logger: () => {} });
  try {
    const a = await server.callTool('vdo_connect', { room: spoolDir, stream_id: 'a' });
    const b = await server.callTool('vdo_connect', {
      room: spoolDir, stream_id: 'b', target_stream_id: 'a',
      file_spool_dir: spoolDir, file_spool_threshold_bytes: 1024
    });
    const payload = Buffer.alloc(1024, 42);
    const send = async (transferId) => {
      const result = await server.callTool('vdo_file_send', {
        session_id: a.session_id, transfer_id: transferId,
        data_base64: payload.toString('base64'), chunk_bytes: 1024
      });
      assert.equal(result.transfer.status, 'completed');
    };
    const incoming = server.sessions.get(b.session_id);
    const outgoing = server.sessions.get(a.session_id);
    for (let i = 0; i < 13; i += 1) await send('repeated');
    const received = await server.callTool('vdo_file_receive', {
      session_id: b.session_id, transfer_id: 'repeated', encoding: 'base64'
    });
    assert.deepEqual(Buffer.from(received.data_base64, 'base64'), payload);
    assert.deepEqual(incoming.completedIncomingOrder, ['repeated']);
    assert.deepEqual(outgoing.completedOutgoingOrder, ['repeated']);
    assert.equal(outgoing.outgoingTransfers.has('repeated'), true);
    assert.equal(fs.readdirSync(spoolDir).length, 1);

    for (let i = 0; i < 11; i += 1) await send(`distinct-${i}`);
    assert.equal(incoming.incomingTransfers.size, 12);
    await send('repeated'); // Refresh one existing entry at the retention limit.
    assert.equal(incoming.incomingTransfers.size, 12);
    assert.equal(outgoing.outgoingTransfers.size, 12);
    assert.equal(fs.readdirSync(spoolDir).length, 12);
    const oldestPath = incoming.incomingTransfers.get('distinct-0').spool_path;
    await send('distinct-11'); // The thirteenth distinct entry evicts one oldest file.
    assert.equal(incoming.incomingTransfers.has('distinct-0'), false);
    assert.equal(outgoing.outgoingTransfers.has('distinct-0'), false);
    assert.equal(fs.existsSync(oldestPath), false);
    assert.equal(incoming.incomingTransfers.has('repeated'), true);
    assert.equal(incoming.incomingTransfers.has('distinct-11'), true);
    assert.equal(incoming.incomingTransfers.size, 12);
    assert.equal(outgoing.outgoingTransfers.size, 12);
    assert.equal(fs.readdirSync(spoolDir).length, 12);
    await server.shutdownAll();
    assert.equal(fs.readdirSync(spoolDir).length, 0);
  } finally {
    await server.shutdownAll();
    fs.rmSync(spoolDir, { recursive: true, force: true });
  }
}

async function duplicateCompletionRetentionTest() {
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-duplicate-completion-'));
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory({
      transformMessage: ({ data }) => data && data.kind === 'file.complete' ? { duplicate: true } : null
    }),
    logger: () => {}
  });
  try {
    const a = await server.callTool('vdo_connect', { room: spoolDir, stream_id: 'a' });
    const b = await server.callTool('vdo_connect', {
      room: spoolDir, stream_id: 'b', target_stream_id: 'a',
      file_spool_dir: spoolDir, file_spool_threshold_bytes: 1024
    });
    for (let i = 0; i < 7; i += 1) {
      await server.callTool('vdo_file_send', {
        session_id: a.session_id, transfer_id: `duplicate-${i}`,
        data_base64: Buffer.alloc(1024, i).toString('base64'), chunk_bytes: 1024
      });
      // The fake SDK schedules the duplicate separately from the original.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const incoming = server.sessions.get(b.session_id);
    assert.equal(incoming.incomingTransfers.size, 7);
    assert.equal(incoming.completedIncomingOrder.length, 7);
    assert.equal(fs.readdirSync(spoolDir).length, 7);
    const received = await server.callTool('vdo_file_receive', {
      session_id: b.session_id, transfer_id: 'duplicate-0', encoding: 'base64'
    });
    assert.deepEqual(Buffer.from(received.data_base64, 'base64'), Buffer.alloc(1024));
    await server.shutdownAll();
    assert.equal(fs.readdirSync(spoolDir).length, 0);
  } finally {
    await server.shutdownAll();
    fs.rmSync(spoolDir, { recursive: true, force: true });
  }
}

run().then(repeatedCompletionRetentionTest).then(duplicateCompletionRetentionTest).then(() => {
  console.log('mcp-file-spool.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
