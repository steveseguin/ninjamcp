# VDO.Ninja MCP (`@vdoninja/mcp`)

MCP bridge for VDO.Ninja WebRTC data channels.

Use it to let AI tools (Codex, Claude Code, and compatible MCP clients) do:

- bot-to-bot messaging
- reliable file transfer
- shared state synchronization

The package depends on `@vdoninja/sdk`, so SDK installs transitively.

## Transport Truth

- This is **WebRTC data transport**, not a generic TCP/SSH tunnel.
- Data channels can run in reliable/ordered mode (SCTP over DTLS).
- TURN improves success on restrictive networks, but it is not a guaranteed firewall bypass for every enterprise policy.

## Quickstart (No Clone)

```bash
npm i @vdoninja/mcp @roamhq/wrtc
npx vdon-mcp-install
npx vdon-mcp-server
```

First MCP call (recommended):

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

Useful install variants:

- `npx vdon-mcp-install --codex-only`
- `npx vdon-mcp-install --claude-only`
- `npx vdon-mcp-install --preset core|file|state|secure-core|secure-full`
- `npx vdon-mcp-install --uninstall`

## Typical Workflows

Message demo:

```bash
npx vdon-mcp-demo-message
```

File demo:

```bash
npx vdon-mcp-demo-file
```

Live network mode (instead of local fake mode):

```bash
MCP_DEMO_FAKE=0 MCP_DEMO_FORCE_TURN=1 npx vdon-mcp-demo-message
MCP_DEMO_FAKE=0 MCP_DEMO_FORCE_TURN=1 npx vdon-mcp-demo-file
```

## Security and Least Privilege

Use secure controls where needed:

- `join_token` and `join_token_secret`
- `enforce_join_token: true`
- `allow_peer_stream_ids: [...]`
- `require_session_mac: true`

Server profile scoping:

```bash
VDON_MCP_TOOL_PROFILE=core npx vdon-mcp-server
```

Set `VDON_MCP_JOIN_TOKEN_SECRET` before secure preset installs/runtime.

## Compatibility

- Codex MCP CLI
- Claude Code MCP CLI
- Other MCP clients that support stdio command servers

Manual command wiring example:

```json
{
  "name": "vdo-ninja-mcp",
  "command": "node",
  "args": ["node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"]
}
```

## Local Development (This Repo)

Start server:

```bash
node scripts/vdo-mcp-server.js
```

Install registration from local checkout:

```bash
node scripts/install-mcp.js
```

## Testing

Fast product-focused suite:

```bash
node tests/run-mcp-tests-minimal.js
```

Full suite:

```bash
node tests/run-mcp-tests.js
```

Live diagnostics:

```bash
node tests/live-turn-smoke.js
node tests/live-turn-soak.js
node tests/live-turn-matrix.js
node tests/live-turn-preset-matrix.js
```

## Key Files

- `scripts/vdo-mcp-server.js` (stdio MCP server)
- `scripts/vdo-mcp-streamable-http.js` (streamable HTTP bridge)
- `scripts/install-mcp.js` (Codex/Claude installer automation)
- `references/quickstart-and-compat.md` (operator quickstart)
- `references/mcp-tool-contract.md` (tool semantics and contracts)
- `server.json` (MCP discovery manifest metadata)

## License

AGPL-3.0-only
