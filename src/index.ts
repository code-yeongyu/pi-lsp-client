import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { getMergedServers } from "./lsp/config-loader.js";
import { LspInspectorComponent } from "./lsp/inspector.js";
import { disposeDefaultLspManager, getLspManager } from "./lsp/manager.js";
import {
	appendPostEditDiagnostics,
	POST_EDIT_DIAGNOSTICS_WIDGET_KEY,
	syncPostEditDiagnosticsWidget,
} from "./lsp/post-edit-diagnostics.js";
import {
	renderDiagnosticsCall,
	renderDiagnosticsResult,
	renderFindReferencesCall,
	renderFindReferencesResult,
	renderGotoDefinitionCall,
	renderGotoDefinitionResult,
	renderPrepareRenameCall,
	renderPrepareRenameResult,
	renderRenameCall,
	renderRenameResult,
	renderSymbolsCall,
	renderSymbolsResult,
} from "./lsp/renderers.js";
import { AUTO_INSTALLABLE_SERVERS, BUILTIN_SERVERS, LSP_INSTALL_HINTS } from "./lsp/server-definitions.js";
import { getAllServers } from "./lsp/server-resolution.js";
import { type LspDiagnosticsDetails, lsp_diagnostics } from "./lsp/tools/diagnostics.js";
import { type LspFindReferencesDetails, lsp_find_references } from "./lsp/tools/find-references.js";
import { type LspGotoDefinitionDetails, lsp_goto_definition } from "./lsp/tools/goto-definition.js";
import {
	type LspPrepareRenameDetails,
	type LspRenameDetails,
	lsp_prepare_rename,
	lsp_rename,
} from "./lsp/tools/rename.js";
import { type LspSymbolsDetails, lsp_symbols } from "./lsp/tools/symbols.js";

const STATUS_KEY = "pi-lsp";

interface ResultLike<T> {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: T;
}

export interface PostEditToolResultHandlerResult {
	content?: ToolResultEvent["content"];
}

export type PostEditToolResultHandler = (
	event: ToolResultEvent,
	ctx: ExtensionContext,
) => Promise<PostEditToolResultHandlerResult | undefined> | PostEditToolResultHandlerResult | undefined;

export interface PostEditToolResultRegistrar {
	on(event: "tool_result", handler: PostEditToolResultHandler): void;
}

/**
 * pi-lsp-client — Language Server Protocol integration for the pi coding agent.
 *
 * Ports omo's LSP tool stack as a pi extension. Provides a shared LspManager
 * with refCount-based lifecycle, idle cleanup (5min), init reaping (60s),
 * typed crash retry for read tools, and a `/lsp` inspector backed by an
 * explicit getSnapshot() API.
 *
 * Tools registered:
 *   - lsp_diagnostics      — errors/warnings/info from language servers
 *   - lsp_goto_definition  — jump to symbol definition
 *   - lsp_find_references  — all usages of a symbol across the workspace
 *   - lsp_symbols          — document outline or workspace symbol search
 *   - lsp_prepare_rename   — validate rename feasibility
 *   - lsp_rename           — apply a workspace edit (sequential)
 *
 * Commands registered:
 *   - /lsp                 — interactive inspector for the active server pool
 *   - /lsp status          — one-line summary of installed servers
 *   - /lsp install <id>    — run an install recipe where whitelisted
 *   - /lsp warmup <id>     — explicit spawn + initialize of an installed server
 *
 * See README.md for installation and usage.
 */
