# ARCHITECTURE.md — paseo-agentes

Clients: one block of Paseo's sidebar (web, desktop, phone) per daemon, and the «Agentes» panel of the Explorer. No other consumer.
Depends on: @getpaseo/plugin (handle, on, settings), PaseoApi (agents and workspaces subscriptions, observeEvents), Claude Code's
files on the daemon host (`~/.claude/tasks`, `~/.claude/projects`, `<tmp>/claude-<uid>`). Nothing depends on it: `panel.watch` is internal.
Stack: TypeScript, the SDK's React/RN, zod contracts (`shared/`), node:test (`npm test`).
Build and deploy: the daemon compiles it on load; `paseo plugin update paseo-agentes --ref main`.
Canonical parts: parsers `server/contexto.ts`; watcher scan and its guard `server/vigilantes.ts`; watches, cache and long poll
`server/vigilia.ts`; the client's single held call `client/vigila.ts`.
Rules (SC-5601): no timer feeds data (only the render clock of «hace X min»); nothing reads disk or `/proc` per client — every read
comes from the server's cache, invalidated by file watches or turn hooks; what Paseo already sends (`lastUsage`, `gitRuntime`,
`githubRuntime`, subagent events) is used as is, never read again by the plugin.
