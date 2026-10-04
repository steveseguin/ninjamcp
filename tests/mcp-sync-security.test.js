'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');
const { createJoinToken } = require('../scripts/lib/bridge-utils');

function makeToken(secret, room, streamID) {
  return createJoinToken({
    room,
    stream_id: streamID,
    exp: Date.now() + 60_000,
    nonce: `${streamID}_${Date.now()}`
  }, secret);
}

async function inboundPolicyTest({ allowlist, enforceToken, token }) {
  const room = 'incoming_policy_room';
  const secret = 'offline-test-secret';
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(), logger: () => {}, onExit: async () => {}
  });
  try {
    const receiver = await server.callTool('vdo_connect', {
      room, stream_id: 'receiver',
      allow_peer_stream_ids: allowlist ? ['allowed'] : [],
      enforce_join_token: enforceToken,
      join_token_secret: enforceToken ? secret : undefined
    });
    const sender = await server.callTool('vdo_connect', {
      room, stream_id: 'blocked', target_stream_id: 'receiver',
      ...(token ? { join_token: token } : {})
    });
    const receiverSession = server.sessions.get(receiver.session_id);
    const senderSession = server.sessions.get(sender.session_id);
    receiverSession.setLocalState('private-state', 'receiver-only', { broadcast: false });
    receiverSession.eventQueue.length = 0;

    senderSession.send({ text: 'blocked raw payload' });
    senderSession.send(Buffer.from('blocked binary payload'));
    senderSession.setLocalState('injected', 'blocked state');
    senderSession.sendProtocol('file.offer', {
      transfer_id: 'blocked-file', total_bytes: 4, total_chunks: 1, chunk_bytes: 1024
    }, receiverSession.sdk.uuid);
    senderSession.requestStateSnapshot(receiverSession.sdk.uuid);

    assert.equal(receiverSession.getStateValue('injected'), null, 'rejected peers cannot change shared state');
    assert.equal(receiverSession.incomingTransfers.size, 0, 'rejected peers cannot allocate file transfers');
    assert.equal(receiverSession.eventQueue.some((event) => event.type === 'data_received'), false,
      'rejected peers cannot place ordinary or binary messages in the MCP inbox');
    assert.equal(senderSession.getStateValue('private-state'), null, 'rejected peers cannot request a state snapshot');
    assert.ok(receiverSession.eventQueue.some((event) => event.type === 'protocol_auth_failed'));

    if (enforceToken) {
      // A fresh peer starts with auth_ok=true for legacy/open-room behavior;
      // that must not count as a successful join-token handshake.
      receiverSession.sdk.emit('dataReceived', {
        uuid: 'no-handshake', streamID: 'allowed',
        data: { __vdo_mcp: 'vdo_mcp_bridge_v1', kind: 'state.patch',
          payload: { key: 'before-handshake', value: true, actor: 'allowed', clock: 1 } }
      });
      assert.equal(receiverSession.getStateValue('before-handshake'), null);
    }
  } finally {
    await server.shutdownAll();
  }
}

async function authorizedPayloadTest() {
  const secret = 'offline-authorized-secret';
  const room = 'authorized_payload_room';
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(), logger: () => {}, onExit: async () => {}
  });
  try {
    const a = await server.callTool('vdo_connect', {
      room, stream_id: 'receiver', join_token_secret: secret,
      enforce_join_token: true, allow_peer_stream_ids: ['allowed']
    });
    const b = await server.callTool('vdo_connect', {
      room, stream_id: 'allowed', target_stream_id: 'receiver',
      join_token: makeToken(secret, room, 'allowed')
    });
    const receiver = server.sessions.get(a.session_id);
    const sender = server.sessions.get(b.session_id);
    sender.send({ text: 'authorized payload' });
    sender.setLocalState('authorized', true);
    await sender.sendFile({ dataBuffer: Buffer.from('authorized file'), transferId: 'allowed-file' });
    assert.equal(receiver.getStateValue('authorized'), true);
    assert.ok(receiver.eventQueue.some((event) => event.data && event.data.text === 'authorized payload'));
    assert.equal(receiver.readIncomingTransfer('allowed-file', 'utf8').data_text, 'authorized file');
  } finally {
    await server.shutdownAll();
  }
}

