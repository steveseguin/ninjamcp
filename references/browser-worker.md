# Share a remote Chrome browser

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/browser-worker.html)

Run an isolated, headless Chrome tab on one computer and let agents use it through Ninja MCP. The host connects outward using WebRTC or your HTTP relay. Chrome's debugging endpoint stays on loopback; agents need no VPN or desktop streaming software.

Each agent gets its own credential. Controllers take turns using a tab lease; observers can read snapshots, request screenshots, and watch optional live tab audio/video.

## Start the host

Install Chrome and Node.js 22.12 or later. In your Ninja MCP installation folder, install the optional browser packages:

```sh
npm install @vdoninja/mcp chrome-devtools-mcp@1.11.0 puppeteer-core@24.37.5
npx vdon-mcp-browser --setup ./private-browser
npx vdon-mcp-browser --worker --config ./private-browser/worker.json
```

The setup prompts for a connection and optional live media. For a direct connection without prompts, add `--transport webrtc`. From a checkout, use `node scripts/vdo-mcp-browser.js` in place of `npx vdon-mcp-browser`. Keep the generated directory outside source control and accessible only to the host account. It contains four credential files:

| File | Give it to |
| --- | --- |
| `worker.json` | The browser host only; it contains every client key. |
| `agent1.json`, `agent2.json` | One controller each. |
| `viewer.json` | An observer who may see the shared tab but cannot control it. |

Copy each client file privately to its intended agent's machine. Give additional clients distinct random 32-byte hex keys and add their IDs, keys, and `controller` or `observer` roles to `worker.json`. Restart the worker to apply credential changes. Use one client credential per active agent process.

Setup also writes `mcp-client.json` with the local agent registration. Adjust its absolute paths when copying it to another computer. `--init` remains available for creating WebRTC credentials without prompts.

The worker starts with one empty shared tab and an ephemeral Chrome profile. Your ordinary Chrome windows and logged-in profile are separate. To select a Chrome executable, add an absolute `executable` path to `worker.json`. When browser packages live elsewhere, set `dependencies` to their installation directory.

## Connect an agent

The agent machine needs Ninja MCP, but does not need Chrome or the optional browser packages. Add this separate server to the agent's MCP configuration, using absolute paths:

```json
{
  "mcpServers": {
    "ninja-browser": {
      "command": "node",
      "args": [
        "/absolute/path/node_modules/@vdoninja/mcp/scripts/vdo-mcp-browser.js",
        "--config",
        "/absolute/private/path/agent1.json"
      ]
    }
  }
}
```

On Windows, use paths such as `C:/Ninja/node_modules/@vdoninja/mcp/scripts/vdo-mcp-browser.js`. Existing message, file, and state tools remain available through the ordinary Ninja MCP server.

Check the host packages or authenticate to the running worker from a client:

```sh
npx vdon-mcp-browser --doctor --config ./private-browser/worker.json
npx vdon-mcp-browser --doctor --config ./private-browser/agent1.json
```

The client check lists tabs without taking control. Its output distinguishes relay access from an authenticated worker response and names the route that returned the result.

Ask the agent to list tabs, claim the shared tab, navigate, and take a snapshot:

```json
{ "name": "browser_tabs", "arguments": {} }
{ "name": "browser_claim", "arguments": { "pageId": 1 } }
{ "name": "browser_call", "arguments": { "pageId": 1, "lease": "<returned lease>", "action": "navigate", "url": "https://example.com" } }
{ "name": "browser_observe", "arguments": { "pageId": 1 } }
```

Use the returned snapshot token and element UID for input:

```json
{ "name": "browser_call", "arguments": { "pageId": 1, "lease": "<returned lease>", "snapshot": "<snapshot token>", "action": "click", "uid": "<element uid>" } }
{ "name": "browser_observe", "arguments": { "pageId": 1, "screenshot": true } }
{ "name": "browser_release", "arguments": { "pageId": 1, "lease": "<returned lease>" } }
```

`fill` takes `uid` and `value`; `key` takes a page key such as `Enter`, `Tab`, or an arrow key. Navigation accepts HTTP and HTTPS URLs. Remote tools do not expose script evaluation, local file uploads, browser shortcuts, or the media publisher's private page. They share the initial tab; newly opened tabs are not exposed. Continue work in the shared tab by navigating it to the desired URL.

## Share control and recover a connection

A lease lasts 60 seconds by default. Set `ttl_ms` between 1,000 and 120,000 when claiming; renew by passing the same lease to `browser_claim`. Another controller can claim after release or expiry. A disconnected agent's lease expires on that same deadline.

