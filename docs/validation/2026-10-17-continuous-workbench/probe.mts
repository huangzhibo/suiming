/** 隔离双作品 + 真实桌面模型；OTLP 透明转发仅记批次元数据，首批受控延迟 1.8 秒。 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { CheckpointArchive } from "../../../packages/runtime/dist/harness/checkpoint-archive.js";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, waitForSessionIdle } from "../../../apps/desktop/test/launch.js";

declare const window: { suiming: DesktopBridge };
const output = resolve("docs/validation/2026-10-17-continuous-workbench");
// 仅用于脚本中途断言失败后沿保留的隔离副本补验，避免重跑已通过的真实创作。
const resume = process.env.SUIMING_VALIDATION_RESUME;
const directory = resume ?? (await realpath(await mkdtemp(join(tmpdir(), "suiming-continuous-ui-"))));
const previous = resume ? JSON.parse(await readFile(join(directory, "diagnostics.json"), "utf8")) : null;
const roots = [join(directory, "甲作品"), join(directory, "乙作品")];
const textA = "text/beat-0001.md",
	textB = "text/beat-0002.md",
	note = "留待明天.md";
const originals = ["黄盖把军杖看了一眼。\n", "火船离岸，江水没过船头的倒影。\n"];
for (const root of resume ? [] : roots) {
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await mkdir(join(root, "text"));
	await writeFile(join(root, textA), originals[0]);
	await writeFile(join(root, textB), originals[1]);
	await writeFile(join(root, note), "只在磁盘的备忘。\n");
	(await LocalProjectService.init({ checkoutPath: root })).close();
}
if (!resume)
	await copyFile(
		process.env.SUIMING_CONFIG_PATH ?? join(homedir(), ".suiming/config.toml"),
		join(directory, "config.toml"),
	);
const batches: {
	status: number;
	durationMs: number;
	spans: { id: string; traceId: string; name: string; sessionId: string; outcome?: string }[];
}[] = previous?.batches ?? [];
let first = !resume;
const relay = createServer(async (req, res) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const json = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString());
		const spans = json.resourceSpans
			.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))
			.map((s: any) => {
				assert.ok(
					!s.attributes.some((a: any) =>
						["langfuse.observation.input", "langfuse.observation.output"].includes(a.key),
					),
				);
				const value = (key: string) => s.attributes.find((a: any) => a.key === key)?.value.stringValue;
				return {
					id: s.spanId,
					traceId: s.traceId,
					name: s.name,
					sessionId: value("langfuse.session.id"),
					outcome: value("langfuse.observation.metadata.outcome"),
				};
			});
		const start = Date.now();
		if (first) {
			first = false;
			await new Promise((r) => setTimeout(r, 1800));
		}
		const headers = Object.fromEntries(
			["authorization", "content-type", "content-encoding", "x-langfuse-ingestion-version"].flatMap((k) =>
				req.headers[k] ? [[k, String(req.headers[k])]] : [],
			),
		);
		const response = await fetch(new URL(req.url ?? "", process.env.LANGFUSE_BASE_URL), {
			method: "POST",
			headers,
			body: bytes,
			signal: AbortSignal.timeout(20000),
		});
		const body = await response.text();
		batches.push({ status: response.status, durationMs: Date.now() - start, spans });
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(body);
	} catch {
		res.writeHead(502);
		res.end("{}");
	}
});
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
const address = relay.address();
assert.ok(address && typeof address !== "string");
const env = {
	...(Object.fromEntries(
		Object.entries(process.env).filter(([k, v]) => k.startsWith("LANGFUSE_") && v !== undefined),
	) as Record<string, string>),
	LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
	SUIMING_AUTH_PATH: process.env.SUIMING_AUTH_PATH ?? join(homedir(), ".suiming/auth.json"),
	SUIMING_TELEMETRY_CONTENT: "false",
	SUIMING_TELEMETRY_ENVIRONMENT: "validation-continuous-workbench",
};
let app = await launchDesktop({ directory, project: roots[0], flags: ["--unconfigured-model-test"], env });
let page = await app.firstWindow();
page.setDefaultTimeout(15000);
const errors: string[] = [];
let pageErrors = collectPageErrors(page);
const diagnostics: string[] = previous?.diagnostics ?? [];
const watch = () =>
	app.process().stderr?.on("data", (chunk) => {
		for (const line of String(chunk).split("\n")) if (line.startsWith("[Suiming telemetry]")) diagnostics.push(line);
	});
watch();
let done = false;
const started = Date.now();
const steps: { name: string; ms: number }[] = previous?.steps ?? [];
let sessionA = previous?.sessionA ?? "",
	sessionB = previous?.sessionB ?? "";
const input = () => page.getByRole("textbox", { name: "输入消息", exact: true });
const editor = () => page.getByLabel("编辑文件内容", { exact: true });
const open = async (path: string) => {
	await page.keyboard.press("Meta+t");
	await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(path);
	await page.keyboard.press("Enter");
	await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).waitFor({ state: "hidden" });
	const edit = page.getByRole("button", { name: "切换到编辑视图", exact: true });
	await edit.or(editor()).first().waitFor();
	if (await edit.isVisible()) await edit.click();
	await editor().waitFor();
};
const send = async (text: string) => {
	await input().fill(text);
	await page.getByRole("button", { name: "发送", exact: true }).click();
};
const switchTo = async (root: string) => {
	await app.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
	}, root);
	await page.getByRole("button", { name: "切换作品", exact: true }).click();
	await page.getByRole("button", { name: "打开作品…", exact: true }).click();
	await eventually(
		async () =>
			page
				.evaluate(() => window.suiming.invoke("workspace.show", {}))
				.then(
					(value) => value.checkoutPath === root,
					() => false,
				),
		"切换完成",
	);
	await page
		.getByRole("button", { name: "切换作品", exact: true })
		.filter({ hasText: basename(root) })
		.waitFor();
};
try {
	await page.getByRole("textbox", { name: "输入消息", exact: true }).waitFor();
	let firstTexts: string[] = [];
	const initial = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
	if (!resume) {
		await open(textA);
		await editor().fill(`${originals[0]}黄盖没有求饶。`);
		await open(textB);
		await editor().fill(`${originals[1]}江面没有回答。`);
		await open(note);
		await editor().fill("甲作品未定稿，不能进入候选。");
		await send(
			"继续写这部作品。请依据已有设计，把 text/beat-0001.md 和 text/beat-0002.md 各修订成约 200—300 字的连贯正文。我刚补在编辑器里的‘黄盖没有求饶。’和‘江面没有回答。’请原样保留。只改这两份正文，不动设计、不委派、不提交版本；留待明天.md 还在推敲，不要读写。完成后把第一节相对 Canon 的差异展示给我。",
		);
		await eventually(async () => {
			sessionA = (await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.id ?? "";
			return !!sessionA;
		}, "创建甲对话");
		await editor().press("Meta+End");
		await page.keyboard.insertText("创作期间继续输入。");
		await input().fill("甲作品下一句尚未发送");
		await waitForSessionIdle(page, sessionA, 1, 360000);
		firstTexts = await Promise.all([textA, textB].map((p) => readFile(join(roots[0], p), "utf8")));
		assert.ok(firstTexts[0].includes("黄盖没有求饶。") && firstTexts[1].includes("江面没有回答。"));
		assert.ok(firstTexts.every((s) => s.length > 140));
		await page.locator(".cm-mergeView").waitFor();
		assert.equal(await input().inputValue(), "甲作品下一句尚未发送");
		assert.equal(await input().evaluate((e) => e === e.ownerDocument.activeElement), true);
		assert.equal(
			(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId,
			initial.revisionId,
		);
		steps.push({ name: "两份正文修订与差异展示", ms: Date.now() - started });
		await page.screenshot({ path: join(output, "revised-diff.png") });
		const attach = await page.evaluate((id) => window.suiming.invoke("session.attach", { sessionId: id }), sessionA);
		const sequence = attach.events.at(-1)?.sequence ?? 0;
		await send(
			"先不要写文件，也不要调用工具。请在对话里详细讨论这两节接下来可以如何改进，分十二个角度，每个角度约二百字。我可能中途叫停。",
		);
		await eventually(
			async () => {
				const a = await page.evaluate(
					({ id, sequence }) =>
						window.suiming.invoke("session.attach", { sessionId: id, afterSequence: sequence }),
					{ id: sessionA, sequence },
				);
				return a.events.some((e) => e.event.type === "TEXT_MESSAGE_CONTENT");
			},
			"真实流开始",
			180000,
		);
		const stopStart = Date.now();
		await page.getByRole("button", { name: "停止", exact: true }).click();
		await waitForSessionIdle(page, sessionA, 2, 20000);
		steps.push({ name: "真实流输出停止", ms: Date.now() - stopStart });
		await input().fill("甲作品恢复后再讨论");
		await switchTo(roots[1]);
		assert.equal((await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions.length, 0);
		await open(textA);
		await editor().fill("乙作品保留自己的独立草稿。");
		await send(
			"这是一部独立作品。仅查看当前页面的作者草稿，告诉我其中的一句话，不保存、不修改、不提交、不切换页面。",
		);
		await eventually(async () => {
			sessionB = (await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.id ?? "";
			return !!sessionB;
		}, "创建乙对话");
		await waitForSessionIdle(page, sessionB, 1, 180000);
		assert.equal(await editor().innerText(), "乙作品保留自己的独立草稿。");
		assert.equal(await readFile(join(roots[1], textA), "utf8"), originals[0]);
		await input().fill("乙作品的独立输入");
		await switchTo(roots[0]);
	} else {
		firstTexts = await Promise.all([textA, textB].map((p) => readFile(join(roots[0], p), "utf8")));
		assert.equal((await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.turn, 2);
	}
	assert.equal(await input().inputValue(), "甲作品恢复后再讨论");
	assert.equal((await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.id, sessionA);
	await page.locator(".tab-btn").filter({ hasText: note }).click();
	assert.equal(await editor().innerText(), "甲作品未定稿，不能进入候选。创作期间继续输入。");
	const noteDraft = await editor().innerText();
	await editor().press("Meta+End");
	await eventually(async () => await editor().evaluate((e) => e === e.ownerDocument.activeElement), "原编辑器焦点");
	errors.push(...pageErrors);
	const closed = app.waitForEvent("close");
	await app.evaluate(({ app }) => {
		setTimeout(() => app.quit(), 0);
	});
	await closed;
	app = await launchDesktop({ directory, flags: ["--unconfigured-model-test"], env });
	watch();
	page = await app.firstWindow();
	page.setDefaultTimeout(15000);
	pageErrors = collectPageErrors(page);
	await editor().waitFor();
	assert.equal(await editor().innerText(), noteDraft);
	assert.equal(await input().inputValue(), "甲作品恢复后再讨论");
	await editor().press("!");
	assert.equal(await editor().innerText(), `${noteDraft}!`);
	await editor().press("Meta+z");
	assert.equal(await editor().innerText(), noteDraft);
	await open(textA);
	await editor().press("Meta+End");
	await page.keyboard.insertText("\n他把衣角攥在掌心。");
	await send(
		"刚才的长讨论已经停止，不必补完。继续修改第一节：保留我新补的‘他把衣角攥在掌心。’和原有‘黄盖没有求饶。’，把两句融入动作，避免解释人物心理。第二节保持原样，不动留待明天.md。完成后检查并提交作品一次，再打开第一节定位‘他把衣角攥在掌心。’。不要委派。",
	);
	await input().fill("甲作品最后一条未发送要求");
	await waitForSessionIdle(page, sessionA, 3, 360000);
	assert.equal(await input().inputValue(), "甲作品最后一条未发送要求");
	assert.equal(await input().evaluate((e) => e === e.ownerDocument.activeElement), true);
	await editor().waitFor();
	assert.match(await editor().innerText(), /他把衣角攥在掌心。/);
	await page.locator(".cm-selectionBackground").first().waitFor();
	assert.equal(await page.getByRole("textbox", { name: "说明要怎么改", exact: true }).count(), 0);
	const final = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
	assert.equal(final.revisions.length, initial.revisions.length + 1);
	const finalA = await readFile(join(roots[0], textA), "utf8");
	assert.ok(finalA.includes("黄盖没有求饶。") && finalA.includes("他把衣角攥在掌心。"));
	assert.equal(await readFile(join(roots[0], textB), "utf8"), firstTexts[1]);
	assert.equal(await readFile(join(roots[0], note), "utf8"), "只在磁盘的备忘。\n");
	await page.screenshot({ path: join(output, "resumed-location.png") });
	await switchTo(roots[1]);
	assert.equal(await editor().innerText(), "乙作品保留自己的独立草稿。");
	assert.equal(await input().inputValue(), "乙作品的独立输入");
	assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisions.length, 1);
	errors.push(...pageErrors);
	assert.deepEqual(errors, []);
	const sessions = [];
	for (const [root, id] of [
		[roots[0], sessionA],
		[roots[1], sessionB],
	]) {
		const project = await LocalProjectService.open(root);
		try {
			const session = project.createExecutionState().session(id);
			const ref = session.checkpointRef ?? assert.fail("checkpoint");
			const state: any = await new CheckpointArchive(project).read(
				(await project.readExecutionObject(ref.id)).bytes,
			);
			sessions.push({
				id,
				turn: session.turn,
				usage: session.usage,
				actions: state.loop.actions.map((a: any) => ({
					name: a.call.name,
					action: a.call.arguments.action ?? null,
					status: a.status,
				})),
			});
		} finally {
			project.close();
		}
	}
	await app.close();
	await writeFile(
		join(output, "measurements.json"),
		JSON.stringify(
			{
				passed: true,
				probeResumed: !!resume,
				elapsedMs: Date.now() - started,
				steps,
				sessions,
				batches,
				diagnostics,
				errors,
				multiFilePreserved: true,
				crossProjectIsolated: true,
				restartPreserved: true,
				canonAdvancedOnce: true,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ passed: true, sessionA, sessionB, elapsedMs: Date.now() - started }));
	done = true;
} finally {
	if (!done) {
		await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
		console.error(`隔离副本保留：${directory}`);
	}
	await app.close().catch(() => {});
	if (!done)
		await writeFile(
			join(directory, "diagnostics.json"),
			JSON.stringify({ batches, diagnostics, steps, sessionA, sessionB }, null, 2),
		);
	relay.closeAllConnections();
	await new Promise<void>((r) => relay.close(() => r()));
	if (done) await rm(directory, { recursive: true, force: true });
}
