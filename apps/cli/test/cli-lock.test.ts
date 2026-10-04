import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { LocalProjectLock } from "@suiming/runtime";
import { SuimCliErrorSchema } from "@suiming/sdk";
import { Value } from "typebox/value";
import { SUIM_CLI_EXIT } from "../src/cli.js";
import { fixture, jsonCommand } from "./cli-harness.js";

// 单独成文件：拿不到作品锁要等满 PROJECT_LOCK_WAIT_MS（5 秒）才报错。放在 cli.test 里，这 5 秒都压在那一组的关键路径上；
// 单独一个文件，等的时候不占 CPU，和别的测试文件并行跑。
test("作品锁被别人占着：命令等满锁超时后报 project_locked，归 conflict、可重试", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const lock = await LocalProjectLock.acquire(checkoutPath);
		try {
			const locked = await jsonCommand(checkoutPath, ["commit"]);
			assert.equal(locked.exitCode, SUIM_CLI_EXIT.conflict);
			assert.equal(Value.Check(SuimCliErrorSchema, locked.value), true);
			assert.deepEqual(locked.value.error, {
				code: "project_locked",
				message: (locked.value.error as { message: string }).message,
				retryable: true,
			});
		} finally {
			await lock.release();
		}
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});
