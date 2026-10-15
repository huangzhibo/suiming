/** 在真实长任务的冷备份副本上验证生产包，只读历史与重载，不发送消息。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProjectService } from "@suiming/runtime";
import { collectPageErrors, launchDesktop } from "../../../apps/desktop/test/launch.js";

const source = process.env.SUIMING_VALIDATION_BACKUP;
const executablePath = process.env.SUIMING_VALIDATION_EXECUTABLE;
assert.ok(source && executablePath, "指定自含的公共作品冷备份与生产 .app 可执行文件");
const directory = await mkdtemp(join(tmpdir(), "suiming-installed-history-"));
const project = join(directory, "work");
execFileSync("ditto", [source, project]);
async function snapshot() {
	const service = await LocalProjectService.open(project);
	try {
		const entities = service.loadExecutionEntities();
		return {
			entities, history: await service.history(), candidate: await service.checkoutCandidate(),
			events: entities.sessions.map((session) => service.readSessionEvents(session.id)),
		};
	} finally { service.close(); }
}
const before = await snapshot();
assert.equal(before.entities.sessions.length, 1);
const app = await launchDesktop({ directory, project, executablePath });
const page = await app.firstWindow();
const errors = collectPageErrors(page);
try {
	assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
	await page.getByRole("button", { name: "选择对话", exact: true }).click();
	await page.getByRole("dialog").getByRole("button").first().click();
	const reply = page.locator(".message.assistant").filter({ hasText: "已完成正式全 Source 独立审稿" });
	await reply.waitFor({ timeout: 30000 });
	await reply.scrollIntoViewIfNeeded();
	const content = await reply.innerText();
	await page.reload();
	await reply.waitFor({ timeout: 30000 });
	await reply.scrollIntoViewIfNeeded();
	assert.equal(await reply.innerText(), content);
	await page.screenshot({ path: join(directory, "history.png") });
	assert.deepEqual(errors, []);
} finally { await app.close(); }
assert.deepEqual(await snapshot(), before, "安装包只读重开不改候选、Canon、调用或持久事件");
const result = { revisions: before.history.length, sessions: before.entities.sessions.length,
	tasks: before.entities.tasks.length, events: before.events.reduce((n, records) => n + records.length, 0),
	packaged: true, reloadPreserved: true, errors };
await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ directory, ...result }));
