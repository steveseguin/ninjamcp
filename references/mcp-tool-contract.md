# Tool contract

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/mcp-tool-contract.html)

The tools, arguments, events, and limits of the Ninja MCP server. The server is [`scripts/vdo-mcp-server.js`](../scripts/vdo-mcp-server.js), registration is handled by [`scripts/install-mcp.js`](../scripts/install-mcp.js), and the registry manifest is [`server.json`](../server.json).

## Transport

The server speaks JSON-RPC 2.0 over stdio.

- Input can be:
  - newline-delimited JSON messages
  - `Content-Length` framed messages
- Output is:
  - framed when framed input is detected
  - newline-delimited JSON otherwise

## Runtime limits

- `VDON_MCP_MAX_MESSAGE_BYTES` caps one JSON-RPC message. Default `1048576`.
- `VDON_MCP_TOOL_PROFILE` selects the tool profile: `core`, `file`, `state`, or `full`. Default `full`.

## Server CLI flags

`scripts/vdo-mcp-server.js` accepts these flags. A flag takes precedence over the matching environment variable.

- `--tool-profile <core|file|state|full>`
- `--max-message-bytes <bytes>`
- `--join-token-secret <secret>`
- `--enforce-join-token <true|false>`
- `--allow-peer-stream-ids <a,b,c>`
- `--require-session-mac <true|false>`

## Tool profiles

| Profile | Tools |
| --- | --- |
| `core` | `vdo_connect`, `vdo_send`, `vdo_receive`, `vdo_status`, `vdo_disconnect`, `vdo_list_sessions`, `vdo_capabilities`, `vdo_sync_peers`, `vdo_sync_announce` (9) |
| `file` | `core` plus the six file transfer tools (15) |
| `state` | `core` plus the three shared state tools (12) |
| `full` | All 18 tools |

`tools/list` only advertises tools in the active profile. Calling a tool outside it returns `validation_error`.

## Session tools

- `vdo_connect`: join a room and open a session.
- `vdo_send`: send JSON or text to one peer or everyone connected.
- `vdo_receive`: read queued events, oldest first, up to `max_events` per call (default 50, max 500). `wait_ms` (0 to 30000) waits for the first event when the queue is empty.
- `vdo_status`: live status for one session, including its `transport`.
- `vdo_disconnect`: leave the room, stop reconnecting, and free the session.
- `vdo_list_sessions`: every active session.
- `vdo_capabilities`: server version, the active profile and its tools, enabled features, and transport facts. Call it first.

### `vdo_connect` options

- Room: `room`, `stream_id`, `target_stream_id`, `transport` (`webrtc` by default, or `http`)
- WebRTC only: `host`, `password`, `force_turn`
- HTTP relay only: `relay_url`, `relay_token`, `relay_key`, with defaults from `VDON_MCP_RELAY_URL`, `VDON_MCP_RELAY_TOKEN`, and `VDON_MCP_RELAY_KEY`. See [relay setup and delivery semantics](http-relay.md).
- Resilience: `heartbeat_ms` (default 15000, max 120000), `reconnect_ms` (3000, max 30000), `max_reconnect_ms` (30000, max 120000)
- Security: `join_token`, `join_token_secret`, `join_token_ttl_ms` (10 minutes, max 24 hours), `enforce_join_token`, `allow_peer_stream_ids`, `require_session_mac`
- File defaults: `file_chunk_bytes` (64 KB, 1 KB to 256 KB), `file_max_bytes` (64 MB, max 256 MB), `file_ack_timeout_ms` (1200, max 30000), `file_max_retries` (6; `0` fails on the first lost chunk)
- File spooling: `file_spool_dir`, `file_spool_threshold_bytes` (4 MB), `keep_spool_files`
- State limits: `state_max_keys` (2048), `state_max_snapshot_entries` (4096)
- Display and logging: `label`, `debug`

Values above a maximum are capped to it.

HTTP is an explicit peer transport, separate from the HTTP endpoint that can expose MCP itself. Both participants must use the same transport. WebRTC-only options are rejected in HTTP mode, and encryption can't be turned off on the relay.

In HTTP mode, `vdo_send` returns `message_id` and `delivery_stage` (`queued` or `rejected`). A later `relay_receipt` event reports `relay_accepted` or `delivery_unknown`. Acceptance doesn't confirm that the peer read the message. `data_received` includes the matching `message_id`. `relay_history_lost` means a replay gap that the application must reconcile. Message queues and relay history are in memory; file completion still requires the peer's acknowledgement.

