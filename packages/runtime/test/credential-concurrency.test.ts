import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { JsonFileCredentialStore } from "../src/model/json-file-credential-store.js";

test("另一进程的读改写持锁期间这边排队，之后合并两边的凭据；崩溃留下的过期锁可回收", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-auth-process-"));
	const path = join(root, "auth.json");
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
import { JsonFileCredentialStore } from ${JSON.stringify(new URL("../src/model/json-file-credential-store.ts", import.meta.url).href)};
await new JsonFileCredentialStore({path: process.env.AUDIT_AUTH_FILE}).modify('a', async () => {
  const ready = new Promise(resolve => process.once('message', resolve));
  process.send('ready'); await ready;
  return {type:'api_key', key:'fake-a'};
}); process.disconnect();
`,
		],
		{ env: { ...process.env, AUDIT_AUTH_FILE: path }, stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	try {
		await once(child, "message");
		const store = new JsonFileCredentialStore({ path });
		let saved = false;
		const saving = store
			.modify("b", async () => ({ type: "api_key", key: "fake-b" }))
			.then(() => {
				saved = true;
			});
		await setTimeout(300);
		assert.equal(saved, false, "子进程的 modify 还没返回，这边不能抢先读改写");
		const exit = once(child, "exit");
		child.send("continue");
		assert.equal((await exit)[0], 0);
		await saving;
		assert.deepEqual(
			(await store.list()).map((item) => item.providerId),
			["a", "b"],
		);
		await mkdir(`${path}.lock`);
		const stale = new Date(Date.now() - 30000);
		await utimes(`${path}.lock`, stale, stale);
		await store.delete("a");
		assert.deepEqual(
			(await store.list()).map((item) => item.providerId),
			["b"],
		);
	} finally {
		child.kill();
		await rm(root, { recursive: true, force: true });
	}
});

test("刷新进行中断开账号：断开排在刷新之后，刷新写回的凭据随即被删掉", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-auth-refresh-"));
	try {
		const path = join(root, "auth.json");
		const a = new JsonFileCredentialStore({ path });
		const b = new JsonFileCredentialStore({ path });
		await a.modify("a", async () => ({ type: "api_key", key: "old" }));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = a.modify("a", async () => {
			entered.resolve();
			await release.promise;
			return { type: "api_key", key: "new" };
		});
		await entered.promise;
		const disconnect = b.delete("a");
		release.resolve();
		await refresh;
		await disconnect;
		assert.deepEqual(await a.list(), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("两个进程同时发现 token 快到期时只刷新一次：OpenAI 的 refresh token 用过一次就作废", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-auth-refresh-once-"));
	try {
		const path = join(root, "auth.json");
		const a = new JsonFileCredentialStore({ path });
		const b = new JsonFileCredentialStore({ path });
		await a.modify("openai", async () => ({ type: "oauth", access: "a0", refresh: "r0", expires: 0 }));
		const used: string[] = [];
		// 与 pi-ai 的 resolveStoredOAuth 同形：在 modify 里复查是否已被别人刷新，没有才拿 refresh token 换新。
		const refresh = (store: JsonFileCredentialStore) =>
			store.modify("openai", async (current) => {
				if (current?.type !== "oauth" || current.expires > Date.now()) return undefined;
				used.push(current.refresh);
				await setTimeout(50);
				return {
					type: "oauth",
					access: `a${used.length}`,
					refresh: `r${used.length}`,
					expires: Date.now() + 3_600_000,
				};
			});
		const [first, second] = await Promise.all([refresh(a), refresh(b)]);
		assert.deepEqual(used, ["r0"]);
		assert.deepEqual(first, second);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
