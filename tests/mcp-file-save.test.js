'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-file-save-'));
  const payload = Buffer.from('received-file-data-'.repeat(100));
  const sentinel = Buffer.from('existing local data that must survive');
  const failures = [];
  let passed = 0;
  try {
    for (const spooled of [false, true]) {
      const server = new VdoMcpServer({
        sdkFactory: createFakeSDKFactory(),
        logger: () => {},
        onExit: async () => {}
      });
      try {
        const sender = await server.callTool('vdo_connect', {
          room: 'file_save_room', stream_id: 'sender'
        });
        const receiver = await server.callTool('vdo_connect', {
          room: 'file_save_room', stream_id: 'receiver',
          target_stream_id: 'sender',
          file_spool_dir: path.join(directory, 'spool'),
          file_spool_threshold_bytes: spooled ? 1024 : 1024 * 1024
        });
        const transferId = 'file_save_case';
        await server.callTool('vdo_file_send', {
          session_id: sender.session_id, transfer_id: transferId,
          data_base64: payload.toString('base64'),
          chunk_bytes: 1024, ack_timeout_ms: 80, max_retries: 4
        });
        const transfers = await server.callTool('vdo_file_transfers', {
          session_id: receiver.session_id, direction: 'incoming'
        });
        assert.equal(transfers.incoming[0].status, 'completed');
        assert.equal(transfers.incoming[0].spooled, spooled);

        for (const overwrite of [undefined, false, true]) {
          for (const scenario of ['absent', 'existing', 'racing']) {
            const label = `${spooled ? 'spool' : 'memory'} / ${String(overwrite)} / ${scenario}`;
            const outputPath = path.join(directory, String(spooled), String(overwrite), scenario, 'saved.bin');
            const args = {
              session_id: receiver.session_id, transfer_id: transferId,
              output_path: outputPath
            };
            if (overwrite !== undefined) args.overwrite = overwrite;
            if (scenario === 'existing') {
              fs.mkdirSync(path.dirname(outputPath), { recursive: true });
              fs.writeFileSync(outputPath, sentinel);
            }

            const operation = spooled ? 'copyFileSync' : 'writeFileSync';
            const original = fs[operation];
            const write = fs.writeFileSync;
            let injected = false;
            if (scenario === 'racing') {
              // Model another local process creating the destination after
              // the existence check, immediately before the actual save.
              fs[operation] = function(...operationArgs) {
                const destination = operationArgs[spooled ? 1 : 0];
                if (destination === outputPath && !injected) {
                  injected = true;
                  write.call(fs, outputPath, sentinel, { flag: 'wx' });
                }
                return original.apply(this, operationArgs);
              };
            }
            try {
              const shouldReject = scenario !== 'absent' && overwrite !== true;
              if (shouldReject) {
                await assert.rejects(server.callTool('vdo_file_save', args),
                  scenario === 'racing' ? { code: 'EEXIST' } : /output exists:/);
                assert.deepEqual(fs.readFileSync(outputPath), sentinel);
              } else {
                const result = await server.callTool('vdo_file_save', args);
                assert.equal(result.ok, true);
                assert.equal(result.output_path, outputPath);
                assert.equal(result.bytes_written, payload.length);
                assert.deepEqual(fs.readFileSync(outputPath), payload);
              }
              if (scenario === 'racing') assert.equal(injected, true);
              const retained = await server.callTool('vdo_file_receive', {
                session_id: receiver.session_id, transfer_id: transferId, encoding: 'base64'
              });
              assert.deepEqual(Buffer.from(retained.data_base64, 'base64'), payload);
              passed += 1;
            } catch (error) {
              failures.push(`${label}: ${error.message}`);
            } finally {
              fs[operation] = original;
            }
          }
        }
      } finally {
        await server.shutdownAll();
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`mcp-file-save.test.js: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
