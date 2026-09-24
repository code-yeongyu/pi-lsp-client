import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMergedServers } from "../src/lsp/config-loader.js";
import { findServerForExtension } from "../src/lsp/server-resolution.js";

let sandbox: string;
let projectDir: string;
let homeDir: string;

function writeProjectConfig(config: unknown): void {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "lsp-client.json"), JSON.stringify(config));
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-lsp-config-"));
	projectDir = join(sandbox, "project");
	homeDir = join(sandbox, "home");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	vi.spyOn(process, "cwd").mockReturnValue(projectDir);
	vi.stubEnv("HOME", homeDir);
	vi.stubEnv("USERPROFILE", homeDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(sandbox, { recursive: true, force: true });
});

describe("per-server timeout overrides", () => {
	it("#given a custom server with timeout overrides #when resolving by extension #then the resolved server carries both overrides", () => {
		// given
		writeProjectConfig({
			lsp: {
				slow: { command: ["node"], extensions: [".slow"], requestTimeoutMs: 90_000, initTimeoutMs: 120_000 },
			},
		});

		// when
		const result = findServerForExtension(".slow");

		// then
		expect(result.status).toBe("found");
		if (result.status !== "found") throw new Error("expected found");
		expect(result.server.id).toBe("slow");
		expect(result.server.requestTimeoutMs).toBe(90_000);
		expect(result.server.initTimeoutMs).toBe(120_000);
	});

	it("#given non-positive or non-number timeout values #when merging config #then those overrides are dropped", () => {
		// given
		writeProjectConfig({
			lsp: {
				zero: { command: ["node"], extensions: [".zero"], requestTimeoutMs: 0, initTimeoutMs: -5 },
				text: { command: ["node"], extensions: [".text"], requestTimeoutMs: "90000", initTimeoutMs: null },
			},
		});

		// when
		const servers = getMergedServers().filter((s) => s.source === "project");

		// then
		expect(servers.map((s) => s.id).sort()).toEqual(["text", "zero"]);
		for (const server of servers) {
			expect(server).not.toHaveProperty("requestTimeoutMs");
			expect(server).not.toHaveProperty("initTimeoutMs");
		}
	});
});