Take a fresh accessibility snapshot after claiming, navigating, or acting. Snapshot tokens expire after 30 seconds. Another agent's accessibility snapshot replaces the current element references; take a fresh one if an input call returns `fresh_snapshot_required`. Screenshots do not replace those references.

The host can enter `revoke 1` in its worker terminal to invalidate the current lease immediately. An action already executing may finish. Stop the worker to close the browser and end all access.

Requests have IDs, deadlines, and bounded retries. A lost response is retried with the same ID; the running worker returns its cached result instead of repeating the action. Recent results remain available for at least two minutes after their request deadline:

```json
{ "name": "browser_result", "arguments": { "request_id": "<uncertain request ID>" } }
```

An `outcome_unknown` response or an unknown result does not mean the action failed to execute. Inspect the page before deciding whether to repeat a click or submission. Results are held in memory; restarting the worker creates a new browser and invalidates old commands. Results are limited to 2 MiB; screenshots cover the viewport and use JPEG compression.

## Keep working when WebRTC is unavailable

For automatic browser routing, create a new group with a private relay configuration:

```sh
npx vdon-mcp-browser --setup ./private-browser --transport auto --relay-config /private/relay.json
```

The relay file uses `{ "url": "https://relay.example.com", "token": "<access token>" }`. You can reuse a ninja-p2p relay configuration and the same hosted relay service; setup creates a separate browser room and encryption key. Mailbox credentials and OAuth connections are separate and are not used here.

`auto` prefers an available WebRTC data channel. If a request needs retrying, it tries the other available route with the same encrypted request and ID. One worker owns the result cache and control leases across both routes. After a WebRTC timeout, new requests prefer HTTP for 30 seconds while the direct connection recovers. Tool results report which route replied.

Use `--transport http` for HTTP only, or `--transport webrtc` for direct connections only. An automatic participant can reach a participant using either one of those routes, provided their connection and browser credentials match. Both routes carry commands, results, and screenshots; live media still needs WebRTC.

For an existing group, set `connection.transport` to `"auto"` or `"http"` in its files, and supply the same relay settings to each participating process. These environment variables override the generated settings:

- `VDON_MCP_RELAY_URL`: your HTTPS relay origin.
- `VDON_MCP_RELAY_TOKEN`: relay access token.
- `VDON_MCP_RELAY_KEY`: room encryption key.

Follow the [relay setup guide](http-relay.md) to host a compatible relay. Browser credentials remain separate from relay credentials; sharing a room key does not grant browser access. Automatic routing applies to this browser adapter; ordinary Ninja MCP room sessions select their transport explicitly.

## Watch live tab audio and video

Add this option to `worker.json`, then restart:

```json
"media": { "enabled": true }
```

Call `browser_media` to get track status and a private VDO.Ninja viewing link. The host captures only the shared tab, including its audio, through Chrome tab capture and publishes it using the VDO.Ninja SDK. The publisher uses a separate browser context and fresh media credentials on every worker start. Microphone and desktop capture are not enabled. Recording is off.

Anyone holding the viewing link can watch and hear that stream. Share it only with intended viewers; restart the worker to replace the link. Media access does not grant control. The capture persists when the shared tab navigates, so stop the worker before opening content you do not want viewers to see.

Live media requires WebRTC even when commands use HTTP. If `browser_media` reports unavailable media or an ended track, use `browser_observe` screenshots and restart after restoring capture or connectivity. An optional `media.host` selects a different SDK signaling endpoint; clients then receive connection settings instead of a default VDO.Ninja link.

For a speaking agent that sees selected browser frames and uses these tools, open the optional [browser companion](browser-agent.md). Live viewing and model sharing have separate controls.

## Choose the host's access deliberately

All configured viewers can see the shared tab, and controllers can interact with sites using the host's network access. Run the worker under an account or container with only the network and filesystem access you intend to share. A separate Chrome profile is not an operating-system sandbox. Avoid signing into personal accounts in this shared tab.

Browser requests and results use a separate AES-GCM key for each client over either transport. Keep credential files private. Removing a client requires updating the host configuration and restarting; possession of that client's file grants its configured role until then.

The adapter uses the pinned [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) release and [VDO.Ninja SDK](https://sdk.vdo.ninja/). Chrome runs with its sandbox enabled. The worker binds no public browser-control port and changes no ordinary Ninja MCP transport defaults.
