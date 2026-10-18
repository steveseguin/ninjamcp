# Connect without WebRTC

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/http-relay.html)

Use the HTTP relay when a machine cannot run the native WebRTC library or its network blocks WebRTC. Two MCP sessions join the same encrypted room through a relay you operate. Messages, file transfers, and shared state use the existing MCP tools.

WebRTC remains the default. Select `transport: "http"` on both participants to use the relay. Sessions using different transports do not discover each other; reconnect both with matching settings when switching.

## Run the relay

The relay needs Node.js 18 or newer and no native dependencies. From a checkout:

```powershell
$env:VDON_RELAY_TOKEN = '<a random access token, at least 32 characters>'
node scripts/vdo-mcp-relay.js
```

From an installed package, use `npx vdon-mcp-relay`. The default listener is `127.0.0.1:8790`. Set `VDON_RELAY_HOST` and `VDON_RELAY_PORT` to change it.

Generate the access token and a separate room key by running this command twice:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the room key on the participating clients. The relay receives only the access token. Give each private group its own relay instance and token, and use a different encryption key for each room.

For other computers to connect, put the relay behind an HTTPS reverse proxy on your server. Forward `/v1/rooms/` unchanged, preserve the `Authorization` header, disable caching, allow request bodies up to 768 KiB, and allow responses to wait at least 30 seconds. Keep the Node listener private to the proxy. Remote clients require HTTPS; plain HTTP is accepted only for loopback addresses.

## Configure each MCP client

Install without the optional native WebRTC library if needed:

```bash
npm install @vdoninja/mcp --omit=optional
```

Set these variables in the environment of each MCP server process. In a client that supports a JSON server configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"],
  "env": {
    "VDON_MCP_RELAY_URL": "https://relay.example.com",
    "VDON_MCP_RELAY_TOKEN": "<relay access token>",
    "VDON_MCP_RELAY_KEY": "<64 hex characters from the second command>"
  }
}
```

For two clients on the relay computer, use `http://127.0.0.1:8790`. Both clients need the same relay URL, access token, room key, and room name. Each needs a different `stream_id`.

Keep secrets in the server environment where possible. `vdo_connect` also accepts `relay_url`, `relay_token`, and `relay_key` for clients that need separate settings per session. These secrets are omitted from status and connection results.

## Join and send

Connect the first agent:

```json
{ "name": "vdo_connect", "arguments": { "transport": "http", "room": "project_room", "stream_id": "planner" } }
```

Connect the second agent:

```json
{ "name": "vdo_connect", "arguments": { "transport": "http", "room": "project_room", "stream_id": "reviewer" } }
```

Use `vdo_sync_peers` to wait for discovery, then address a peer by its stream ID:

```json
{ "name": "vdo_send", "arguments": { "session_id": "<planner-session>", "target": "reviewer", "data": { "text": "Please review the plan." } } }
{ "name": "vdo_receive", "arguments": { "session_id": "<reviewer-session>", "wait_ms": 1000 } }
```

File tools use the same target and retain chunk hashes, acknowledgements, retries, and completion checks. For shared state with `require_session_mac: true`, use the peer UUID from `vdo_sync_peers` as the state operation's `target`; the MAC belongs to that peer connection.

## Delivery and recovery

The relay accepts encrypted events through POST. Clients receive them through long polling with a cursor. Each request returns as soon as an event is available, or after 25 seconds. This path does not need SSE or WebSockets.

| Result or event | Meaning and action |
| --- | --- |
| `vdo_send`: `delivery_stage: "queued"` | The local transport accepted the message. Save its `message_id` if you need to track it. |
| `relay_receipt`: `stage: "relay_accepted"` | The relay accepted the event. This does not confirm peer receipt or task completion; have the other agent reply when those matter. |
| `relay_receipt`: `stage: "delivery_unknown"` | POST retries failed. The relay may have accepted a request whose response was lost. Check with the peer before repeating a consequential task. |
| `data_received` | The receiving bridge accepted a message. Its `message_id` matches the sender's ID. The AI client still needs to poll and act on it. |
| `relay_connection` | The reader lost or regained connectivity. Use `vdo_status` to inspect the current connection. |
| `relay_history_lost` | The cursor is no longer available. Reconcile outstanding tasks with peers, request a state snapshot, and inspect unfinished file transfers before resuming. |
| `relay_message_rejected` | An event failed decryption or validation. Check matching room keys and synchronized clocks. |

Retries within the retained history reuse the same encrypted event ID. Distinct messages with identical text keep distinct IDs. Reconnection resumes a running session's cursor; process restarts start a new session. New sessions begin with current traffic rather than retrieving past conversations.

The relay keeps at most 512 events or 8 MiB per room for up to five minutes, across at most 16 rooms. It has no disk archive. A restart clears its history. Use the relay for live collaboration; use an application inbox for durable offline work. A busy room or large transfer can exhaust replay before five minutes.

Queues and request sizes are bounded. `vdo_send` can return `ok: false` when the transport has no known peer, is disconnected, or its queue is full. Wait for discovery or recovery before retrying. File tools already split payloads into chunks; avoid sending whole large files as ordinary messages.

## Trust and privacy

Room payloads use AES-256-GCM with a fresh random nonce and a key derived from the shared room key. The room identifier and event ID are authenticated with each encrypted message. The relay sees connection addresses, opaque room identifiers, timing, and sizes, but does not receive the room key or plaintext payloads.

Every holder of a room key can decrypt that room's traffic, including messages addressed to another participant, and can claim a participant identity. A target selects delivery; it is not a private subchannel within the room. Share keys only with trusted participants and use separate rooms for separate trust groups. Use the existing join-token and allowlist controls to restrict application delivery; an allowlist alone does not establish a cryptographic identity. Rotate shared keys and reconnect participants when access changes.

This group-key mode has no forward secrecy: a disclosed key can decrypt previously captured room traffic. Use WebRTC when its connection-level privacy is required. Keep clocks synchronized; expired or far-future events are rejected.

The HTTP relay carries data. The optional [browser adapter](browser-worker.md) supports automatic WebRTC/HTTP routing for its commands and images; live browser audio/video still uses WebRTC. Ordinary room sessions choose their transport explicitly. The `vdon-mcp-http` command exposes MCP itself over HTTP; `vdon-mcp-relay` carries encrypted events between peers. They are different services.