## Sync tools

- `vdo_sync_peers`: each peer's handshake, auth, and capability state.
- `vdo_sync_announce`: send a sync hello now, to everyone or to one peer with `uuid` or `target`.

## File transfer tools

- `vdo_file_send`: send from `data_base64`.
- `vdo_file_send_path`: stream from a local `file_path` without loading it into context.
- `vdo_file_resume`: resume an outgoing transfer by `transfer_id`.
- `vdo_file_transfers`: incoming and outgoing transfer state.
- `vdo_file_receive`: read a completed incoming file as `base64`, `utf8`, or `json`.
- `vdo_file_save`: write a completed incoming file to `output_path`. Set `overwrite` to replace an existing file.

Both send tools accept `chunk_bytes`, `ack_timeout_ms`, and `max_retries` to override the session defaults for one transfer, and `timeout_ms` to bound the wait for the receiver to accept the offer. Without `timeout_ms`, the sender waits for the larger of the ack timeout and one second.

A retained incoming `transfer_id` is bound to its sending peer's UUID and its offer metadata: content hash, byte count, chunk layout, name, and MIME type. Identical retries from that peer resume or confirm completion. Reusing the ID for different content or metadata, or from another peer, is rejected; use a new ID for a new transfer. A peer that reconnects with a new UUID doesn't inherit an existing ID. Completion acknowledgements must match the sender's content hash and byte count.

## Shared state tools

- `vdo_state_set`: set a key and, by default, broadcast it. Refuses new keys once the session holds `state_max_keys` keys.
- `vdo_state_get`: read one key, or the whole snapshot when `key` is omitted.
- `vdo_state_sync`: exchange full snapshots with everyone, or with one peer via `uuid` or `target`. `mode` is `request` (the default) or `send`.

Conflicts resolve last-writer-wins on a `(clock, actor)` pair:

1. The higher `clock` wins.
2. On equal clocks, the lexicographically higher `actor` wins.

## Protocol envelope

Internal control, file, and state messages use this envelope:

```json
{
  "__vdo_mcp": "vdo_mcp_bridge_v1",
  "kind": "sync.* | file.* | state.*",
  "payload": {}
}
```

## Events from `vdo_receive`

Lifecycle:

- `ready`, `connected`, `disconnected`, `connect_error`, `connection_failed`, `sdk_error`, `reconnect_scheduled`
- `peer_connected`, `peer_disconnected`, `data_channel_open`, `data_channel_close`

Data:

- `data_received`, `send_error`, `send_rejected`

Sync and security:

- `sync_hello_sent`, `sync_peer_updated`, `sync_peer_rejected`, `protocol_auth_failed`, `protocol_unknown`

Files:

- `file_offer_received`, `file_offer_rejected`, `file_chunk_received`, `file_chunk_rejected`, `file_received`, `file_transfer_complete`, `file_transfer_cancelled`, `file_protocol_error`, `file_protocol_unhandled`

State:

- `state_updated`, `state_snapshot_merged`, `state_protocol_unhandled`

HTTP relay:

- `relay_receipt`, `relay_connection`, `relay_history_lost`, `relay_message_rejected`

## Error shape

Failed tool calls return `isError: true` with:

```json
{
  "ok": false,
  "error": {
    "type": "validation_error | tool_error",
    "message": "...",
    "tool": "..."
  }
}
```

`validation_error` means bad arguments, an unknown session or transfer, or a tool outside the active profile. `tool_error` means a valid call that failed, such as a timed-out transfer.

## Client wiring

Automated registration for Codex and Claude Code:

```bash
npm i @vdoninja/mcp
npx vdon-mcp-install
```

Register a preset:

```bash
npx vdon-mcp-install --preset core
npx vdon-mcp-install --preset file
npx vdon-mcp-install --preset state
npx vdon-mcp-install --preset secure-core
npx vdon-mcp-install --preset secure-full
```

Remove the registration:

```bash
npx vdon-mcp-install --uninstall
```

Manual configuration for clients that use an `mcpServers` file:

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"]
    }
  }
}
```

More client formats are in [client configuration](client-config-examples.md).
