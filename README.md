# VDO.Ninja MCP (`@vdoninja/mcp`)

## TL;DR

This package gives an AI app a small set of tools for talking to another AI app. Two Codex, Claude, Cursor, or other MCP sessions can join the same VDO.Ninja room, send messages, exchange files, and keep shared task state without you building a new messaging server.

If your AI client supports MCP and you want **tools it can call**, use this package. If you want an **always-on agent room with a local inbox**, use [`ninja-p2p`](https://github.com/steveseguin/ninja-p2p) instead.

**Best for:** MCP-native agent handoffs, file delivery, and small shared-state workflows.

**Not for:** a general VPN, permanent storage, or a large public chat network.

Package: [`@vdoninja/mcp`](https://www.npmjs.com/package/@vdoninja/mcp) | [Quickstart](references/quickstart-and-compat.md) | [Client setup examples](references/client-config-examples.md) | [Support](https://discord.vdo.ninja)

## What It Looks Like

One agent joins a room:

```json
{ "name": "vdo_connect", "arguments": { "room": "family_calendar", "stream_id": "planner" } }
```

A second agent joins the same room, then sends it a message:

```json
{ "name": "vdo_connect", "arguments": { "room": "family_calendar", "stream_id": "reviewer", "target_stream_id": "planner" } }
{ "name": "vdo_send", "arguments": { "session_id": "<reviewer-session>", "data": { "text": "I checked the plan. Tuesday has a conflict." } } }
```

Those are normal MCP tool calls. This server translates them into VDO.Ninja SDK operations over WebRTC data channels.

## Which VDO.Ninja Package Do I Need?

| Your goal | Use |
| --- | --- |
| Add connect/send/file/state tools to an MCP client | **`@vdoninja/mcp`** |
| Give agents a persistent room and local inbox | [`@vdoninja/ninja-p2p`](https://github.com/steveseguin/ninja-p2p) |
| Build directly with WebRTC media or data channels | [`@vdoninja/sdk`](https://github.com/steveseguin/ninjasdk) |

This package uses VDO.Ninja's existing room, discovery, and WebRTC behavior. It does not add signaling-server commands. `@vdoninja/sdk` and the Node WebRTC runtime install as package dependencies.

## Why This MCP

- Open source (`AGPL-3.0-only` with additional unmodified-distribution exception) and free to use.
- Peer-to-peer first: no central relay required for normal data flow.
- End-to-end encrypted WebRTC data transport (DTLS + SCTP data channels).
- Reliable data channel mode available for ordered/loss-recovered delivery.
- Low infrastructure overhead for bot-to-bot messaging and file sync.
- Works for local LAN, remote internet peers, and hybrid topologies.
- TURN support improves connectivity when direct P2P is blocked.
- Good fit for multi-agent coordination without exposing plaintext payloads to a middlebox.

## Common and Interesting Use Cases

- AI swarm coordination: multiple agents in a private room exchanging tasks, state, and results.
- Bot-to-bot handoff: one agent collects context, another executes, another validates, all over P2P.
- Private file exchange: send logs, artifacts, prompts, and generated outputs directly between agents.
- Human + AI war room: operator plus several bots sharing near-real-time status updates.
- Edge + cloud hybrid: local on-device agent syncs with remote agents without standing up a custom tunnel.
- Temporary secure collaboration spaces: ad-hoc rooms with join tokens and peer allowlists.
- Cross-tool interop: Codex and Claude instances sharing updates through the same bridge contract.

## Fun Agent-to-Agent Rooms

These are real patterns teams are starting to use:

- Claude Code to Codex CLI pair mode where one agent asks for a second opinion and gets patch/test feedback.
- OpenClaw-to-OpenClaw specialist rooms where one local assistant asks another for tool-specific help.
- Small LLM idea circles (3-5 agents) sharing proposals, critiques, and final votes.
- Private "night shift" automation where bots sync status/events/files without broad network exposure.

OpenClaw project link:

- https://github.com/openclaw/openclaw

## Quick Example: Claude + Codex Helper Loop

1. Claude-side session:
```json
{
  "name": "vdo_connect",
  "arguments": {
    "room": "agent_help_room",
    "stream_id": "claude_agent"
  }
}
```

2. Codex-side session:
```json
{
  "name": "vdo_connect",
  "arguments": {
    "room": "agent_help_room",
    "stream_id": "codex_agent",
    "target_stream_id": "claude_agent"
  }
}
```

3. Claude sends task:
```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<claude_session>",
    "data": {
      "type": "help.request",
      "task": "review patch for race condition"
    }
  }
}
```

4. Codex replies:
```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<codex_session>",
    "data": {
      "type": "help.reply",
      "summary": "found 2 edge cases",
      "next_steps": ["add timeout guard", "add retry test"]
    }
  }
}
```

## High-Value AI Advantages

- Agents share messages/files/state directly, without opening broad machine-to-machine network access.
- You can limit tool access with profiles (`core|file|state|full`) so each agent only gets what it needs.
- Rooms can be short-lived: create for a task, then close when done.
- Easy to start: no private subnet setup, no custom tunnel setup.
- Works between browser peers and Node peers.
- Data channels can be reliable and ordered, which is good for control messages.
- Security options are built in: join tokens, stream allowlists, and session MAC checks.

## Clever Real-World Patterns

- Reviewer team: one writer agent, several reviewer agents, and one decider agent sharing feedback in the same room.
- State recovery: agents can re-sync shared state with `vdo_state_sync` after reconnects.
- File pipeline: one agent sends artifacts, another indexes them, another summarizes them.
- Human override: a person can join the room to inspect progress and step in when needed.
- Local-first flow: keep sensitive work local and only send required outputs to remote agents.
- Burst jobs: create short-lived agent groups per task instead of running a permanent private network.

## Compared with VPN Overlays (e.g., Tailscale)

Where this MCP is often better for AI workflows:

- You need agent-to-agent messaging/file/state, not full network access between hosts.
- You want tool-level permissions instead of giving every machine broad private-network reach.
- You want browser and Node agents working together quickly.
- You want temporary collaboration sessions without managing a permanent virtual network.

Where overlays are often better:

- You need always-on private IP connectivity across many services.
- You need many protocols (databases, SSH, internal web apps) over one virtual network.
- You need centralized network policy and audit at the infrastructure layer.

Practical framing:

- This MCP is not a full replacement for Tailscale.
- It is a strong complement for AI-native, data-channel-first collaboration.

## Transport Truth

- This is **WebRTC data transport**, not a generic TCP/SSH tunnel.
- Data channels can run in reliable/ordered mode (SCTP over DTLS).
- Default behavior is direct P2P when possible (great for LAN/local-network speed and low latency).
- Privacy mode is opt-in via `force_turn=true`: this can reduce direct IP exposure between peers, but may reduce connection success in some environments.
- TURN improves success on restrictive networks, but it is not a guaranteed firewall bypass for every enterprise policy.

## Quickstart (No Clone)

Install from a stable folder. The installer stores an absolute script path in Codex/Claude config.

```bash
npm i @vdoninja/mcp
npx vdon-mcp-install
npx vdon-mcp-server
```

When started directly in a terminal, `vdon-mcp-server` now prints a short "server running" banner and a first-call hint.

First MCP call (recommended):

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

Useful install variants:

- `npx vdon-mcp-install --codex-only`
- `npx vdon-mcp-install --claude-only`
- `npx vdon-mcp-install --preset core|file|state|secure-core|secure-full`
- `npx vdon-mcp-install --uninstall`

## Onboarding Guides

- Operator quickstart: `references/quickstart-and-compat.md`
- Client setup examples (Cursor, Gemini CLI, OpenCode): `references/client-config-examples.md`
- First functional workflows (Codex-to-Codex and Claude-to-Claude): `references/client-config-examples.md`

## Typical Workflows

Message demo:

```bash
npx vdon-mcp-demo-message
```

Purpose: prove end-to-end room connect + message send/receive over data channels.

File demo:

```bash
npx vdon-mcp-demo-file
```

Purpose: prove reliable chunked file transfer and receive path.

Live network mode (instead of local fake mode):

```bash
MCP_DEMO_FAKE=0 npx vdon-mcp-demo-message
MCP_DEMO_FAKE=0 npx vdon-mcp-demo-file
```

Privacy-first relay mode (opt-in):

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

AGPL-3.0-only with additional unmodified-distribution exception.

- Main license text: `LICENSE`
- Additional permission: `LICENSE-SDK-EXCEPTION`
