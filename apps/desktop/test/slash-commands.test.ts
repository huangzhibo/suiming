import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };

// ADR-0039：输入框的 `/` 命令管这段对话怎么跑：`/目标`、`/讨论`、`/模型`；目标在输入框上方有状态条。
// faux 模型的回复在 entry.ts 的 --slash-command-test。
test("/ 命令：菜单与键盘、/讨论 与开关同一个状态、/模型、/目标 设目标到需要拍板再清除、/讨论 带话发出", {
	timeout: 120000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-slash-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--slash-command-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(10000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		const menu = page.getByRole("listbox", { name: "命令", exact: true });
		// 讨论标记：开着时出现，关着时不占位置
		const discussOn = () => page.locator('button[aria-label="讨论"][aria-pressed="true"]').waitFor();
		const discussOff = () => page.locator('button[aria-label="讨论"]').waitFor({ state: "detached" });
		const send = () => page.keyboard.press("Meta+Enter");
		// 设了 SUIMING_CAPTURE_DIR 才截图，给人看样子
		const capture = async (name: string) => {
			if (!process.env.SUIMING_CAPTURE_DIR) return;
			await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, `slash-${name}.png`),
			});
		};

		// 菜单：行首输入 / 出现，只有三条；按前缀筛，Esc 收起，再输入又出现
		await input.click();
		const composer = page.locator('[data-variant="composer"]');
		const before = await composer.boundingBox();
		await input.fill("/");
		await menu.waitFor();
		// 菜单浮在输入框上方，不把输入框和上面的对话往上推；也没被别的东西盖住（2026-10-19 作者截图发现）
		const after = await composer.boundingBox();
		const box = await menu.boundingBox();
		assert.ok(before && after && box);
		assert.equal(after.y, before.y, "弹出菜单时输入框没有移动");
		assert.ok(box.y + box.height <= after.y, "菜单在输入框上方");
		assert.ok(
			await menu.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const top = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + 6);
				return top !== null && element.contains(top);
			}),
			"菜单顶端露在最上层，没被裁掉或盖住",
		);
		const options = await menu.getByRole("option").allInnerTexts();
		assert.deepEqual(
			options.map((text) => text.split(/\s/u)[0]),
			["/目标", "/讨论", "/模型"],
		);
		assert.match(options[1] ?? "", /打开讨论/, "讨论那一行写明选了会怎样");
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
		await discussOn(); // /讨论 打开的就是输入框底部的讨论标记
		assert.equal(await input.inputValue(), "", "立刻执行的命令清掉输入");
		assert.match((await input.getAttribute("placeholder")) ?? "", /只出方案/, "提示语跟着模式换");
		await capture("composer-discuss");
		await input.fill("/讨");
		assert.match(await menu.getByRole("option").first().innerText(), /关上讨论/);
		// 英文别名不开输入法也能打
		await input.fill("/plan");
		await page.keyboard.press("Enter");
		await discussOff(); // 再来一次就关上

		// /模型 打开输入框里同一个模型面板
		await input.fill("/模型");
		await page.keyboard.press("Enter");
		await page.getByText("只改这段对话", { exact: true }).waitFor();
		await capture("model-panel");
		await page.keyboard.press("Escape");

		// 方向键 + Tab 选 /目标：进入目标输入，底部出现「目标」标记，与讨论同一种样子（照 Codex 的计划 / 目标）
		await input.fill("/g");
		await menu.waitFor();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Tab");
		const goalChip = page.locator('button[aria-label="目标"][aria-pressed="true"]');
		await goalChip.waitFor();
		assert.equal(await input.inputValue(), "", "选了 /目标 就清空输入，等你写目标");
		assert.match((await input.getAttribute("placeholder")) ?? "", /描述目标/);
		await capture("composer-goal");
		// 点标记取消，回到普通输入；再选一次
		await goalChip.click();
		await goalChip.waitFor({ state: "detached" });
		await input.fill("/目标");
		await page.keyboard.press("Enter");
		await goalChip.waitFor();

		// 设目标：续跑到模型标「等你拍板」，状态条写明原因；inbox 里只有作者那一句
		await input.fill("把第一节的杖数改成六十");
		await send();
		await goalChip.waitFor({ state: "detached" }); // 发出后回到普通输入
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
		// 直接打 `/目标 <动作>` 也行：`/目标 清除` 与状态条上的「清除」同一个动作，不会被当成新目标去跑
		await input.fill("/目标 清除");
		await send();
		await bar.waitFor({ state: "hidden" });

		// `/讨论 <话>`：打开讨论并把这句话发出去
		await input.fill("/讨论 第一节怎么改");
		await send();
		await page.getByText("先说方案。", { exact: true }).waitFor();
		await discussOn();
		await eventually(
			async () =>
				(await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.discuss === true,
			"对话记下讨论开着",
		);

		// 离开这段对话的动作走按钮，没有命令：报错，不发出去
		await input.fill("/新对话");
		await send();
		await page.getByText("没有这个命令：/新对话", { exact: true }).waitFor();
		assert.equal(await input.inputValue(), "/新对话");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
