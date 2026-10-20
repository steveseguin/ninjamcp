# Advanced diagnostics

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/advanced-diagnostics.html)

Use these checks when you are debugging reliability or network edge cases. Everyday setup doesn't need them.

The test suites are in the repository, not the npm package. Run them from a clone after `npm install`. Live tests also need the optional Node WebRTC runtime; they skip themselves without it.

## Live network tests

These connect to the real VDO.Ninja network. They are skipped unless `LIVE_VDO_TEST=1` is set.

```bash
LIVE_VDO_TEST=1 npm run test:mcp:live
LIVE_VDO_TEST=1 npm run test:mcp:soak
LIVE_VDO_TEST=1 npm run test:mcp:matrix
LIVE_VDO_TEST=1 npm run test:mcp:preset:matrix
LIVE_VDO_TEST=1 SOAK_MATRIX_SWEEP_RUNS=20 npm run test:mcp:matrix:sweep
```

| Command | What it checks |
| --- | --- |
| `test:mcp:live` | Two live peers connect and exchange messages. |
| `test:mcp:soak` | Repeated connect, message, and reconnect cycles. |
| `test:mcp:matrix` | The soak run across direct and forced-TURN connection profiles, including UDP, TCP, and TLS hints. |
| `test:mcp:preset:matrix` | Each installer preset's tool profile and security settings. |
| `test:mcp:matrix:sweep` | The matrix repeated many times against a minimum success rate. |

The preset matrix skips the secure presets unless a join-token secret is set:

```bash
LIVE_VDO_TEST=1 VDON_MCP_JOIN_TOKEN_SECRET=change_me npm run test:mcp:preset:matrix
```

## Preset matrix options

- `PRESET_MATRIX_ADAPTIVE_FALLBACK=1` tries other connection candidates when one fails.
- `PRESET_MATRIX_ALLOW_DIRECT_FALLBACK=1` allows a direct connection after the TURN candidates.
- `PRESET_MATRIX_STRICT=1` exits with a failure when any profile fails.
- `PRESET_CONNECT_ATTEMPTS`, `PRESET_CONNECT_TIMEOUT_MS`, and `PRESET_CHANNEL_READY_TIMEOUT_MS` control connection attempts.

Reports are written to:

- `tests/artifacts/latest-preset-matrix-report.json`
- `tests/artifacts/latest-preset-matrix-summary.txt`
- `tests/artifacts/history/preset-matrix-*.json`
- `tests/artifacts/history/preset-matrix-*.txt`

## Retry and timeout settings

| Test | Variables |
| --- | --- |
| Live smoke | `LIVE_SMOKE_RETRIES`, `LIVE_SMOKE_TIMEOUT_MS` |
| Soak | `SOAK_RETRIES`, `SOAK_TIMEOUT_MS` |
| Matrix | `SOAK_MATRIX_PROFILE_RETRIES`, `SOAK_MATRIX_PROFILE_TIMEOUT_MS` |
| Sweep | `SOAK_MATRIX_SWEEP_RUNS`, `SOAK_MATRIX_SWEEP_TIMEOUT_MS`, `SOAK_MATRIX_SWEEP_MIN_SUCCESS_RATE` |

## Reading the results

- If the simulated demos pass but the live tests fail, the problem is the network path, not your agents or client setup.
- Strict corporate networks and some WSL setups block WebRTC's UDP traffic. Try forced TURN, or switch both agents to the [HTTP relay](http-relay.md). These tests cover WebRTC only.
- TURN improves reachability, but it doesn't get through every firewall policy.
