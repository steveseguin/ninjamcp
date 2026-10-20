# WebRTC data notes

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/vdo-ninja-p2p-data-notes.html)

Operational constraints of VDO.Ninja's peer-to-peer data channels, drawn from the [VDO.Ninja SDK](https://github.com/steveseguin/ninjasdk) documentation, and how Ninja MCP builds on them. These notes cover the default WebRTC transport. The optional [HTTP relay](http-relay.md) is a separate transport with its own limits.

## Platform constraints

1. Signaling is not an app-data tunnel.
   - Only handshake and signaling data should cross the WebSocket.
   - Application payloads are expected over WebRTC data channels.
2. Room size is bounded.
   - The documented guidance is about 80 peers per room, and viewer limits can apply.
   - For wider fan-out, split rooms or use a server-mediated pattern.
3. The network is serverless for app data.
   - VDO.Ninja doesn't relay or store your application protocol on its servers.
   - Design peer to peer first. Ninja MCP's HTTP relay is a separate service you run yourself.

## Topologies that work

1. Two-peer data link (recommended).
   - Peer A: `announce({ streamID })`
   - Peer B: `view(streamID, { audio: false, video: false })`
   - Result: one bidirectional data channel.
2. Multi-peer data mesh.
   - Use `autoConnect(room)` half-mesh mode to avoid duplicate pair connections.
   - Move to a full mesh only when media exchange needs two directional audio/video links.
3. Targeted delivery.
   - Use `sendData(data, "uuid")` or an advanced target object.
   - Keep `preference: "any"` unless you specifically need publisher-only, viewer-only, or all-channel behavior.

## Delivery semantics

- The SDK's default data channels are reliable and ordered.
- That reliability applies once a channel is established. It doesn't guarantee every network can establish one.
- TURN improves the chance of connecting through restrictive NAT and firewalls, but doesn't guarantee reachability.
- Ninja MCP adds application-level reliability for file transfer:
  - SHA-256 validation of every chunk and of the whole file
  - ACK and NACK feedback with retries
  - resume from `next_seq` after an interruption

## Firewalls and NAT

1. Use TURN when needed.
   - `forceTURN: true` routes connections through relay infrastructure.
   - This helps on restrictive networks but adds latency and relay cost.
2. Treat signaling fallback as a last resort.
   - `allowFallback: true` lets `sendData` fall back to the signaling server when no peer-to-peer channel is open.
   - Use it for small control messages, not sustained throughput.
3. Expect some networks to fail.
   - Some enterprise, WSL, and other network setups block WebRTC's UDP traffic entirely.
   - Build retry and reconnection logic regardless of TURN, or use the HTTP relay.

## Keep-alive and continuity

1. Keep a heartbeat.
   - Send lightweight, periodic application-level heartbeats.
   - Optionally send SDK pings (`sendPing`) to connected peers.
2. Reconnect predictably.
   - On disconnect or error, recreate the SDK instance, reconnect, rejoin the room, re-announce, and re-view targets.
   - Make handlers idempotent so duplicate or delayed messages around a reconnect are harmless.
3. Use canonical IDs.
   - Room and stream IDs should use letters, numbers, and underscores.
   - Use the same sanitized IDs on every peer.

## Data bridge settings

The standalone bridge script [`scripts/vdo-data-bridge.js`](../scripts/vdo-data-bridge.js) reads these environment variables:

- `VDON_ROOM`: required in real deployments
- `VDON_STREAM_ID`: optional; random if omitted
- `VDON_TARGET_STREAM_ID`: optional; views that peer's stream for a two-peer link
- `VDON_HOST`: default `wss://wss.vdo.ninja`
- `VDON_PASSWORD`: `false` disables handshake encryption; omitted uses the SDK default
- `VDON_FORCE_TURN`: `true` or `false`
- `VDON_LABEL`: optional display label
- `VDON_HEARTBEAT_MS`: default `15000`
- `VDON_RECONNECT_MS`: default `3000`
- `VDON_MAX_RECONNECT_MS`: default `30000`
- `VDON_DEBUG`: `true` or `false`

## Application envelopes

Use explicit envelope types and IDs rather than raw strings:

```json
{
  "type": "mcp.request",
  "id": "req_123",
  "method": "tool.call",
  "payload": { "name": "lookup", "args": { "q": "abc" } }
}
```

```json
{
  "type": "mcp.response",
  "id": "req_123",
  "ok": true,
  "payload": { "result": "..." }
}
```

Avoid the SDK's reserved pub/sub types (`subscribe`, `unsubscribe`, `channelMessage`) for custom envelopes.

## Ninja MCP's protocol envelopes

Ninja MCP reserves envelopes that carry:

- `__vdo_mcp: "vdo_mcp_bridge_v1"`
- `kind: "sync.*" | "file.*" | "state.*"`

File transfer handshake:

1. `file.offer`
2. `file.accept`
3. `file.chunk`, answered by `file.ack` or `file.nack`
4. `file.complete`
5. `file.complete_ack`

Resume flow:

1. `file.resume_req`
2. `file.resume_state`, carrying `next_seq`

## Large files

- Ninja MCP can spool large incoming transfers to disk.
- Tune spooling with these `vdo_connect` options:
  - `file_spool_dir`
  - `file_spool_threshold_bytes`
  - `keep_spool_files`
- Use `vdo_file_send_path` to avoid base64 memory overhead for large local files.
- Use `vdo_file_save` to write completed incoming transfers straight to disk.

## Shared room state

- Shared state replicates with `state.patch` and `state.snapshot` messages.
- Conflicts resolve last-writer-wins on a `(clock, actor)` pair:
  - the higher `clock` wins
  - ties go to the lexicographically higher `actor`
- The MCP tools are:
  - `vdo_state_set`
  - `vdo_state_get`
  - `vdo_state_sync`

## SDK references

- [VDO.Ninja SDK README](https://github.com/steveseguin/ninjasdk/blob/main/README.md)
- [AI integration guide](https://github.com/steveseguin/ninjasdk/blob/main/AI-INTEGRATION.md)
- [API reference](https://github.com/steveseguin/ninjasdk/blob/main/docs/api-reference.md)