async function revokedPeerPayloadTest(reason) {
  const room = `revoked_${reason.replace(/-/g, '_')}`;
  const secret = 'offline-revocation-secret';
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(), logger: () => {}, onExit: async () => {}
  });
  try {
    const a = await server.callTool('vdo_connect', {
      room, stream_id: 'receiver', join_token_secret: secret,
      enforce_join_token: true, allow_peer_stream_ids: ['allowed']
    });
    const b = await server.callTool('vdo_connect', {
      room, stream_id: 'allowed', target_stream_id: 'receiver',
      join_token: makeToken(secret, room, 'allowed')
    });
    const receiver = server.sessions.get(a.session_id);
    const sender = server.sessions.get(b.session_id);
    const uuid = sender.sdk.uuid;
    const oldDataCallback = [...receiver.sdk.listeners.get('dataReceived')][0];
    const oldDisconnectCallback = [...receiver.sdk.listeners.get('peerDisconnected')][0];
    assert.equal(receiver.peerState.get(uuid).auth_ok, true);
    const incoming = receiver.createIncomingTransfer(uuid, 'allowed', {
      transfer_id: 'incoming', total_bytes: 4, total_chunks: 1, chunk_bytes: 1024
    });
    const outgoing = receiver.buildOutgoingTransfer({
      transferId: 'outgoing', dataBuffer: Buffer.from('test'), targetUuid: uuid
    });
    const cursor = receiver.protocolCursor;
    const pendingAck = receiver.waitForProtocolEvent((event) => event.kind === 'file.ack', 20, cursor);

    if (reason === 'rejected') {
      sender.sendProtocol('sync.reject', { reason: 'revoked' }, receiver.sdk.uuid);
    } else if (reason === 'peer-disconnected') {
      receiver.sdk.emit('peerDisconnected', { uuid });
    } else if (reason === 'sdk-disconnected') {
      receiver.sdk.emit('disconnected', {});
    } else {
      await receiver.connectSession();
    }
    assert.equal(receiver.peerState.get(uuid).auth_ok, false);
    if (reason !== 'rejected') assert.equal(receiver.sharedKeys.has(uuid), false);
    receiver.eventQueue.length = 0;
    const protocolCursor = receiver.protocolCursor;
    const deliver = (data) => oldDataCallback({ detail: { uuid, streamID: 'allowed', data } });
    deliver({ text: 'late message' });
    deliver(Buffer.from('late binary'));
    deliver(new Uint8Array([1, 2]).buffer);
    const messages = [
      ['state.patch', { key: 'late', value: true, actor: 'allowed', clock: 1 }],
      ['state.snapshot', { entries: [{ key: 'late', value: true, actor: 'allowed', clock: 1 }] }],
      ['state.snapshot_req', {}],
      ['file.offer', { transfer_id: 'late-file', total_bytes: 4, total_chunks: 1, chunk_bytes: 1024 }],
      ['file.chunk', { transfer_id: 'incoming', seq: 0, data_base64: Buffer.from('late').toString('base64') }],
      ['file.complete', { transfer_id: 'incoming' }],
      ['file.cancel', { transfer_id: 'incoming' }],
      ['file.resume_req', { transfer_id: 'incoming' }],
      ...['file.accept', 'file.ack', 'file.nack', 'file.complete_ack', 'file.resume_state'].map((kind) => [
        kind, { transfer_id: 'outgoing', seq: 0, next_seq: 1, expected_seq: 1, status: 'completed' }
      ])
    ];
    for (const [kind, payload] of messages) {
      deliver({ __vdo_mcp: 'vdo_mcp_bridge_v1', kind, payload });
    }
    assert.equal(await pendingAck, null, 'late acknowledgements cannot resolve pending transfers');
    assert.equal(receiver.protocolCursor, protocolCursor, 'late protocol data cannot reach file/state handlers');
    assert.equal(receiver.getStateValue('late'), null);
    assert.equal(receiver.incomingTransfers.size, 1);
    assert.equal(incoming.status, 'receiving');
    assert.equal(incoming.received_chunks.size, 0);
    assert.equal(incoming.complete_received, false);
    assert.equal(outgoing.status, 'offered');
    assert.equal(outgoing.acked_chunks.size, 0);
    assert.equal(receiver.eventQueue.some((event) => event.type === 'data_received'), false);

    if (reason === 'sdk-replaced') {
      // The replacement must start unauthenticated, even for an old peer UUID.
      receiver.sdk.emit('dataReceived', { uuid, streamID: 'allowed', data: { text: 'no inherited auth' } });
      assert.equal(receiver.eventQueue.some((event) => event.type === 'data_received'), false);
      // Authenticate on the replacement SDK, then invoke a queued callback
      // from its predecessor. The old disconnect must not revoke the new key.
      receiver.sdk.emit('dataReceived', {
        uuid, streamID: 'allowed',
        data: sender.buildProtocolEnvelope('sync.hello', {}, receiver.sdk.uuid)
      });
      assert.equal(receiver.peerState.get(uuid).auth_ok, true);
      oldDisconnectCallback({ detail: { uuid } });
      assert.equal(receiver.peerState.get(uuid).auth_ok, true);
      assert.equal(receiver.sharedKeys.has(uuid), true);
    }
  } finally {
    await server.shutdownAll();
  }
}

