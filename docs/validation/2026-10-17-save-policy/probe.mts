/** node --import tsx docs/validation/2026-10-17-save-policy/probe.mts [--interactive] */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "../../../packages/runtime/src/index.js";
import { ConfinedExecutionEnv } from "../../../packages/runtime/src/harness/confined-env.js";
import { fileTools } from "../../../packages/runtime/src/harness/tools.js";
import { readProjectFile, saveProjectFile } from "../../../packages/runtime/src/local/project-files.js";
import { sampleWorkFiles, sampleWorkText } from "../../../packages/runtime/test/sample-work.js";

const here = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), "suiming-save-policy-"));
const interactive = process.argv.includes("--interactive");
const a = "world/characters/黄盖.md";
const b = "intent/计谋的代价.md";
const paths = [a, b];
const partial = "第二幕人物最终决定";
const addition = "\nAgent 补充：他清楚这一选择的代价。\n";
const modes = ["manual", "handoff", "idle"] as const;
type Mode = (typeof modes)[number];
const results: object[] = [];
let checks = 0;
await build({
	entryPoints: [join(here, "prototype.tsx")],
	bundle: true,
	format: "esm",
	platform: "browser",
	jsx: "automatic",
	outfile: join(output, "prototype.js"),
	logLevel: "warning",
});
await copyFile(join(here, "prototype.html"), join(output, "prototype.html"));
const browser = await chromium.launch({ headless: !interactive });
async function fixture(mode: Mode) {
	const root = await mkdtemp(join(output, "work-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root });
	const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
	let tools = fileTools(env, "write");
	let saves = 0,
		agentReads = 0;
	let failPath = "";
	let holdPath = "";
	let held = false;
	let release: (() => void) | undefined;
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.setDefaultTimeout(8000);
	const run = (name: string, input: object) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool);
		return tool.execute("probe", input);
	};
	await page.exposeFunction("prototypeInvoke", async (action: string, input: any) => {
		if (action === "files") return Promise.all(paths.map((path) => readProjectFile(root, path)));
		if (action === "save") {
			assert.ok(paths.includes(input.path));
			saves++;
			if (input.path === failPath) throw new Error("EIO: 隔离注入保存失败");
			const value = await saveProjectFile(root, input);
			if (input.path === holdPath) {
				held = true;
				await new Promise<void>((done) => {
					release = done;
				});
				holdPath = "";
			}
			return value;
		}
		if (action === "agentRead") {
			tools = fileTools(env, "write");
			const values = [];
			for (const path of input as string[]) {
				assert.ok(paths.includes(path));
				await run("read", { path });
				agentReads++;
				values.push({ path, content: await readFile(join(root, path), "utf8") });
			}
			return values;
		}
		if (action === "agentWrite") {
			for (const file of input) {
				assert.ok(paths.includes(file.path));
				await run("write", { path: file.path, content: file.content + addition });
			}
			return true;
		}
		if (action === "inspect")
			return {
				passed: (await project.check()).inspection.check.state.passed,
				changed: (await project.status()).entries.length,
				revisions: (await project.history()).length,
			};
		if (action === "commit") return project.commitCheckout();
		throw new Error(`unknown prototype action ${action}`);
	});
	// Playwright 本地响应，不启动 HTTP 服务，也不请求互联网；file:// 的模块受 CORS 限制。
	await page.route("**/*", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/" || path === "/prototype.js")
			await route.fulfill({
				body: await readFile(join(output, path === "/" ? "prototype.html" : "prototype.js")),
				contentType: path === "/" ? "text/html" : "text/javascript",
			});
		else await route.abort();
	});
	await page.goto("http://save-policy.test/");
	await page.getByLabel("保存方式").selectOption(mode);
	const editor = () => page.locator('.editor:visible [aria-label="编辑文件内容"]');
	const select = async (path: string) => {
		await page.getByRole("button", { name: path.split("/").at(-1)! }).click();
	};
	const edit = async (path: string, content: string) => {
		await select(path);
		await editor().fill(content);
	};
	const handoff = async () => {
		await page.getByRole("button", { name: /^(同步所选文件并交给 Agent|交给 Agent（读取磁盘）)$/ }).click();
	};
	const snapshot = () => page.evaluate(() => (window as any).lab.snapshot());
	const save = async (path: string) => {
		await select(path);
		if (mode === "idle") await page.waitForTimeout(1750);
		else if (mode === "handoff") await handoff();
		else await page.getByRole("button", { name: "保存当前文件" }).click();
		await until(async () => !(await snapshot()).pending.length);
	};
	return {
		page,
		project,
		root,
		env,
		edit,
		select,
		editor,
		snapshot,
		handoff,
		save,
		counts: () => ({ saves, agentReads }),
		fail: (path: string) => {
			failPath = path;
		},
		hold: (path: string) => {
			holdPath = path;
		},
		held: () => held,
		release: () => release?.(),
		disk: (path: string) => readFile(join(root, path), "utf8"),
		close: async () => {
			release?.();
			await context.close();
			project.close();
			assert.deepEqual(errors, []);
		},
	};
}
async function until(predicate: () => Promise<boolean>, message = "等待实验条件", timeout = 8000) {
	const start = performance.now();
	while (!(await predicate())) {
		assert.ok(performance.now() - start < timeout, message);
		await new Promise((done) => setTimeout(done, 25));
	}
}
async function scenario(
	mode: Mode,
	name: string,
	body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<object | void>,
) {
	const f = await fixture(mode);
	try {
		const facts = await body(f);
		results.push({ mode, name, passed: true, ...facts });
		checks++;
		console.log(`PASS ${mode}: ${name}`);
	} catch (error) {
		await f.page.screenshot({ path: join(output, "failure.png"), fullPage: true });
		console.error("原型现场", JSON.stringify(await f.snapshot()), output);
		throw error;
	} finally {
		await f.close();
	}
}
try {
	if (interactive) {
		const f = await fixture("manual");
		console.log("隔离原型已打开；关闭浏览器后删除临时作品。没有读取日常配置或凭据。");
		await new Promise<void>((done) => browser.once("disconnected", () => done()));
		f.project.close();
	} else {
		for (const mode of modes) {
			await scenario(mode, "尚未停顿就交付，计时保存不能保证 Agent 读到最新编辑", async (f) => {
				await f.edit(a, sampleWorkText(a) + "\n刚输入就交付。\n");
				await f.handoff();
				await until(async () => (await f.snapshot()).reads === 1);
				const actual = (await f.snapshot()).agent[0].content.includes("刚输入就交付");
				assert.equal(actual, mode === "handoff");
				if (mode === "idle") {
					await until(async () => (await f.disk(a)).includes("刚输入就交付"));
					await f.page.getByRole("button", { name: "执行读取后准备的修改" }).click();
					await until(async () => (await f.snapshot()).status.includes("Agent 写入被拒"));
					assert.match(await f.disk(a), /刚输入就交付/);
				}
				return { agentSawFreshEdit: actual };
			});
			await scenario(mode, "多文件、定向交付与合法半句话进入 Canon", async (f) => {
				await f.edit(a, sampleWorkText(a) + "\n他主动承担风险。\n");
				await f.edit(b, sampleWorkText(b) + `\n${partial}`);
				await f.page.waitForTimeout(1750);
				await f.handoff();
				await until(async () => (await f.snapshot()).reads === 1);
				const before = await f.snapshot();
				assert.equal(before.agent[0].content.includes("主动承担"), mode !== "manual");
				assert.equal((await f.disk(b)).includes(partial), mode === "idle");
				const beforeCounts = f.counts();
				if (mode === "manual") {
					await f.save(a);
					await f.handoff();
					await until(async () => (await f.snapshot()).reads === 2);
				}
				const check = (await f.project.check()).inspection.check.state.passed;
				assert.equal(check, true);
				assert.equal((await f.project.history()).length, 1, "保存没有自动推进 Canon");
				await f.project.commitCheckout();
				const exported = await f.project.exportRevision();
				const canonB = new TextDecoder().decode(exported.find((file) => file.path === b)!.bytes);
				assert.equal(canonB.includes(partial), mode === "idle", "实际 Canon 字节验证，不只看界面标签");
				await f.page.getByRole("button", { name: "检查候选" }).click();
				await until(async () => (await f.snapshot()).status.includes("Canon"));
				await f.page.screenshot({ path: join(output, `${mode}.png`), fullPage: true });
				return {
					beforeCounts,
					initialAgentSawAuthorEdit: mode !== "manual",
					unrelatedHalfSentenceInCandidate: mode === "idle",
					checkerPassed: check,
					halfSentenceInCanon: canonB.includes(partial),
				};
			});
			await scenario(mode, "作者落盘后拒绝 Agent 旧整篇结果", async (f) => {
				const toolset = fileTools(f.env, "write");
				await toolset.find((t) => t.name === "read")!.execute("old-read", { path: a });
				await f.edit(a, sampleWorkText(a) + "\n作者新句。\n");
				await f.save(a);
				await assert.rejects(
					toolset
						.find((t) => t.name === "write")!
						.execute("late-write", { path: a, content: sampleWorkText(a) + addition }),
					{ code: "file_write_conflict" },
				);
				assert.match(await f.disk(a), /作者新句/);
			});
			await scenario(mode, "Agent 先写后保存受阻、不覆盖、不反复重试", async (f) => {
				await f.edit(a, sampleWorkText(a) + "\n作者草稿。\n");
				const toolset = fileTools(f.env, "write");
				await toolset.find((t) => t.name === "read")!.execute("read", { path: a });
				await toolset
					.find((t) => t.name === "write")!
					.execute("write", { path: a, content: sampleWorkText(a) + addition });
				await f.save(a);
				assert.match((await f.snapshot()).documents[a].content, /作者草稿/);
				assert.match(await f.disk(a), /Agent 补充/);
				assert.ok((await f.snapshot()).failures[a]);
				const saves = f.counts().saves;
				await f.page.waitForTimeout(1750);
				assert.equal(f.counts().saves, saves);
				assert.equal(f.counts().agentReads, 0, "交付同步失败时不能继续读旧文件");
			});
			await scenario(mode, "保存回执迟到、继续输入、切到另一文件", async (f) => {
				f.hold(a);
				await f.edit(a, sampleWorkText(a) + "\n第一次保存。\n");
				if (mode === "handoff") await f.handoff();
				else if (mode === "manual") await f.page.getByRole("button", { name: "保存当前文件" }).click();
				await until(async () => f.held());
				await f.editor().press("ControlOrMeta+End");
				await f.editor().pressSequentially("继续输入");
				await f.select(b);
				await f.editor().focus();
				f.release();
				await until(async () => !(await f.snapshot()).pending.length);
				assert.match((await f.snapshot()).documents[a].content, /继续输入/);
				assert.ok(await f.editor().evaluate((el) => el === document.activeElement));
				if (mode === "handoff") {
					await until(async () => (await f.snapshot()).reads === 1);
					assert.doesNotMatch((await f.snapshot()).agent[0].content, /继续输入/, "交付只包括点击时的快照");
				}
				if (mode === "idle") {
					await until(async () => (await f.disk(a)).includes("继续输入"));
					await until(async () => !(await f.snapshot()).documents[a], "等待第二次保存回执，而不是只等文件落盘");
					assert.equal((await f.snapshot()).documents[a], undefined);
				}
			});
			await scenario(mode, "外部删除后保留草稿且不复活文件", async (f) => {
				await f.edit(a, sampleWorkText(a) + "\n仍在编辑。\n");
				await rm(join(f.root, a));
				await f.save(a);
				await assert.rejects(f.disk(a), { code: "ENOENT" });
				assert.match((await f.snapshot()).documents[a].content, /仍在编辑/);
				assert.ok((await f.snapshot()).failures[a]);
			});
			await scenario(mode, "未完成 YAML 的候选与提交边界", async (f) => {
				await f.edit(a, "---\nname: [黄盖\n---\n还没写完");
				if (mode === "idle") await f.page.waitForTimeout(1750);
				else if (mode === "handoff") {
					await f.handoff();
					await until(async () => (await f.snapshot()).reads === 1);
				}
				if (mode === "manual") assert.equal((await f.project.check()).inspection.check.state.passed, true);
				else {
					await assert.rejects(f.project.commitCheckout());
					assert.match(await f.disk(a), /还没写完/);
				}
				assert.equal((await f.project.history()).length, 1);
				return { unfinishedSyntaxInCandidate: mode !== "manual", canonUnchanged: true };
			});
		}
		await scenario("handoff", "全选交付也会提交合法半句话", async (f) => {
			await f.edit(a, sampleWorkText(a) + "\n写完的一句。\n");
			await f.edit(b, sampleWorkText(b) + `\n${partial}`);
			await f.page.getByLabel(`交付 ${b}`, { exact: true }).check();
			await f.handoff();
			await until(async () => (await f.snapshot()).reads === 1);
			assert.equal(f.counts().agentReads, 2);
			await f.project.commitCheckout();
			assert.match(
				new TextDecoder().decode((await f.project.exportRevision()).find((file) => file.path === b)!.bytes),
				new RegExp(partial),
			);
		});
		await scenario("handoff", "批量第二份失败，阻止 Agent 开始并保留部分保存事实", async (f) => {
			await f.edit(a, sampleWorkText(a) + "\n第一份写完。\n");
			await f.edit(b, sampleWorkText(b) + `\n${partial}`);
			await f.page.getByLabel(`交付 ${b}`, { exact: true }).check();
			f.fail(b);
			await f.handoff();
			await until(async () => (await f.snapshot()).status.includes("交付未开始"));
			assert.equal(f.counts().agentReads, 0);
			assert.match(await f.disk(a), /第一份写完/);
			assert.equal(await f.disk(b), sampleWorkText(b));
			assert.match((await f.snapshot()).documents[b].content, new RegExp(partial));
			assert.equal((await f.snapshot()).documents[a], undefined);
		});
		await scenario("handoff", "批量交付固定点击时快照，排队期间的新输入留在草稿", async (f) => {
			await f.edit(a, sampleWorkText(a) + "\n第一份交付。\n");
			await f.edit(b, sampleWorkText(b) + "\n第二份交付。\n");
			await f.page.getByLabel(`交付 ${b}`, { exact: true }).check();
			f.hold(a);
			await f.handoff();
			await until(async () => f.held());
			await f.editor().fill(sampleWorkText(b) + "\n第二份交付。\n交付后继续输入");
			f.release();
			await until(async () => (await f.snapshot()).reads === 1);
			assert.doesNotMatch(await f.disk(b), /交付后继续输入/);
			assert.match((await f.snapshot()).documents[b].content, /交付后继续输入/);
			assert.doesNotMatch((await f.snapshot()).agent.find((file: any) => file.path === b).content, /交付后继续输入/);
		});
		await scenario("idle", "中文组合输入、模式切换取消计时器与只读操作", async (f) => {
			await f.editor().dispatchEvent("compositionstart");
			await f.editor().fill(sampleWorkText(a) + "\n组合中的文字");
			await f.page.waitForTimeout(1750);
			assert.equal(f.counts().saves, 0);
			await f.editor().dispatchEvent("compositionend");
			await until(async () => f.counts().saves === 1);
			await until(async () => !(await f.snapshot()).pending.length);
			await f.edit(a, sampleWorkText(a) + "\n新的草稿");
			await f.page.getByLabel("保存方式").selectOption("manual");
			await f.page.waitForTimeout(1750);
			assert.equal(f.counts().saves, 1);
			await f.handoff();
			await until(async () => (await f.snapshot()).reads === 1);
			assert.doesNotMatch((await f.snapshot()).agent[0].content, /新的草稿/);
		});
		await scenario("handoff", "窄窗与一次真实按钮写入", async (f) => {
			await f.page.setViewportSize({ width: 800, height: 800 });
			await f.edit(a, sampleWorkText(a) + "\n作者交付句。\n");
			await f.handoff();
			await until(async () => (await f.snapshot()).reads === 1);
			await f.page.getByRole("button", { name: "执行读取后准备的修改" }).click();
			await until(async () => (await f.disk(a)).includes("Agent 补充"));
			assert.match(await f.disk(a), /作者交付句/);
			assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
			await f.page.screenshot({ path: join(output, "narrow.png"), fullPage: true });
		});
		await writeFile(
			join(here, "measurements.json"),
			JSON.stringify(
				{
					date: "2026-10-17",
					productionDefaultsChanged: false,
					realModelCalls: 0,
					debounceMs: 1500,
					checks,
					results,
				},
				null,
				2,
			) + "\n",
		);
		console.log(`完成 ${checks} 组独立场景。截图与构建原型：${output}`);
	}
} finally {
	await browser.close();
	// 图像与原型保留以便复核，临时作品一律移除。
	const { readdir } = await import("node:fs/promises");
	for (const name of await readdir(output))
		if (name.startsWith("work-")) await rm(join(output, name), { recursive: true, force: true });
}
