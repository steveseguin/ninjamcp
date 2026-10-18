# Integrating remote SSApp control

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/ssapp-integration.html)

Use Ninja MCP to let an authorized agent on another computer operate an existing Social Stream Ninja
Standalone (SSApp) instance: manage sources, diagnose capture, inspect windows, and use browser input.
The bridge forwards SSApp's `ssapp_*` tool schemas, structured results, and MCP images.

## Set up remote access

Use SSApp with **API 1.4.1 and MCP adapter 1.3.1 or newer**. Enable **File > Local AI / Automation**,
restart SSApp, and save **Copy MCP Setup** as a private JSON file on that computer.
The bridge checks these versions when it connects. If an installed build lacks them,
run SSApp from its [current source checkout](https://github.com/steveseguin/ssn_app)
and copy that instance's MCP setup.
Install Ninja MCP on the host and each agent computer. Node.js 18 or newer is required by the bridge.

On the SSApp host:

```bash
npx vdon-mcp-ssapp --setup ./private-ssapp --adapter-config ./ssapp-mcp.json
npx vdon-mcp-ssapp --worker --config ./private-ssapp/worker.json
```

The generated folder contains separate controller credentials for `agent1` and `agent2`, an
observe-only `viewer`, and a local MCP registration example. Keep `worker.json` on the host.
Give each agent only its own JSON file through a private channel. Protect the folder with your
operating system's file permissions; these files grant access to the app.

On the agent computer, register a separate stdio MCP server using `vdon-mcp-ssapp --config`
and the absolute path of that agent's JSON file. When using the generated `mcp-client.json`,
adjust the executable, script and credential paths to their locations on that computer.

```bash
npx vdon-mcp-ssapp --doctor --config ./agent1.json
```

WebRTC is the default. To prefer WebRTC with HTTP fallback, add `--transport auto` and
`--relay-config ./relay.json` to the setup command. For machines without native WebRTC, install
with `npm install @vdoninja/mcp --omit=optional` and use `--transport http`.
The private relay file supplies `url` and `token` for your [HTTP relay](http-relay.md);
setup generates a new room encryption key. The host needs an allowed outbound route, with no
public SSApp port, VPN, or desktop sharing server.

For a source checkout, use `node scripts/vdo-mcp-ssapp.js` in place of the installed command.
The copied adapter configuration must contain one SSApp server with an absolute executable path.
A source adapter can use the absolute path to Node with
`["/absolute/ssapp/resources/ssapp-mcp.js"]` as its arguments. Set its
`env.SSAPP_CONTROL_URL` if SSApp uses a non-default loopback port.

### Use the remote tools

1. Call `ninja_ssapp_status`, then `ssapp_get_capabilities` and `ssapp_list_browser_targets`.
2. Inspect a target or capture a screenshot. Observations do not require a control lease.
3. Call `ninja_ssapp_claim` before changing the app. Use the normal `ssapp_*` arguments,
   including `confirm: true` for an authorized action where its schema requires it.
4. Observe the result, then call `ninja_ssapp_release` so another agent can take over.

The lease covers the whole app. It lasts 60 seconds by default; renew with `ninja_ssapp_claim`
before it expires, or supply `ttl_ms` between 1000 and 120000. Other agents can observe while
one controls. On the host, enter `revoke` to release control or `stop` to stop the bridge.
Stopping the bridge leaves SSApp and its sources running.

After SSApp restarts, call status again, list fresh targets, inspect them, and reclaim control.
For an uncertain result, inspect the app and use `ninja_ssapp_result` with the returned
`request_id` before repeating an action. If control was suspended after an adapter failure,
claim with `reconciled: true` only after checking its outcome.

### Choose permissions

In the host's `worker.json`, each client has a `role` of `controller` or `observer`.
An optional `tools` array restricts that client's allowed `ssapp_*` tool names. Restart the
worker after changing permissions. Policies apply on the host even to tools omitted from discovery.
Permissions cover tools across the app, not individual sources or windows; grant controller
access only to agents allowed to operate that scope.

Host file selection is disabled by default. Set `allowHostFiles: true` for a specific client
to allow the file chooser and dialog tools to use authorized absolute paths on the host.
Remote file staging is not provided; place a file on the host through a separately authorized
transfer before selecting it. Use `ssapp_browser_screenshot` for remote viewing: the local
`ssapp_browser_frame_stream` endpoint is not forwarded, and SSApp audio/video streaming is
not part of this bridge.

## Existing interfaces and responsibilities

| Component | Responsibility |
| --- | --- |
| SSApp | Owns sources, logged-in sessions, Electron windows, capture, diagnostics, and local controls. |
| SSApp MCP adapter | Exposes the `ssapp_*` schemas, tool results, image content, and runtime compatibility checks. |
| Ninja MCP | Connects the remote agent to a host, authenticates requests, manages control ownership, and transports results. |
| VDO.Ninja SDK | Provides WebRTC peer connectivity and data/media transport, with TURN where needed. |
| ninja-p2p | Optional persistent agent inboxes, handoffs, wake hooks, and team coordination. |

The SDK's [existing Social Stream integration](https://sdk.vdo.ninja/#social-stream-ninja) connects to
SSN's chat stream as a dock peer. ninja-p2p also has a chat bridge using SSN's WebSocket API. Those
interfaces serve audience messages and existing SSN actions. The new SSApp browser controls are
available through its local API/MCP interface; a normal chat connection does not expose them.

Keep chat access and app-control authorization separate. Joining an SSN session, receiving a chat
message, or sharing an agent room must not authorize keyboard input into a sign-in window.
Ninja MCP and ninja-p2p use different application envelopes; a common room name is not an adapter.

### Sources of truth

Read these files when implementing or updating the adapter; derive schemas from code rather than
maintaining a second handwritten tool definition list.

| Location | Contract or implementation |
| --- | --- |
| SSApp `resources/ssapp-mcp.js` | Tool definitions, normalization, MCP results, HTTP client, compatibility checks. |
| SSApp `resources/electron-control-api.js` | API version, command definitions, HTTP routes, operations, SSE. |
| SSApp `resources/browser-control-service.js` | Shared browser schemas, targets, input, screenshots, menus, files, live frames. |
| SSApp `resources/source-observation-service.js` | Source diagnostics, captured events, semantic inspection, screenshot capture. |
| SSApp `resources/app-window-control-service.js`, `resources/app-dialog-service.js` | App-owned window and dialog controls. |
| SSApp `bootstrap.js`, `main.js` | Packaged MCP launch, opt-in setup, loopback binding, routing and lifecycle. |
| Social Stream `docs/skills/control-social-stream/` | Canonical operating skill, API/browser references, version history. |
| Ninja MCP [browser RPC](../scripts/lib/browser-rpc.js) | Per-client encrypted requests, request IDs, deadlines, result chunks and retry cache. |
| Ninja MCP [browser worker](../scripts/lib/browser-worker.js) | Existing Chrome backend, controller roles and tab leases. |
| Ninja MCP [browser entry point](../scripts/vdo-mcp-browser.js) | Host/client setup, MCP tool exposure and transport connection. |
| Ninja MCP [bridge session](../scripts/lib/bridge-session.js) | WebRTC and HTTP transport integration. |

Repositories: [SSApp](https://github.com/steveseguin/ssn_app),
[Social Stream](https://github.com/steveseguin/social_stream),
[SDK](https://github.com/steveseguin/ninjasdk),
[ninja-p2p](https://github.com/steveseguin/ninja-p2p).
Use local source files for capabilities that have not reached the published repository yet.
The canonical [control skill](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/SKILL.md)
links its [API reference](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/control-api.md),
[browser controls](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/browser-control.md)
and [version log](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/version-log.md).

## Connect to the local app

1. Start SSApp on the computer whose windows will be controlled.
2. Enable **File > Local AI / Automation** and restart SSApp.
3. Use **Copy MCP Setup** from that menu for the installed app's executable and arguments.
4. Call `ssapp_get_capabilities`, then `ssapp_get_status`.

The packaged executable accepts `--ssapp-mcp` to run its stdio adapter, using Electron's bundled
Node runtime. This mode does not launch the ordinary app or enable its API; SSApp must also be
running with automation enabled. Installed-app use does not require a separate Node installation.
For development, `node <ssapp-checkout>/resources/ssapp-mcp.js` runs the same adapter.

| Setting | Meaning |
| --- | --- |
| `http://127.0.0.1:17777` | Default API origin; intentionally tokenless and loopback-only. |
| `--ssapp-control-api` / `SSAPP_CONTROL_API=1` | Enable the local control API. |
| `--ssapp-control-port=17777` / `SSAPP_CONTROL_PORT` | Select the app's listening port. |
| `--ssapp-headless-control` / `SSAPP_HEADLESS_CONTROL=1` | Hide app windows; does not enable the API by itself. |
| `SSAPP_CONTROL_URL` | MCP adapter's API origin; only `http://127.0.0.1:PORT` is accepted, without credentials, path, query or fragment. |
| `SSAPP_MCP_REQUEST_TIMEOUT_MS` | Local adapter request timeout, bounded to 100–35000 ms; default 35000 ms. |

Do not use the legacy `--remote-control` renderer-execution harness as the integration API.
Do not change the loopback bind or the adapter URL restriction to support a remote client.

### Compatibility and wire formats

The remote-control baseline is **SSApp 0.4.37 with API 1.4.1 and MCP adapter 1.3.1**.
Earlier builds sharing the app version can lack the controls. Read `payload.commands` from
capabilities and keep `ssappVersion`, `apiVersion`, and the MCP server version distinct.
SSApp's adapter currently reports MCP protocol `2025-06-18` during initialization.

The MCP tool list remains discoverable while SSApp is offline. A listed tool is not proof that
the running app supports it. Preserve the adapter's availability checks and offline errors.
Browser, app-window and dialog tools can run without first checking renderer-dependent capabilities;
the bridge must preserve this route so a blocking prompt can be answered.

The local HTTP interface includes:

| Route | Use |
| --- | --- |
| `GET /api/v1/instance` | Renderer-independent app instance and versions; the bridge binds local calls with `X-SSApp-Instance-Id`. |
| `GET /api/v1/capabilities` | Commands, platforms, modes, settings and versions. |
| `GET /api/v1/status` | App and source state. Status fields are top-level rather than a universal `payload` wrapper. |
| `POST /api/v1/command` | A JSON object containing `action` and `value`. |
| `GET /api/v1/operations/OPERATION_ID` | Look up a retained operation. |
| `GET /api/v1/events` | Bounded SSE history; resume with `Last-Event-ID`. |

Command responses normally contain `ok` with `payload` or structured `error`, plus `ssappVersion`,
`apiVersion`, and `requestId`. Many mutations also return `meta.operationId`. Reload/shutdown and
navigation acknowledgements may describe an accepted request, not the completed user workflow.

MCP results include `content`, `structuredContent`, version `_meta`, and `isError` on failure.
Screenshots use MCP image content; their base64 bytes are removed from the parallel structured
result. These fields are forwarded intact. Diagnostics stay off stdout. Ninja MCP preserves caller
response IDs and adds transport metadata under `_meta.ninja`.

## Tool reference

Prefer a source/settings command when it directly expresses the task. Use browser input for
website and app interaction. General browser controls operate existing SSApp targets; they do
not grant control of other desktop applications or create an independent Chrome session.

### Browser targets and input

| MCP tool | HTTP action | Purpose |
| --- | --- | --- |
| `ssapp_list_browser_targets` | `listBrowserTargets` | Discover main UI, source, sign-in, popup and embedded browser surfaces. |
| `ssapp_browser_screenshot` | `captureBrowserScreenshot` | Capture a viewport and its coordinate mapping. |
| `ssapp_browser_inspect` | `inspectBrowserTarget` | Read visible text, frames and opaque element references. |
| `ssapp_browser_interact` | `interactBrowserTarget` | Click, focus, scroll, fill or press a basic key using an element reference. |
| `ssapp_browser_input` | `browserInput` | Mouse, keyboard, drag, selection, wheel and touch batches. |
| `ssapp_browser_navigate` | `navigateBrowserTarget` | HTTP(S) navigation, back, forward, reload and stop. |
| `ssapp_browser_window` | `setBrowserTargetWindow` | Show, hide, focus, minimize, maximize, restore, resize or close the owning window. |
| `ssapp_browser_choose_files` | `chooseBrowserFiles` | Select authorized host files for an HTML upload control. |
| `ssapp_browser_frame_stream` | `getBrowserFrameStream` | Local-only multipart JPEG endpoint; use screenshots remotely. |
| `ssapp_list_app_menu_items` | `listAppMenuItems` | Discover application menu items and a target's captured context menu. |
| `ssapp_invoke_app_menu_item` | `invokeAppMenuItem` | Invoke an item using its returned path and exact label. |

Discover `targetId` values such as `wc:7`; never invent or persist them across app restarts.
Target entries include `windowId`, `sourceId` when available, `tabId`, parent window, kind, title,
redacted URL, loading/visibility/focus state and zoom. Source IDs identify configured sources;
window, tab and target IDs identify runtime objects and are not interchangeable.
Re-list after popups open, windows close, or SSApp restarts. Virtual sources can have diagnostics
and captured events without any browser target or screenshot.

Native input targets browser content without moving the operating-system pointer. Hidden targets
remain controllable. Showing/focusing is explicit and restricted in headless mode. Window resizing
uses Electron content dimensions, which may differ from CSS viewport dimensions under zoom.

### Source, settings, diagnostics, windows and dialogs

Keep the existing tools available alongside browser controls:

| Task | MCP tools |
| --- | --- |
| Discovery | `ssapp_get_capabilities`, `ssapp_get_status`, `ssapp_list_sources`, `ssapp_get_source` |
| Source configuration | `ssapp_add_source`, `ssapp_update_source`, `ssapp_remove_source`, `ssapp_set_source_connection_mode` |
| Source lifecycle | `ssapp_start_source`, `ssapp_stop_source`, `ssapp_reload_source`, `ssapp_start_all_sources`, `ssapp_stop_all_sources`, `ssapp_reload_all_sources` |
| Source presentation | `ssapp_set_source_mute`, `ssapp_toggle_source_mute`, `ssapp_set_source_visibility`, `ssapp_toggle_source_visibility` |
| Settings and operations | `ssapp_get_settings`, `ssapp_update_settings`, `ssapp_get_operation` |
| Capture diagnostics | `ssapp_get_source_diagnostics`, `ssapp_get_recent_source_events`, `ssapp_wait_for_source_events` |
| Source-page workflows | `ssapp_capture_source_screenshot`, `ssapp_inspect_source_page`, `ssapp_interact_source_page`, `ssapp_reload_source_page`, `ssapp_show_source_for_human` |
| App windows | `ssapp_list_app_windows`, `ssapp_capture_app_window_screenshot`, `ssapp_inspect_app_window`, `ssapp_interact_app_window`, `ssapp_set_app_window_visibility` |
| Dialogs | `ssapp_get_pending_app_dialogs`, `ssapp_wait_for_app_dialog`, `ssapp_respond_to_app_dialog` |
| App lifecycle | `ssapp_reload_app`, `ssapp_shutdown` |

Use live platform/settings capabilities. Stop an active source before changing inactive-only
configuration; use dedicated mute/visibility commands for live changes. The local MCP adapter
defaults a mode-less TikTok add to WebSocket Auto; forwarding through that adapter preserves
this behavior, while a direct HTTP implementation would need to account for its different defaults.

Captured-event queries have cursors, bounded history and a `historyLost` indicator; waits allow up
to 25 seconds. These are captured-output observations, not an independent record of all incoming
platform messages. Preserve cursors and gap information and avoid treating a connected or quiet
source as proof of successful capture.

## Observation and interaction rules

1. Discover the target and inspect or screenshot it.
2. If choosing a point from an image, send that screenshot's `screenshotId` with the image pixel
   coordinates. SSApp maps them to the viewport. Without it, coordinates are viewport CSS pixels.
3. Execute a bounded input batch with `confirm: true` for an authorized workflow.
4. Inspect the resulting state. Re-observe after navigation, scrolling, layout changes or resizing.

Example MCP call after replacing the target, screenshot ID and coordinates with observed values:

```json
{
  "name": "ssapp_browser_input",
  "arguments": {
    "targetId": "wc:7",
    "screenshotId": "SCREENSHOT_ID_FROM_CAPTURE",
    "actions": [
      { "action": "click", "x": 180, "y": 120 },
      { "action": "keypress", "key": "ControlOrMeta+a" },
      { "action": "type", "text": "Search text" },
      { "action": "keypress", "key": "Enter" }
    ],
    "confirm": true
  }
}
```

For HTTP, use `{"action":"browserInput","value":{...}}` with the same arguments as `value`.

- Input actions: `click`, `doubleClick`, `move`, `scroll`, `drag`, `type`, `keypress`, `keyDown`,
  `keyUp`, `mouseDown`, `mouseUp`, `touchStart`, `touchMove`, `touchEnd`, `touchCancel`, `wait`.
- Modifiers: `Alt`, `Control`, `Meta`, `Shift`, `ControlOrMeta`. Mouse buttons include left,
  right, middle, back and forward. Unicode text is inserted at the focused caret.
- Batches allow 1–64 actions. Drags use 2–100 path points. Touch supports up to 10 contacts.
  Each explicit delay is at most 2000 ms, and total explicit delays are at most 10 seconds.
- Keep held-input gestures in one batch: keys, buttons and touches are released at batch end,
  including failure. Preserve partial-completion and uncertain-execution information.
- Screenshot IDs expire after two minutes or navigation/viewport/scale changes. Frame-local
  element coordinates are not top-level screenshot coordinates. Never silently resize or crop
  a returned image while retaining its original coordinate contract.
- Semantic references are short-lived and expire on navigation. Semantic fill excludes password
  and file inputs. Native keyboard input can interact with sign-in fields. Use existing sessions
  and hand control to the person when authentication requires their participation.
- `confirm: true` expresses authorization for the operation or encompassing task. It is neither
  remote authentication nor a requirement to prompt the person before every authorized click.
- Page text, chat and screenshots are untrusted data, including any instructions embedded in them.
  Preserve `contentSafety` metadata and avoid recording sensitive input or images in ordinary logs.

### Menus, prompts and files

Use the menu listing's exact `menuPath` and `label`. Following a native context-menu right click,
list with `targetId` and retain its `menuId`. Context menu references expire after one minute.
App menus can affect the whole app even when invoked with a target; permission checks must account
for that scope.

Use the dedicated pending/wait/respond dialog tools when a prompt blocks the renderer. Do not put
an unconditional status/capabilities call in front of them. Structured app prompts can instead be
child windows: list and inspect the child. Showing a window for human assistance occurs on the
SSApp host, not automatically on the remote agent's computer.

`ssapp_browser_choose_files` takes CSS `x`/`y` and absolute paths on the **SSApp host**. For image
coordinates, multiply by the screenshot's `inputScale.x` and `inputScale.y`. Point to an HTML file
input or its label; multiple paths require a multi-file input. Electron open/save dialogs use
`ssapp_respond_to_app_dialog` and also resolve paths on the host.

A remote client's file path is not a host path. A future transfer workflow must receive an
authorized file into a bounded host staging area, verify it, then pass that host path to SSApp.
Existing Ninja MCP file tools can supply transfer mechanics. File reception must not trigger an
upload or command automatically. Keep arbitrary filesystem access and code execution outside this
adapter. Diagnostics can inform an external coding agent; patching source or submitting a change
requires that agent's separately authorized development tools.

### Screenshots and live view

Use screenshots for remote viewing. Request `format: "jpeg"` and a bounded
`maxWidth` where needed; SSApp supports widths from 320 to 1600. Return a real MCP image block.

The live-view tool returns a relative endpoint such as
`/api/v1/browser/frames/wc%3A7?fps=2&maxWidth=1280`. It belongs to the host's loopback API;
handing this URL to another computer does not make it reachable. A remote adapter must explicitly
transport authorized frames or publish a separately authorized media stream.

Current SSApp live view is multipart JPEG, 1–5 fps, at most two connections, and has no audio.
Capture runs only while connected; close the host stream when its viewer disconnects or loses
permission. Preserve backpressure and use a fresh screenshot for coordinate input. Ninja MCP's
Chrome audio/video publisher is specific to its Chrome tab and cannot be assumed to capture SSApp.
A model needs a compatible media adapter to interpret continuous audio/video; ordinary MCP image
tools are sufficient for screenshot-based control.

## Transport and recovery

The external host worker launches SSApp's configured local MCP adapter and forwards authenticated
requests. Remote callers cannot choose executables, environment variables, API URLs, or raw debug
commands. SSApp's API remains on loopback. Per-client encryption is separate from the room key;
an SSN chat session or ordinary Ninja room membership does not grant app control.

The worker checks the running app's instance ID before admitting work. The local adapter also
sends that ID on each HTTP request, so a restart between discovery and dispatch rejects stale
commands. Local clients that omit the instance header continue using the ordinary local API.

Ordinary mutations run in order with at most eight queued calls. Observations and dialog responses
can run concurrently so a long wait does not prevent prompt recovery. Revocation and lease expiry
reject queued mutations; an action already dispatched to SSApp may finish. Graceful client shutdown
releases control. Abrupt disconnects are detected by the transport; lease expiry also bounds control
ownership while that detection is pending.

The `auto` route prefers WebRTC and can retry through the configured HTTP relay using the same
request identity. The worker returns cached results for duplicate delivery. Its process-local
cache retains results through the request deadline plus two minutes. This does not guarantee
exactly-once execution across a worker or app restart: an unknown result requires inspection before
retrying. Delivery, accepted commands, and completed work are separate outcomes. Use SSApp's
operation tools when a response returns an operation ID.

| Limit | Action |
| --- | --- |
| Encrypted request: 65000 base64 characters | Reduce a large input batch before sending. Held-input gestures are never split automatically. |
| SSApp remote result: 10 MiB; chunks: 24000 bytes | Use JPEG or a smaller screenshot when a result is too large. Results and images are never silently truncated. |
| Local adapter: 35 s; remote request: 60 s | After timeout, look up the request and inspect app state before repeating a mutation. |
| At most 16 pending transport requests | Keep concurrent observations bounded and release control when finished. |

The separate Chrome adapter retains its own 2 MiB result limit and browser-specific tools.
Ninja MCP message, file, and shared-state workflows remain separate from SSApp control.
For continuing agent inboxes and handoffs, use ninja-p2p; receiving a handoff does not automatically
authorize an SSApp operation.
