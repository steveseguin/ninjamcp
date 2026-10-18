# Ninja MCP integration instructions

## Guides

- Provide user guides in both Markdown under `references/` and HTML under `docs/`.
- Keep both versions in sync when changing setup steps, commands, permissions, or limits.
- Reuse the documentation site's styles and navigation. Link new guides from `docs/guide.html`
  and include their URLs in `docs/sitemap.xml`.

## Social Stream Ninja / SSApp

Before working on SSApp support, read [references/ssapp-integration.md](references/ssapp-integration.md).
It documents the local interface and the optional `vdon-mcp-ssapp` remote backend.
Use [references/ssapp-capability-matrix.md](references/ssapp-capability-matrix.md) for capability
coverage, ownership, remaining work and validation procedures. Keep its stable row IDs and distinguish
implemented code from demonstrated remote workflows; retain execution evidence outside this checkout.

- Reuse SSApp's existing `ssapp_*` MCP tools and control API. Preserve their schemas, image results,
  version information, confirmation semantics, and structured errors.
- Keep SSApp's tokenless API bound to `127.0.0.1`. Remote authentication and control ownership belong
  in the Ninja MCP bridge; ordinary SSN chat-session membership must not grant app control.
- Keep remote access opt-in. Preserve ordinary SSApp appearance, behavior, sessions, and startup cost.
  Start capture or streaming only when requested. An AI provider or model must remain optional.
- Keep the existing Chrome worker and ordinary Ninja MCP messaging/file/state workflows working.
  SSApp support must operate the running Electron app and its windows through its supported controls.
- If SSApp API/MCP contracts change, update its canonical `control-social-stream` skill and version log
  in the same work. Runtime capabilities determine availability, including builds sharing a version.
- Use the real SSApp runtime for integration validation. Keep scratch harnesses, credentials, profiles,
  screenshots, and test reports outside the public checkout.

Local source locations on Steve's machine:

- SSApp: `C:\Users\steve\Code\ssapp`
- Social Stream sources: `C:\Users\steve\Code\social_stream`
- Canonical skill: `C:\Users\steve\Code\social_stream\docs\skills\control-social-stream`
- VDO.Ninja SDK: `C:\Users\steve\Code\ninjasdk`
- Agent coordination: `C:\Users\steve\Code\ninja-p2p`

Read each repository's instructions before changing it. In SSApp, do not read or modify
`resources/social_stream_fallback`; source changes belong in `social_stream`.
Do not create branches, worktrees, or pull requests without Steve explicitly requesting them.
