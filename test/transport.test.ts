import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

import { REQUEST_TIMEOUT_MS } from "../src/lsp/constants.js";
import { LspConnectionClosedError, LspRequestTimeoutError } from "../src/lsp/errors.js";
import { LspClientTransport } from "../src/lsp/transport.js";
import type { ResolvedServer } from "../src/lsp/types.js";

import { makeServer } from "./helpers/fake-lsp-client.js";

class NotificationHarness extends LspClientTransport {
	private readonly input = new PassThrough();
	private readonly output = new PassThrough();

	constructor() {
		super("/root/a", makeServer("typescript"));
	}

	installDestroyedConnection(): void {
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.output),
		);
		connection.listen();
		this.connection = connection;
		this.output.destroy();
	}

	notify(): Promise<void> {
		return this.sendNotification("window/logMessage", { type: 3, message: "test" });
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.output.destroy();
	}
}

class StopHarness extends LspClientTransport {
	readonly requests: string[] = [];
	readonly notifications: string[] = [];
	private readonly input = new PassThrough();
	private readonly output = new PassThrough();

	constructor() {
		super("/root/a", makeServer("typescript"));
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.output),
		);
		connection.listen();
		this.connection = connection;
	}

	protected override sendRequest<T>(method: string): Promise<T>;
	protected override sendRequest<T>(method: string, params: unknown): Promise<T>;
	protected override async sendRequest<T>(method: string, _params?: unknown): Promise<T> {
		this.requests.push(method);
		return null as T;
	}

	protected override async sendNotification(method: string): Promise<void> {
		this.notifications.push(method);
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.output.destroy();
	}
}

class UnresponsiveHarness extends LspClientTransport {
	private readonly input = new PassThrough();
	private readonly output = new PassThrough();

	constructor(server: ResolvedServer) {
		super("/root/a", server);
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.output),
		);
		connection.listen();
		this.connection = connection;
	}

	// Server never replies — this is the only way to exercise the timeout path
	// without a real subprocess.
	requestThatNeverResolves(): Promise<unknown> {
		return this.sendRequest("initialize", {});
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.output.destroy();
	}
}

describe("LspClientTransport", () => {
	it("#given server with no requestTimeoutMs override #when request never resolves #then it times out at the default", async () => {
		// given
		vi.useFakeTimers();
		const harness = new UnresponsiveHarness(makeServer("typescript"));

		try {
			// when
			const pending = harness.requestThatNeverResolves();
			const assertion = expect(pending).rejects.toBeInstanceOf(LspRequestTimeoutError);
			await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

			// then
			await assertion;
		} finally {
			harness.disposeHarness();
			vi.useRealTimers();
		}
	});

	it("#given server with a longer requestTimeoutMs override #when request outlives the default #then it does not time out early", async () => {
		// given
		vi.useFakeTimers();
		const harness = new UnresponsiveHarness(
			makeServer("kotlin", [".kt"], { requestTimeoutMs: REQUEST_TIMEOUT_MS * 3 }),
		);

		try {
			// when: advance past the global default but still under the override
			const pending = harness.requestThatNeverResolves();
			let settled = false;
			pending.catch(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);

			// then: the request must still be pending — the override, not the default, governs it
			expect(settled).toBe(false);

			// cleanup: let it actually time out so nothing is left dangling
			await expect(vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 3).then(() => pending)).rejects.toBeInstanceOf(
				LspRequestTimeoutError,
			);
		} finally {
			harness.disposeHarness();
			vi.useRealTimers();
		}
	});

	it("#given destroyed json-rpc writer #when notification is sent #then write failure rejects to caller", async () => {
		// given
		const harness = new NotificationHarness();
		harness.installDestroyedConnection();

		try {
			// when / then
			await expect(harness.notify()).rejects.toBeInstanceOf(LspConnectionClosedError);
		} finally {
			harness.disposeHarness();
		}
	});

	it("#given active connection #when stopping #then shutdown is a request before exit notification", async () => {
		// given
		const harness = new StopHarness();

		try {
			// when
			await harness.stop();

			// then
			expect(harness.requests).toEqual(["shutdown"]);
			expect(harness.notifications).toEqual(["exit"]);
		} finally {
			harness.disposeHarness();
		}
	});
});
