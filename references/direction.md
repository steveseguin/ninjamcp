# Direction: live tools and perception for MCP agents

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/direction.html)

Ninja MCP should give an MCP-capable agent a focused way to reach trusted peers, use authorized remote tools, and see and hear selected live context across computers. Keep setup small, prefer direct peer connections, and preserve useful data interactions when WebRTC is unavailable.

The defining experience is an agent working with someone through their existing AI client: the person shows a camera or screen, the agent uses an authorized remote tool or consults a peer, and the result comes back with live context. The person can interrupt speech, change the request, take back control, or stop sharing immediately.

Two agents exchanging a short text message must remain easy. Media, a model-provider account, a background daemon, and a workflow engine should be optional.

## Complement ninja-p2p

| Project | Main responsibility | User's starting point |
| --- | --- | --- |
| **Ninja MCP** | Active connections, MCP tool contracts, scoped remote operations, and live media access, including an optional shared Chrome worker. | Add an MCP server to an existing AI client and call a tool. |
| [ninja-p2p](https://github.com/steveseguin/ninja-p2p) | The continuing team workspace: sidecars, identities and profiles, local inbox/outbox, handoffs, receipts, wake hooks, files, and the operator dashboard. | Start a sidecar, join the team, and retain work between agent turns. |
| [VDO.Ninja SDK](https://sdk.vdo.ninja/) | Reusable peer connectivity, data channels, and audio/video transport. | Build an application or adapter. |

ninja-p2p owns the room's continuing conversation and work lifecycle. Ninja MCP owns how an MCP client accesses an active peer or remote capability. A shared Chrome worker belongs with Ninja MCP's remote tool adapters; assigning its work and retaining the team's handoffs belong with ninja-p2p. Voice and vision support both experiences through shared SDK media adapters. See [ninja-p2p's north star](https://github.com/steveseguin/ninja-p2p/blob/main/docs/north-star.md).

Keep both usable independently. An optional Ninja MCP adapter should expose ninja-p2p's existing directory, inbox, handoff, and receipt operations, with ninja-p2p remaining the owner of those records. It should preserve origin, request identity, permissions, and the difference between storage acknowledgement and task completion. Extend that integration for background work instead of adding a second inbox, wake scheduler, or team task store to Ninja MCP.

Current room and file envelopes differ between the packages. Sharing the SDK or a room name does not provide application interoperability; use matching packages until an explicit adapter is available. Coordinate reusable relay contracts and media adapters across the projects while keeping their storage and execution guarantees explicit.

## Available foundation

- MCP tools for messages, files, peer discovery, and shared state.
- Direct WebRTC and optional TURN connectivity.
- An explicit, self-hosted encrypted HTTP relay for machines and networks without WebRTC.
- Tool profiles, peer allowlists, join tokens, and per-peer protocol MACs.
- An optional [Chrome worker](browser-worker.md) with individual client credentials, tab leases, snapshots, screenshots, and SDK tab audio/video.
- Guided browser setup, connection diagnostics, and automatic WebRTC/HTTP routing with one request identity and worker result cache.
- An optional [browser companion](browser-agent.md) with OpenAI Realtime speech, selected browser frames, explicit control permission, and interruption.
- An optional [SSApp bridge](ssapp-integration.md) for the running app's MCP tools, screenshots, input and dialogs, with individual credentials and one controller at a time.

The HTTP path uses POST and long polling with bounded replay. It is a live transport, not a durable inbox. Ordinary room sessions choose matching transports explicitly; the browser adapter can use both. Browser media uses WebRTC separately. A compatible ninja-p2p relay can serve both projects, while its hosted mailboxes retain work between agent turns. Relay acceptance, agent wake, and completed work remain separate outcomes.

## What to build next

1. **Make live tool interactions dependable.** Expose peer capabilities, active connection status, bounded requests, and clear results through a small MCP surface. Distinguish queue acceptance, peer responses, progress, and completion. Bind remote operations to an authenticated caller and an explicit worker permission. Receiving a message never grants permission to execute commands.
2. **Extend dependable routing beyond browser tools.** Preserve request identity, authentication, and receipt meaning when moving between direct WebRTC, TURN, and the HTTP relay. Carry the browser adapter's direct, relay-only, and automatic policies into other tool adapters where execution can be reconciled. Add SSE where it helps, and make interrupted or uncertain operations visible. Build the optional ninja-p2p adapter for work that must wait in a persistent inbox. Keep large file bytes separate from latency-sensitive events.
3. **Expand shared perception deliberately.** Build on the browser companion's microphone, selected frames, timestamps, and interruptible speech. Add camera and screen selection before expanding providers, keeping recipients visible and recording off by default. Preserve text and selected snapshots when live media cannot connect. Reuse the media adapter in ninja-p2p's team dashboard.
4. **Connect to continuing collaboration.** Expose ninja-p2p handoffs and receipts through an optional MCP adapter, preserving the sidecar's state and delivery semantics. Map progress, artifacts, input requests, cancellation, and results to the owning worker or task system. An A2A adapter should share those contracts across the projects. Keep delegation limits and background wake policy with the system that runs them.

Transporting a video track does not make a model understand it. Media adapters should support native streaming models or a pipeline of speech recognition, a text/vision model, and speech synthesis. Stop queued speech on interruption; treat cancelling the underlying task as a separate action.

## Build on the VDO.Ninja SDK

The MCP bridge already uses `@vdoninja/sdk`. Reuse its media publishing and track events for voice, camera, screen, and browser streams. Its request/reply helpers provide a starting point for remote operations; application authorization, stable task IDs, and retry handling still belong to the worker. Keep large transfers on separate data channels and use queue limits so file traffic does not delay controls. See the [SDK API](https://sdk.vdo.ninja/docs/api-reference.html) and [remote-control guide](https://sdk.vdo.ninja/docs/remote-control.html).

The SDK's RPC helpers and Ninja MCP's room protocol are separate interfaces. Connect them through a versioned adapter that preserves authentication and request identity across WebRTC and HTTP. Do not assume an SDK request handler inherits the MCP bridge's peer checks.

## Optional shared Chrome worker

The [browser worker](browser-worker.md) lets people and agents use one isolated remote Chrome tab. The host runs a local Chrome DevTools MCP server and a Ninja room participant. Agents send authenticated tool requests through Ninja MCP; the worker executes them locally and returns results. The host connects outward through WebRTC or the configured HTTPS relay, keeping Chrome's debugging endpoint private. This design needs no VPN, VNC, or VLC. Connectivity still depends on the host's allowed outbound routes.

The adapter pins [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) and Puppeteer as optional dependencies, with explicit page targeting and a separate browser runtime. An extension-based server such as [mcp-chrome](https://github.com/hangwin/mcp-chrome) remains an alternative for an operator's existing browser. [Remote Ninja](https://github.com/steveseguin/remote_ninja) provides an existing VDO.Ninja example of forwarding remote operations to a local application.

Allow multiple observers and give one agent a time-limited control lease for a tab. Hold the lease across a multi-step interaction, check its owner and generation before executing queued commands, and reject stale commands after handoff. Use explicit page IDs and require fresh page state after navigation. Operations affecting the whole browser need coordination across tabs. A human can revoke control; disconnected controllers must not retain an indefinite lock.

Optional live video and captured tab audio travel through SDK media tracks, separately from commands and file transfers. The host explicitly enables Chrome tab capture for the isolated worker. Snapshots remain available when live media cannot connect, and visual responses carry capture timestamps. The browser companion consumes selected frames and the operator's microphone, with separate controls for live viewing, model sharing, and browser control.

The first worker milestone is two agents taking turns on one isolated tab, a human watching its SDK stream, and correlated command results across reconnects. Use bounded requests, enforce permissions at the worker, and reconcile uncertain outcomes before retrying clicks or form submissions. Live audio capture and interruption belong in that milestone's media path; a video recording alone does not provide an interactive call. Shared room membership or possession of a relay key must not automatically grant browser control.

## Ideas to carry forward

| Project | Useful contribution |
| --- | --- |
| [Reason Network](https://github.com/reason-machines/reason-network) | A directory of live sessions, context-aware addressing, immediate or deferred delivery, and relay-backed connectivity. |
| [A2A](https://a2a-protocol.org/latest/specification/) | Capability cards, explicit task lifecycles, streaming progress, and artifacts. |
| [Agent Relay](https://github.com/AgentWorkforce/relay) | Direct messages, channels, threads, and an inspectable conversation. |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Durable mail and searchable threads for ninja-p2p's continuing workspace, accessible through an optional MCP adapter. |
| [agents-party](https://github.com/1gr14/agents-party) | A shared room where people can follow and participate in agent collaboration. |
| [ntfy](https://docs.ntfy.sh/subscribe/api/) and [NATS JetStream](https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment) | Replay cursors, bounded retrieval, explicit acknowledgements, and redelivery. |
| [Pipecat](https://github.com/pipecat-ai/pipecat), [LiveKit Agents](https://docs.livekit.io/agents/), and [FastRTC](https://github.com/gradio-app/fastrtc) | Agents as media participants, interchangeable media/model adapters, interruption handling, and short runnable examples. |
| [Social Stream](https://github.com/steveseguin/social_stream/blob/main/api.md) | Simple POST and SSE interaction patterns for a separately operated agent relay. |

Use these as design references. Adopt an idea when it helps participants communicate, retain context, share perception, or control the work. Keep orchestration platforms, public directories, file reservations, and search optional until their value justifies their complexity.

## Product boundaries

Ninja MCP should stay useful to one MCP client using one remote capability. ninja-p2p should stay useful to a continuing team using its CLI, library, or dashboard. The SDK and shared transport/media adapters support both. A feature belongs in Ninja MCP when it improves tool access, active-session reliability, remote control, or live perception; durable team coordination belongs in ninja-p2p.

Privacy needs explicit membership and route visibility. Future invitations should be revocable and scoped. Relay authentication and encryption are separate concerns; a TLS connection alone does not hide plaintext from a relay. Cloud model processing must be visible even when transport to the agent is encrypted.

Reliable delivery does not guarantee exactly-once execution of an external action. Preserve request IDs, use idempotency where supported, and expose an uncertain outcome after a crash instead of silently repeating consequential work.

Judge progress by successful collaborations with a clear result and less manual context copying. Track time to first exchange, missing or duplicate deliveries, reconnect delay, file integrity, and resource cost. For media, measure transport delay, model response time, and interruption response separately.
