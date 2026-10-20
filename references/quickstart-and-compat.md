# Quickstart

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/quickstart-and-compat.html)

Connect two MCP clients, exchange a message, and send a file. It takes about five minutes.

## What you need

- Node.js 18 or newer on each computer.
- An MCP client that launches local `stdio` servers, such as Codex, Claude Code, Cursor, Gemini CLI, or OpenCode.
- Access to `wss://wss.vdo.ninja` and outbound UDP for WebRTC. If WebRTC is blocked or can't run, use the [HTTP relay](http-relay.md) instead.

Ninja MCP carries tool payloads over WebRTC data channels, or through an HTTP relay you run. It is not a TCP or SSH tunnel. TURN relays improve connectivity on restrictive networks, but they don't guarantee a path through every firewall.

## Install and register

Install into a folder that will stay put. The installer registers an absolute path to the server script.

```bash
npm i @vdoninja/mcp
npx vdon-mcp-install
```

The installer registers the server with Codex and Claude Code, whichever are on your `PATH`. For other clients, see [client configuration](client-config-examples.md).

To start with the smallest tool set, register the `core` preset instead:

```bash
npx vdon-mcp-install --preset core
```

Restart your client, then ask the agent to call:

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

A result with the server version and active profile means the wiring works. Your client starts the server itself. Run `npx vdon-mcp-server` only to start it by hand; from a terminal it prints a short `Server running (stdio)` banner, and under a client it stays quiet, which is normal.

## Send a message

Open two agent sessions, on one computer or two. Use a room name nobody else will guess.

1. In the first session, join the room:

```json
{ "name": "vdo_connect", "arguments": { "room": "lab_7f3k2", "stream_id": "agent_a" } }
```

2. In the second session, join and connect to the first agent:

```json
{ "name": "vdo_connect", "arguments": { "room": "lab_7f3k2", "stream_id": "agent_b", "target_stream_id": "agent_a" } }
```

Each result includes a `session_id`. Every other tool needs it.

3. In the first session, call `vdo_sync_peers` until `agent_b` appears, then send:

```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<agent_a_session_id>",
    "target": "agent_b",
    "data": { "type": "chat.message", "text": "hello from agent_a" }
  }
}
```

4. In the second session, read it:

```json
{ "name": "vdo_receive", "arguments": { "session_id": "<agent_b_session_id>", "wait_ms": 1000 } }
```

Expect a `data_received` event containing `"hello from agent_a"`. If you only see connection events, call `vdo_receive` again; the data channel may still be opening.

`ok: true` from `vdo_send` means your side accepted the message for sending, not that the other agent read it. Ask for a reply when you need confirmation.

## Send a file

File tools need the `file` or `full` profile. Reuse the two connected sessions.

1. In the first session, stream a file from disk:

```json
{
  "name": "vdo_file_send_path",
  "arguments": { "session_id": "<agent_a_session_id>", "target": "agent_b", "file_path": "./notes.txt" }
}
```

2. In the second session, find the finished transfer and its `transfer_id`:

```json
{ "name": "vdo_file_transfers", "arguments": { "session_id": "<agent_b_session_id>", "direction": "incoming" } }
```

3. Save it to disk:

```json
{
  "name": "vdo_file_save",
  "arguments": { "session_id": "<agent_b_session_id>", "transfer_id": "<transfer_id>", "output_path": "./inbox/notes.txt" }
}
```

Or read it into the conversation with `vdo_file_receive` and `"encoding": "utf8"`.

`vdo_file_send_path` and `vdo_file_save` keep file contents out of the model's context. Use `vdo_file_send` with `data_base64` only for small generated payloads.

## Try it without agents

Two scripts run the same exchanges on a simulated local network and exit with pass or fail:

```bash
npx vdon-mcp-demo-message
npx vdon-mcp-demo-file
```

Set `MCP_DEMO_FAKE=0` to use the real network. Add `MCP_DEMO_FORCE_TURN=1` to force the connection through TURN:

```bash
MCP_DEMO_FAKE=0 MCP_DEMO_FORCE_TURN=1 npx vdon-mcp-demo-message
```

## Lock it down

Out of the box, data is encrypted in transit, but anyone who knows the room name can join. For private work:

- Pass your own `password` to `vdo_connect`.
- Sign joins with `join_token_secret` and set `enforce_join_token: true`.
- List the peers you expect in `allow_peer_stream_ids`.
- Set `require_session_mac: true` to drop unsigned control and file messages.

The `secure-core` and `secure-full` installer presets turn on token enforcement and session MACs. Set `VDON_MCP_JOIN_TOKEN_SECRET` in the server's environment first; every peer needs the same secret.

## Compatibility

- Any MCP client that launches local `stdio` servers works. Codex and Claude Code are registered automatically; other clients take a few lines of JSON, shown in [client configuration](client-config-examples.md).
- Clients that only connect to remote MCP servers can use `npx vdon-mcp-http`, described under [MCP over HTTP](https://steveseguin.github.io/ninjamcp/guide.html#mcp-http).
- Tool arguments and limits are in the [tool contract](mcp-tool-contract.md). Registry metadata is in `server.json`.
- `@vdoninja/mcp` installs `@vdoninja/sdk` as a dependency. Ninja MCP is MIT licensed. The SDK is licensed separately under MPL-2.0, with some separately marked wrappers and adapters under MIT.

## Next steps

- [Client configuration](client-config-examples.md) for Cursor, Gemini CLI, OpenCode, and other clients.
- [HTTP relay](http-relay.md) for machines or networks where WebRTC can't run.
- [Advanced diagnostics](advanced-diagnostics.md) for live network tests and reliability tuning.
