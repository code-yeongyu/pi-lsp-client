import { describe, expect, it, vi } from "vitest";

import type { LspClient } from "../src/lsp/client.js";
import { LspManager } from "../src/lsp/manager.js";
import type { ResolvedServer } from "../src/lsp/types.js";

import { FakeLspClient, type FakeLspClientOptions, makeServer } from "./helpers/fake-lsp-client.js";

interface FakeContext {
	manager: LspManager;
	clients: FakeLspClient[];
	now: { value: number };
}

function setupManager(options?: {
	idleTimeoutMs?: number;
	initTimeoutMs?: number;
	reaperIntervalMs?: number;
	clientFactoryOptions?: () => FakeLspClientOptions;
}): FakeContext {
	const clients: FakeLspClient[] = [];
	const now = { value: 1_000 };
	const manager = new LspManager({
		idleTimeoutMs: options?.idleTimeoutMs ?? 5_000,
		initTimeoutMs: options?.initTimeoutMs ?? 1_000,
		reaperIntervalMs: options?.reaperIntervalMs ?? 100,
		now: () => now.value,
		clientFactory: (root: string, server: ResolvedServer): LspClient => {
			const client = new FakeLspClient(root, server, options?.clientFactoryOptions?.());
			clients.push(client);
			return client;
		},
	});
	return { manager, clients, now };
}

function firstClient(clients: readonly FakeLspClient[]): FakeLspClient {
	const client = clients[0];
	if (!client) throw new Error("expected first fake LSP client");
	return client;
}

function firstSnapshot(manager: LspManager): ReturnType<LspManager["getSnapshot"]>[number] {
	const entry = manager.getSnapshot()[0];
	if (!entry) throw new Error("expected first LSP manager snapshot entry");
	return entry;
}

