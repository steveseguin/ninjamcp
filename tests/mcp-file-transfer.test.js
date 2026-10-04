'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function setupPair(sdkFactory, room) {
  const server = new VdoMcpServer({
    sdkFactory,
    logger: () => {},
    onExit: async () => {}
  });

  const a = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_a',
    heartbeat_ms: 1000,
    file_ack_timeout_ms: 60
  });

  const b = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_b',
    target_stream_id: 'agent_a',
    heartbeat_ms: 1000,
    file_ack_timeout_ms: 60
  });

  return { server, a, b };
}

async function basicCorruptionRecoveryTest() {
  let corruptedFirstChunk = false;
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (!data || typeof data !== 'object') return null;
      if (data.__vdo_mcp !== 'vdo_mcp_bridge_v1') return null;
      if (data.kind !== 'file.chunk') return null;
      if (corruptedFirstChunk) return null;
      if (!data.payload || data.payload.seq !== 0) return null;

      corruptedFirstChunk = true;
      const copy = JSON.parse(JSON.stringify(data));
      if (typeof copy.payload.data_base64 === 'string' && copy.payload.data_base64.length > 5) {
        copy.payload.data_base64 = `${copy.payload.data_base64.slice(0, -4)}AAAA`;
      }
      return { data: copy };
    }
  });

  const { server, a, b } = await setupPair(sdkFactory, 'file_corrupt_room');

  try {
    const payload = Buffer.from('abc123'.repeat(4000));
    const result = await server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: 'corrupt_case',
      data_base64: payload.toString('base64'),
      chunk_bytes: 4096,
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(result.ok, true);
    assert.equal(result.transfer.status, 'completed');
    assert.ok(result.transfer.retries_total >= 1, 'expected retry after corrupted chunk');

    const receive = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'corrupt_case',
      encoding: 'base64'
    });

    assert.equal(receive.ok, true);
    assert.equal(receive.data_base64, payload.toString('base64'));
  } finally {
    await server.shutdownAll();
  }
}

async function resumeAfterDroppedAckTest() {
  let dropAcks = true;
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (!data || typeof data !== 'object') return null;
      if (data.__vdo_mcp !== 'vdo_mcp_bridge_v1') return null;
      if (!dropAcks) return null;
      if (data.kind === 'file.ack' && data.payload && data.payload.seq >= 1) {
        return { drop: true };
      }
      if (data.kind === 'file.resume_state') {
        return { drop: true };
      }
      return null;
    }
  });

  const { server, a, b } = await setupPair(sdkFactory, 'file_resume_room');

  try {
    const payload = Buffer.from('resume-payload-'.repeat(3000));
    let firstError = null;

    try {
      await server.callTool('vdo_file_send', {
        session_id: a.session_id,
        transfer_id: 'resume_case',
        data_base64: payload.toString('base64'),
        chunk_bytes: 4096,
        ack_timeout_ms: 50,
        max_retries: 1
      });
    } catch (error) {
      firstError = error;
    }

    assert.ok(firstError, 'initial transfer should fail while ack dropping is active');

    dropAcks = false;

    const resumed = await server.callTool('vdo_file_resume', {
      session_id: a.session_id,
      transfer_id: 'resume_case',
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.transfer.status, 'completed');

    const read = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'resume_case',
      encoding: 'utf8'
    });

    assert.equal(read.ok, true);
    assert.equal(read.data_text, payload.toString('utf8'));
  } finally {
    await server.shutdownAll();
  }
}

async function lostAckKeepsChunkDataTest(droppedSeq) {
  let dropped = false;
  const sentChunks = [];
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (data && data.kind === 'file.chunk') sentChunks.push(data.payload.seq);
      if (!dropped && data && data.kind === 'file.ack' && data.payload.seq === droppedSeq) {
        dropped = true;
        return { drop: true };
      }
      return null;
    }
  });
  const { server, a, b } = await setupPair(sdkFactory, `lost_ack_${droppedSeq}`);
  try {
    const payload = Buffer.concat([Buffer.alloc(1024, 'a'), Buffer.alloc(1024, 'b')]);
    const result = await server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: 'lost_ack',
      data_base64: payload.toString('base64'),
      chunk_bytes: 1024,
      ack_timeout_ms: 20,
      max_retries: 2
    });
    assert.equal(dropped, true);
    assert.equal(result.transfer.status, 'completed');
    assert.deepEqual(sentChunks, [0, 1], 'resume must not reuse old chunk data or send past the end');
    const receive = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'lost_ack',
      encoding: 'base64'
    });
    assert.equal(receive.data_base64, payload.toString('base64'));
  } finally {
    await server.shutdownAll();
  }
}

async function completionRequiresReceiverValidationTest(mode) {
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (!data || typeof data !== 'object') return null;
      if (mode === 'failed-hash' && data.kind === 'file.offer') {
        const copy = JSON.parse(JSON.stringify(data));
        copy.payload.file_hash = 'incorrect-file-hash';
        // Exercise file validation in the supported optional-MAC mode.
        delete copy.mac;
        return { data: copy };
      }
      if (mode === 'missing-complete' && data.kind === 'file.complete') return { drop: true };
      if (mode === 'lost-complete-ack' && data.kind === 'file.complete_ack') return { drop: true };
      return null;
    }
  });
  const { server, a, b } = await setupPair(sdkFactory, `completion_${mode}`);
  try {
    const send = server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: mode,
      data_base64: Buffer.from('completion must be verified').toString('base64'),
      ack_timeout_ms: 20,
      max_retries: 2
    });
    if (mode === 'lost-complete-ack') {
      const result = await send;
      assert.equal(result.transfer.status, 'completed');
      const receive = await server.callTool('vdo_file_receive', {
        session_id: b.session_id, transfer_id: mode, encoding: 'utf8'
      });
      assert.equal(receive.data_text, 'completion must be verified');
    } else {
      await assert.rejects(send, /timed out waiting for file.complete_ack/);
      const outgoing = await server.callTool('vdo_file_transfers', { session_id: a.session_id });
      assert.equal(outgoing.outgoing[0].status, 'failed');
    }
  } finally {
    await server.shutdownAll();
  }
}

async function run() {
  await basicCorruptionRecoveryTest();
  await resumeAfterDroppedAckTest();
  await lostAckKeepsChunkDataTest(0);
  await lostAckKeepsChunkDataTest(1);
  await completionRequiresReceiverValidationTest('failed-hash');
  await completionRequiresReceiverValidationTest('missing-complete');
  await completionRequiresReceiverValidationTest('lost-complete-ack');
  console.log('mcp-file-transfer.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
