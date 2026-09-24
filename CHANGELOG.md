# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-24

### Added

- Per-server `requestTimeoutMs` and `initTimeoutMs` overrides in
  `.pi/lsp-client.json` / `~/.pi/lsp-client.json`
  ([#5](https://github.com/code-yeongyu/pi-lsp-client/pull/5), thanks
  [@mixxer](https://github.com/mixxer)). The overrides now reach the tool
  resolution path, and only finite positive numbers are accepted.

### Fixed

- `/lsp warmup <id>` resolves ids through the merged server list, so custom
  servers from `.pi/lsp-client.json` can be warmed up
  ([#4](https://github.com/code-yeongyu/pi-lsp-client/issues/4)).

### Changed

- `vscode-jsonrpc` `^8.2.1` -> `^9.0.2` (major). The transport imports the
  `vscode-jsonrpc/node` subpath export.
- Dev dependencies pinned exact: `@biomejs/biome` 2.5.5 -> 2.5.14, `vitest`
  ^4.1.5 -> 5.0.1, `typescript` ^7.0.2 -> 7.0.2, `@types/node` ^22.10.5 ->
  26.6.2, `@typescript/native-preview` ^7.0.0-dev.20260120.1 ->
  7.0.0-dev.20260707.2. Added `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 0.87.1 as
  dev dependencies so tests run against the current upstream runtime.
- Peer dependencies are limited to `@earendil-works/pi-*` (`*`). The
  `typebox` peer was dropped; `Type` is imported from `@earendil-works/pi-ai`.
- `engines.node` `>=20.0.0` -> `>=22.19.0`, matching `pi-coding-agent`.
- Biome config migrated to the 2.5.14 schema.
- CI runs on Bun 1.4.2 (`bun install --frozen-lockfile`, `bun run check`,
  `bun run test`, `npm pack --dry-run`) across ubuntu/macos x node 22/24,
  plus an `npm ci && npm test` consumer job. `bun.lock` added next to
  `package-lock.json`.

## [0.1.0]

Initial version (never tagged).

### Added

- Initial release porting omo's LSP tool stack as a pi-coding-agent extension.
- Six tools: `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`,
  `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename`.
- Shared `LspManager` singleton with refCount-based lifecycle, idle cleanup
  (5 minutes), init reaping (60 seconds), and abort-aware acquisition.
- Typed crash boundary: `LspConnectionClosedError` and
  `LspProcessExitedError` in `errors.ts`. The wrapper retries idempotent read
  tools exactly once on a typed dead-connection error; mutating tools are
  never retried.
- Built-in registry of 40+ language servers with per-server install hints
  ported verbatim from omo, plus an `AUTO_INSTALLABLE_SERVERS` whitelist that
  drives `/lsp install <id>` for safe automatic installation.
- Custom user config: `.pi/lsp-client.json` (project) and
  `~/.pi/lsp-client.json` (user) merge with project taking priority over
  user, both taking priority over the builtin registry.
- Three commands: `/lsp` (interactive inspector via `ctx.ui.custom`),
  `/lsp install <id>`, `/lsp warmup <id>`.
- Custom TUI rendering for all six tools, with bespoke expanded views for
  diagnostics, references, symbols, and rename, plus compact `Text`
  renderers for goto-definition and prepare-rename.
- Status footer (`ctx.ui.setStatus("pi-lsp", ...)`) showing alive vs
  initializing server counts, updated on `session_start` and `turn_end`,
  cleared on `session_shutdown`.
- `LspManager.getSnapshot()` API exposing per-client `{ root, serverId,
  refCount, pendingWaiters, lastUsedAt, isInitializing, alive, command }`
  for both the `/lsp` inspector and tests.
- TypeBox tool schemas with `StringEnum` for enum parameters so the tool
  surface stays compatible with Google's tool-calling API.
- `lsp_rename.executionMode = "sequential"` so workspace edits never race
  against pi's parallel tool execution or other mutating tools.
