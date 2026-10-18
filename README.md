# VDO.Ninja MCP (`@vdoninja/mcp`)

Give an MCP client live tools for exchanging messages, files, and small shared-state updates with peers on other computers. The MCP server manages active connections while your AI client calls the tools and consumes incoming events.

WebRTC is the default peer transport. An optional [self-hosted HTTP relay](https://steveseguin.github.io/ninjamcp/http-relay.html) works when WebRTC is unavailable.

[Package](https://www.npmjs.com/package/@vdoninja/mcp) | [HTML guides](https://steveseguin.github.io/ninjamcp/guide.html#guides) | [Client setup](https://steveseguin.github.io/ninjamcp/client-config-examples.html) | [Tool reference](https://steveseguin.github.io/ninjamcp/mcp-tool-contract.html) | [Support](https://discord.vdo.ninja)

HTML guides are also included in the package's `docs/` folder for offline reading.

## Get started

Install from a stable folder; the installer registers an absolute script path with your MCP client.

```bash
npm install @vdoninja/mcp
npx vdon-mcp-install
```

The installer supports Codex and Claude Code. Use `--codex-only` or `--claude-only` to choose one, or follow the [manual setup examples](https://steveseguin.github.io/ninjamcp/client-config-examples.html) for other MCP clients. Your client launches the server; `npx vdon-mcp-server` starts it directly for manual use.

Ask the first agent to connect:

```json
{ "name": "vdo_connect", "arguments": { "room": "project_room", "stream_id": "planner" } }
```

Ask the second agent to join and connect to the first:

```json
{ "name": "vdo_connect", "arguments": { "room": "project_room", "stream_id": "reviewer", "target_stream_id": "planner" } }
```

Wait for the peer to appear in `vdo_sync_peers`, then send a message using the returned session ID:

```json
{ "name": "vdo_send", "arguments": { "session_id": "<reviewer-session>", "target": "planner", "data": { "text": "Please send me the plan to review." } } }
{ "name": "vdo_receive", "arguments": { "session_id": "<planner-session>", "wait_ms": 1000 } }
```

These are MCP tool calls made by your AI client. A successful send means the transport accepted the payload; ask the recipient to reply when you need confirmation. Clients use `vdo_receive` to retrieve incoming events.

See the [quickstart](https://steveseguin.github.io/ninjamcp/quickstart-and-compat.html) for connection troubleshooting and secure presets.

## What you can do

| Goal | Tools |
| --- | --- |
| Connect, discover peers, and inspect a room | `vdo_connect`, `vdo_sync_peers`, `vdo_status` |
| Exchange messages and hand off work | `vdo_send`, `vdo_receive` |
| Send and save artifacts with integrity checks and retries | `vdo_file_send_path`, `vdo_file_receive`, `vdo_file_save` |
| Share small task state and recover a snapshot | `vdo_state_set`, `vdo_state_get`, `vdo_state_sync` |
| Inspect available tools and transport behavior | `vdo_capabilities` |
| End a session | `vdo_disconnect` |

Choose a tool profile with `npx vdon-mcp-install --preset core`, `file`, or `state`. The `full` profile includes all tools. Use `secure-core` or `secure-full` with a configured `VDON_MCP_JOIN_TOKEN_SECRET` for join-token enforcement and session MACs. The [tool reference](https://steveseguin.github.io/ninjamcp/mcp-tool-contract.html) describes peer allowlists and other connection controls.

## Choose a connection

| Path | When to use it |
| --- | --- |
| WebRTC | Default for direct peer messaging and files. Payloads travel over encrypted data channels. |
| WebRTC with `force_turn: true` | Route through TURN when you need it. TURN still requires a WebRTC runtime and network support. |
| HTTP relay with `transport: "http"` | Use a relay you operate when WebRTC cannot run or connect. Follow the [relay setup guide](https://steveseguin.github.io/ninjamcp/http-relay.html). |

The HTTP relay uses encrypted room messages, POST, and long polling. Both peers must select HTTP and share the relay settings. It has bounded in-memory replay, with visible events for lost history; use an application inbox when work must survive process restarts or long periods offline. Room-key holders can decrypt the room's traffic, so use separate rooms for separate trust groups.

The native WebRTC dependency installs by default. For HTTP-only machines, install with `npm install @vdoninja/mcp --omit=optional` and configure a relay. Ordinary room sessions select their transport explicitly; the optional browser adapter also supports automatic routing.

## Where this fits

| Your goal | Use |
| --- | --- |
| Connect an MCP client to live peers and exchange messages, files, and state | **This package** |
| Keep a team connected between agent turns, with local inboxes, handoffs, wake hooks, and a dashboard | [ninja-p2p](https://github.com/steveseguin/ninja-p2p) |
| Build directly with WebRTC audio, video, or data | [VDO.Ninja SDK](https://github.com/steveseguin/ninjasdk) |

Choose Ninja MCP when your client should manage an active interaction through MCP tools. Choose ninja-p2p when a background sidecar should retain incoming work and notify an agent between turns. Ninja MCP's ordinary event queues and shared state live in the server process; use ninja-p2p for persistent agent inbox workflows.

Both use the VDO.Ninja SDK, but their message and file protocols differ. A common room name alone does not connect their higher-level workflows. A dedicated adapter is planned; until then, use matching packages on both ends of each workflow.

Ninja MCP's direction is live access to remote peers, tools, and perception through MCP. ninja-p2p's direction is the continuing team workspace and its handoffs. See [Ninja MCP's direction](https://steveseguin.github.io/ninjamcp/direction.html) and [ninja-p2p's direction](https://github.com/steveseguin/ninja-p2p/blob/main/docs/north-star.md).

## Optional remote Chrome

The [browser worker](https://steveseguin.github.io/ninjamcp/browser-worker.html) lets agents share an isolated, headless Chrome tab over WebRTC or your HTTP relay. Each agent has a separate credential; one controller holds the tab while others observe. Tools return page snapshots and screenshots. Hosts can also enable live tab audio/video through the VDO.Ninja SDK.

Install the optional browser packages on the host, run `vdon-mcp-browser --setup`, and register it as a separate MCP server. The [setup guide](https://steveseguin.github.io/ninjamcp/browser-worker.html) covers connection checks, automatic WebRTC/HTTP routing, control handoff, and private viewing links.

The optional [browser companion](https://steveseguin.github.io/ninjamcp/browser-agent.html) adds a speaking agent with microphone, browser-frame sharing, interruption, and control permissions. It uses an OpenAI API key; ordinary MCP tools and live browser viewing do not require a model account.

## Optional remote SSApp

For an existing Social Stream Ninja Standalone instance, the optional [SSApp bridge](https://steveseguin.github.io/ninjamcp/ssapp-integration.html)
forwards its MCP tools, screenshots, and input over WebRTC or the HTTP relay. Agents use separate credentials
and take turns controlling the app; SSApp keeps its existing sessions and windows.

## Run from a checkout

```bash
npm install
node scripts/vdo-mcp-server.js
```

`npm run check` runs the existing suite. `npm run demo:message` and `npm run demo:file` run local simulated workflows; set `MCP_DEMO_FAKE=0` to use live WebRTC peers. See [advanced diagnostics](https://steveseguin.github.io/ninjamcp/advanced-diagnostics.html) for live network checks.

## License

MIT. Copyright (c) 2026 Steve Seguin.

The `@vdoninja/sdk` dependency has its own terms: MPL-2.0, with some separately marked wrappers and adapters under MIT. Preserve its copyright and license notices when redistributing it and comply with the MPL-2.0 for covered SDK files. Those terms do not require the rest of an application to use the MPL-2.0.
