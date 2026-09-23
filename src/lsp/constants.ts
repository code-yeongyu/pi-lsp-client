export const DEFAULT_MAX_REFERENCES = 200;
export const DEFAULT_MAX_SYMBOLS = 200;
export const DEFAULT_MAX_DIAGNOSTICS = 200;
export const DEFAULT_MAX_DIRECTORY_FILES = 50;

// Default timeouts — override per-server via `.pi/lsp-client.json` or
// `~/.pi/lsp-client.json` (`requestTimeoutMs` / `initTimeoutMs` fields), since
// some servers (e.g. kotlin-language-server on a multi-module Gradle project)
// take far longer than others to answer `initialize`.
export const REQUEST_TIMEOUT_MS = 15_000;
export const INIT_TIMEOUT_MS = 60_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const REAPER_INTERVAL_MS = 60_000;
export const STOP_HARD_KILL_TIMEOUT_MS = 5_000;
export const STOP_SIGKILL_GRACE_MS = 1_000;
