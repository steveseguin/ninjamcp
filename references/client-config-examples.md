# Client configuration

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/client-config-examples.html)

Ready-to-paste setup for popular MCP clients. Every example launches the same local `stdio` server.

## Install the package

Install in a folder that will stay put:

```bash
npm i @vdoninja/mcp
```

The examples point at the server script inside that folder:

- Linux and macOS: `/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js`
- Windows: `C:\path\to\node_modules\@vdoninja\mcp\scripts\vdo-mcp-server.js`

Replace the placeholder with the real folder. Clients often start in a different working directory, so use an absolute path. In JSON on Windows, write each backslash twice (`C:\\path\\to\\...`) or use forward slashes.

## Codex and Claude Code

The installer registers the server for you, with an absolute path:

```bash
npx vdon-mcp-install
```

Register with one client, choose where Claude Code stores it, or pick a tool profile:

```bash
npx vdon-mcp-install --codex-only
npx vdon-mcp-install --claude-only --claude-scope user
npx vdon-mcp-install --preset core
```

Check the registration with `codex mcp get vdo-ninja-mcp` or `claude mcp get vdo-ninja-mcp`. Remove it with `npx vdon-mcp-install --uninstall`.

## Cursor

Add to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"],
      "env": { "VDON_MCP_TOOL_PROFILE": "core" }
    }
  }
}
```

## Gemini CLI

Add to `.gemini/settings.json` in the project, or to `~/.gemini/settings.json` (`%USERPROFILE%\.gemini\settings.json` on Windows):

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"],
      "env": { "VDON_MCP_TOOL_PROFILE": "core" }
    }
  }
}
```

Restart Gemini CLI, then run `/mcp` to confirm the server is connected.

## OpenCode

Add under `mcp` in `opencode.json` in the project root, or in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vdo-ninja-mcp": {
      "type": "local",
      "command": ["node", "/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"],
      "enabled": true,
      "environment": { "VDON_MCP_TOOL_PROFILE": "core" }
    }
  }
}
```

## Other clients

Any client that launches local `stdio` servers needs a command, the script path, and optional flags or environment variables:

```json
{
  "command": "node",
  "args": ["/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js", "--tool-profile", "core"]
}
```

Server settings work as flags, such as `--tool-profile core`, or as environment variables, such as `VDON_MCP_TOOL_PROFILE=core`. A flag takes precedence. The [configuration reference](https://steveseguin.github.io/ninjamcp/guide.html#config) lists them all.

For clients that connect to remote MCP servers over HTTP instead, see [MCP over HTTP](https://steveseguin.github.io/ninjamcp/guide.html#mcp-http).

## Check the connection

Restart the client and ask the agent to call:

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

A result with the server version and active profile means the client is wired up. Then follow the [quickstart](quickstart-and-compat.md) to connect two agents.

## Keep the tool list small

Every MCP server adds its tool descriptions to the agent's context. Start with the `core` profile, which has 9 tools, and move to `file`, `state`, or `full` only when you need file transfer or shared state.

## Example: two Codex sessions

Use a new room name for each test.

1. Install and register once:

```bash
npm i @vdoninja/mcp
npx vdon-mcp-install --codex-only
```

2. Open two Codex sessions, A and B.

3. In session A, join the room:

```json
{ "name": "vdo_connect", "arguments": { "room": "codex_lab_001", "stream_id": "codex_a" } }
```

4. In session B, join and connect to A:

```json
{ "name": "vdo_connect", "arguments": { "room": "codex_lab_001", "stream_id": "codex_b", "target_stream_id": "codex_a" } }
```

5. In session A, send a message:

```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<codex_a_session_id>",
    "target": "codex_b",
    "data": { "type": "chat.message", "text": "hello from codex_a" }
  }
}
```

6. In session B, read it:

```json
{ "name": "vdo_receive", "arguments": { "session_id": "<codex_b_session_id>", "wait_ms": 1000 } }
```

Expected result: a `data_received` event containing `"hello from codex_a"`.

The same steps work for two Claude Code sessions (register with `--claude-only`) or for one of each.

## Scripted check

For a quick pass or fail without agents:

```bash
npx vdon-mcp-demo-message
npx vdon-mcp-demo-file
```

Each script exits successfully when its message or file exchange completes.
