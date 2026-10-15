/** 在冷备份恢复副本上验证桌面读取与重载；不发送消息，不调用模型。 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProjectService } from "@suiming/runtime";
import { collectPageErrors, launchDesktop } from "../../../apps/desktop/test/launch.js";

const project = process.env.SUIMING_VALIDATION_RESTORED;
assert.ok(project, "指定已由 probe.mts 核验的恢复副本");
const directory = await mkdtemp(join(tmpdir(), "suiming-restored-desktop-"));
async function execution() {
	const p = await LocalProjectService.open(project as string);
	try {
		return { entities: p.loadExecutionEntities(), history: await p.history() };
	} finally {
		p.close();
	}
}
const before = await execution();
const app = await launchDesktop({ directory, project });
const page = await app.firstWindow();
const errors = collectPageErrors(page);
try {
	await page.getByRole("button", { name: "选择对话", exact: true }).click();
	await page.getByRole("dialog").getByRole("button").first().click();
	const reply = page.locator(".message.assistant").filter({ hasText: "已完成正式全 Source 独立审稿" });
	await reply.waitFor({ timeout: 30000 });
	await reply.scrollIntoViewIfNeeded();
	const text = await reply.innerText();
	await page.screenshot({ path: join(directory, "before-reload.png") });
	await page.reload();
	await reply.waitFor({ timeout: 30000 });
	await reply.scrollIntoViewIfNeeded();
	assert.equal(await reply.innerText(), text);
	await page.screenshot({ path: join(directory, "after-reload.png") });
	assert.deepEqual(errors, []);
} catch (error) {
	await page.screenshot({ path: join(directory, "failure.png") });
	console.error(await page.locator("body").innerText());
	throw error;
} finally {
	await app.close();
}
assert.deepEqual(await execution(), before, "桌面打开与重载不重跑、不增加调用或作品版本");
await writeFile(join(directory, "result.json"), JSON.stringify({ restoredReply: true, reload: true, errors }));
console.log(JSON.stringify({ directory, restoredReply: true, reload: true, errors }));
