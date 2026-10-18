# SSApp remote capability matrix

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/ssapp-capability-matrix.html)

Use this matrix to implement and validate complete remote workflows in Social Stream Ninja Standalone
(SSApp). Start with the [remote setup guide](ssapp-integration.md), then select the workflow and row IDs
that apply. Each row defines the intended behavior, current integration route, remaining work, and an
observable acceptance check. The scope is SSApp and its owned surfaces; external desktop applications,
model execution, and repository publishing have separate owners.

## Reading and maintaining the matrix

The implementation baseline is SSApp **0.4.38**, control API **1.4.1**, local MCP adapter **1.3.1**,
and Ninja MCP **0.4.2** with the SSApp backend. Runtime discovery is authoritative. A package version
alone does not establish that a particular source mode, permission, or workflow is available.

Settings-export support requires the updated 0.4.38 development build advertising API 1.5.0 /
MCP 1.4.0 and the Ninja MCP settings-export helper. See the [backup workflow](ssapp-integration.md#retrieve-a-settings-backup).
The existing 0.4.38 release does not imply these additional commands are available.

| State | Meaning and action |
| --- | --- |
| Implemented | A supported code path exists through the remote bridge. Run the stated acceptance check for the intended environment. |
| Partial | Some required behavior exists; the row identifies the remaining part. |
| UI path | The application has a relevant UI and generic controls can reach it, but no dedicated complete command contract exists. Exercise the whole workflow before relying on it. |
| Missing | No SSApp integration route provides the described capability. Implement it before advertising support. |
| External | A cooperating application, model harness, human, or development tool owns this part. Document and validate the handoff. |

Implementation and validation are separate dimensions. Record verification as **Not run**, **Supporting
check**, **Local app verified**, **Remote app verified**, **Inconclusive**, or **Failed**, using the
[evidence record](#evidence-record). Do not infer a passed remote workflow from forwarding its schema.
Preserve stable row IDs when adding or splitting requirements.

Priorities describe delivery order: **P0** = dependable remote control; **P1** = broad app workflows and
operational completeness; **P2** = optional live media, advanced sharing, and development extensions.
An implemented P0 row still needs regression validation. Optional P2 features need not block a clearly
scoped claim of complete screenshot-based app control.

References such as N1 and S3 resolve in the [implementation reference map](#implementation-reference-map).
N = Ninja MCP, S = SSApp, C = Social Stream, E = external adapter. V01–V12 are reusable validation
procedures below; each row adds its particular expected result. Owner names indicate where to make
a change, not permission to change unrelated behavior.

## 1. Connection, identity and discovery

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-d01"></a>D01 | Connect to an explicitly enabled SSApp without opening a public app port. | Implemented / P0 | Ninja [N1](#n1)–[N3](#n3); SSApp [S1](#s1)–[S2](#s2) | Preserve localhost binding and separate remote credentials. | [V01](#validation-v01): remote status works; disabled app has no control listener; bridge stop leaves app running. |
| <a id="cap-d02"></a>D02 | Identify the running app instance and all relevant versions. | Implemented / P0 | `ninja_ssapp_status`; `/api/v1/instance`; [N2](#n2), [S2](#s2) | Keep app, API, adapter and bridge versions distinct. | [V01](#validation-v01)/[V05](#validation-v05): restart app; instance changes and old mutations fail before dispatch. |
| <a id="cap-d03"></a>D03 | Discover actual tools, argument schemas and result shapes. | Implemented / P0 | `tools/list`; `ssapp_get_capabilities`; [N1](#n1)–[N2](#n2), [S1](#s1) | Tool listing while offline does not imply runtime support. | [V01](#validation-v01): compare permitted local/remote catalogs and unsupported-action errors. |
| <a id="cap-d04"></a>D04 | Distinguish offline, loading, ready and prompt-blocked states. | Partial / P0 | status, capabilities and dialog tools; [S1](#s1)–[S2](#s2), [S5](#s5) | Readiness is spread across interfaces; preserve recovery tools during capability timeouts. | [V01](#validation-v01)/[V03](#validation-v03): each induced state produces actionable status without trapping prompt recovery. |
| <a id="cap-d05"></a>D05 | Discover effective role, tool permissions and control owner. | Implemented / P0 | `ninja_ssapp_status`; [N2](#n2) | Scope is app-wide tools, not selected sources. | [V06](#validation-v06): observer/controller/restricted client receive accurate permissions and lease owner. |
| <a id="cap-d06"></a>D06 | Address multiple configured instances without confusing them. | Partial / P1 | Separate worker configs, origins and credentials; [N1](#n1)–[N2](#n2) | No unified instance directory; configure one worker endpoint per instance. | [V01](#validation-v01): two isolated apps with different ports; calls affect only their configured instance. |
| <a id="cap-d07"></a>D07 | Diagnose invalid configuration and unreachable app connections. | Implemented / P0 | `vdon-mcp-ssapp --doctor`; [N1](#n1) | Doctor is a connectivity check, not a capture test. | [V01](#validation-v01): bad executable, offline app, bad credential and blocked route return non-success with useful cause. |
| <a id="cap-d08"></a>D08 | Learn unsupported remote features before attempting work. | Partial / P1 | [N2](#n2) discovery `live_frames: false`; explicit errors | Local frame-stream tool can still appear in the forwarded catalog; reconcile availability messaging. | [V01](#validation-v01): client can distinguish unsupported remote frames from a temporarily offline target. |

## 2. Targets and surface coverage

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-s01"></a>S01 | Find the main app, source, sign-in, popup and embedded targets. | Implemented / P0 | `ssapp_list_browser_targets`; [S3](#s3), [S6](#s6) | Discovery covers SSApp-owned browser contents. | [V02](#validation-v02): independently enumerate fixture surfaces; every expected controllable surface is listed. |
| <a id="cap-s02"></a>S02 | Associate targets with source, window, tab and parent identities. | Partial / P0 | [S3](#s3) target metadata; [N2](#n2) instance binding | Some associations are nullable; do not treat target, source and session IDs as interchangeable. | [V02](#validation-v02): follow popup lineage and known source; ambiguous associations remain explicit. |
| <a id="cap-s03"></a>S03 | Discover newly opened windows and remove closed targets. | Implemented / P0 | Re-list browser targets; [S3](#s3) | Poll/re-list; no dedicated remote target lifecycle subscription. | [V02](#validation-v02): open/close popups repeatedly; fresh list matches and stale IDs fail clearly. |
| <a id="cap-s04"></a>S04 | Automatically notify an agent when targets appear or disappear. | Missing / P1 | Add scoped lifecycle events in [S2](#s2)/[S3](#s3) and [N1](#n1) | Existing captured-source event tools are not a general target event stream. | [V02](#validation-v02)/[V05](#validation-v05): exactly one ordered lifecycle notice per transition, with resync after gaps. |
| <a id="cap-s05"></a>S05 | Control hidden/minimized/background surfaces without stealing desktop focus. | Implemented / P0 | [S3](#s3) input; [S4](#s4) screenshot preparation | Showing/focusing remains explicit; distinguish temporary capture preparation from user-visible activation. | [V02](#validation-v02)/[V10](#validation-v10): interact and capture; independent host focus/visibility remains as intended. |
| <a id="cap-s06"></a>S06 | Observe virtual sources that have no rendered browser window. | Implemented / P0 | source status, diagnostics and events; [S4](#s4), [C1](#c1) | Return no-window errors for screenshots, not a fabricated target. | [V07](#validation-v07): virtual source remains diagnosable without a browser surface. |
| <a id="cap-s07"></a>S07 | Handle authentication or links that leave the owned app surfaces. | External / P1 | Human or separately authorized browser adapter; [S6](#s6) | Do not advertise arbitrary desktop/browser control through SSApp. | [V03](#validation-v03): external step is identified; handoff and return to correct source are explicit. |
| <a id="cap-s08"></a>S08 | Continue through nested overlays, tooltips and modal child windows. | Partial / P0 | inspection, hover, target listing; [S3](#s3)–[S5](#s5) | Dynamic UI requires fresh observation; test each modal type rather than assuming coverage. | [V02](#validation-v02)/[V03](#validation-v03): interact with foreground modal without accidentally activating covered content. |

## 3. Observation and page understanding

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-o01"></a>O01 | Return actual screenshots as MCP images with metadata. | Implemented / P0 | `ssapp_browser_screenshot`; [S1](#s1), [S3](#s3); [N1](#n1)–[N2](#n2) | Preserve image blocks and avoid duplicating bytes in structured text. | [V02](#validation-v02)/[V05](#validation-v05): image decodes, matches fixture and retains metadata across remote transport. |
| <a id="cap-o02"></a>O02 | Map resized image coordinates correctly under zoom and display scaling. | Implemented / P0 | `screenshotId`, viewport, `inputScale`; [S3](#s3) | Never resize/crop a transported image without a matching coordinate contract. | [V02](#validation-v02): click known grid cells at several widths, zoom levels and host display scales. |
| <a id="cap-o03"></a>O03 | Inspect visible text, semantic controls and frame content. | Implemented / P0 | `ssapp_browser_inspect`; [S3](#s3)–[S4](#s4) | Bounded text/elements; this does not return full DOM, selectors or input values. | [V02](#validation-v02): known labels/roles appear across frames; unrelated hidden/private values remain excluded. |
| <a id="cap-o04"></a>O04 | Inspect late-mounted controls beyond the first element limit. | Implemented / P0 | `elementOrder: "reverse"`; [S4](#s4) | Reverse ordering is not general semantic pagination. | [V02](#validation-v02): late modal control is reachable on an element-heavy page. |
| <a id="cap-o05"></a>O05 | Reject stale screenshots and element references. | Implemented / P0 | [S3](#s3) screenshot generation; [S4](#s4) opaque refs | Scrolling/layout changes still require re-observation even when a token remains valid. | [V02](#validation-v02): navigation/resize/expiry reject old references; new observation succeeds. |
| <a id="cap-o06"></a>O06 | Wait for a particular element, URL or page-state condition. | Partial / P1 | Current inspect/status polling; [S3](#s3)–[S4](#s4) | Add bounded condition waits if needed; no dedicated general wait-for-element tool. | [V02](#validation-v02): delayed control succeeds within deadline; absent control times out without input. |
| <a id="cap-o07"></a>O07 | Read long pages or virtual lists without overlooking later content. | Partial / P1 | scrolling plus repeated inspection; [S3](#s3) | No complete full-page/virtual-list export contract; track progress and repeated items. | [V02](#validation-v02): fixture's first/middle/last items observed; termination does not falsely imply full coverage. |
| <a id="cap-o08"></a>O08 | Produce focused crops or changed-region observations efficiently. | Missing / P2 | Future [S3](#s3) capture options and N transport | Preserve crop origins, timestamp and screenshot identity if introduced. | [V08](#validation-v08): chosen region matches host; coordinate input still lands correctly. |
| <a id="cap-o09"></a>O09 | Return bounded, redacted observations with untrusted-content markers. | Implemented / P0 | [S1](#s1), [S4](#s4); [N1](#n1) preserves results | Screenshots can visibly contain private data; metadata is not pixel redaction. | [V06](#validation-v06): test secrets in URLs/fields and hostile page text; allowed output retains safety metadata. |

## 4. Mouse, keyboard and touch

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-i01"></a>I01 | Click with left/right/middle buttons and double-click. | Implemented / P0 | `ssapp_browser_input`; [S3](#s3) | Use observed viewport/image coordinates. | [V02](#validation-v02): fixture event type, button and click count match each action exactly. |
| <a id="cap-i02"></a>I02 | Hover and activate hover-dependent controls. | Implemented / P0 | `move`; [S3](#s3) | Re-observe after hover changes layout. | [V02](#validation-v02): tooltip/submenu appears and intended item becomes reachable. |
| <a id="cap-i03"></a>I03 | Scroll vertically/horizontally in the intended container. | Implemented / P0 | `scroll`; [S3](#s3) | Wheel coordinates choose the receiving surface. | [V02](#validation-v02): nested panel scrolls while unrelated page position is unchanged. |
| <a id="cap-i04"></a>I04 | Drag sliders, text selections and reorderable items. | Implemented / P0 | `drag`, mouse down/move/up; [S3](#s3) | Keep held gestures in one batch. | [V02](#validation-v02): final value, selected text and item order match independently known fixture state. |
| <a id="cap-i05"></a>I05 | Perform HTML drag-and-drop with browser drag data. | Implemented / P0 | [S3](#s3) drag interception | Native OS file dragging is a different workflow; use file chooser tools. | [V02](#validation-v02): drop event and payload arrive once at intended target, including cancelled drag. |
| <a id="cap-i06"></a>I06 | Insert Unicode, emoji and non-English text. | Implemented / P0 | `type`; [S3](#s3) | Unicode insertion is not OS IME composition testing. | [V02](#validation-v02): compare resulting text code points with fixture input, including identical repeated text. |
| <a id="cap-i07"></a>I07 | Use shortcuts, held modifiers and shifted punctuation. | Implemented / P0 | `keypress`, `keyDown`, `keyUp`; [S3](#s3) | `ControlOrMeta` follows host platform; keyboard layout/IME coverage needs separate cases. | [V02](#validation-v02)/[V10](#validation-v10): selection, shortcut effect, case and punctuation are correct on each claimed host OS. |
| <a id="cap-i08"></a>I08 | Navigate forms, focus, edit, select and replace text. | Implemented / P0 | input plus semantic interaction; [S3](#s3)–[S4](#s4) | Input-value extraction is intentionally unavailable; verify visible result or fixture oracle. | [V02](#validation-v02): Tab/Shift-Tab/arrows/Home/End/Enter/Escape achieve the expected form state. |
| <a id="cap-i09"></a>I09 | Send touch and multiple-contact gestures. | Implemented / P1 | `touchStart/Move/End/Cancel`; [S3](#s3) | This is browser touch dispatch, not blanket touchscreen/OS emulation. | [V02](#validation-v02): contacts, movement and cancel are correct; no stuck touch after failure. |
| <a id="cap-i10"></a>I10 | Release held input and expose partial completion after failure. | Implemented / P0 | [S3](#s3) input cleanup and completed-action metadata | A completed action may have side effects even when later input fails. | [V02](#validation-v02)/[V05](#validation-v05): inject mid-batch failure; no held input remains and completion count is accurate. |
| <a id="cap-i11"></a>I11 | Validate whole batches and enforce bounded input work. | Implemented / P0 | schemas; [S1](#s1), [S3](#s3); remote size checks [N4](#n4) | 64 actions; 2 s per explicit delay, 10 s total; remote envelope can be smaller than local limits. | [V02](#validation-v02)/[V05](#validation-v05): invalid/oversize batch fails before any fixture event; valid boundary cases succeed. |
| <a id="cap-i12"></a>I12 | Copy/paste task data without reading unrelated host clipboard content. | Partial / P1 | Keyboard shortcuts only; [S3](#s3) | No isolated clipboard read/write contract; design an app/task buffer if needed. | [V02](#validation-v02)/[V06](#validation-v06): paste intended content; pre-existing unrelated clipboard data is not returned or leaked. |

## 5. Navigation and window management

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-n01"></a>N01 | Navigate to HTTP(S) URLs while preserving SSApp navigation handling. | Implemented / P0 | `ssapp_browser_navigate`; [S3](#s3), [S6](#s6) | Accepted navigation is not page-load completion. | [V02](#validation-v02): follow redirects, verify final target and preserve expected session behavior. |
| <a id="cap-n02"></a>N02 | Back, forward, reload and stop loading. | Implemented / P0 | navigation history; [S3](#s3) | Re-observe after transitions; old screenshot coordinates are invalid. | [V02](#validation-v02): controlled history sequence and slow page produce expected final state. |
| <a id="cap-n03"></a>N03 | Show/hide/focus/minimize/maximize/restore/resize windows. | Implemented / P0 | `ssapp_browser_window`; [S3](#s3) | Resizes use Electron content dimensions; headless visibility restrictions still apply. | [V02](#validation-v02)/[V10](#validation-v10): host bounds/state match; source remains active where intended. |
| <a id="cap-n04"></a>N04 | Close the intended surface with normal app close semantics. | Implemented / P0 | [S3](#s3) window action; [S6](#s6) lifecycle | Closing main window may hide it according to existing app behavior. | [V02](#validation-v02): child closes alone; main close follows settings and does not imply shutdown. |
| <a id="cap-n05"></a>N05 | Open the correct new source or sign-in window. | UI path / P0 | source commands and app controls; [S3](#s3), [S6](#s6), [C1](#c1) | No generic remote create-arbitrary-browser tool; use established app flows. | [V03](#validation-v03)/[V07](#validation-v07): correct partition/account/source is used and newly created target is discoverable. |
| <a id="cap-n06"></a>N06 | Handle page load failure, redirect loops and unexpected destinations. | Partial / P1 | loading state, screenshots, source errors; [S3](#s3)–[S4](#s4) | Add scoped navigation failure details if existing observations cannot distinguish causes. | [V02](#validation-v02)/[V09](#validation-v09): known failures are identified without endless retries or global compatibility changes. |
| <a id="cap-n07"></a>N07 | Change zoom and validate cross-display behavior. | UI path / P1 | normal menu/UI; [S3](#s3) menu and capture metadata | No dedicated set-zoom command; display movement may need a host-side handoff. | [V02](#validation-v02)/[V10](#validation-v10): changed zoom maps screenshots correctly and ordinary window behavior persists. |

## 6. Sign-in, prompts and native menus

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-a01"></a>A01 | Use the intended existing account and browser session. | UI path / P0 | SSApp sign-in/session UI; [S6](#s6), [C1](#c1) | Generic controls do not establish that every platform's authentication flow is covered. | [V03](#validation-v03): own test accounts remain isolated; expected account is active after return. |
| <a id="cap-a02"></a>A02 | Handle notices, consent screens and sign-in form controls. | UI path / P0 | semantic/native input; [S3](#s3)–[S4](#s4) | Existing session use first; do not request secret values in conversation. | [V03](#validation-v03): fixture plus authorized real platform flow reaches the intended page. |
| <a id="cap-a03"></a>A03 | Hand MFA/passkeys/CAPTCHA/private steps to a person and resume. | External / P0 | `ssapp_show_source_for_human`, window show; [S3](#s3), [S4](#s4) | Human participation occurs on host or a separately shared surface; no automatic bypass. | [V03](#validation-v03): pause clearly, complete human step, then continue the original source task once. |
| <a id="cap-a04"></a>A04 | Detect sign-in success, failure and expired authentication. | Partial / P0 | source diagnostics and page observation; [S4](#s4), [C1](#c1) | No universal authenticated/account-status command; platform-specific evidence is required. | [V03](#validation-v03)/[V09](#validation-v09): good/expired/wrong-account cases are distinguished with observable evidence. |
| <a id="cap-a05"></a>A05 | Answer JavaScript alert/confirm/prompt while renderer is blocked. | Implemented / P0 | pending/wait/respond dialog tools; [S5](#s5); [N2](#n2) bypass queue | Preserve the prompt recovery path during long operations. | [V03](#validation-v03): open a prompt with input, answer remotely, and verify exactly one result. |
| <a id="cap-a06"></a>A06 | Operate Electron message/open/save dialogs and structured child prompts. | Implemented / P0 | [S5](#s5) dialog tools; [S3](#s3)/[S5](#s5) child window controls | File paths require client host-file permission; cancellation is a distinct result. | [V03](#validation-v03)/[V04](#validation-v04): accept/cancel/checkbox/default choices and child inputs behave correctly. |
| <a id="cap-a07"></a>A07 | Discover and invoke application and context menus. | Implemented / P0 | `ssapp_list_app_menu_items`, `ssapp_invoke_app_menu_item`; [S3](#s3) | Use exact returned path/label; context menu IDs expire. | [V02](#validation-v02): right-click, list, invoke; disabled/stale item fails without unintended action. |
| <a id="cap-a08"></a>A08 | Hand control to a person without losing task context. | Partial / P1 | release/revoke; [N1](#n1)–[N2](#n2); host window controls | No unified human-assistance request/ack/resume protocol. | [V03](#validation-v03)/[V06](#validation-v06): person changes state; agent re-observes and resumes without replaying old input. |

## 7. Source configuration and application state

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-c01"></a>C01 | Discover supported platforms, identifiers, modes and settings. | Implemented / P0 | `ssapp_get_capabilities`; [C1](#c1), [S1](#s1)–[S2](#s2) | Read live platform definitions; do not assume common modes apply everywhere. | [V07](#validation-v07): unsupported mode is refused and source-specific defaults match capability output. |
| <a id="cap-c02"></a>C02 | Add/read/update/remove a source by stable ID. | Implemented / P0 | source commands; [S1](#s1), [C1](#c1) | Inactive-only updates require stopping; source creation supports an idempotency key. | [V07](#validation-v07): repeated keyed add makes one source; changes persist; removal affects only selected ID. |
| <a id="cap-c03"></a>C03 | Start/stop/restart sources, including filtered bulk operations. | Implemented / P0 | lifecycle tools; [S1](#s1), [C1](#c1) | Capture success requires V07 delivery checks, not only an active status. | [V07](#validation-v07): selected sources transition correctly; excluded sources and destinations stay unchanged. |
| <a id="cap-c04"></a>C04 | Set mute/visibility/mode/account role/reply-only/auto-activation. | Implemented / P0 | source settings and presentation tools; [S1](#s1), [C1](#c1) | Respect active-source restrictions and per-platform capabilities. | [V07](#validation-v07)/[V10](#validation-v10): live mute/visibility works; inactive changes and restart persistence match requested values. |
| <a id="cap-c05"></a>C05 | Create/rename/reorder groups and manage membership. | UI path / P1 | group UI; [C1](#c1) | No complete group CRUD tool set in local adapter. | [V07](#validation-v07): perform via UI, restart, confirm order/membership and unaffected groups. |
| <a id="cap-c06"></a>C06 | Configure group discovery and automatic activation workflows. | UI path / P1 | group controls and platform UI; [C1](#c1) | Platform-specific; retired global settings must not be reintroduced. | [V07](#validation-v07): new eligible stream activates once; ineligible/ended stream behavior follows settings. |
| <a id="cap-c07"></a>C07 | Create/switch/delete application profiles and separate browser sessions. | UI path / P1 | sessions UI and app IPC; [S6](#s6), [C1](#c1) | App profile and browser account partition are different concepts. | [V03](#validation-v03)/[V07](#validation-v07): sources/settings/accounts remain isolated; bridge rebinds after relevant restart. |
| <a id="cap-c08"></a>C08 | Read/update supported global settings. | Implemented / P0 | `ssapp_get_settings`, `ssapp_update_settings`; [S1](#s1), [C1](#c1) | Only advertised settings are in the direct contract; broader settings use UI. | [V07](#validation-v07): allowed update persists; unknown/retired field fails without changing other settings. |
| <a id="cap-c09"></a>C09 | Detect accidental duplicate source configurations. | Partial / P1 | source listing; [C1](#c1); add idempotency | Stable retry key prevents one kind of duplicate; equivalent URLs/accounts require explicit comparison. | [V07](#validation-v07): repeated add is prevented while intentionally separate account sources remain distinct. |
| <a id="cap-c10"></a>C10 | Import/export configuration or restore a known state. | Partial / P1 | `ssapp_export_settings_backup`; [S7](#s7), [N8](#n8); existing import UI | Dedicated settings export and retrieval; restore remains an explicitly authorized UI workflow. | [V04](#validation-v04)/[V10](#validation-v10): export matches ordinary backup, alter fixture settings, restore and compare intended state only. |

## 8. Dock, overlays and audience operations

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-w01"></a>W01 | Open and operate relevant SSN dock/overlay/settings surfaces. | UI path / P1 | [C1](#c1)–[C2](#c2); [S3](#s3) where app-owned | External dock/browser surfaces need their own authorized connection. | [V07](#validation-v07): intended destination is identifiable and its actual output can be observed. |
| <a id="cap-w02"></a>W02 | Configure filters, formatting and routing through supported controls. | UI path / P1 | Social Stream settings and SSN control actions; [C2](#c2) | No blanket parity with all SSN features through local `ssapp_*` tools. | [V07](#validation-v07): predefined included/excluded fixtures reach precisely their intended destinations. |
| <a id="cap-w03"></a>W03 | Send a chat reply to the intended account/platform/destination. | External / P1 | existing SSN message transport; [C2](#c2), [E2](#e2) | Remote app access is separate from permission to publish; platform support varies. | [V07](#validation-v07): authorized unique test reply appears once at actual destination, not merely accepted by relay. |
| <a id="cap-w04"></a>W04 | Moderate supported messages without affecting unrelated content. | External / P1 | platform/SSN moderation workflow; [C2](#c2) | Do not infer platform moderation permission from app control or chat receipt. | [V07](#validation-v07): intended fixture deleted/suppressed; other messages and same-text distinct IDs retained. |
| <a id="cap-w05"></a>W05 | Operate polls, giveaways, queues and other production controls. | External / P1 | SSN page/relay capabilities; [C2](#c2) | Enumerate specific supported actions and response semantics; no universal local MCP mapping. | [V07](#validation-v07): start/update/end each advertised feature and verify actual dock/overlay state. |
| <a id="cap-w06"></a>W06 | Inspect/export chat history and retrieve the output. | UI path / P1 | SSApp history/export UI; F04–F06 | Export on host and return to agent are separate steps. | [V04](#validation-v04)/[V07](#validation-v07): expected IDs/timestamps preserved; file retrieved completely with correct encoding. |

## 9. Files and artifacts

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-f01"></a>F01 | Choose an already authorized host file in an HTML upload control. | Implemented / P1 | `ssapp_browser_choose_files`; [S3](#s3); [N2](#n2) `allowHostFiles` | Host absolute paths; CSS coordinates; file input or label; default denied remotely. | [V04](#validation-v04): permitted file selected; denied client has no selection side effect. |
| <a id="cap-f02"></a>F02 | Handle multiple files and native open/save dialogs. | Implemented / P1 | chooser and dialog tools; [S3](#s3), [S5](#s5), [N2](#n2) | Multi-file HTML input required; save path resolves on host. | [V04](#validation-v04): content/name/count correct; missing path and non-multiple input are rejected. |
| <a id="cap-f03"></a>F03 | Transfer remote files into an SSApp host staging area. | Missing / P1 | Adapt Ninja file transfers [N6](#n6) to an SSApp staging contract | Generic file tools alone do not create authorized upload staging or host-path grants. | [V04](#validation-v04): interrupted transfer resumes, hash matches, quota enforced, only verified file becomes selectable. |
| <a id="cap-f04"></a>F04 | Track browser downloads to completion or failure. | Missing / P1 | Add scoped download lifecycle in [S6](#s6)/[S2](#s2) and remote contract | UI may initiate download but there is no complete download listing/result tool. | [V04](#validation-v04): success, cancel, partial and failure have distinct results and no premature completion. |
| <a id="cap-f05"></a>F05 | Return exports, diagnostics and other host artifacts to the remote agent. | Partial / P1 | Settings export [S7](#s7), [N8](#n8), [N2](#n2) | Settings backups only; explicit per-controller permission, opaque IDs, bounded chunks and verified agent-side save. General artifacts remain missing. | [V04](#validation-v04): retrieve permitted export; length/hash match; other clients and substituted paths denied; existing destination preserved. |
| <a id="cap-f06"></a>F06 | Manage staging retention, cleanup and artifact ownership. | Partial / P1 | Settings-export retention [S7](#s7), [N2](#n2), [N8](#n8) | Four in-memory settings backups, 8 MiB each, five-minute expiry, explicit release and app-restart invalidation. General staging remains missing; delivered/cached copies persist separately. | [V04](#validation-v04)/[V06](#validation-v06): expiry/release ends retrieval; cancelled or corrupt transfer creates no final file; unrelated files preserved. |
| <a id="cap-f07"></a>F07 | Keep transfer progress separate from upload/submission completion. | Partial / P1 | [N6](#n6) transfer receipts; page observation | Add end-to-end workflow states; file receipt must never automatically submit a form. | [V04](#validation-v04): transfer completes while upload remains pending until authorized; final page/server receipt observed. |

## 10. Live perception and media

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-m01"></a>M01 | Obtain on-demand viewport frames locally. | Partial / P2 | `ssapp_browser_frame_stream`; [S3](#s3) | Local 1–5 fps multipart JPEG exists; remote worker explicitly rejects it. | [V08](#validation-v08): local stream stops on disconnect; remote advertises no usable remote stream yet. |
| <a id="cap-m02"></a>M02 | Deliver authorized live SSApp frames across computers. | Missing / P2 | Build N/S frame forwarding or SDK publisher [E1](#e1) | A host-loopback URL is not a remote viewer URL; use scoped subscription and bounded transport. | [V08](#validation-v08): remote sees changing target, stops on revoke, and never receives unselected surfaces. |
| <a id="cap-m03"></a>M03 | Adjust frame rate/size and preserve freshness/backpressure. | Partial / P2 | [S3](#s3) local limits; [N4](#n4) large-result transport | Define remote media adaptation, timestamps and slow-client policy. | [V08](#validation-v08): constrained link drops/adjusts stale frames rather than blocking control input. |
| <a id="cap-m04"></a>M04 | Share selected app audio without capturing unrelated devices. | Missing / P2 | New SSApp capture adapter; [E1](#e1) transport | Existing Chrome publisher N7 is not an SSApp audio implementation. | [V08](#validation-v08): known signal is audible remotely; other apps/microphone absent unless explicitly selected. |
| <a id="cap-m05"></a>M05 | Send frames/audio to a model that can understand them. | External / P2 | model harness, [E1](#e1); [N7](#n7) companion patterns | Streaming transport alone does not provide model perception or recording consent. | [V08](#validation-v08)/[V11](#validation-v11): model answers controlled visual/audio question; interruptions stop queued output. |
| <a id="cap-m06"></a>M06 | Fall back to screenshots and cleanly end observation. | Partial / P1 | screenshots work; [N2](#n2) close; future media subscription | Maintain explicit fallback and close all bridge-owned captures; leave sources running. | [V08](#validation-v08)/[V10](#validation-v10): media fails, screenshot still works, unsubscribe removes capture work without stopping app. |

## 11. Diagnostics and recovery decisions

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-x01"></a>X01 | Read source errors, lifecycle, counters and bounded page/process state. | Implemented / P0 | `ssapp_get_source_diagnostics`; [S4](#s4) | Shared processes can share PID; memory fields may be unavailable by OS. | [V09](#validation-v09): controlled source fault is associated with correct ID; unavailable fields remain explicit. |
| <a id="cap-x02"></a>X02 | Read/wait for captured events with cursors and gap detection. | Implemented / P0 | recent/wait source event tools; [S4](#s4) | Retained output is not independent evidence of all incoming platform messages. | [V07](#validation-v07)/[V09](#validation-v09): drain pages, overflow history, observe `historyLost`, and reconcile counters. |
| <a id="cap-x03"></a>X03 | Distinguish quiet chat from failed, paused, filtered or misrouted capture. | Partial / P0 | X01/X02 plus source/destination observation | Requires independent expected input and destination evidence. | [V07](#validation-v07): induce each condition; diagnosis identifies stage instead of treating zero traffic as success. |
| <a id="cap-x04"></a>X04 | Read scoped console and request-failure diagnostics. | Missing / P1 | Future bounded redacted diagnostic endpoints [S2](#s2)/[S4](#s4) | Do not substitute arbitrary renderer execution, raw headers or credentials. | [V09](#validation-v09)/[V06](#validation-v06): known failing request/console marker appears; unrelated session secrets do not. |
| <a id="cap-x05"></a>X05 | Produce a useful diagnostic bundle for a remote developer. | Partial / P1 | Existing structured observations and images | No complete bundle/export/retrieval contract; connect X01/X04 with F05. | [V09](#validation-v09)/[V04](#validation-v04): bundle identifies versions, source, interval and error evidence with bounded size. |
| <a id="cap-x06"></a>X06 | Correlate failures with configuration changes, navigation and reconnects. | Partial / P1 | source events and API operations; [S2](#s2)/[S4](#s4) | No unified durable action timeline; record safe request IDs and timestamps. | [V09](#validation-v09): induced change has a distinguishable before/after state and matching operation record. |
| <a id="cap-x07"></a>X07 | Select a scoped recovery and prove the result. | Partial / P0 | reload/restart/mode/UI tools; [S1](#s1)–[S4](#s4) | Agent reasoning/harness owns diagnosis; avoid changing global app compatibility settings. | [V09](#validation-v09)/[V07](#validation-v07): original fault disappears, delivery checks pass, unrelated sources unchanged. |

## 12. Capture and destination correctness

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-q01"></a>Q01 | Establish eligible incoming messages independently of captured output. | External / P0 | Fixture/source network evidence; [C2](#c2) and validation harness | Captured-event ledger alone cannot reveal upstream loss. | Procedure [V07](#validation-v07): expected IDs/occurrences and observation interval known before comparison. |
| <a id="cap-q02"></a>Q02 | Compare input, capture and each intended destination exactly. | Partial / P0 | [S4](#s4) captures plus independent destination observer | No universal built-in end-to-end delivery assertion tool. | Procedure [V07](#validation-v07): every eligible message occurs exactly once at each intended stage/destination. |
| <a id="cap-q03"></a>Q03 | Preserve identical-text messages as distinct occurrences. | Partial / P0 | Source-native IDs or occurrence-aware fixture ledger | Counts or author/text hashes alone are insufficient. | Procedure [V07](#validation-v07): two same-author/same-text messages remain two; one replay of an ID remains one. |
| <a id="cap-q04"></a>Q04 | Account for history, filters, moderation and exclusions. | Partial / P0 | source settings and destination workflow; [C2](#c2) | Define exclusions before run; do not invent exclusions to hide failures. | Procedure [V07](#validation-v07): excluded IDs match policy and unrelated messages remain. |
| <a id="cap-q05"></a>Q05 | Exercise bursts, reload/reconnect/replay, edits and pruning. | External / P0 | real source runtime and controlled fixture harness | Validate affected capture modes separately; no inference from one platform to another. | Procedure [V07](#validation-v07): complete ledgers show zero unexplained loss/duplication after drain. |
| <a id="cap-q06"></a>Q06 | Cover hidden-window and long-session capture behavior. | External / P0 | existing SSApp capture harnesses [S8](#s8) | A short browser-control run does not establish delivery or long-session behavior. | Procedure [V07](#validation-v07)/[V10](#validation-v10): duration/mode recorded; buffer/hidden/reconnect conditions exercised. |
| <a id="cap-q07"></a>Q07 | Report failure/inconclusive honestly when evidence is absent. | External / P0 | harness and agent reporting contract | No eligible traffic, unseen destination or disabled capture is never a pass. | Procedure [V07](#validation-v07): each missing-evidence scenario returns inconclusive/non-success with reason. |

## 13. Transport, retries and process lifecycle

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-r01"></a>R01 | Connect using WebRTC or explicitly configured HTTP transport. | Implemented / P0 | [N3](#n3)–[N5](#n5); [E1](#e1) | TURN/network policy can affect connectivity; no universal firewall bypass claim. | [V05](#validation-v05): real second-computer route works; unavailable route reports a useful error. |
| <a id="cap-r02"></a>R02 | Fall back from WebRTC to HTTP without repeating the action. | Implemented / P0 | [N3](#n3) request-route tracking; [N4](#n4) dedupe | Preserve identity across routes and wait for actual effect/result. | [V05](#validation-v05): drop first reply after execution; fallback returns result and host counter increments once. |
| <a id="cap-r03"></a>R03 | Recover a retained result by request ID. | Implemented / P0 | `ninja_ssapp_result`; [N4](#n4) | Process-local bounded cache; unknown means uncertain, not unexecuted. | [V05](#validation-v05): retrieve result, then test expired/missing record and ensure no automatic mutation replay. |
| <a id="cap-r04"></a>R04 | Bind queued and dispatched calls to the intended app instance. | Implemented / P0 | [N2](#n2) instance check; [S1](#s1)–[S2](#s2) conditional header | Re-discover targets and reclaim control after app restart. | [V05](#validation-v05): restart between discovery and dispatch; stale input cannot affect new instance. |
| <a id="cap-r05"></a>R05 | Handle worker/adapter failure and uncertain execution. | Implemented / P0 | [N2](#n2) uncertain flag; `reconciled: true`; [N4](#n4) boot IDs | Reconciliation is a client assertion after inspection, not proof generated by the flag. | [V05](#validation-v05): kill adapter after dispatch; control pauses until outcome inspection and explicit reclaim. |
| <a id="cap-r06"></a>R06 | Cancel queued work and expose limits of cancelling active work. | Partial / P0 | lease revocation/generation; [N2](#n2) | No general per-operation cancellation or rollback; active actions may finish. | [V05](#validation-v05)/[V06](#validation-v06): revoked queued operation never starts; executing action outcome is reported honestly. |
| <a id="cap-r07"></a>R07 | Bound concurrent work, request size, result size and deadlines. | Implemented / P0 | [N2](#n2)–[N4](#n4); [S2](#s2)–[S3](#s3) | Limits are distinct; reject oversize before mutation whenever possible. | [V05](#validation-v05): below/at/above limits behave explicitly; no truncation or uncontrolled queue growth. |
| <a id="cap-r08"></a>R08 | Transfer large screenshots with integrity and backpressure. | Implemented / P0 | [N4](#n4) chunks; [N2](#n2) 10 MiB result ceiling | 10 MiB is result envelope, not image bytes; size must include base64/metadata overhead. | [V05](#validation-v05): 4 MB payload and boundary result survive byte/hash comparison and a slow receiver. |
| <a id="cap-r09"></a>R09 | Keep prompt recovery usable during blocked/long-running work. | Implemented / P0 | [N2](#n2) observation/dialog dispatch; [S1](#s1)/[S5](#s5) | Do not reintroduce unconditional capabilities gating or one global serial queue. | [V03](#validation-v03)/[V05](#validation-v05): long event wait plus prompt still permits answer and eventual completion. |
| <a id="cap-r10"></a>R10 | Stop the bridge cleanly while leaving SSApp running. | Implemented / P0 | [N1](#n1)–[N2](#n2) cleanup | Own only bridge/adapter resources; do not inherit Chrome-owned-process cleanup behavior. | [V05](#validation-v05)/[V10](#validation-v10): disconnect/stop; app and source state remain, leases/capture owned by bridge end. |
| <a id="cap-r11"></a>R11 | Resume event observations across disconnects without hiding gaps. | Partial / P1 | source cursors; [S4](#s4); [S2](#s2) local SSE | General SSE is not transparently forwarded; consumers must handle process-local cursor reset/gaps. | [V05](#validation-v05)/[V07](#validation-v07): reconnect, drain retained events, identify lost history and new app instance. |

## 14. Permissions, ownership and ordinary user behavior

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-p01"></a>P01 | Authenticate each agent separately over either transport. | Implemented / P0 | per-client keys; [N1](#n1), [N4](#n4) | Room/session IDs and `confirm` are not remote credentials. | [V06](#validation-v06): wrong key, wrong client and other room peer cannot read or forge control results. |
| <a id="cap-p02"></a>P02 | Enforce observer and tool allowlists on the host. | Implemented / P0 | [N2](#n2) `allowed` and execute checks | Do not rely only on catalog filtering or client-side checks. | [V06](#validation-v06): call a hidden mutation directly; server rejects it with zero side effects. |
| <a id="cap-p03"></a>P03 | Allow one controller, lease renewal, release and host revocation. | Implemented / P0 | claim/release/status; [N1](#n1)–[N2](#n2) | Whole-app lease; already executing action may complete. | [V06](#validation-v06): two controllers contend, expiry/renewal/revoke work, observer continues allowed reads. |
| <a id="cap-p04"></a>P04 | Restrict access to specified sources/windows including observations. | Missing / P1 | New [N2](#n2) grants plus [S3](#s3) ownership metadata | Filter direct IDs, defaults, menus, dialogs, bulk actions, files, screenshots and nested popups. | [V06](#validation-v06): allowed target succeeds; every route to disallowed target is denied, including images. |
| <a id="cap-p05"></a>P05 | Rotate/revoke a client's credentials without broad disruption. | Partial / P1 | config edits and worker restart; [N1](#n1) | Current credential policy changes require restart; active hot-revocation interface is absent. | [V06](#validation-v06): revoked client denied; documented restart effect on other clients is accurate. |
| <a id="cap-p06"></a>P06 | Offer a clear human takeover and remote-access status control. | Partial / P1 | host terminal `revoke`/`stop`; normal app window control | No integrated SSApp remote-session indicator/takeover panel; add only inside opt-in configuration. | [V06](#validation-v06)/[V10](#validation-v10): host regains control promptly; unenabled ordinary UI is unchanged. |
| <a id="cap-p07"></a>P07 | Keep a bounded action audit without logging sensitive input. | Missing / P1 | future N/S audit envelope using request/operation IDs | Define retention, redaction and access; exclude raw passwords, keys and routine screenshots. | [V06](#validation-v06)/[V09](#validation-v09): actor/action/outcome trace is useful; seeded secrets absent from normal audit output. |
| <a id="cap-p08"></a>P08 | Treat page/chat content as untrusted data. | Partial / P0 | [S1](#s1)/[S4](#s4) safety metadata; consuming agent policy | Metadata survives transport; resistance also depends on harness behavior. | [V06](#validation-v06)/[V11](#validation-v11): hostile fixture instructions do not change authorized task or disclose unrelated content. |
| <a id="cap-p09"></a>P09 | Preserve normal app appearance, sessions and disabled-mode cost. | Implemented / P0 | opt-in API, external bridge; [S6](#s6), [N1](#n1) | No background model/capture/remote connection merely from ordinary app startup. | [V10](#validation-v10): compare disabled baseline, focus/dialog behavior, connections and settings before/after. |

## 15. Agent and harness compatibility

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-h01"></a>H01 | Preserve stable tool schemas, MCP images, structured errors and versions. | Implemented / P0 | [N1](#n1)–[N2](#n2) forwarding; [S1](#s1) | Management tools are distinct from `ssapp_*` argument schemas. | [V01](#validation-v01)/[V11](#validation-v11): schema/result comparison and actual image-using client workflow agree. |
| <a id="cap-h02"></a>H02 | Use SSApp through ordinary MCP clients and scripted callers. | Implemented / P0 | stdio MCP; [S1](#s1) local HTTP; [N1](#n1) remote MCP | Local HTTP origin is not itself a remotely exposed API; remote code can be an MCP client. | [V11](#validation-v11): two independent clients complete discovery, observe, act, verify and release. |
| <a id="cap-h03"></a>H03 | Work with Codex, Claude, Pi, OpenCode and a custom local-model harness. | External / P1 | each client's MCP/tool adapter; [E3](#e3) | Verify each advertised client/version; protocol compatibility alone does not prove image/tool behavior. | [V11](#validation-v11): record client/model versions and complete same fixture task without custom per-page code. |
| <a id="cap-h04"></a>H04 | Offer bounded observations usable by smaller/slower models. | Partial / P1 | [S3](#s3) limits and screenshots; external planning loop | Tune observation size/latency in harness; do not silently remove important controls. | [V11](#validation-v11): constrained model selects intended controls within declared budget and stops on ambiguity. |
| <a id="cap-h05"></a>H05 | Retain task progress and hand work to another agent. | External / P1 | ninja-p2p [E2](#e2) or client task store | Separate room protocols need an explicit adapter; task receipt does not grant app control. | [V11](#validation-v11)/[V06](#validation-v06): second agent claims, re-observes and continues without replay or stale refs. |
| <a id="cap-h06"></a>H06 | Provide accurate setup, skill, version and recovery guidance. | Implemented / P0 | setup guide, [N1](#n1) doctor, [C3](#c3) skill | Update Markdown and HTML together and advertise only supported scopes. | [V01](#validation-v01)/[V11](#validation-v11): fresh installation follows guide successfully; unavailable features have clear alternatives. |

## 16. Development and patch workflows

| ID | Required behavior | State / priority | Route and owner | Remaining work or constraint | Validation and pass condition |
| --- | --- | --- | --- | --- | --- |
| <a id="cap-z01"></a>Z01 | Identify relevant source code, runtime revision and fault evidence. | Partial / P2 | diagnostics X rows; [C2](#c2) sources; external checkout | App version does not identify remotely loaded source revision; add a bounded revision descriptor if needed. | [V12](#validation-v12): reproducer records exact source/hash and affected source/mode without dumping secrets. |
| <a id="cap-z02"></a>Z02 | Reproduce an issue in an isolated real SSApp runtime. | External / P2 | development harness and SSApp checkout; [S8](#s8) | Do not use unrelated Chrome or headless mocks as proof of SSApp compatibility. | [V12](#validation-v12): original failure reproduced with same relevant session/hooks/config and independent oracle. |
| <a id="cap-z03"></a>Z03 | Edit and apply a narrowly scoped source/config fix. | External / P2 | authorized coding agent and [C2](#c2) checkout | Browser MCP does not supply arbitrary shell/repository write access; no automatic script execution from chat. | [V12](#validation-v12): diff affects intended source only; runtime uses changed revision. |
| <a id="cap-z04"></a>Z04 | Reload, verify and roll back an unsuccessful development change. | Partial / P2 | source reload controls plus authorized development tools | Implement explicit development override/rollback outside everyday control if required. | [V12](#validation-v12)/[V07](#validation-v07): original failure resolves; regression checks pass; rollback restores known revision. |
| <a id="cap-z05"></a>Z05 | Produce a reviewable patch and submit through authorized repository tools. | External / P2 | coding agent/Git workflow; [E3](#e3) | Respect repository branch/PR/release rules and separate publishing authorization. | [V12](#validation-v12): diff, scope, reproduction and verification evidence accompany the requested submission. |

## Validation procedures

Use an isolated SSApp profile, controlled fixture pages and independently observed host state. On
Windows run natively, not through WSL. Use actual SSApp for app behavior; unrelated Chrome is suitable
only for the HTML documentation itself. Never use the `CamCam66Gaming` channel. Do not restart or
reconfigure shared relay/mailbox services as an incidental test step. Keep fixtures, credentials,
logs and screenshots outside public checkouts. Cap concurrent worker pools to at most half the host's
logical processors, using a lower limit if the machine becomes sluggish.

Each procedure requires an explicit result: passed within the recorded scope, failed, or inconclusive.
No fresh runtime run is implied by a matrix row's implementation state.

<a id="validation-v01"></a>

### V01 — Connection and contract

Use the [setup guide](ssapp-integration.md) with an isolated app and private worker/client credentials.
Run `node scripts/vdo-mcp-ssapp.js --doctor --config <private-agent-config>` from the Ninja MCP checkout.
Capture initialize, tools/list, status and capabilities through the actual remote client. Record versions,
instance ID, role, tool names and route; omit credentials. Compare permitted schemas and image/error
shapes with the host adapter. Repeat while the app is offline, loading, then ready; try an unsupported
command and a wrong credential. Verify that enabling headless mode alone does not enable the API.
For multi-instance claims, use separate ports and independent fixture markers. A doctor success alone
does not satisfy a browser, capture or source workflow.

<a id="validation-v02"></a>

### V02 — Browser surface and input

Serve a controlled page containing labelled fields, a click counter, nested scroll panels, same-origin
and cross-origin frames, a canvas, drag/drop zones, touch event markers, delayed controls and popup
buttons. Create it through the real SSApp window path. Establish positions/state independently on the
host fixture. Drive all tested actions from the remote MCP connection. Check exact text, event type,
button/contact count, drag payload, focus, window bounds and side effects. Repeat selected cases hidden,
minimized, zoomed and resized. Test stale IDs after navigation/close and references after expiry.
Record screenshot hash/dimensions and map coordinates using `screenshotId`; a successful input response
without the expected fixture effect is not a pass. Validation code may observe fixture state; production
tools must not depend on arbitrary page-script injection by the agent.

<a id="validation-v03"></a>

### V03 — Authentication, dialogs and human handoff

Start with fixture sign-in fields and JavaScript/Electron prompts, then use an authorized test account
for each real platform whose support will be claimed. Open the correct session's sign-in flow, observe
the resulting popup and validate account isolation. Exercise accept/cancel/default/checkbox/file choices.
Trigger a blocking prompt while another request waits; answer it through the recovery tools. For human
steps, release or suspend control, show the correct host surface, let the person complete the step, then
re-discover and resume once. Record only non-secret evidence of the resulting account/source state.
Fixture password entry does not establish real OAuth, passkey or CAPTCHA completion.

<a id="validation-v04"></a>

### V04 — Files and artifacts

Use temporary task-owned directories with known small, multiple, Unicode-named and boundary-size files.
Test denied and permitted host-file clients; establish hashes before transfer. Check browser selection
and actual upload receipt separately. Exercise missing files, cancellation, transfer interruption,
partial downloads, quota exhaustion and expiry. Verify exported/retrieved artifact hashes and reject
path substitution outside the grant. Cleanup must preserve unrelated host files. Until staging/download
tools exist, mark those subcases missing rather than treating a generic file transfer as full SSApp support.

For settings export, compare its decoded payload with an ordinary File-menu export, allowing only the
export timestamp to differ. Include a multi-chunk backup, denied permissions, observer and other-client
reads, missing confirmation, path substitution, a dropped reply, expiry, restart, size limits, checksum
corruption and release during transfer. Verify the agent destination is created only after integrity
checks and an existing file is never replaced. Exercise normal export success/cancel while automation
is enabled and after an automation export; its dialogs, filename, contents and destination must match
ordinary behavior, and normal exports must not become automation artifacts.
Retrieve multiple near-limit backups within the retry-retention window; later calls must still
complete. Drop a chunk reply and retry the immutable read, checking its hash and retained
request fingerprint. Export/release mutations must continue to return their original cached receipts.

<a id="validation-v05"></a>

### V05 — Transport and lifecycle faults

Use two computers for remote claims, logging actual route and host-side effects. Exercise WebRTC,
HTTP-only and automatic fallback separately. Drop a response after a non-idempotent fixture action has
executed, then retry with the same request identity over the alternate route. Require one host effect and
the original result. Test request-ID conflicts, duplicate chunks, slow receivers, oversized envelopes,
expired requests, cache expiry and 4 MB image payloads. Restart app, adapter and worker separately;
do not assume exactly-once execution across lost process-local caches. Check uncertain-outcome handling,
reconciliation, stale-instance rejection and fresh discovery. Verify queue revocation, active-action
limitations, bridge shutdown and app persistence. Record route/ID/result/effect together; encrypted send
acceptance alone is not completion. Use local fault injection rather than disrupting shared infrastructure.

<a id="validation-v06"></a>

### V06 — Permissions and ownership

Create controller A, controller B, observer and restricted-tool credentials. Test normal and direct calls
to hidden tools, forged identity, absent/expired lease, renewal, revocation, reconnect and queued work.
Observe independently that denied calls cause no effect. Try file paths through both chooser and dialog
routes. For future target grants, include default-main-window calls, parent/child popups, menus, bulk
actions, dialogs, screenshots and source aliases. Plant synthetic private values and hostile instructions
in fixture content; verify redaction plus the consuming harness's task boundaries. Do not claim target
isolation when only a tool allowlist exists.

<a id="validation-v07"></a>

### V07 — Sources and delivery

Choose an affected platform/mode and intended destinations. Establish independently known eligible input
IDs or occurrence-aware fixture tokens, including two distinct identical-text messages. Define interval,
history/filter/moderation exclusions and pending-message drain in advance. Collect input, capture and
actual destination ledgers, not just totals or periodic samples. Compare every eligible identity exactly
once per intended destination and report missing, duplicate and unexpected identities at each stage.
Exercise relevant bursts, delayed rows, pruning, edits/moves, hidden windows, pause/resume, reload/replay,
reconnect and stream changes. Check persistent source/group/settings state separately. No input evidence,
disabled capture, no eligible traffic or unavailable destination output means inconclusive. Loss/duplication
fixes require original-failing/final-passing controlled cases plus actual live chat in SSApp for each
affected source and mode. Use S8 as a starting point, not as a substitute for the required evidence.

<a id="validation-v08"></a>

### V08 — Media and observation lifecycle

Use a selected fixture surface with a visible monotonic clock and optional known audio tone. Observe from
another computer, measure frame freshness and input latency under constrained bandwidth, and verify
unselected surfaces/audio devices are absent. Test unsubscribe, revoke, target close and route loss;
bridge-owned capture must stop. Preserve screenshot-based fallback and coordinate mapping. Distinguish
WebRTC publishing, viewer playback and model understanding as three separate results. Record microphone,
app-audio and recording choices independently; ordinary app startup must not start capture.

<a id="validation-v09"></a>

### V09 — Diagnostics

Induce one fault at a time: invalid URL, expired test authentication, request failure, missing page element,
disabled capture, known filter exclusion, unreachable destination and resource pressure. Compare the
agent's diagnosis with the injected cause. Require a source/instance/version/time-scoped explanation and
an appropriately scoped recovery. Bound observations and redact synthetic secrets. Repeat with no eligible
traffic; the agent should report uncertainty instead of inventing a capture verdict. A useful diagnostic
bundle needs evidence of both failure and recovery and must be retrievable through an authorized route.

<a id="validation-v10"></a>

### V10 — Ordinary use, persistence and host matrix

Compare normal startup with automation disabled against the established baseline: appearance, settings,
sessions, window focus, native dialogs, network listeners and idle work. Then enable automation and test
hidden/headless workflows, restarts and shutdown/disconnect behavior. Compare settings and source state
before/after; verify that no unrelated account or compatibility flag changed. Run on Windows, macOS and
Linux before claiming all three; test representative display scale, keyboard layout and installed-package
launches. Record long-run duration, reconnect count and resource trend. A Windows result does not establish
macOS/Linux host behavior; a Linux agent controlling Windows is still a Windows host result.

<a id="validation-v11"></a>

### V11 — Agent interoperability and complete tasks

Use actual named clients/model versions, not only a protocol simulator. Each should discover tools, view an
image, identify a control, claim, act, verify and release. Exercise errors, large images and recovery with
an unfamiliar page without custom per-page automation code. For a local model, configure the endpoint in
the external harness, then measure task success and observation budget. A model recognizing an image and
a transport returning image bytes are separate checks. Handoffs must retain task intent while discarding
stale references and acquiring a new valid lease.

<a id="validation-v12"></a>

### V12 — Diagnosis-to-patch

Use separately authorized development access to the correct source checkout. Record source revision/hash,
affected mode, reproduction and independent expected output. Demonstrate the original failure in SSApp,
apply a narrow change, rerun the same case and relevant regressions, then demonstrate rollback. Follow
live-delivery requirements for capture loss/duplication. Produce a diff and evidence suitable for review.
Branch creation, PR submission, push, release and deployment follow their own explicit authorization and
repository rules. Do not turn ordinary chat or a received file into code execution permission.

## End-to-end acceptance workflows

These workflows prevent broad tool coverage from being mistaken for complete user outcomes.

| Workflow | Required rows | Observable completion |
| --- | --- | --- |
| Set up a new source and capture chat | D01–D05, S01–S03, A01–A05, C01–C04, Q01–Q07 | Correct source/account/mode persists; independently eligible messages reach the intended destination exactly once. Human sign-in steps are explicitly handed off. |
| Repair a broken source | X01–X07, C03–C04, R03–R05, Q01–Q07 | Known cause identified; scoped recovery applied; failure no longer reproduced and delivery verified. |
| Operate an unfamiliar sign-in/popup workflow | S01–S08, O01–O07, I01–I10, N01–N06, A01–A08 | Correct account/session, popup and prompts handled; user-only steps completed by user; agent resumes without stale input. |
| Recover from a lost network reply | R01–R10, P01–P03 | One independently observed action despite retry/fallback; result recovered or uncertainty reported without blind replay. |
| Upload a remote file and retrieve an export | F01–F07, A06, P02 | Authorized file transferred, verified, selected and submitted; correct completed export returned and staging cleaned. Missing F rows remain explicit blockers. |
| Share a live source with an agent | M01–M06, P01–P04 | Selected fresh frames/audio reach authorized viewer/model; stop/revoke removes capture work and preserves app/source operation. |
| Hand off between two agents and a person | P01–P06, A08, H05, R04–R06 | Single owner at a time; person can intervene; successor re-observes and continues with no repeated side effects. |
| Diagnose and submit a source fix | Z01–Z05, X01–X07, Q01–Q07 | Reviewable narrow patch, original/final evidence, relevant live checks and rollback; submission only through authorized repository workflow. |

## Implementation sequence

1. Preserve the existing P0 controls and recovery behavior. Complete the V01/V02/V03/V05/V06 fixture
   workflow across the remote bridge, including stale-instance, large-image and blocked-prompt cases.
2. Close P0 observation gaps: useful readiness/navigation diagnosis, bounded state waits, target lifecycle
   notifications and authentication/human-handoff outcomes. Add direct commands only where existing UI
   observation cannot reliably express or verify the task.
3. Exercise source setup, capture repair and export workflows. Address group/session UI gaps and establish
   independent destination evidence. Do not expand source capture behavior as an incidental bridge change.
4. Implement staged files/download/artifact handles with scoped permissions, then selected-target grants
   if remote operators need narrower access than the whole app.
5. Add remote live frames and optional audio using the SDK and explicit subscription lifecycle. Keep model
   integration optional. Build development/patch access and ninja-p2p handoffs as separate cooperating layers.

For every added capability, change the owning layer, preserve schema/instance/error semantics, update
runtime discovery and the [canonical SSApp skill](#c3), and validate the linked row plus the end-to-end
workflow it enables. Keep both versions of this matrix synchronized. This sequence is a planning order;
it does not authorize unrelated platform, account, infrastructure, repository or deployment changes.

## Evidence record

Keep execution records outside the public repository. Use one record per row and environment, with these
fields; a single successful fixture run should not silently mark all related rows passed.

| Field | Required detail |
| --- | --- |
| Matrix row and workflow | Stable row ID(s), requirement exercised, exact fixture/scenario. |
| Implementation revision | SSApp, source files, Ninja MCP and relevant SDK revision/hash; dirty-file digest if applicable. |
| Environment | Host/agent OS, app/API/MCP/client/model versions, profile, display/keyboard conditions. |
| Route and scope | Actual WebRTC/HTTP/fallback route, same-machine vs two-computer, permissions and granted targets. |
| Observation interval | Start/end, drain period, duration and repeated-event/reconnect counts. |
| Independent oracle | Expected input/state, how obtained independently, actual app/destination observation. |
| Outcome | Not run, supporting check, local app verified, remote app verified, inconclusive or failed; reason and scope. |
| Artifacts | Redacted logs, result JSON, screenshot hashes, expected/observed ledgers, reproduction command. |
| Remaining coverage | Specific unsupported/untested modes, platforms and fault conditions; next required check. |

Retain failures and inconclusive results alongside later passes. Generic code inspection, protocol tests,
mock servers, schema checks and documentation checks are supporting evidence, not real SSApp workflow
validation. A retained summary with no per-case details supports only the scope it actually records.

## Implementation reference map

### Ninja MCP

- <a id="n1"></a>**N1 — Remote entry point:** [scripts/vdo-mcp-ssapp.js](../scripts/vdo-mcp-ssapp.js).
  Setup, doctor, status/claim/release/result tools, stdio forwarding and host/client lifecycle.
- <a id="n2"></a>**N2 — SSApp host controller:** [scripts/lib/ssapp-worker.js](../scripts/lib/ssapp-worker.js).
  `LocalMcp`, `SsappController`, `allowed`, `checkLease`, `execute`, `RPC_OPTIONS`; instance binding,
  uncertainty, tool policy, host-file permission, queues, prompt bypass and explicit remote-frame rejection.
- <a id="n3"></a>**N3 — Transport selection:** [scripts/lib/browser-routes.js](../scripts/lib/browser-routes.js)
  and [scripts/vdo-mcp-browser.js](../scripts/vdo-mcp-browser.js) `makeSession`; automatic routes and sessions.
- <a id="n4"></a>**N4 — Request reliability:** [scripts/lib/browser-rpc.js](../scripts/lib/browser-rpc.js).
  `BrowserRpcWorker`/`BrowserRpcClient`, encryption, boot/request IDs, deadlines, dedupe, chunks and backpressure.
- <a id="n5"></a>**N5 — Connectivity:** [scripts/lib/bridge-session.js](../scripts/lib/bridge-session.js),
  [scripts/lib/http-relay-transport.js](../scripts/lib/http-relay-transport.js),
  [HTTP relay guide](http-relay.md) and [setup implementation](../scripts/lib/browser-setup.js).
- <a id="n6"></a>**N6 — Generic files and tool contract:** [tool reference](mcp-tool-contract.md),
  [scripts/vdo-mcp-server.js](../scripts/vdo-mcp-server.js), bridge-session transfer methods. Existing generic
  transfers need an explicit SSApp artifact/staging adapter; they do not grant arbitrary host file access.
- <a id="n7"></a>**N7 — Separate Chrome/media patterns:** [browser worker](browser-worker.md),
  [voice companion](browser-agent.md), [scripts/lib/browser-media.js](../scripts/lib/browser-media.js).
  Reuse suitable media patterns without assuming Chrome tab capture supports Electron surfaces.

- <a id="n8"></a>**N8 — Agent-side settings export:** [scripts/lib/ssapp-export.js](../scripts/lib/ssapp-export.js).
  Chunk reads through the authenticated bridge, length/hash verification, private temporary file,
  no-overwrite delivery, and incomplete-file cleanup. Client registration is in N1; ownership is in N2.

### SSApp

Source repository: [steveseguin/ssn_app](https://github.com/steveseguin/ssn_app).
In a local workspace, these paths are relative to its `ssapp` checkout.

- <a id="s1"></a>**S1 — Local MCP contract:** [resources/ssapp-mcp.js](https://github.com/steveseguin/ssn_app/blob/main/resources/ssapp-mcp.js).
  `TOOL_DEFINITIONS`, `DIRECT_WHILE_RENDERER_BLOCKED`, `listTools`, `callTool`, screenshot and error shaping.
- <a id="s2"></a>**S2 — API:** [resources/electron-control-api.js](https://github.com/steveseguin/ssn_app/blob/main/resources/electron-control-api.js).
  `COMMAND_DEFINITIONS`, `createControlApiRouter`, instance endpoint, conditional instance checks, operations/SSE.
- <a id="s3"></a>**S3 — Browser controls:** [resources/browser-control-service.js](https://github.com/steveseguin/ssn_app/blob/main/resources/browser-control-service.js).
  `BROWSER_COMMANDS`, targets, screenshots, native input, menu/file/window/navigation controls and frame stream.
- <a id="s4"></a>**S4 — Observation:** [resources/source-observation-service.js](https://github.com/steveseguin/ssn_app/blob/main/resources/source-observation-service.js).
  Diagnostics, event cursors, inspection/opaque references, redaction and `captureWindowPage`.
- <a id="s5"></a>**S5 — Windows/dialogs:** [app-window-control-service.js](https://github.com/steveseguin/ssn_app/blob/main/resources/app-window-control-service.js)
  and [app-dialog-service.js](https://github.com/steveseguin/ssn_app/blob/main/resources/app-dialog-service.js).
- <a id="s6"></a>**S6 — Runtime integration:** [main.js](https://github.com/steveseguin/ssn_app/blob/main/main.js)
  and [bootstrap.js](https://github.com/steveseguin/ssn_app/blob/main/bootstrap.js). Opt-in startup, browser
  ownership/session behavior, IPC and packaged MCP launch. Keep source-specific behavior scoped.
- <a id="s7"></a>**S7 — Settings export:** [resources/settings-export-service.js](https://github.com/steveseguin/ssn_app/blob/main/resources/settings-export-service.js).
  Shared command schemas, bounded in-memory backups, byte reads, expiry and release. S6 collects
  settings only on explicit request using the existing backup payload builder.
- <a id="s8"></a>**S8 — Existing validation starting points:** SSApp `tests/electron/mcp-app-window-dialog-e2e.js`,
  `tests/electron/hidden-capture-diagnostics.js`, and commands in its `package.json` and `AGENTS.md`.
  Inspect each harness before running; choose isolated profiles and independently complete delivery evidence.

### Social Stream and cooperating tools

- <a id="c1"></a>**C1 — App source/group/session UI:** SSApp [index.html](https://github.com/steveseguin/ssn_app/blob/main/index.html),
  including `getCapabilities`, source command handlers, group management and profile switching. Check
  `resources/ssapp-mcp.js` before assuming a UI action has a dedicated tool.
- <a id="c2"></a>**C2 — Capture and destinations:** [social_stream](https://github.com/steveseguin/social_stream),
  including platform source files, `settings/config*.json`, dock/overlay pages and existing message transports.
  Make source changes in that checkout, never the disposable SSApp `resources/social_stream_fallback` mirror.
- <a id="c3"></a>**C3 — Canonical operating skill:** [control-social-stream](https://github.com/steveseguin/social_stream/tree/main/docs/skills/control-social-stream),
  [API reference](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/control-api.md),
  [browser reference](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/browser-control.md),
  [version log](https://github.com/steveseguin/social_stream/blob/main/docs/skills/control-social-stream/references/version-log.md).
  Update these with API/MCP/schema/capability compatibility changes in the same work.
- <a id="e1"></a>**E1 — SDK:** [ninjasdk](https://github.com/steveseguin/ninjasdk) and
  [SDK guide](https://sdk.vdo.ninja/). Data/media connectivity is separate from SSApp authorization and model understanding.
- <a id="e2"></a>**E2 — Agent coordination:** [ninja-p2p](https://github.com/steveseguin/ninja-p2p) and its
  [SSN chat bridge](https://github.com/steveseguin/ninja-p2p/blob/main/docs/social-stream-bridge.md).
  Persistent inboxes/handoffs and audience messages do not automatically expose SSApp controls.
- <a id="e3"></a>**E3 — Client and development adapters:** [client configuration](client-config-examples.md)
  and the chosen client's tools for models, files and repositories. Keep those permissions separate from SSApp control.