describe("LspManager", () => {
	it("#given two concurrent getClient calls #when both await #then start and initialize run once", async () => {
		// given
		const { manager, clients } = setupManager();
		const server = makeServer("typescript");

		// when
		const [c1, c2] = await Promise.all([manager.getClient("/root/a", server), manager.getClient("/root/a", server)]);

		// then
		expect(clients.length).toBe(1);
		expect(c1).toBe(c2);
		expect(firstClient(clients).startCallCount).toBe(1);
		expect(firstClient(clients).initializeCallCount).toBe(1);
		expect(firstSnapshot(manager).refCount).toBe(2);

		await manager.stopAll();
	});

	it("#given different roots for same server #when getClient #then clients are not shared", async () => {
		// given
		const { manager, clients } = setupManager();
		const server = makeServer("typescript");

		// when
		const c1 = await manager.getClient("/root/a", server);
		const c2 = await manager.getClient("/root/b", server);

		// then
		expect(c1).not.toBe(c2);
		expect(clients.length).toBe(2);

		await manager.stopAll();
	});

	it("#given live pooled client #when getClient + releaseClient #then refCount decrements", async () => {
		// given
		const { manager, now } = setupManager();
		const server = makeServer("typescript");
		await manager.getClient("/root/a", server);

		// when
		now.value += 100;
		await manager.getClient("/root/a", server);
		expect(firstSnapshot(manager).refCount).toBe(2);
		manager.releaseClient("/root/a", server.id);
		manager.releaseClient("/root/a", server.id);

		// then
		expect(firstSnapshot(manager).refCount).toBe(0);

		await manager.stopAll();
	});

	it("#given dead pooled client #when getClient #then old client is stopped and new client is created", async () => {
		// given
		const { manager, clients } = setupManager();
		const server = makeServer("typescript");
		await manager.getClient("/root/a", server);
		manager.releaseClient("/root/a", server.id);
		firstClient(clients).markDead();

		// when
		const fresh = await manager.getClient("/root/a", server);

		// then
		expect(clients.length).toBe(2);
		expect(fresh).toBe(clients[1]);
		expect(clients[0]?.stopCallCount).toBeGreaterThan(0);

		await manager.stopAll();
	});

	it("#given refCount zero and idle past timeout #when reaper fires #then client is stopped and removed", async () => {
		// given
		vi.useFakeTimers();
		try {
			const { manager, clients, now } = setupManager({ idleTimeoutMs: 1_000, reaperIntervalMs: 100 });
			const server = makeServer("typescript");
			await manager.getClient("/root/a", server);
			manager.releaseClient("/root/a", server.id);

			// when
			now.value += 2_000;
			vi.advanceTimersByTime(150);

			// then
			expect(firstClient(clients).stopCallCount).toBeGreaterThan(0);
			expect(manager.getSnapshot()).toEqual([]);

			await manager.stopAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("#given hung init older than init timeout #when reaper fires #then client is stopped and key removed", async () => {
		// given
		vi.useFakeTimers();
		try {
			const { manager, clients, now } = setupManager({
				idleTimeoutMs: 60_000,
				initTimeoutMs: 1_000,
				reaperIntervalMs: 100,
				clientFactoryOptions: () => ({ initDelayMs: 60_000 }),
			});
			const server = makeServer("typescript");
			const acquisition = manager.getClient("/root/a", server);
			void acquisition.catch(() => {});

			// give microtasks time to register the pending init
			await Promise.resolve();
			expect(manager.getSnapshot()).toHaveLength(1);

			// when
			now.value += 2_000;
			vi.advanceTimersByTime(150);

			// then
			expect(firstClient(clients).stopCallCount).toBeGreaterThan(0);
			expect(manager.getSnapshot()).toEqual([]);

			await manager.stopAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("#given server initTimeoutMs longer than manager default #when init exceeds manager default #then reaper does not evict it", async () => {
		// given
		vi.useFakeTimers();
		try {
			const { manager, clients, now } = setupManager({
				idleTimeoutMs: 60_000,
				initTimeoutMs: 1_000,
				reaperIntervalMs: 100,
				clientFactoryOptions: () => ({ initDelayMs: 60_000 }),
			});
			// per-server override raises the effective timeout well above the manager default
			const server = makeServer("kotlin", [".kt"], { initTimeoutMs: 10_000 });
			const acquisition = manager.getClient("/root/a", server);
			void acquisition.catch(() => {});

			await Promise.resolve();
			expect(manager.getSnapshot()).toHaveLength(1);

			// when: past the manager default (1_000ms) but still under the server override (10_000ms)
			now.value += 2_000;
			vi.advanceTimersByTime(150);

			// then: the reaper must consult the per-server override, not the manager default
			expect(manager.getSnapshot()).toHaveLength(1);
			expect(firstClient(clients).stopCallCount).toBe(0);

			await manager.stopAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("#given server initTimeoutMs shorter than manager default #when init exceeds the override #then reaper evicts it early", async () => {
		// given
		vi.useFakeTimers();
		try {
			const { manager, clients, now } = setupManager({
				idleTimeoutMs: 60_000,
				initTimeoutMs: 10_000,
				reaperIntervalMs: 100,
				clientFactoryOptions: () => ({ initDelayMs: 60_000 }),
			});
			// per-server override lowers the effective timeout below the manager default
			const server = makeServer("flaky", [".flaky"], { initTimeoutMs: 500 });
			const acquisition = manager.getClient("/root/a", server);
			void acquisition.catch(() => {});

			await Promise.resolve();
			expect(manager.getSnapshot()).toHaveLength(1);

			// when: past the server override (500ms) but still under the manager default (10_000ms)
			now.value += 1_000;
			vi.advanceTimersByTime(150);

			// then: the reaper must consult the per-server override, not the manager default
			expect(firstClient(clients).stopCallCount).toBeGreaterThan(0);
			expect(manager.getSnapshot()).toEqual([]);

			await manager.stopAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("#given failed warmup #when later getClient #then key was deleted and a fresh client is built", async () => {
		// given
		let firstCall = true;
		const failingFactory = () => {
			if (firstCall) {
				firstCall = false;
				return { failInitialize: true };
			}
			return {};
		};
		const { manager, clients } = setupManager({ clientFactoryOptions: failingFactory });
		const server = makeServer("typescript");

		// when
		manager.warmupClient("/root/a", server);
		await new Promise((r) => setTimeout(r, 20));

		const fresh = await manager.getClient("/root/a", server);

		// then
		expect(clients.length).toBe(2);
		expect(fresh).toBe(clients[1]);

		await manager.stopAll();
	});

	it("#given failed start #when later getClient #then failed client is stopped and a fresh client is built", async () => {
		// given
		let firstCall = true;
		const failingFactory = () => {
			if (firstCall) {
				firstCall = false;
				return { failStart: true };
			}
			return {};
		};
		const { manager, clients } = setupManager({ clientFactoryOptions: failingFactory });
		const server = makeServer("typescript");

		// when
		await expect(manager.getClient("/root/a", server)).rejects.toThrow("fake start failed");

		// then
		expect(manager.getSnapshot()).toEqual([]);
		expect(clients[0]?.stopCallCount).toBeGreaterThan(0);

		const fresh = await manager.getClient("/root/a", server);
		expect(clients.length).toBe(2);
		expect(fresh).toBe(clients[1]);

		await manager.stopAll();
	});

	it("#given failed initialize #when later getClient #then failed client is stopped and a fresh client is built", async () => {
		// given
		let firstCall = true;
		const failingFactory = () => {
			if (firstCall) {
				firstCall = false;
				return { failInitialize: true };
			}
			return {};
		};
		const { manager, clients } = setupManager({ clientFactoryOptions: failingFactory });
		const server = makeServer("typescript");

		// when
		await expect(manager.getClient("/root/a", server)).rejects.toThrow("fake initialize failed");

		// then
		expect(manager.getSnapshot()).toEqual([]);
		expect(firstClient(clients).stopCallCount).toBeGreaterThan(0);

		const fresh = await manager.getClient("/root/a", server);
		expect(clients.length).toBe(2);
		expect(fresh).toBe(clients[1]);

		await manager.stopAll();
	});

	it("#given pending init #when caller signal aborts #then refCount not pinned and orphan is cleaned up", async () => {
		// given
		const { manager, clients } = setupManager({
			clientFactoryOptions: () => ({ initDelayMs: 10_000 }),
		});
		const server = makeServer("typescript");
		const controller = new AbortController();

		// when
		const acquisition = manager.getClient("/root/a", server, controller.signal);

		await Promise.resolve();
		expect(manager.getSnapshot()).toHaveLength(1);
		expect(firstSnapshot(manager).pendingWaiters).toBe(1);
		expect(firstSnapshot(manager).refCount).toBe(0);

		controller.abort();

		// then
		await expect(acquisition).rejects.toThrow();
		await new Promise((r) => setTimeout(r, 20));
		expect(manager.getSnapshot()).toEqual([]);
		expect(firstClient(clients).stopCallCount).toBeGreaterThan(0);

		await manager.stopAll();
	});

	it("#given multiple clients #when stopAll #then all clients stopped and pool cleared", async () => {
		// given
		const { manager, clients } = setupManager();
		await manager.getClient("/root/a", makeServer("typescript"));
		await manager.getClient("/root/b", makeServer("rust"));

		// when
		await manager.stopAll();

		// then
		expect(manager.getSnapshot()).toEqual([]);
		expect(clients.every((c) => c.stopCallCount > 0)).toBe(true);
	});

	it("#given snapshot #when inspecting fields #then exposes the documented contract", async () => {
		// given
		const { manager } = setupManager();
		await manager.getClient("/root/a", makeServer("typescript"));

		// when
		const snapshot = manager.getSnapshot();

		// then
		expect(snapshot).toHaveLength(1);
		const entry = firstSnapshot(manager);
		expect(entry.root).toBe("/root/a");
		expect(entry.serverId).toBe("typescript");
		expect(entry.command).toEqual(["fake-server"]);
		expect(typeof entry.refCount).toBe("number");
		expect(typeof entry.pendingWaiters).toBe("number");
		expect(typeof entry.lastUsedAt).toBe("number");
		expect(typeof entry.isInitializing).toBe("boolean");
		expect(typeof entry.alive).toBe("boolean");

		await manager.stopAll();
	});

	it("#given disposed manager #when getClient #then throws", async () => {
		// given
		const { manager } = setupManager();
		await manager.stopAll();

		// when / then
		await expect(manager.getClient("/root/a", makeServer("typescript"))).rejects.toThrow(/disposed/i);
	});
});
