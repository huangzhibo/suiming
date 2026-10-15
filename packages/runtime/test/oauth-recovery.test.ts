import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { OAUTH_TEST_PROVIDER, oauthFixture } from "./oauth-fixture.js";
import { oauthServer } from "./oauth-server.js";

test("两个独立进程经 pi-ai 同时刷新隔离 OAuth：只使用一次刷新令牌，取消调用不丢已轮换凭据", {
	timeout: 20000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-oauth-process-"));
	const server = await oauthServer();
	const path = join(root, "auth.json");
	const f = oauthFixture(path, server.endpoint);
	const children: ReturnType<typeof spawn>[] = [];
	try {
		await f.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
		const gate = Promise.withResolvers<void>();
		server.state.refreshGate = gate.promise;
		const start = () => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`
import { oauthFixture } from ${JSON.stringify(new URL("./oauth-fixture.ts", import.meta.url).href)};
const f = oauthFixture(process.argv[1], process.argv[2]);
const modify = f.credentials.modify.bind(f.credentials);
f.credentials.modify = (...args) => { process.send('waiting-for-refresh-lock'); return modify(...args); };
const auth = await f.models.getAuth(f.model);
if (auth?.auth.apiKey !== 'test-access-1') throw new Error('并发调用没读到同一份新凭据');
process.disconnect();
`,
					path,
					server.endpoint,
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
			);
			children.push(child);
			return { child, started: once(child, "message"), exit: once(child, "exit") };
		};
		const first = start();
		await server.state.refreshEntered.promise;
		const second = start();
		await second.started;
		gate.resolve();
		assert.equal((await first.exit)[0], 0);
		assert.equal((await second.exit)[0], 0);
		assert.equal(server.state.refreshes, 1);
		const refreshed = await f.credentials.read(OAUTH_TEST_PROVIDER);
		assert.equal(refreshed?.type === "oauth" && refreshed.access, "test-access-1");
		// pi-ai 在刷新开始后脱离调用方 signal：作者停止不应丢掉已轮换的令牌。
		await f.credentials.modify(OAUTH_TEST_PROVIDER, async (c) => {
			assert.ok(c?.type === "oauth");
			return { ...c, expires: 0 };
		});
		server.state.refreshEntered = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		server.state.refreshGate = secondGate.promise;
		const abort = new AbortController();
		const request = f.models.getAuth(f.model, { signal: abort.signal });
		const rejected = assert.rejects(request, /作者停止/);
		await server.state.refreshEntered.promise;
		abort.abort(new Error("作者停止"));
		await rejected;
		secondGate.resolve();
		// 排在刷新后读取，确认锁内落盘没有随调用取消。
		const saved = await f.credentials.modify(OAUTH_TEST_PROVIDER, async () => undefined);
		assert.equal(saved?.type === "oauth" && saved.access, "test-access-2");
		assert.equal(server.state.refreshes, 2);
	} finally {
		for (const child of children) child.kill();
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("授权刷新失效后原凭据保留，错误给出恢复指引；重新登录后原 Gateway 可直接使用", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-oauth-expired-"));
	const server = await oauthServer();
	try {
		const f = oauthFixture(join(root, "auth.json"), server.endpoint);
		await f.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
		const original = await readFile(f.credentials.path);
		server.state.failure = "invalid_grant: refresh token revoked";
		const bound = await f.gateway.bind("main");
		const response = await bound.stream({ messages: [{ role: "user", content: "继续", timestamp: 1 }] }).result();
		assert.equal(response.stopReason, "error");
		assert.match(response.errorMessage ?? "", /重新登录/);
		assert.match(response.errorMessage ?? "", /invalid_grant/);
		assert.deepEqual(await readFile(f.credentials.path), original);
		assert.equal(server.state.refreshes, 1);
		await f.models.login(OAUTH_TEST_PROVIDER, "oauth", { prompt: async () => "isolated-code", notify: () => {} });
		server.state.failure = "";
		const continued = await bound.stream({ messages: [{ role: "user", content: "继续", timestamp: 2 }] }).result();
		assert.equal(continued.stopReason, "stop");
		assert.equal(server.state.logins, 1);
		assert.equal(server.state.refreshes, 1);
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("刷新响应迟到与重新登录并发时，新登录凭据最终保留；网络刷新失败仍可重试且不清空账号", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-oauth-login-race-"));
	const server = await oauthServer();
	const gate = Promise.withResolvers<void>();
	try {
		const f = oauthFixture(join(root, "auth.json"), server.endpoint);
		const loginClient = oauthFixture(f.credentials.path, server.endpoint);
		await f.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
		server.state.refreshResultGate = gate.promise;
		const refresh = f.models.getAuth(f.model);
		await server.state.refreshRotated.promise;
		const login = loginClient.models.login(OAUTH_TEST_PROVIDER, "oauth", {
			prompt: async () => "isolated-code",
			notify: () => {},
		});
		await server.state.loginIssued.promise;
		gate.resolve();
		await Promise.all([refresh, login]);
		const saved = await f.credentials.read(OAUTH_TEST_PROVIDER);
		assert.equal(saved?.type === "oauth" && saved.access, "test-access-2");
		await f.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
		const before = await readFile(f.credentials.path);
		server.state.failure = "fetch failed";
		const bound = await f.gateway.bind("main");
		const context = { messages: [{ role: "user" as const, content: "继续", timestamp: 1 }] };
		const failed = await bound.stream(context).result();
		assert.match(failed.errorMessage ?? "", /先检查网络/);
		assert.match(failed.errorMessage ?? "", /fetch failed/);
		assert.equal(isRetryableAssistantError(failed), true, "恢复提示不改变 pi-ai 的瞬时重试判断");
		assert.deepEqual(await readFile(f.credentials.path), before);
		server.state.failure = "";
		assert.equal((await bound.stream(context).result()).stopReason, "stop");
		assert.equal(server.state.logins, 1, "网络恢复后无需重新登录");
	} finally {
		gate.resolve();
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
