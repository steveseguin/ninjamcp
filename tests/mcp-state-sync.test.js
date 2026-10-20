'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function run() {
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const a = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_a'
    });
    const b = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_b',
      target_stream_id: 'agent_a'
    });
    const c = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_c',
      target_stream_id: 'agent_a'
    });

    const s1 = await server.callTool('vdo_state_set', {
      session_id: a.session_id,
      key: 'mission',
      value: 'alpha'
    });
    assert.equal(s1.ok, true);

    const bGet1 = await server.callTool('vdo_state_get', {
      session_id: b.session_id,
      key: 'mission'
    });
    const cGet1 = await server.callTool('vdo_state_get', {
      session_id: c.session_id,
      key: 'mission'
    });
    assert.equal(bGet1.value, 'alpha');
    assert.equal(cGet1.value, 'alpha');

    const bWrite = await server.callTool('vdo_state_set', {
      session_id: b.session_id,
      key: 'mission',
      value: 'bravo'
    });
    assert.equal(bWrite.ok, true);

    await server.callTool('vdo_state_sync', {
      session_id: a.session_id,
      mode: 'send'
    });

    const cGet2 = await server.callTool('vdo_state_get', {
      session_id: c.session_id,
      key: 'mission'
    });
    assert.equal(cGet2.value, 'bravo');

    const aMeta = await server.callTool('vdo_state_get', {
      session_id: a.session_id,
      include_meta: true
    });
    assert.equal(aMeta.ok, true);
    assert.ok(aMeta.value && Array.isArray(aMeta.value.entries));
    assert.ok(aMeta.value.entries.some((entry) => entry.key === 'mission'));

    // A peer's later write must follow clocks it has already observed, even
    // when another actor has performed more writes or sorts after it.
    for (const value of ['second', 'third', 'fourth']) {
      await server.callTool('vdo_state_set', { session_id: c.session_id, key: 'mission', value });
    }
    const observed = await server.callTool('vdo_state_get', {
      session_id: a.session_id, key: 'mission', include_meta: true
    });
    assert.equal(observed.value.value, 'fourth');
    const later = await server.callTool('vdo_state_set', {
      session_id: a.session_id, key: 'mission', value: 'latest'
    });
    assert.ok(later.entry.clock > observed.value.clock);
    for (const peer of [a, b, c]) {
      const result = await server.callTool('vdo_state_get', { session_id: peer.session_id, key: 'mission' });
      assert.equal(result.value, 'latest');
    }
    await server.callTool('vdo_state_sync', { session_id: c.session_id, mode: 'send' });
    assert.equal((await server.callTool('vdo_state_get', {
      session_id: a.session_id, key: 'mission'
    })).value, 'latest');

    // Snapshot entries and actor clocks must both advance the local clock.
    // Limit the snapshot so the highest-clock entry is omitted from entries.
    const snapshotSource = await server.callTool('vdo_connect', {
      room: 'snapshot_clock_room', stream_id: 'z_source', state_max_snapshot_entries: 1
    });
    await server.callTool('vdo_state_set', {
      session_id: snapshotSource.session_id, key: 'a_first', value: 'included', broadcast: false
    });
    for (let i = 0; i < 5; i += 1) {
      await server.callTool('vdo_state_set', {
        session_id: snapshotSource.session_id, key: 'z_last', value: i, broadcast: false
      });
    }
    const snapshotPeer = await server.callTool('vdo_connect', {
      room: 'snapshot_clock_room', stream_id: 'a_peer', target_stream_id: 'z_source'
    });
    await server.callTool('vdo_state_sync', { session_id: snapshotPeer.session_id, mode: 'request' });
    const snapshotRead = await server.callTool('vdo_state_get', {
      session_id: snapshotPeer.session_id, include_meta: true
    });
    assert.equal(snapshotRead.value.entries.length, 1);
    assert.equal(snapshotRead.value.actor_clock.z_source, 6);
    const snapshotWrite = await server.callTool('vdo_state_set', {
      session_id: snapshotPeer.session_id, key: 'z_last', value: 'after snapshot'
    });
    assert.equal(snapshotWrite.entry.clock, 7);
    assert.equal((await server.callTool('vdo_state_get', {
      session_id: snapshotSource.session_id, key: 'z_last'
    })).value, 'after snapshot');

    // Local writes respect state_max_keys, matching what peers will accept.
    const limited = await server.callTool('vdo_connect', {
      room: 'state_limit_room', stream_id: 'limited', state_max_keys: 2
    });
    await server.callTool('vdo_state_set', { session_id: limited.session_id, key: 'k1', value: 1 });
    await server.callTool('vdo_state_set', { session_id: limited.session_id, key: 'k2', value: 2 });
    await assert.rejects(
      server.callTool('vdo_state_set', { session_id: limited.session_id, key: 'k3', value: 3 }),
      /state key limit reached/
    );
    const updated = await server.callTool('vdo_state_set', { session_id: limited.session_id, key: 'k1', value: 'again' });
    assert.equal(updated.ok, true, 'existing keys stay writable at the limit');

    console.log('mcp-state-sync.test.js passed');
  } finally {
    await server.shutdownAll();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