export default function (pi: ExtensionAPI): void {
	const manager = getLspManager();

	pi.registerTool({
		...lsp_diagnostics,
		renderCall: (args, theme) => renderDiagnosticsCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderDiagnosticsResult(result as ResultLike<LspDiagnosticsDetails>, options, theme),
	});

	pi.registerTool({
		...lsp_goto_definition,
		renderCall: (args, theme) => renderGotoDefinitionCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderGotoDefinitionResult(result as ResultLike<LspGotoDefinitionDetails>, options, theme),
	});

	pi.registerTool({
		...lsp_find_references,
		renderCall: (args, theme) => renderFindReferencesCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderFindReferencesResult(result as ResultLike<LspFindReferencesDetails>, options, theme),
	});

	pi.registerTool({
		...lsp_symbols,
		renderCall: (args, theme) => renderSymbolsCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderSymbolsResult(result as ResultLike<LspSymbolsDetails>, options, theme),
	});

	pi.registerTool({
		...lsp_prepare_rename,
		renderCall: (args, theme) => renderPrepareRenameCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderPrepareRenameResult(result as ResultLike<LspPrepareRenameDetails>, options, theme),
	});

	pi.registerTool({
		...lsp_rename,
		renderCall: (args, theme) => renderRenameCall(args as never, theme),
		renderResult: (result, options, theme) =>
			renderRenameResult(result as ResultLike<LspRenameDetails>, options, theme),
	});

	const updateStatus = (ctx: ExtensionContext): void => {
		const snapshots = manager.getSnapshot();
		const ui = ctx.ui;
		if (snapshots.length === 0) {
			ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const alive = snapshots.filter((s) => s.alive && !s.isInitializing).length;
		const initializing = snapshots.filter((s) => s.isInitializing).length;
		const theme = ui.theme;
		const parts: string[] = [];
		if (alive > 0) parts.push(theme.fg("success", `LSP ${alive}`));
		if (initializing > 0) parts.push(theme.fg("warning", `init ${initializing}`));
		ui.setStatus(STATUS_KEY, parts.join(" "));
	};

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	registerPostEditDiagnosticsHook(pi);

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(POST_EDIT_DIAGNOSTICS_WIDGET_KEY, undefined);
		await disposeDefaultLspManager();
	});

	pi.registerCommand("lsp", {
		description: "Inspect active LSP servers, install or warm up servers",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();

			if (args.startsWith("install")) {
				const id = args.slice("install".length).trim();
				if (!id) {
					ctx.ui.notify("Usage: /lsp install <serverId>", "warning");
					return;
				}
				await runInstall(id, ctx);
				return;
			}

			if (args.startsWith("warmup")) {
				const id = args.slice("warmup".length).trim();
				if (!id) {
					ctx.ui.notify("Usage: /lsp warmup <serverId>", "warning");
					return;
				}
				runWarmup(id, ctx);
				return;
			}

			if (args === "status") {
				const installed = getAllServers().filter((s) => s.installed);
				const summary =
					installed.length === 0
						? "No installed LSP servers"
						: `${installed.length} installed server(s): ${installed.map((s) => s.id).join(", ")}`;
				ctx.ui.notify(summary, "info");
				return;
			}

			if (!ctx.hasUI) {
				const snapshots = manager.getSnapshot();
				const summary =
					snapshots.length === 0
						? "No active LSP servers"
						: `${snapshots.length} active: ${snapshots.map((s) => s.serverId).join(", ")}`;
				ctx.ui.notify(summary, "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new LspInspectorComponent(manager, theme, () => done());
			});
		},
	});
}

export function registerPostEditDiagnosticsHook(pi: PostEditToolResultRegistrar): void {
	pi.on("tool_result", handlePostEditDiagnosticsToolResult);
}

export async function handlePostEditDiagnosticsToolResult(
	event: ToolResultEvent,
	ctx: ExtensionContext,
): Promise<PostEditToolResultHandlerResult | undefined> {
	const result = await appendPostEditDiagnostics(event, async (filePath) => {
		const result = await lsp_diagnostics.execute(
			`${event.toolCallId}:post-edit-diagnostics:${filePath}`,
			{ filePath, severity: "error" },
			undefined,
			undefined,
			ctx,
		);
		return result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	});
	syncPostEditDiagnosticsWidget((key, content, options) => ctx.ui.setWidget(key, content, options), result);
	return result?.content ? { content: result.content } : undefined;
}

async function runInstall(id: string, ctx: ExtensionContext): Promise<void> {
	const recipe = AUTO_INSTALLABLE_SERVERS[id];
	if (!recipe) {
		const hint = LSP_INSTALL_HINTS[id];
		if (hint) {
			ctx.ui.notify(`No automated installer for '${id}'. Manual install: ${hint}`, "warning");
		} else if (BUILTIN_SERVERS[id]) {
			ctx.ui.notify(`No automated installer or hint for '${id}'.`, "warning");
		} else {
			ctx.ui.notify(`Unknown server id '${id}'.`, "error");
		}
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `Installing ${id}...`);
	const [cmd, ...args] = recipe;
	if (!cmd) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`Invalid install recipe for '${id}'`, "error");
		return;
	}

	await new Promise<void>((resolve) => {
		const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.once("error", (err) => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(`Install failed: ${err.message}`, "error");
			resolve();
		});
		proc.once("close", (code) => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (code === 0) {
				ctx.ui.notify(`Installed '${id}' successfully`, "info");
			} else {
				const tail = stderr.trim().split("\n").slice(-3).join("\n");
				ctx.ui.notify(`Install '${id}' failed (exit ${code})\n${tail}`, "error");
			}
			resolve();
		});
	});
}

function runWarmup(id: string, ctx: ExtensionContext): void {
	const server = getMergedServers().find((candidate) => candidate.id === id);
	if (!server) {
		ctx.ui.notify(`Unknown server id '${id}'.`, "error");
		return;
	}

	try {
		const { source: _source, ...resolved } = server;
		getLspManager().warmupClient(ctx.cwd, resolved);
		ctx.ui.notify(`Warming up '${id}' in background`, "info");
	} catch (err) {
		ctx.ui.notify(`Warmup '${id}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}
