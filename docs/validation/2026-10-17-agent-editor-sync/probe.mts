/** 真实模型 + 隔离 Electron；不复制可轮换凭据，不保存模型原文到验收目录。 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { CheckpointArchive } from "../../../packages/runtime/dist/harness/checkpoint-archive.js";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, waitForSessionIdle } from "../../../apps/desktop/test/launch.js";

declare const window: { suiming: DesktopBridge };
const output = resolve("docs/validation/2026-10-17-agent-editor-sync");
const directory = await mkdtemp(join(tmpdir(), "suiming-agent-editor-real-"));
const root = join(directory, "work");
await mkdir(root);
await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
const a = "intent/计谋的代价.md";
const b = "讨论备忘.md";
const c = "留待明天.md";
await writeFile(join(root, b), "乙的原文。\n");
await writeFile(join(root, c), "丙的原文。\n");
(await LocalProjectService.init({ checkoutPath: root })).close();
const originalA = await readFile(join(root, a), "utf8");
const draftA = `${originalA}\n作者补充：不能牺牲无辜者。\n`;
const draftB = "乙的原文。\n作者补充：保留渡口会面的构想。\n";
const outsideB = "乙的原文。\n外部补充：渡口在夜里封锁。\n";
await copyFile(
	process.env.SUIMING_CONFIG_PATH ?? join(homedir(), ".suiming/config.toml"),
	join(directory, "config.toml"),
);
const telemetry = Object.fromEntries(
	Object.entries(process.env).filter(([key, value]) => key.startsWith("LANGFUSE_") && value !== undefined),
) as Record<string, string>;
const app = await launchDesktop({
	directory,
	project: root,
	flags: ["--unconfigured-model-test"],
	env: {
		...telemetry,
		SUIMING_AUTH_PATH: process.env.SUIMING_AUTH_PATH ?? join(homedir(), ".suiming/auth.json"),
		SUIMING_TELEMETRY_CONTENT: "false",
		SUIMING_TELEMETRY_ENVIRONMENT: "validation-editor-sync",
	},
});
const telemetryDiagnostics: string[] = [];
app.process().stderr?.on("data", (chunk) => {
	// 只记导出诊断码，不保留可能含原文、路径或凭据的整段 stderr。
	for (const match of String(chunk).matchAll(/\[Suiming telemetry\] ([a-z_]+)/g)) telemetryDiagnostics.push(match[1]);
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
const errors = collectPageErrors(page);
let completed = false;
try {
	await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	for (const [path, content] of [
		[a, draftA],
		[b, draftB],
		[c, "丙的草稿，还未定稿。"],
	]) {
		await page.keyboard.press("Meta+t");
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(path);
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill(content);
	}
	await writeFile(join(root, b), outsideB);
	const before = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	await input.fill(
		`请整理 ${a} 和 ${b}。我在编辑器里还没保存，乙同时被外部修改了；保留原有内容以及作者和外部两边的补充，在两份文件末尾各增加“验收补充：下一轮再展开。”。这是文件协作验收，不扩写故事，不委派，不提交版本，不改其他文件，尤其不要动 ${c}。请直接完成，不需要我点击保存或处理冲突。`,
	);
	const started = Date.now();
	await page.getByRole("button", { name: "发送", exact: true }).click();
	let sessionId = "";
	await eventually(async () => {
		const sessions = await page.evaluate(() => window.suiming.invoke("session.list", {}));
		sessionId = sessions.sessions[0]?.id ?? "";
		return !!sessionId;
	}, "真实对话创建");
	await waitForSessionIdle(page, sessionId, 1, 360000);
	const afterA = await readFile(join(root, a), "utf8");
	const afterB = await readFile(join(root, b), "utf8");
	assert.ok(afterA.includes("不能牺牲无辜者") && afterA.includes("下一轮再展开"));
	assert.ok(
		afterB.includes("保留渡口会面的构想") && afterB.includes("渡口在夜里封锁") && afterB.includes("下一轮再展开"),
	);
	assert.equal(await readFile(join(root, c), "utf8"), "丙的原文。\n");
	assert.equal(await editor.innerText(), "丙的草稿，还未定稿。");
	assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId, before.revisionId);
	assert.equal(await page.getByRole("button", { name: "保存范围", exact: true }).count(), 0);
	await page.screenshot({ path: join(output, "real-desktop.png") });
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
	await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 960);
	await page.evaluate(
		() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
	);
	await input.fill("下一轮暂不发送");
	assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isVisible(), true);
	await page.screenshot({ path: join(output, "real-narrow.png") });
	await page.reload();
	await editor.waitFor();
	assert.equal(await editor.innerText(), "丙的草稿，还未定稿。");
	assert.equal(await input.inputValue(), "下一轮暂不发送");
	assert.deepEqual(errors, []);
	const sessions = await page.evaluate(() => window.suiming.invoke("session.list", {}));
	const project = await LocalProjectService.open(root);
	let actions: { call: { name: string; arguments: Record<string, unknown> } }[];
	try {
		const ref = project.createExecutionState().session(sessionId).checkpointRef ?? assert.fail("缺少 checkpoint");
		const state = (await new CheckpointArchive(project).read((await project.readExecutionObject(ref.id)).bytes)) as {
			loop: { actions: typeof actions };
		};
		actions = state.loop.actions;
		assert.ok(actions.some((a) => a.call.name === "read" && a.call.arguments.editor === true));
		assert.ok(actions.some((a) => a.call.name === "write" && typeof a.call.arguments.draftSHA === "string"));
	} finally {
		project.close();
	}
	const toolSequence = actions.map((a) => ({
		tool: a.call.name,
		editor: a.call.arguments.editor === true,
		merge: typeof a.call.arguments.draftSHA === "string",
	}));
	await writeFile(
		join(output, "real-measurements.json"),
		JSON.stringify(
			{
				passed: true,
				sessionId,
				elapsedMs: Date.now() - started,
				targetOnly: true,
				conflictMerged: true,
				canonUnchanged: true,
				reloadPreserved: true,
				errors,
				sessions,
				toolSequence,
				telemetryDiagnostics,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ passed: true, sessionId, elapsedMs: Date.now() - started }));
	completed = true;
} finally {
	if (!completed) await page.screenshot({ path: join(directory, "failure.png") }).catch(() => undefined);
	await app.close();
	if (completed) await rm(directory, { recursive: true, force: true });
	else console.error(`验收副本保留供排查：${directory}`);
}