async function run() {
  const secret = 'sync_secret_123';
  const room = 'sync_secure_room';

  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    defaultJoinTokenSecret: secret,
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const badTokenAttempt = async () => {
      await server.callTool('vdo_connect', {
        room,
        stream_id: 'broken_peer',
        join_token: 'broken.token',
        join_token_secret: secret
      });
    };
    await assert.rejects(badTokenAttempt, /invalid join_token/i);

    const a = await server.callTool('vdo_connect', {
      room,
      stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'secure_a'),
      enforce_join_token: true,
      allow_peer_stream_ids: ['secure_b']
    });

    const b = await server.callTool('vdo_connect', {
      room,
      stream_id: 'secure_b',
      target_stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'secure_b'),
      enforce_join_token: true
    });

    await server.callTool('vdo_sync_announce', { session_id: a.session_id });
    await server.callTool('vdo_sync_announce', { session_id: b.session_id });

    const syncA = await server.callTool('vdo_sync_peers', {
      session_id: a.session_id
    });

    assert.ok(syncA.peers.some((peer) => peer.stream_id === 'secure_b' && peer.auth_ok === true));

    const c = await server.callTool('vdo_connect', {
      room,
      stream_id: 'intruder',
      target_stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'intruder'),
      enforce_join_token: true
    });

    await server.callTool('vdo_sync_announce', { session_id: c.session_id });

    const syncAfter = await server.callTool('vdo_sync_peers', {
      session_id: a.session_id
    });

    const intruder = syncAfter.peers.find((peer) => peer.stream_id === 'intruder');
    assert.ok(intruder, 'intruder should be tracked');
    assert.equal(intruder.handshake_state, 'rejected');
    assert.equal(intruder.rejected_reason, 'peer not on allowlist');

    await inboundPolicyTest({ allowlist: true, enforceToken: false });
    await inboundPolicyTest({ allowlist: false, enforceToken: true });
    await inboundPolicyTest({ allowlist: false, enforceToken: true, token: 'invalid.token' });
    await authorizedPayloadTest();
    for (const reason of ['rejected', 'peer-disconnected', 'sdk-disconnected', 'sdk-replaced']) {
      await revokedPeerPayloadTest(reason);
    }
    console.log('mcp-sync-security.test.js passed');
  } finally {
    await server.shutdownAll();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
