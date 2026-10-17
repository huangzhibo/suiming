import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };

// ADR-0038 决定三：输入框的 `/` 命令只是现有能力的入口，与按钮做同一件事；目标在输入框上方有状态条。
// faux 模型的回复在 entry.ts 的 --slash-command-test。
test("/ 命令：菜单与键盘、切模式、设目标到需要拍板、自定义命令展开、模型、提交与新对话", {
	timeout: 120000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-slash-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	// 作者存的常用话与 config.toml 同目录（E2E 的 SUIMING_CONFIG_PATH 在 directory 下）
	await mkdir(join(directory, "commands"));
	await writeFile(join(directory, "commands", "审一下.md"), "独立审一下 $ARGUMENTS");
	const app = await launchDesktop({ directory, project: root, flags: ["--slash-command-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(10000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		const menu = page.getByRole("listbox", { name: "命令", exact: true });
		const send = () => page.keyboard.press("Meta+Enter");
		const head = async () => (await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId;

		// 菜单：行首输入 / 出现，按前缀筛，Esc 收起，再输入又出现
		await input.click();
		await input.fill("/");
		await menu.waitFor();
		const options = await menu.getByRole("option").allInnerTexts();
		for (const name of ["/goal", "/讨论", "/协作", "/自主", "/模型", "/新对话", "/提交", "/审一下"])
			assert.ok(
				options.some((text) => text.startsWith(name)),
				`菜单里有 ${name}`,
			);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "hidden" });
		await input.fill("/讨");
		await menu.waitFor();
		assert.equal(await menu.getByRole("option").count(), 1);
		// 输入法组字时的回车不选命令
		await input.evaluate((element) =>
			element.dispatchEvent(
				new (
					globalThis as unknown as { KeyboardEvent: new (type: string, init: Record<string, unknown>) => Event }
				).KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
			),
		);
		assert.equal(await input.inputValue(), "/讨");
		await page.keyboard.press("Enter");
		await page.locator('[data-collaboration-mode="discuss"]').waitFor();
		assert.equal(await input.inputValue(), "", "立刻执行的命令清掉输入");
		await input.fill("/自");
		await page.keyboard.press("Enter");
		await page.locator('[data-collaboration-mode="autonomous"]').waitFor();

		// 方向键 + Tab 补全要参数的命令
		await input.fill("/");
		await menu.waitFor();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Tab");
		assert.equal(await input.inputValue(), "/goal ", "第一项是 /goal，补成带空格的命令等你写目标");

		// 设目标：续跑到模型标「等你拍板」，状态条写明原因；inbox 里只有作者那一句
		await input.fill("/goal 把第一节的杖数改成六十");
		await send();
		const bar = page.getByRole("status", { name: "对话目标", exact: true });
		await bar
			.locator('[data-goal-status="blocked"]')
			.or(page.locator('[data-goal-status="blocked"]'))
			.first()
			.waitFor();
		await bar.getByText("要不要连人物档一起改，需要你定").waitFor();
		const sessions = await page.evaluate(() => window.suiming.invoke("session.list", {}));
		const session = sessions.sessions[0];
		assert.equal(session?.goal?.status, "blocked");
		assert.equal(session?.goal?.autoTurns, 1);
		const inbox = await page.evaluate(
			(sessionId) => window.suiming.invoke("session.inbox", { sessionId }),
			session?.id ?? "",
		);
		assert.deepEqual(
			inbox.map((item) => item.text),
			["把第一节的杖数改成六十"],
		);
		await bar.getByRole("button", { name: "清除", exact: true }).click();
		await bar.waitFor({ state: "hidden" });

		// 自定义命令：按参数展开，发出去的就是作者的消息
		await input.fill("/审一下 第一节");
		await send();
		await page.getByText("收到常用话。", { exact: true }).waitFor();

		// /模型 打开同一个面板
		await input.fill("/模型");
		await page.keyboard.press("Enter");
		await page.getByText("当前对话 · 不修改默认配置", { exact: true }).waitFor();
		await page.keyboard.press("Escape");

		// /提交 与「提交版本」同一个动作：Agent 改了第一节，候选可以提交
		const before = await head();
		await input.fill("/提交");
		await page.keyboard.press("Enter");
		await eventually(async () => (await head()) !== before, "提交成新版本");

		// 不存在的命令报错，不发出去
		await input.fill("/没有这个");
		await send();
		await page.getByText("没有这个命令：/没有这个", { exact: true }).waitFor();

		// /新对话 与「新对话」按钮同一个动作
		await input.fill("/新对话");
		await page.keyboard.press("Enter");
		await eventually(
			async () => (await page.getByRole("status", { name: "对话目标", exact: true }).count()) === 0,
			"切到新对话",
		);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
