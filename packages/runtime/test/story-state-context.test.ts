import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	compileHostContext,
	LocalProjectService,
	LocalWorkspace,
	materializeOpenStoryDirectorySnapshot,
	parseHostContextTask,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

test("故事状态按幕前 / 变化 / 幕后区分人物与读者知情，复用资源清空规则，查询绑定明确 revision", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-observation-"));
	let project: LocalProjectService | undefined;
	try {
		const files = sampleWorkFiles().map((file) => {
			if (!file.path.includes("/beat-")) return file;
			let text = new TextDecoder()
				.decode(file.bytes)
				.replace("  resource: [火船]", "  resource: [火船]\n  secret: [连环计]");
			text = text.replace(
				"changes:\n",
				file.path.endsWith("beat-0001.md")
					? "changes:\n  character:\n    黄盖:\n      secret:连环计.revealed: true\n"
					: "changes:\n  reader:\n    secret:连环计.revealed: true\n",
			);
			return { ...file, bytes: new TextEncoder().encode(text) };
		});
		await materializeOpenStoryDirectorySnapshot(root, files);
		project = await LocalProjectService.init({ checkoutPath: root });
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("状态查询不调用模型");
		});
		const revisionId = (await workspace.invoke("workspace.show", {})).revisionId;
		const query = (task: string) => workspace.invoke("workspace.context", { task, revisionId });
		const before = await query("design:state:beat-0001:before");
		assert.equal(before.revisionId, revisionId);
		assert.doesNotMatch(before.text, /连环计 · 已揭示/);
		assert.match(before.text, /火船 · 持有者：黄盖/);
		// 有人拿着的物品，位置是原子规则隐含清空的「无」，单列一行只是噪声。
		assert.doesNotMatch(before.text, /火船 · 位置/);
		assert.match(before.text, /诈降：尚未开启/);
		assert.ok(!before.paths.some((path) => path.endsWith("beat-0002.md")), "未来 Beat 不成为状态依据");
		const after = await query("design:state:beat-0001:after");
		assert.match(after.text, /黄盖 · 连环计 · 已揭示：是/);
		assert.doesNotMatch(after.text, /读者 · 连环计/);
		assert.match(after.text, /诈降：待兑现/);
		const changes = await query("design:state:beat-0002:changes");
		assert.match(changes.text, /火船 · 持有者：黄盖 → 无/);
		// 桌面只编译 Write Context 与设计视图；其余种类原来静默退回一份裁剪过的 Design Frame，结果是错的。
		for (const task of ["design", "review:design", "source:read:原作:0:100"])
			await assert.rejects(query(task), { code: "unsupported_context_task" }, task);
		assert.match(changes.text, /火船 · 已消耗：未记录 → 是/);
		assert.match(changes.text, /读者 · 连环计 · 已揭示：未记录 → 是/);
		assert.match(changes.text, /诈降：兑现/);
		const final = await query("design:state:beat-0002:after:resource:火船");
		assert.match(final.text, /火船 · 已消耗：是/);
		assert.doesNotMatch(final.text, /持有者：黄盖/);
		assert.match(final.text, /诈降：已兑现/);
		const character = await query("design:state:beat-0002:after:character:黄盖");
		assert.match(character.text, /黄盖 · 连环计 · 已揭示：是/);
		assert.doesNotMatch(character.text, /读者 · 连环计/);
		const host = await compileHostContext(project, "design:state:beat-0002:changes");
		assert.equal(host.text, changes.text, "host 与桌面使用相同投影");
		assert.equal(host.design?.phase, "changes");
		for (const id of ["beat-0001", "beat-0002"]) {
			const file = join(root, `outline/story/vol-0001/${id}.md`);
			await writeFile(file, (await readFile(file, "utf8")).replaceAll("连环计", "铁索连舟"));
		}
		assert.match((await query("design:state:beat-0001:after")).text, /连环计 · 已揭示/);
		await project.commitCheckout();
		assert.equal(
			(await query("design:state:beat-0001:after")).text,
			after.text,
			"推进 head 不改变旧 revision 的答案",
		);
		assert.match(
			(await workspace.invoke("workspace.context", { task: "design:state:beat-0001:after" })).text,
			/铁索连舟 · 已揭示/,
		);
		await assert.rejects(query("design:state:beat-0099:before"), { code: "story_beat_not_found" });
		await assert.rejects(query("design:state:beat-0001:after:character:不存在"), { code: "invalid_context_task" });
		for (const invalid of [
			"design:state:beat-0001",
			"design:state:beat-0001:during",
			"design:state:beat-0001:after:resource",
		])
			assert.throws(() => parseHostContextTask(invalid), { code: "invalid_context_task" });
	} finally {
		project?.close();
		await rm(root, { recursive: true, force: true });
	}
});
