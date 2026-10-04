import type { DesktopBridge } from "@suiming/sdk";

declare const window: {
	suiming?: DesktopBridge;
	innerWidth: number;
	requestAnimationFrame(callback: () => void): number;
};
declare const document: { documentElement: { scrollWidth: number } };

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { _electron as electron, type Locator } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

test("状态查询：全书选择不筛选计数，幕前 / 变化 / 幕后明确，回看依据与重载保留观察条件", {
	timeout: 90000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-state-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		assert.equal(
			await page.getByRole("button", { name: "故事状态", exact: true }).count(),
			1,
			"首次查询前已有固定入口",
		);
		const agentPosition = await page.getByRole("button", { name: "对话", exact: true }).boundingBox();
		await page.getByRole("button", { name: "打开故事轴", exact: true }).click();
		await page.getByRole("button", { name: "故事状态", exact: true }).click();
		await page.getByText("尚未选择故事位置", { exact: true }).waitFor();
		await page.getByRole("combobox", { name: "选择观察位置", exact: true }).click();
		await page.getByRole("option", { name: "beat-0001", exact: true }).click();
		await page
			.getByRole("region", { name: "故事状态查询" })
			.getByRole("radio", { name: "进入前", exact: true })
			.waitFor();
		await page.getByRole("button", { name: "对话", exact: true }).click();
		await page.getByRole("button", { name: /^身份$/ }).click();
		await page.getByRole("button", { name: /黄盖\s*2 个情节/ }).waitFor();
		await page.locator("[data-beat='beat-0001']").click();
		await page.getByRole("button", { name: /黄盖\s*2 个情节/ }).waitFor();
		await page.locator("[data-beat='beat-0002']").click();
		await page.getByRole("button", { name: "查看此处状态", exact: true }).click();
		const panel = page.getByRole("region", { name: "故事状态查询" });
		await panel.getByText(/火船 · 持有者：黄盖/).waitFor();
		await panel.getByText("本幕变化", { exact: true }).click();
		await panel.getByText(/火船 · 持有者：黄盖 → 无/).waitFor();
		await panel.getByText("结束后", { exact: true }).click();
		await panel.getByText(/火船 · 已消耗：是/).waitFor();
		await mkdir("/tmp/suiming-desktop-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/observation-after.png" });
		// 行内来源链接打开工作稿，查询仍停在第二幕结束后。
		await panel.locator(".design-body button").first().click();
		await page.getByRole("radio", { name: "设计", exact: true }).waitFor();
		assert.equal(await panel.getByRole("combobox").count(), 0, "Beat 页复用顺序导航，不重复列出所有 Beat");
		await panel.getByText(/火船 · 已消耗：是/).waitFor();
		await page.getByRole("button", { name: "后退", exact: true }).click();
		await panel.getByText(/火船 · 已消耗：是/).waitFor();
		await page.getByRole("button", { name: "前进", exact: true }).click();
		await page.getByRole("button", { name: "新标签页", exact: true }).click();
		await panel.getByText(/火船 · 已消耗：是/).waitFor();
		// 重载期间欢迎页一次都不能出现：加载态与「没有打开作品」曾是同一个分支，作者重载时看到「开始新作」，
		// 像是作品没了。工作台的工具行一出现就停止观察。
		await page.addInitScript(`
			window.__welcomeSeen = false;
			const observer = new MutationObserver(() => {
				if (document.body && document.body.textContent.includes("开始新作")) window.__welcomeSeen = true;
				if (document.querySelector("[data-panel-toolbar]")) observer.disconnect();
			});
			observer.observe(document, { childList: true, subtree: true, characterData: true });
		`);
		await page.reload();
		await panel.getByText(/火船 · 已消耗：是/).waitFor();
		assert.equal(await page.evaluate("window.__welcomeSeen"), false, "重载时先给加载态，不闪欢迎页");
		const state = await page.evaluate(() => window.suiming?.invoke("workspace.show", {}));
		assert.equal(
			(await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length,
			0,
			"查询与重载都不启动模型",
		);
		await panel.getByRole("button", { name: "引用此状态给 Agent", exact: true }).click();
		await page.getByText("故事状态引用：beat-0002 · 结束后", { exact: true }).waitFor();
		const afterReference = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		assert.equal(afterReference?.sessions.length, 0, "引用只准备上下文，发送才开 session");
		// Beat 入口以自身位置发起新查询；人物页可限定主体。
		await page.getByRole("button", { name: "故事状态", exact: true }).click();
		await panel.getByRole("radio", { name: "进入前", exact: true }).click();
		await panel.getByText(/火船 · 持有者：黄盖/).waitFor();
		await panel.getByText(/依据文件 ·/).click();
		await panel.locator("details").getByRole("button", { name: "黄盖", exact: true }).click();
		await page.getByRole("button", { name: "故事状态", exact: true }).click();
		await panel.getByText("只看 黄盖", { exact: true }).waitFor();
		await panel.getByRole("combobox", { name: "选择观察位置", exact: true }).click();
		await page.getByRole("option", { name: "beat-0001", exact: true }).click();
		await panel.getByText("beat-0001", { exact: true }).first().waitFor();
		await panel.getByRole("button", { name: "查看全部", exact: true }).click();
		await panel.getByText("全部人物、资源与读者期待", { exact: true }).waitFor();
		await page.getByRole("button", { name: "故事状态", exact: true }).click();
		await panel.getByText("只看 黄盖", { exact: true }).waitFor();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/observation-character.png" });
		await page.getByRole("button", { name: "对话", exact: true }).click();
		await panel.waitFor({ state: "hidden" });
		// 后续浏览不改写已准备的引用；发送时携带当时的边界、版本与状态结果。

		// 查询前后入口不移动；侧栏收起与展开保留模式，工具行的边界完全对齐。
		assert.deepEqual(await page.getByRole("button", { name: "对话", exact: true }).boundingBox(), agentPosition);
		await page.getByRole("button", { name: "故事状态", exact: true }).click();
		await page.getByRole("button", { name: "收起右栏", exact: true }).click();
		await page.getByRole("button", { name: "展开右栏", exact: true }).click();
		await panel.waitFor();
		const toolbars = await page.locator("[data-panel-toolbar]").all();
		const boxes = await Promise.all(toolbars.map((toolbar) => toolbar.boundingBox()));
		assert.equal(boxes.length, 3);
		for (const box of boxes) {
			assert.equal(box?.height, 37);
			assert.equal(box?.y, boxes[0]?.y);
		}
		await page.getByRole("button", { name: "对话", exact: true }).click();
		await page.getByRole("textbox", { name: "输入消息" }).fill("依据引用状态检查下一幕的行动");
		await page.reload();
		await page.getByRole("textbox", { name: "输入消息" }).waitFor();
		assert.equal(await page.getByRole("textbox", { name: "输入消息" }).inputValue(), "依据引用状态检查下一幕的行动");
		await page.getByRole("button", { name: "查看引用内容", exact: true }).click();
		const preview = page.getByRole("dialog").locator(".reference-preview");
		assert.match(await preview.innerText(), /观察 Beat：beat-0002\n观察边界：after/);
		assert.match(await preview.innerText(), /火船 · 已消耗：是/);
		await page.keyboard.press("Escape");
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length, 0);

		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.locator(".message.assistant").filter({ hasText: "黄盖要当众挨这顿打，还是另想办法？" }).waitFor();
		const sent = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		assert.equal(sent?.sessions.length, 1);
		const sessionId = sent?.sessions[0]?.id ?? "";
		const inbox = await page.evaluate((id) => window.suiming?.invoke("session.inbox", { sessionId: id }), sessionId);
		const goal = inbox?.[0]?.text ?? "";
		assert.match(goal, /观察 Beat：beat-0002\n观察边界：after/);
		assert.ok(goal.includes(`revision: ${state?.revisionId}`));
		assert.match(goal, /火船 · 已消耗：是/);
		// Agent 与作者改的是同一份 checkout。此刻还没人改文件，所以是空差异。
		assert.deepEqual(await page.evaluate(() => window.suiming?.invoke("project.diff", {})), []);
		const input = page.getByRole("textbox", { name: "输入消息" });
		assert.equal(await input.inputValue(), "", "成功发送后清除对应草稿");
		await input.fill("旧委托的补充草稿");
		await page.getByRole("button", { name: "新对话", exact: true }).click();
		assert.equal(await input.inputValue(), "", "新委托不混入其他委托的草稿");
		await input.fill("另一份未发送委托");
		await page.reload();
		await input.waitFor();
		assert.equal(await input.inputValue(), "另一份未发送委托");
		await page.getByRole("button", { name: "选择对话", exact: true }).click();
		await page.getByRole("dialog").getByRole("button").first().click();
		assert.equal(await input.inputValue(), "旧委托的补充草稿");

		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/observation-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Electron typed IPC：编辑 CAS、版本比较、窗口重载只 attach、作者回应、正文与独立审稿贯通", {
	timeout: 90000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-desktop-"));
	const root = join(directory, "长夜来信");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "desktop-story" });
	project.close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
		timeout: 20000,
	});
	const page = await app.firstWindow();
	// Electron 的 will-prevent-unload 负责原生确认；禁止 Playwright 再处理同一个 Chromium 通知。
	page.on("dialog", () => undefined);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "材料", exact: true }).click();
		await page.getByRole("button", { name: /计谋的代价/ }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
		await page.locator(".cm-editor .cm-content").first().click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText("主角的计谋必须当场付出不可逆的代价。");
		await page.getByText("未保存", { exact: true }).waitFor();
		await page.reload();
		await page.getByText("未保存", { exact: true }).waitFor();
		assert.equal(app.process().exitCode, null);
		assert.ok(!(await readFile(join(root, "intent/计谋的代价.md"), "utf8")).includes("不可逆"));
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.ok((await readFile(join(root, "intent/计谋的代价.md"), "utf8")).includes("不可逆"));
		await page.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name: "查看版本差异", exact: true }).click();
		await page.locator(".cm-mergeView").waitFor();
		await mkdir("/tmp/suiming-desktop-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/diff.png" });
		// 底栏的「N 个文件未提交」就是看这份改动的入口；Agent 面板原来另有一条常驻的「候选」横幅，与底栏、本轮对账说同一件事。
		await page.getByRole("button", { name: "1 个文件未提交", exact: true }).click();
		await page.getByRole("heading", { name: "未提交的修改" }).waitFor();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.locator(".cm-mergeView").waitFor();
		await page.getByRole("button", { name: "提交版本", exact: true }).click();
		await page.getByText("已提交一个新版本", { exact: true }).waitFor();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.getByRole("textbox", { name: "输入消息" }).fill("确认作者想要真打还是做做样子");
		await page.getByRole("textbox", { name: "输入消息" }).press("Meta+Enter");
		await page.locator(".run-status").getByText("正在处理", { exact: true }).waitFor();
		await page.reload();
		await page.locator(".message.assistant").filter({ hasText: "黄盖要当众挨这顿打，还是另想办法？" }).waitFor();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/waiting.png" });
		const state = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		assert.equal(state?.sessions.length, 1);
		await page.getByRole("textbox", { name: "输入消息" }).fill("诈降");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		// turn 结束对账：只问不改的第一轮不显示；这一轮写了正文、留了审稿、提交了两次，意图没动。
		const turnSummary = page.locator("[data-turn-summary]");
		await turnSummary.waitFor();
		assert.equal(await turnSummary.count(), 1);
		assert.equal(
			await turnSummary.innerText(),
			"本轮：作者 1 条 · 意图未改动 · 正文改了 1 个文件 · 审稿改了 1 个文件 · 提交了 2 个版本",
		);
		await page.locator(".message.user").filter({ hasText: "诈降" }).first().waitFor();
		await page.locator(".activities").first().waitFor();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/workspace.png" });
		// 活动的 target 指向真实作品路径时可直接点开。活动按连续性分组，作者回答会把它们隔成多组，所以逐组展开。
		for (const group of await page.locator(".activities").all()) await group.locator("summary").first().click();
		await page.locator('.activities [data-page="text/beat-0001.md"]').first().click();
		// 复用当前标签打开，不新增页：后面按基线标签数断言。
		await page.locator(".tab-btn").filter({ hasText: "beat-0001" }).first().waitFor();
		// 审稿从左栏的 Review 组进入；被审版本的稿与当前稿并置在同一页。
		await page
			.getByRole("button", { name: /^审稿 / })
			.first()
			.click();
		await page.getByRole("heading", { name: "审稿报告 · 6 条问题" }).waitFor();
		const findings = page.getByRole("region", { name: "审稿结论与问题" });
		const currentBox = await page.locator(".issue-current").boundingBox();
		const mainBox = await page.locator("main").boundingBox();
		assert.ok(
			currentBox &&
				mainBox &&
				currentBox.height > 200 &&
				currentBox.y + currentBox.height <= mainBox.y + mainBox.height,
		);
		// finding 标题按钮里还带「第 N 段」标签：引文现在都锚得到段落，名字不再是纯标题。
		await findings.getByRole("button", { name: /^补充审读问题 5/ }).click();
		await findings.getByRole("button", { name: /取信动作略显概括/ }).click();
		await page.locator(".evidence-text").filter({ hasText: "他没有喊" }).waitFor();
		// finding 的引文对回当前稿：标出第 2 段，当前稿里那一段带 data-mark。
		await page.getByText("第 2 段", { exact: true }).first().waitFor();
		await page.locator(".issue-current p[data-mark='true']").filter({ hasText: "他没有喊" }).waitFor();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/review.png" });
		await page
			.getByRole("button", { name: /在正文中打开/ })
			.first()
			.click();
		await page.locator(".cm-editor .cm-content").first().click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText("军杖落到第三十下，黄盖背上已经见了血。他抬头看了周瑜一眼，仍然一声没吭。");
		await writeFile(join(root, "text/beat-0001.md"), "外部作者修改：黄盖在军杖落下前停了一下。\n");
		await page.getByText("文件在外部发生了修改", { exact: true }).waitFor();
		await page.getByRole("button", { name: "比较外部修改", exact: true }).click();
		await page.locator(".cm-mergeView").waitFor();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/conflict.png" });
		await page.getByRole("button", { name: "以外部版本为合并基线", exact: true }).click();
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		await page.getByRole("button", { name: "提交版本", exact: true }).click();
		await page.getByText("已提交一个新版本", { exact: true }).waitFor();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page
			.getByRole("button", { name: /^审稿 / })
			.first()
			.click();
		await page.getByText("稿子已改，需重新核对", { exact: true }).waitFor();
		await page.locator(".evidence-text").filter({ hasText: "他没有喊" }).waitFor();
		// 专注阅读 = 收起两侧面板；重新展开后回到原对象。
		await page
			.getByRole("button", { name: /在正文中打开/ })
			.first()
			.click();
		await page.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		await page.getByRole("button", { name: "收起左栏", exact: true }).click();
		await page.getByRole("button", { name: "收起右栏", exact: true }).click();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/reading.png" });
		await page.getByRole("button", { name: "展开左栏", exact: true }).click();
		await page.getByRole("button", { name: "展开右栏", exact: true }).click();
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		await page.getByRole("button", { name: "打开故事轴", exact: true }).click();
		await page.locator("svg[aria-label='故事轴']").waitFor();
		const axis = page.getByRole("img", { name: "故事轴", exact: true });
		const axisAligned = async () => {
			const svg = await axis.elementHandle();
			assert.ok(svg);
			await page.waitForFunction((svg) => {
				const viewport = svg.parentElement?.parentElement;
				const background = svg.querySelector("rect[data-axis-band]");
				if (!viewport || !background) return false;
				const right = viewport.getBoundingClientRect().left + viewport.clientWidth;
				return (
					Math.abs(svg.getBoundingClientRect().right - right) < 1 &&
					Math.abs(background.getBoundingClientRect().right - right) < 1 &&
					viewport.scrollWidth === viewport.clientWidth
				);
			}, svg);
		};
		await axisAligned();
		await page.getByRole("button", { name: "缩小", exact: true }).click();
		await axisAligned();
		await page.getByRole("button", { name: "适应窗口", exact: true }).click();
		await axisAligned();
		// 点 Beat 列只改变选择；双击打开它的页面。
		await page.locator("[data-beat='beat-0002']").click();
		await page.getByRole("button", { name: "查看此处状态", exact: true }).waitFor();
		// 人物泳道来自 refs.character。样例唯一的 refs.beat 是 beat-0002 连紧挨着的 beat-0001：
		// 相邻由列的先后表达，不画因果弧，泳道也就不出现。
		await page.getByRole("button", { name: "黄盖", exact: true }).first().waitFor();
		assert.equal(await page.locator("path[data-arc]").count(), 0);
		// 刷选：在列头从 beat-0001 拖到 beat-0002 → 区间标出并能引用给 Agent；finding 密度开关给有 finding 的列上底色。
		const a = await page.locator("[data-beat='beat-0001']").boundingBox();
		const b = await page.locator("[data-beat='beat-0002']").boundingBox();
		assert.ok(a && b);
		await page.mouse.move(a.x + a.width / 2, a.y + 10);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2, b.y + 10, { steps: 4 });
		await page.mouse.up();
		await page.getByText(/已选 .* 2 个情节/).waitFor();
		// 此时唯一的审稿已 stale，密度不计 stale 报告，所以只断言开关本身；映射逻辑由单元测试覆盖。
		await page.getByRole("button", { name: "审稿意见密度", exact: true }).click();
		assert.equal(
			await page.getByRole("button", { name: "审稿意见密度", exact: true }).getAttribute("aria-pressed"),
			"true",
		);
		assert.equal(await page.locator("[data-findings]").count(), 0);
		await page.getByRole("button", { name: "引用给 Agent", exact: true }).click();
		await page.getByText(/故事轴区间 beat-0001 → beat-0002/).waitFor();
		await page.getByRole("button", { name: "清除", exact: true }).click();
		// 点轴上的卷名进入该卷，面包屑「故事轴」回到全书。
		await page.locator("[data-volume='vol-0001']").click();
		await axisAligned();
		// 进入卷后面包屑多出可点的「故事轴」（标签页那个也叫故事轴，所以是第二个）；点它回到全书后消失。
		const backToBook = page.getByRole("button", { name: "故事轴", exact: true }).nth(1);
		await backToBook.waitFor();
		await backToBook.click();
		await backToBook.waitFor({ state: "hidden" });
		// 标题列宽度可拖：把手向右拖 60px。
		const handle = page.getByRole("slider", { name: "标题列宽度" });
		const before = Number(await handle.getAttribute("aria-valuenow"));
		const box = await handle.boundingBox();
		assert.ok(box);
		await page.mouse.move(box.x + box.width / 2, box.y + 200);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, { steps: 4 });
		await page.mouse.up();
		assert.equal(Number(await handle.getAttribute("aria-valuenow")), before + 60);
		await axisAligned();
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/spine.png" });
		await page.locator("[data-beat='beat-0001']").dblclick();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		// Beat 页末尾是以它为中心的邻域图，点节点换到那个 artifact；承诺页顶部是生命周期轨迹。
		await page.getByRole("radio", { name: "设计", exact: true }).click();
		await page.locator("[data-neighborhood]").getByText("黄盖", { exact: true }).waitFor();
		await page.locator("[data-neighborhood] g[role='button']").filter({ hasText: "诈降" }).click();
		await page.getByRole("heading", { name: "诈降", exact: true }).waitFor();
		await page.locator("svg[aria-label='读者期待进展']").waitFor();
		// 支持的最小窗口必须真正容纳操作控件，仅断言 body 无横向滚动会漏掉 overflow-hidden 裁切。
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.getByRole("button", { name: "展开左栏", exact: true }).waitFor();
		await page.getByRole("button", { name: "后退", exact: true }).click();
		await page.getByRole("radio", { name: "设计", exact: true }).waitFor();
		const narrowMain = await page.locator("main").boundingBox();
		assert.ok(narrowMain && narrowMain.width >= 600);
		for (const control of [
			page.getByRole("button", { name: "切换到编辑视图", exact: true }),
			page.getByRole("button", { name: "更多", exact: true }),
			page.getByRole("status", { name: "作品与当前对象状态" }),
		]) {
			const bounds = await control.boundingBox();
			assert.ok(bounds && bounds.x >= narrowMain.x && bounds.x + bounds.width <= narrowMain.x + narrowMain.width);
		}
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-editor .cm-content").first().click();
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("临时编辑");
		await page.getByRole("button", { name: "后退", exact: true }).click();
		assert.equal(await page.locator(".tab-btn").count(), 2, "后退保留未保存的原 tab");
		await page.locator(".tab-btn").first().locator("button").first().click();
		await page.getByRole("button", { name: "取消编辑", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "放弃修改", exact: true }).click();
		await page.getByRole("button", { name: "展开左栏", exact: true }).click();
		await page.getByRole("button", { name: "收起左栏", exact: true }).waitFor();
		await page.getByRole("button", { name: "展开右栏", exact: true }).waitFor();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1460, 940));
		await page.getByRole("button", { name: "收起左栏", exact: true }).waitFor();
		await page.getByRole("button", { name: "收起右栏", exact: true }).waitFor();

		await page.getByRole("button", { name: "打开故事轴", exact: true }).click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 740));
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/narrow.png" });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);

		const reopened = await LocalProjectService.open(root);
		try {
			const state = reopened.loadExecutionState();
			assert.equal(state.sessions.length, 1, "追问接着同一个 session");
			assert.equal(state.sessions[0]?.turn, 2);
			assert.equal(state.tasks.filter((task) => task.kind === "review").length, 1);
			assert.equal(state.sessions[0]?.status, "idle");
		} finally {
			reopened.close();
		}
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-desktop-failure.png" });
		console.error("renderer errors", errors, await page.locator("body").innerText());
		throw error;
	} finally {
		// 失败时编辑可能未保存；把原生确认框桩成「放弃」，否则 app.close 会挂在弹窗上等人点。
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBoxSync = () => 1;
			})
			.catch(() => undefined);
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("主进程 SIGKILL 后重开：未知请求默认 paused，显式重发接着同一份消息列表", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-desktop-recovery-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const initialized = await LocalProjectService.init({ checkoutPath: root, projectId: "desktop-recovery" });
	initialized.close();
	const args = [
		resolve("apps/desktop/test-dist/entry.js"),
		`--project=${root}`,
		`--user-data-dir=${join(directory, "app-data")}`,
		"--recovery-test",
	];
	let app = await electron.launch({ args });
	try {
		const stdout = app.process().stdout;
		assert.ok(stdout);
		const requestStarted = new Promise<void>((resolve) => {
			let output = "";
			const onData = (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-1024);
				if (!output.includes("SUIMING_TEST_MODEL_REQUEST_STARTED")) return;
				stdout.off("data", onData);
				resolve();
			};
			stdout.on("data", onData);
		});
		let page = await app.firstWindow();
		await page.getByRole("textbox", { name: "输入消息" }).fill("分析现有设计是否清楚");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		// 调用计数会先于请求发送更新；等 faux provider 真正接到请求后再注入进程故障。
		await requestStarted;
		const child = app.process();
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		app = await electron.launch({ args: [...args, "--recovery-second"] });
		page = await app.firstWindow();
		// 重开时持有进程已死：session 回 idle 记 process_restart；再发一句才会读到停在半途的请求，落进 paused。
		await page.getByText("上次没有正常结束", { exact: true }).waitFor({ timeout: 7000 });
		await page.getByRole("textbox", { name: "输入消息" }).fill("接着分析");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByRole("button", { name: "确认重新请求模型", exact: true }).waitFor({ timeout: 7000 });
		const before = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		assert.equal(before?.sessions.length, 1);
		assert.equal(before?.sessions[0]?.status, "paused");
		assert.equal(before?.sessions[0]?.usage?.calls, 1);
		// usage 原样透传存储形状：待确认数是 calls - confirmedCalls，由界面派生，命令目录不存第二份。
		const usage = before?.sessions[0]?.usage;
		assert.ok(usage);
		assert.equal(usage.calls - (usage.confirmedCalls ?? usage.calls), 1);
		await page.getByRole("button", { name: "确认重新请求模型", exact: true }).click();
		await page.locator(".message.assistant").filter({ hasText: "恢复后的分析已完成" }).waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const opened = await LocalProjectService.open(root);
		try {
			const state = opened.loadExecutionState();
			assert.equal(state.sessions.length, 1);
			assert.equal(state.sessions[0]?.status, "idle");
			assert.ok((state.sessions[0]?.usage?.calls ?? 0) >= 2);
			assert.equal((await opened.history()).length, 1);
		} finally {
			opened.close();
		}
	} catch (error) {
		const page = await app.firstWindow();
		console.error("recovery UI", await page.locator("body").innerText());
		console.error("recovery state", await page.evaluate(() => window.suiming?.invoke("workspace.show", {})));
		throw error;
	} finally {
		await app.close().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

test("打开没有 .suiming 的 Open Story Directory：主进程就地初始化，作品文件成为第一个版本", {
	timeout: 60000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-desktop-plain-"));
	const root = join(directory, "plain");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
		timeout: 20000,
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		const state = await page.evaluate(() => window.suiming?.invoke("workspace.show", {}));
		assert.equal(state?.revisions.length, 1);
		assert.equal(state?.dirty, false);
		assert.ok(state?.files.some((file) => file.path === "outline/story/vol-0001/beat-0001.md"));
		assert.ok(state?.storyText.every((item) => item.state === "missing"));
		const recent = await page.evaluate(() => window.suiming?.recentProjects());
		assert.equal(recent?.length, 1);
		assert.equal(recent?.[0]?.name, "plain");
		// 误选一个既非空又没有作品文件的目录：拒绝，不写入任何东西。
		const foreign = join(directory, "not-a-story");
		await mkdir(foreign);
		await writeFile(join(foreign, "notes.txt"), "随手记\n");
		await assert.rejects(
			page.evaluate((path) => window.suiming?.openProject(path), foreign),
			/没有作品文件/,
		);
		await assert.rejects(readFile(join(foreign, "outline/story/index.yaml")), { code: "ENOENT" });
		// 旧仓格式的作品：不做迁移，错误说清是哪份文件、哪一项；scaffold 补的 index.yaml 与 .suiming 都收回。
		const legacy = join(directory, "legacy");
		await mkdir(join(legacy, "source/source_old"), { recursive: true });
		await writeFile(join(legacy, "intent/book.md"), "旧仓作品。\n").catch(async () => {
			await mkdir(join(legacy, "intent"), { recursive: true });
			await writeFile(join(legacy, "intent/book.md"), "旧仓作品。\n");
		});
		await writeFile(join(legacy, "source/source_old/source.yaml"), "schema_version: 3\nsource_id: old\ninput: {}\n");
		await writeFile(join(legacy, "source/source_old/original.bin"), "旧材料\n");
		await writeFile(join(legacy, "source/source_old/material.txt"), "旧材料\n");
		await assert.rejects(
			page.evaluate((path) => window.suiming?.openProject(path), legacy),
			(error: Error) => {
				assert.match(error.message, /不是当前 Story Language 格式/);
				assert.match(error.message, /source\/source_old\/source\.yaml/);
				assert.doesNotMatch(error.message, /Error invoking remote method/);
				return true;
			},
		);
		await assert.rejects(readFile(join(legacy, "outline/story/index.yaml")), { code: "ENOENT" });
		await assert.rejects(readFile(join(legacy, ".suiming")), { code: "ENOENT" });
		// 只有 intent 的目录：scaffold 补齐缺失的 index.yaml 后照常打开。
		const partial = join(directory, "partial");
		await mkdir(join(partial, "intent"), { recursive: true });
		await writeFile(join(partial, "intent/只有意图.md"), "# 只有意图\n\n先立意图，**再写大纲**。\n");
		assert.equal(await page.evaluate((path) => window.suiming?.openProject(path), partial), true);
		await page.getByText("只有意图", { exact: true }).first().waitFor();
		// 图例与操作说明只在帮助模态框里常驻。
		await page.getByRole("button", { name: "帮助", exact: true }).click();
		await page.getByRole("dialog").getByRole("heading", { name: "图例与操作" }).waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		// 设计文档按 Markdown 渲染：加粗成为 <strong>，标题不再原样露出 #。
		await page.locator(".design-body strong").filter({ hasText: "再写大纲" }).waitFor();
		assert.equal((await page.locator(".design-body").innerText()).includes("# 只有意图"), false);
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/markdown-design.png" });
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("设置页：profile 状态、provider 登录向导与断开都经主进程，凭据只落在 auth.json", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-desktop-settings-"));
	const root = join(directory, "settings");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const configPath = join(directory, "config.toml");
	const authPath = join(directory, "auth.json");
	// 默认模型指向一个还没有凭据的服务商。模型选择器只列已配置且启用的服务商（2026-09-11 起），
	// 这个前提选不出来，只能由配置文件给出——作者从旧配置升级、或删掉凭据之后就是这个状态。
	await writeFile(
		configPath,
		'version = 1\n[models.profiles.main]\nprovider = "deepseek"\nmodel = "deepseek-flash"\n',
	);
	// 设置页读的是产品配置：把两份文件指到临时目录，并去掉开发 shell 里的 SUIMING_* 覆盖与各家 API key，不碰 ~/.suiming。
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^SUIMING_|_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/.test(name)),
	) as Record<string, string>;
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
		env: { ...env, SUIMING_CONFIG_PATH: configPath, SUIMING_AUTH_PATH: authPath },
		timeout: 20000,
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
		const form = page.getByRole("form", { name: "默认对话模型", exact: true });
		await form.getByText("此模型尚无可用凭据，请在「提供商」中配置。", { exact: true }).waitFor();
		await page.getByRole("tab", { name: "提供商", exact: true }).click();
		await page.getByRole("button", { name: "配置 DeepSeek", exact: true }).click();
		// API key 走 provider 自己的登录提示：主进程转述 secret prompt，窗口回答，凭据不回读。
		await page.getByRole("button", { name: "输入 API key" }).click();
		const secret = page.locator("input[type=password]");
		await secret.waitFor();
		await mkdir("/tmp/suiming-desktop-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/settings-login.png" });
		await secret.fill("sk-desktop-test-never-shown");
		await page.getByRole("button", { name: "提交", exact: true }).click();
		await page.getByText("API key · 本地保存", { exact: true }).waitFor();
		const stored = JSON.parse(await readFile(authPath, "utf8")) as { credentials: Record<string, { key: string }> };
		assert.equal(stored.credentials.deepseek?.key, "sk-desktop-test-never-shown");
		assert.equal((await page.content()).includes("sk-desktop-test-never-shown"), false);
		await page.getByRole("button", { name: "关闭", exact: true }).click();
		await page.getByRole("button", { name: "删除本地凭据", exact: true }).click();
		await page.getByRole("button", { name: "确认删除", exact: true }).click();
		await page.getByText("未配置凭据", { exact: true }).waitFor();
		// 设置是模态框：Esc 关掉回到工作面；Agent 面板在发送前就指出缺什么，并能重新打开设置。
		await page.keyboard.press("Escape");
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		await page.getByText(/DeepSeek 还没有可用凭据/).waitFor();
		await page.getByRole("button", { name: "对话模型", exact: true }).click();
		await page.getByRole("button", { name: "模型设置…", exact: true }).click();
		await page.getByRole("dialog").getByRole("heading", { name: "设置", exact: true }).waitFor();
		// 等弹出动画结束再截图，否则截到半透明的中间帧。
		await page.waitForTimeout(400);
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/settings-dialog.png" });
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("导航与文件：侧栏独立、共享草稿、固定与新开、关闭选择、重载和源文件修复", { timeout: 120000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-navigation-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "黄盖推开赤壁的大门，望向封存多年的火船。\n\n".repeat(80));
	await writeFile(join(root, "AGENTS.md"), "作者的辅助笔记\n");
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		const body = page.locator('[data-scroll-key="body:text"]');
		await body.evaluate((element) => {
			element.scrollTop = 420;
		});
		const position = await page.getByRole("navigation", { name: "作品位置" }).innerText();
		for (const name of ["文件", "身份", "搜索", "大纲"]) {
			await page.getByRole("button", { name, exact: true }).click();
			assert.equal(await body.evaluate((element) => element.scrollTop), 420);
			assert.equal(await page.getByRole("navigation", { name: "作品位置" }).innerText(), position);
			assert.equal(await page.locator(".tab-btn").count(), 1);
		}
		// 阅读选区和位置属于该 tab，切换后恢复真实选区。
		await body.evaluate((element) => {
			const node = element.querySelector("p")?.firstChild;
			if (node) element.ownerDocument.getSelection()?.setBaseAndExtent(node, 0, node, 4);
		});
		await page.getByRole("button", { name: "新标签页", exact: true }).click();
		await page.getByRole("heading", { name: "打开一个工作页面", exact: true }).waitFor();
		// 「最近访问」每行是标题加相对路径两行，约 36px；`tree-row` 是给单行树用的 h-7（28px）。
		// 压不进去时相邻行会互相叠上——2026-09-13 作者截图发现。这里直接钉住：包围盒不许重叠。
		const rows = await page.locator('[data-scroll-key="empty"] [data-page]').all();
		assert.ok(rows.length >= 1, "最近访问应当有记录");
		let previousBottom = 0;
		for (const row of rows) {
			const box = await row.boundingBox();
			assert.ok(box);
			assert.ok(box.height >= 34, `两行内容的行高不能被固定高度压住，实际 ${box.height}px`);
			assert.ok(box.y >= previousBottom - 1, `相邻两行重叠：上一行底 ${previousBottom}，这一行顶 ${box.y}`);
			previousBottom = box.y + box.height;
		}
		await page.locator(".tab-btn").first().locator("button").first().click();
		assert.equal(
			await body.evaluate(
				(element) =>
					new Promise<number>((resolve) =>
						element.ownerDocument.defaultView?.requestAnimationFrame(() =>
							resolve(element.ownerDocument.getSelection()?.toString().length ?? 0),
						),
					),
			),
			4,
		);
		assert.equal(await body.evaluate((element) => element.scrollTop), 420);
		await page.locator(".tab-btn").last().locator("button").first().click();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		// 编辑明确目标；普通导航保护草稿，新页面与已有页面各自恢复。
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
		await page.locator(".cm-content").click();
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("\n第一份共享草稿");
		await page.getByText("未保存", { exact: true }).waitFor();
		await page.locator('.beat-row[data-page$="beat-0002.md"]').click();
		assert.equal(await page.locator(".tab-btn").count(), 2);
		await page.locator(".tab-btn").first().locator("button").first().click();
		assert.match(await page.locator(".cm-content").innerText(), /第一份共享草稿/);
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name: "在文件树中定位", exact: true }).click();
		const proseFile = page.locator('[data-file-path="text/beat-0001.md"]');
		await proseFile.click();
		assert.equal(await page.locator(".tab-btn").count(), 2, "文件树激活同一作品页，未保存草稿不造成重复页");
		await page.getByRole("navigation", { name: "作品位置" }).waitFor();
		assert.equal(await page.locator(".cm-content").getAttribute("contenteditable"), "true");
		await proseFile.click({ button: "middle" });
		await page.locator(".tab-btn").nth(1).locator("button").first().click();
		await page.locator("[data-prose]").filter({ hasText: "第一份共享草稿" }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").click();
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("\n第二次共享修改");
		await page.reload();
		await page.locator(".cm-content").filter({ hasText: "第二次共享修改" }).waitFor();
		assert.doesNotMatch(await readFile(join(root, "text/beat-0001.md"), "utf8"), /共享/);
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		assert.equal(await page.getByRole("dialog").count(), 0, "仍由作品页持有的草稿不丢弃");
		await page.locator(".tab-btn").first().locator("button").first().click();
		await page.locator(".cm-content").filter({ hasText: "第二次共享修改" }).waitFor();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
		await page.locator(".cm-content").filter({ hasText: "第二次共享修改" }).waitFor();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "放弃修改", exact: true }).click();
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.getByRole("heading", { name: "打开一个工作页面", exact: true }).waitFor();
		// 明确新开允许副本，默认点击激活已有；固定页面不会被替换。
		await page.getByRole("button", { name: "大纲", exact: true }).click();
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.locator(".tab-btn").click({ button: "right" });
		await page.getByRole("menuitem", { name: "固定标签页", exact: true }).click();
		await page.locator('.beat-row[data-page$="beat-0002.md"]').click();
		assert.equal(await page.locator(".tab-btn").count(), 2);
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		assert.equal(await page.locator(".tab-btn[data-active=true]").innerText(), "beat-0001");
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click({ button: "middle" });
		assert.equal(await page.locator(".tab-btn").count(), 3);
		await page.locator('.beat-row[data-page$="beat-0002.md"]').click({ button: "right" });
		await page.getByRole("menuitem", { name: "在新标签页打开", exact: true }).click();
		assert.equal(await page.locator(".tab-btn").count(), 4);
		await page.getByRole("button", { name: "新标签页", exact: true }).click();
		await page.getByRole("heading", { name: "打开一个工作页面", exact: true }).waitFor();
		// 辅助文件在当前编辑器保存；有未知保留路径时仍能打开文件树。
		await page.getByRole("button", { name: "文件", exact: true }).click();
		await page.getByRole("treeitem", { name: "AGENTS.md", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").click();
		await page.keyboard.press("Meta+A");
		await page.keyboard.insertText("辅助笔记的修改");
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByText("已保存", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "辅助笔记的修改");
		const diff = await page.evaluate(() => window.suiming?.invoke("project.diff", {}));
		assert.ok(!diff?.some((entry) => entry.path === "AGENTS.md"));
		await writeFile(join(root, "text/broken.txt"), "未知保留路径");
		await page.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		const textFolder = page.getByRole("treeitem", { name: "text", exact: true });
		if ((await textFolder.getAttribute("aria-expanded")) !== "true") await textFolder.click();
		await page.getByRole("treeitem", { name: "broken.txt", exact: true }).click();
		await page
			.getByText(/Story Language 不认识这个路径：text\/broken.txt/)
			.first()
			.waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").filter({ hasText: "未知保留路径" }).waitFor();
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-navigation-failure.png" });
		console.error("navigation errors", errors, await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("分栏调宽：拖拽、窄栏导航、边界对齐、键盘与宽度恢复", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-pane-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "军杖落到第三十下。\n\n".repeat(80));
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const left = page.getByRole("separator", { name: "调整左栏宽度", exact: true });
	const right = page.getByRole("separator", { name: "调整右栏宽度", exact: true });
	const drag = async (handle: Locator, delta: number, y = 140) => {
		const box = await handle.boundingBox();
		assert.ok(box);
		await page.mouse.move(box.x + box.width / 2, box.y + y);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + delta, box.y + y, { steps: 8 });
		await page.mouse.up();
	};
	const aligned = async (side: "left" | "right") => {
		const header = await page.locator(`[data-pane-header='${side}']`).boundingBox();
		const pane = await page.locator(`#workbench-${side}`).boundingBox();
		assert.ok(header && pane);
		assert.equal(header.x, pane.x);
		assert.equal(header.width, pane.width);
		const handle = await (side === "left" ? left : right).boundingBox();
		assert.ok(handle);
		assert.equal(handle.y, header.y, "拖动条从窗口顶部开始");
		assert.equal(handle.y + handle.height, pane.y + pane.height, "拖动条贯通至内容底部");
	};
	// 侧栏收起后，标签栏紧贴展开按钮块：中间多出的外边距露出窗格的 chrome 底色，曾在标签左边留下一道灰条（作者截图发现）。
	const flushWithToggle = async (side: "left" | "right") => {
		const toggle = await page.locator(`[data-side-toggle='${side}']`).boundingBox();
		const strips = page.locator("[data-pane-id] .drag");
		const strip = await (side === "left" ? strips.first() : strips.last()).boundingBox();
		assert.ok(toggle && strip);
		if (side === "left") assert.equal(strip.x, toggle.x + toggle.width, "标签栏从左侧展开按钮块的右边缘开始");
		else assert.equal(strip.x + strip.width, toggle.x, "标签栏到右侧展开按钮块的左边缘为止");
		assert.equal(toggle.y + toggle.height, strip.y + strip.height, "按钮块与标签栏的底边线在同一行");
	};
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await app.evaluate(({ BrowserWindow, app: desktopApp }) => {
			desktopApp.focus({ steal: true });
			BrowserWindow.getAllWindows()[0]?.focus();
			return true;
		});
		const windowBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
		// AI 面板最大化、还原、折叠后，文档的原生拖动区不能遮住重新展开按钮。
		await page.getByRole("button", { name: "展开为主工作面", exact: true }).click();
		await page.getByRole("button", { name: "收回为侧栏", exact: true }).click();
		await page.getByRole("button", { name: "收起右栏", exact: true }).click();
		const reopen = page.getByRole("button", { name: "展开右栏", exact: true });
		const reopenBox = await reopen.boundingBox();
		assert.ok(reopenBox);
		await flushWithToggle("right");
		for (const strip of await page.locator("[data-pane-id] .drag").all()) {
			const box = await strip.boundingBox();
			assert.ok(box && box.x + box.width <= reopenBox.x, "标签栏拖动区域不能覆盖右栏展开按钮");
		}
		await reopen.click();
		await right.waitFor();
		await aligned("right");
		for (const side of ["left", "right"] as const) {
			const handle = side === "left" ? left : right;
			await aligned(side);
			await handle.focus();
			await handle.hover({ position: { x: 4, y: 12 } });
			await page.waitForTimeout(500);
			assert.equal(await page.getByRole("tooltip").count(), 0, "拖动条悬停和聚焦均不弹出提示");
			const width = Number(await handle.getAttribute("aria-valuenow"));
			await drag(handle, 16, 12);
			assert.equal(Number(await handle.getAttribute("aria-valuenow")), width + (side === "left" ? 16 : -16));
			await drag(handle, -16, 12);
			assert.equal(Number(await handle.getAttribute("aria-valuenow")), width);
		}
		assert.deepEqual(
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds()),
			windowBefore,
			"标题栏位置拖动分栏不能移动应用窗口",
		);
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		const body = page.locator('[data-scroll-key="body:text"]');
		await body.evaluate((element) => {
			element.scrollTop = 420;
		});
		const location = await page.getByRole("navigation", { name: "作品位置" }).innerText();
		const outline = page.getByRole("button", { name: "大纲", exact: true });
		assert.equal(await outline.getAttribute("aria-pressed"), "true", "首次打开默认选中作品大纲");
		assert.equal(
			await page.locator("[data-navigation-icons] button").first().getAttribute("aria-label"),
			"大纲",
			"作品大纲位于文件入口之前",
		);
		// macOS 普通窗口须避让左上角原生按钮，其他平台不预留这块空间。
		const fullIconWidth = process.platform === "darwin" ? 224 : 200;
		assert.equal(await left.getAttribute("aria-valuenow"), "244");
		await drag(left, fullIconWidth - 244);
		await outline.waitFor();
		assert.equal(await left.getAttribute("aria-valuenow"), String(fullIconWidth));
		assert.equal(await page.getByRole("button", { name: /^切换导航：/ }).count(), 0);
		const header = await page.locator("[data-pane-header='left']").boundingBox();
		assert.ok(header);
		for (const button of await page.locator("[data-pane-header='left']").getByRole("button").all()) {
			const box = await button.boundingBox();
			assert.ok(box && box.x >= header.x && box.x + box.width <= header.x + header.width);
		}
		if (process.platform === "darwin") {
			await drag(left, -2);
			await page.getByRole("button", { name: "切换导航：大纲", exact: true }).waitFor();
			assert.equal(await outline.count(), 0, "被收纳的图标不进入辅助技术导航");
			const fullscreen = async (value: boolean) => {
				// macOS 的全屏切换是 Space 动画，宿主状态不对时 enter/leave-full-screen 可能永远不来。
				// 无界等待会让整条测试静默耗到 90 秒预算、报一句没有信息的超时；有界并点名原因。
				const entered = await app.evaluate(({ BrowserWindow }, full) => {
					const win = BrowserWindow.getAllWindows()[0];
					if (!win) throw new Error("缺少桌面窗口");
					// 回调整体会被序列化到主进程执行：里面不能出现具名函数声明，tsx 的 keepNames 会插入
					// 主进程没有的 __name 助手。
					return new Promise<boolean>((resolve) => {
						const timer = setTimeout(() => resolve(false), 15000);
						// once 按事件名字面量重载，三元表达式会让重载解析失败；两条分支各自写全。
						if (full)
							win.once("enter-full-screen", () => {
								clearTimeout(timer);
								resolve(true);
							});
						else
							win.once("leave-full-screen", () => {
								clearTimeout(timer);
								resolve(true);
							});
						win.setFullScreen(full);
					});
				}, value);
				assert.ok(
					entered,
					`窗口未在 15 秒内${value ? "进入" : "退出"}全屏。这一步依赖宿主的 macOS 窗口状态，不是产品缺陷；` +
						`本机另开着桌面应用或负载过高时会这样。`,
				);
				await page.locator(`html[data-window-controls='${value ? "none" : "left"}']`).waitFor();
			};
			await fullscreen(true);
			await drag(left, -22);
			await outline.waitFor();
			assert.equal(await left.getAttribute("aria-valuenow"), "200", "全屏下最窄左栏仍显示全部入口");
			assert.equal(await page.getByRole("button", { name: /^切换导航：/ }).count(), 0);
			await aligned("left");
			const buttons = await page.locator("[data-pane-header='left']").getByRole("button").all();
			assert.equal(buttons.length, 6, "五个入口及收起按钮都可操作");
			const handleBox = await left.boundingBox();
			assert.ok(handleBox);
			let previousRight = 0;
			for (const button of buttons) {
				const box = await button.boundingBox();
				assert.ok(box);
				assert.equal(box.width, 28, "紧凑布局保持 28px 点击宽度");
				assert.equal(box.height, 24, "紧凑布局保持 24px 点击高度");
				assert.ok(box.x >= previousRight + 2);
				assert.ok(box.x + box.width <= handleBox.x, "按钮与分栏拖动区不重叠");
				previousRight = box.x + box.width;
			}
			await page.getByRole("button", { name: "文件", exact: true }).click();
			await outline.click();
			await page.reload();
			await outline.waitFor();
			assert.equal(await left.getAttribute("aria-valuenow"), "200", "全屏重载仍使用真实窗口状态");
			await page.getByRole("button", { name: "收起左栏", exact: true }).click();
			const expand = page.getByRole("button", { name: "展开左栏", exact: true });
			assert.equal((await expand.boundingBox())?.x, 48, "收起后展开按钮也靠近导航轨");
			await expand.click();
			await fullscreen(false);
			await page.getByRole("button", { name: "切换导航：大纲", exact: true }).waitFor();
			await drag(left, 22);
		}
		await drag(left, -180);
		assert.equal(await left.getAttribute("aria-valuenow"), "200");
		await aligned("left");
		assert.equal(await body.evaluate((element) => element.scrollTop), 420);
		for (const name of ["身份", "材料", "搜索", "大纲", "文件"]) {
			if (process.platform === "darwin") {
				await page.getByRole("button", { name: /^切换导航：/ }).click();
				assert.equal(await page.getByRole("menuitemradio").count(), 5);
				await page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
			} else await page.getByRole("button", { name, exact: true }).click();
			assert.equal(await page.getByRole("navigation", { name: "作品位置" }).innerText(), location);
			assert.equal(await page.locator(".tab-btn").count(), 1);
			assert.equal(await body.evaluate((element) => element.scrollTop), 420);
		}
		// 可用空间允许时恢复快捷图标，左右顶部和内容边界一起移动。
		await drag(left, 160);
		assert.equal(await left.getAttribute("aria-valuenow"), "360");
		await page.getByRole("button", { name: "文件", exact: true }).waitFor();
		await drag(right, -60);
		assert.equal(await right.getAttribute("aria-valuenow"), "444");
		await aligned("left");
		await aligned("right");
		await page.reload();
		await left.waitFor();
		assert.equal(await left.getAttribute("aria-valuenow"), "360");
		assert.equal(await right.getAttribute("aria-valuenow"), "444");
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(960, 640);
			return true;
		});
		await page.getByRole("button", { name: "展开左栏", exact: true }).waitFor();
		await flushWithToggle("left");
		// 测试源码不带 DOM 类型，计算样式在页面里取。
		const [railBackground, mainBackground] = (await page.evaluate(
			`['nav[aria-label="全局动作"]', "main"].map((selector) => getComputedStyle(document.querySelector(selector)).backgroundColor)`,
		)) as string[];
		assert.equal(railBackground, mainBackground, "左栏收起后动作栏与主工作面同为白底");
		assert.equal(await right.getAttribute("aria-valuenow"), "316");
		assert.equal((await page.locator("main").boundingBox())?.width, 600);
		await page.getByRole("button", { name: "展开左栏", exact: true }).click();
		await right.waitFor({ state: "hidden" });
		await left.focus();
		await page.keyboard.press("Home");
		await page
			.getByRole("button", { name: process.platform === "darwin" ? "切换导航：文件" : "文件", exact: true })
			.waitFor();
		await page.keyboard.press("ArrowRight");
		assert.equal(await left.getAttribute("aria-valuenow"), "216");
		await page.keyboard.press("Enter");
		assert.equal(await left.getAttribute("aria-valuenow"), "244");
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(1460, 940);
			return true;
		});
		await right.waitFor();
		assert.equal(await right.getAttribute("aria-valuenow"), "444", "窗口临时收窄不覆盖偏好");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").fill("尚未保存的正文草稿");
		await right.focus();
		await page.keyboard.press("End");
		assert.equal(await right.getAttribute("aria-valuenow"), "560");
		assert.equal((await page.locator("main").boundingBox())?.width, 612);
		assert.equal(await page.locator(".cm-content").innerText(), "尚未保存的正文草稿");
		await right.dblclick();
		assert.equal(await right.getAttribute("aria-valuenow"), "384");
		await aligned("right");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("提示：避免重复名称，截断补全、中文说明、禁用原因、键盘与图中提示一致", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-hover-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "notes/reference/drafts"), { recursive: true });
	await writeFile(join(root, "notes/reference/drafts/guide.md"), "辅助文件的阅读内容。\n");
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// 按真实移动路径经过间隙，允许 Tooltip 的可悬停区域结束，再进入下一个触发器。
	const hover = async (target: Locator) => {
		await target.scrollIntoViewIfNeeded();
		const box = await target.boundingBox();
		assert.ok(box);
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
	};
	const tooltip = page.getByRole("tooltip");
	const visibleTip = page.locator('[data-slot="tooltip-content"]');
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	try {
		await button("大纲").waitFor();
		await app.evaluate(({ BrowserWindow, app: desktopApp }) => {
			desktopApp.focus({ steal: true });
			const win = BrowserWindow.getAllWindows()[0];
			win?.show();
			win?.focus();
			return true;
		});
		await hover(button("大纲"));
		await tooltip.filter({ hasText: /按卷和故事顺序浏览作品/ }).waitFor();
		assert.match(await tooltip.innerText(), /按卷和故事顺序浏览作品/);
		assert.equal(await button("大纲").getAttribute("title"), null);
		// 移入提示仍能阅读；Escape 关闭，焦点不会触发动作。
		await hover(visibleTip);
		assert.equal(await tooltip.count(), 1);
		await page.keyboard.press("Escape");
		await tooltip.waitFor({ state: "hidden" });
		await button("提交版本").focus();
		await tooltip.filter({ hasText: /没有可提交的修改/ }).waitFor();
		assert.match(await tooltip.innerText(), /没有可提交的修改/);
		assert.equal(await button("提交版本").isDisabled(), true);
		await page.keyboard.press("Escape");
		await button("折叠全部卷").click();
		await button("展开全部卷").waitFor();
		await button("展开全部卷").click();
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		// 完整面包屑逐段悬停没有重复提示，父级仍可定位大纲；完整 tab 标题同样保持安静。
		const breadcrumb = page.getByRole("navigation", { name: "作品位置" });
		const location = await breadcrumb.innerText();
		for (const target of [
			breadcrumb.getByRole("button", { name: "赤壁之战", exact: true }),
			breadcrumb.locator('[aria-current="page"]'),
			page.locator('.tab-btn[data-active="true"] button').first(),
		]) {
			assert.ok(await target.evaluate((element) => element.scrollWidth <= element.clientWidth));
			await hover(target);
			await page.waitForTimeout(500);
			assert.equal(await tooltip.count(), 0, "完整名称不重复提示");
		}
		await breadcrumb.getByRole("button", { name: "赤壁之战", exact: true }).click();
		assert.equal(await breadcrumb.innerText(), location, "父级只定位导航，不替换当前内容");
		// 普通文件仍显示物理路径；折叠段补全路径，作品页保持对象面包屑。
		await button("文件").click();
		for (const path of ["notes", "notes/reference", "notes/reference/drafts", "notes/reference/drafts/guide.md"])
			await page.locator(`[data-file-path="${path}"]`).click();
		await button("定位折叠的路径").focus();
		await tooltip.filter({ hasText: "notes / reference / drafts / guide.md" }).waitFor();
		await page.keyboard.press("Escape");
		await button("后退").click();
		await button("大纲").click();
		assert.equal(await page.getByRole("radio", { name: "设计", exact: true }).getAttribute("aria-checked"), "true");
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByText("正文尚未开始。", { exact: false }).waitFor();
		await hover(button("关闭标签"));
		await tooltip.filter({ hasText: /关闭标签页/ }).waitFor();
		assert.match(await tooltip.innerText(), /关闭标签页/);
		// 保存到目录的修改可提交，但编辑器还有未保存文字时，点击和键盘均不得提交。
		await mkdir(join(root, "text"), { recursive: true });
		await writeFile(join(root, "text/beat-0001.md"), "已经保存的候选正文。\n");
		await page.reload();
		await button("切换到编辑视图").click();
		await page.locator(".cm-content").fill("还未保存的修改");
		const before = await page.evaluate(() => window.suiming?.invoke("workspace.show", {}));
		assert.equal(await button("提交版本").isDisabled(), true);
		await button("提交版本").focus();
		await tooltip.filter({ hasText: /请先保存未保存的修改/ }).waitFor();
		assert.match(await tooltip.innerText(), /请先保存未保存的修改/);
		await button("提交版本").dispatchEvent("click");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Space");
		const after = await page.evaluate(() => window.suiming?.invoke("workspace.show", {}));
		assert.equal(after?.revisionId, before?.revisionId);
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length, 0);
		assert.equal(await page.locator(".cm-content").innerText(), "还未保存的修改");
		assert.equal(await readFile(join(root, "text/beat-0001.md"), "utf8"), "已经保存的候选正文。\n");
		await button("保存 ⌘S").click();
		await button("切换到阅读视图").click();
		await button("打开故事轴").click();
		// 卷名是原生导航按钮，Enter / Space 都可进入；当前卷标题不再声称可以进入。
		for (const key of ["Enter", "Space"]) {
			const volume = page.locator('[data-volume="vol-0001"]');
			await volume.focus();
			await tooltip.filter({ hasText: /点击进入这一卷/ }).waitFor();
			await page.keyboard.press(key);
			const back = page
				.getByRole("navigation", { name: "作品位置" })
				.getByRole("button", { name: "故事轴", exact: true });
			await back.waitFor();
			assert.equal(await volume.evaluate((element) => element.tagName), "SPAN");
			await hover(volume);
			await tooltip.filter({ hasText: "赤壁之战 · 2 个情节" }).waitFor();
			assert.equal(await tooltip.innerText(), "赤壁之战 · 2 个情节");
			await back.click();
		}
		await hover(button("放大"));
		await tooltip.filter({ hasText: "放大故事轴" }).waitFor();
		assert.equal(await tooltip.innerText(), "放大故事轴");
		await page.locator('[data-beat="beat-0001"]').focus();
		await tooltip.filter({ hasText: /单击选择；双击打开/ }).waitFor();
		assert.match(await tooltip.innerText(), /单击选择；双击打开/);
		await page.keyboard.press("Escape");
		await tooltip.waitFor({ state: "hidden" });
		// 长文件名在窄窗口里完整换行，并保持在窗口内。
		const longFile = `${"long-source-name-".repeat(12)}.md`;
		await writeFile(join(root, longFile), "辅助材料\n");
		const resizeFile = "窗口宽度变化后的完整材料.md";
		await writeFile(
			join(root, resizeFile),
			"辅助材料\n\nhttps://example.com/plain\n\n[材料出处](https://example.com/source)\n",
		);
		await page.reload();
		// reload 后先是加载态（只有「正在打开作品…」）：必须等作品真的渲染出来再操作，否则数到的是零个按钮。
		await page.getByRole("button", { name: "收起右栏", exact: true }).waitFor();
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(960, 640);
			return true;
		});
		// setSize 之后导航图标要重新量宽才决定平铺还是收成菜单：立刻数按钮拿的是回流前的快照，负载高时
		// 两种都数不到、或数到缩窗前的旧按钮——这条 E2E 一直偶发失败的原因。先等渲染进程看到新宽度、再等
		// 两帧让 ResizeObserver 与重渲染落地，然后等某一种形态出现再分支（只做后一半在 2026-09-13 试过，不够）。
		await page.waitForFunction(() => window.innerWidth <= 960);
		await page.evaluate(
			() =>
				new Promise((resolve) =>
					window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(true))),
				),
		);
		const navMenu = page.getByRole("button", { name: /^切换导航：/ });
		await button("展开左栏").or(button("文件")).or(navMenu).first().waitFor();
		if (await button("展开左栏").count()) {
			await button("展开左栏").click();
			await button("文件").or(navMenu).first().waitFor();
		}
		if (await button("文件").count()) await button("文件").click();
		else {
			await navMenu.click();
			await page.getByRole("menuitemradio", { name: /^文件/ }).click();
		}
		await page.locator(`[data-file-path="${longFile}"]`).focus();
		await tooltip.filter({ hasText: longFile }).waitFor();
		assert.equal(await tooltip.innerText(), longFile);
		const box = await visibleTip.boundingBox();
		assert.ok(box && box.width <= 320 && box.height > 40 && box.x >= 0 && box.x + box.width <= 960);
		await page.locator(`[data-file-path="${longFile}"]`).click();
		await page.locator('.tab-btn[data-active="true"] button').first().focus();
		await tooltip.filter({ hasText: longFile }).waitFor();
		await page.keyboard.press("Escape");
		// 相同名称在窄窗口补全、放宽后关闭；根目录里的完整名称也不重复提示。
		await page.locator('[data-file-path="outline"]').focus();
		await page.waitForTimeout(500);
		assert.equal(await tooltip.count(), 0);
		await page.locator(`[data-file-path="${resizeFile}"]`).click();
		const fileName = page.getByRole("navigation", { name: "文件路径" }).locator('[aria-current="page"]');
		assert.ok(await fileName.evaluate((element) => element.scrollWidth > element.clientWidth));
		await hover(fileName);
		await tooltip.filter({ hasText: resizeFile }).waitFor();
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(2000, 940);
			return true;
		});
		await tooltip.waitFor({ state: "hidden" });
		assert.ok(await fileName.evaluate((element) => element.scrollWidth <= element.clientWidth));
		await hover(fileName);
		await page.waitForTimeout(500);
		assert.equal(await tooltip.count(), 0);
		// Markdown 已显示完整 URL 时不重复提示，有名称的链接仍显示目的地址。
		await hover(page.getByText("https://example.com/plain", { exact: true }));
		await page.waitForTimeout(500);
		assert.equal(await tooltip.count(), 0);
		await hover(page.getByText("材料出处", { exact: true }));
		await tooltip.filter({ hasText: "https://example.com/source" }).waitFor();
		await button("设置").click();
		await button("关闭对话框").focus();
		await tooltip.filter({ hasText: "关闭对话框" }).waitFor();
		assert.equal(await tooltip.innerText(), "关闭对话框");
		await page.keyboard.press("Escape");
		await tooltip.waitFor({ state: "hidden" });
		assert.equal(await page.getByRole("dialog").count(), 1, "第一次 Escape 只关闭提示");
		await page.keyboard.press("Escape");
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		// Hint 作为弹出层触发器时必须转交事件与 ref，不能只显示提示而打不开菜单。
		await button("新标签页").click();
		await button("标签页列表").click();
		await page.getByRole("menuitem").first().click();
		await button("切换作品").click();
		await page.getByText("当前作品", { exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-hover-failure.png" });
		console.error("hover errors", errors, await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
