import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService } from "@suiming/runtime";
import { parse, stringify } from "yaml";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare const innerHeight: number;
declare function requestAnimationFrame(callback: () => void): number;

test("期待事件路径：宽窄窗、原文摘录、回应语义、同节阶段、空记录和大量异常事件", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-contract-journey-"));
	const root = join(directory, "work");
	await cp(resolve("examples/sanguo"), root, { recursive: true });
	const service = await LocalProjectService.init({ checkoutPath: root });
	service.close();
	const index = parse(await readFile(join(root, "outline/story/index.yaml"), "utf8")) as {
		volumes: { id: string; beat_ids: string[] }[];
	};
	// 无效生命周期只作为未提交候选测试，绝不写进公共示例或 Canon。
	const ordered = await Promise.all(
		index.volumes.flatMap((volume) =>
			volume.beat_ids.map(async (localId) => {
				const path = `outline/story/${volume.id}/${localId}.md`;
				const content = await readFile(join(root, path), "utf8");
				const fields = parse(/^---\n([\s\S]*?)\n---/u.exec(content)?.[1] ?? "") as { title?: string };
				return { localId, path, title: fields.title ?? localId };
			}),
		),
	);
	const fixtures = [
		{ id: "空记录", open: [], advance: [], resolve: [] },
		{ id: "等待回应", open: [0], advance: [], resolve: [] },
		{ id: "回应后继续推进", open: [0], advance: [3], resolve: [2] },
		{ id: "同节建立推进回应", open: [0], advance: [0], resolve: [0] },
		{
			id: "多次推进",
			open: [0],
			advance: Array.from({ length: 28 }, (_, i) => i + 1),
			resolve: [29],
		},
	];
	for (const fixture of fixtures) {
		await writeFile(
			join(root, `outline/contracts/验收${fixture.id}.md`),
			`---\n{}
---\n# 验收${fixture.id}\n\n这是用于交互和布局验证的合成期待。\n`,
		);
	}
	for (let ordinal = 0; ordinal < 30; ordinal++) {
		const beat = ordered[ordinal];
		assert.ok(beat);
		const path = join(root, beat.path);
		const text = await readFile(path, "utf8");
		const front = /^---\n([\s\S]*?)\n---\n/u.exec(text);
		assert.ok(front);
		const fields = parse(front[1] ?? "") as { contracts?: Record<string, string[]> };
		fields.contracts ??= {};
		for (const phase of ["open", "advance", "resolve"] as const) {
			const ids = fixtures
				.filter((fixture) => fixture[phase].includes(ordinal))
				.map((fixture) => `验收${fixture.id}`);
			if (ids.length) fields.contracts[phase] = [...(fields.contracts[phase] ?? []), ...ids];
		}
		await writeFile(path, `---\n${stringify(fields)}---\n${text.slice(front[0].length)}`);
	}
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const capture = async (name: string) => {
		if (!process.env.SUIMING_UI_CAPTURE) return;
		await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
		await page.screenshot({
			path: join(process.env.SUIMING_UI_CAPTURE, name),
			type: "jpeg",
			quality: 85,
			animations: "disabled",
		});
	};
	try {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		const closeChat = page.getByRole("button", { name: "收起右栏", exact: true });
		if (await closeChat.isVisible()) await closeChat.click();
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		const visit = async (id: string) => {
			const path = `outline/contracts/${id}.md`;
			await search.fill(path);
			await page.locator(`.item-btn[data-page="${path}"]`).click();
			await page.locator("[data-contract-track]").waitFor();
		};
		const track = page.locator("[data-contract-track]");
		const events = track.locator("[data-contract-event]");
		await visit("传国玉玺下落");
		assert.equal(await track.locator("[data-contract-excerpt]").count(), 0, "原文按需预览，不常驻占位");
		await events.first().locator("button[data-page]").hover();
		const preview = page.getByRole("region", { name: /^情节预览：/u });
		await preview.locator("[data-contract-excerpt]").filter({ hasText: "张让" }).waitFor();
		await preview.hover();
		await capture("01-hover-preview.jpg");
		await page.keyboard.press("Escape");
		await preview.waitFor({ state: "hidden" });
		assert.equal(await events.count(), 2);
		assert.equal(
			await events.locator("[data-contract-order]:visible").count(),
			2,
			"横向路径仍显示每个事件的全书序号",
		);
		assert.equal(await track.locator("[data-contract-deadline]").count(), 0, "实际回应节点不附加计划期限");
		assert.equal(await track.locator('[data-phase="advance"]').count(), 0, "无推进不造空阶段");
		const first = await events.nth(0).boundingBox();
		const second = await events.nth(1).boundingBox();
		assert.ok(first && second && Math.abs(first.y - second.y) < 1 && first.x + first.width <= second.x + 1);
		const connection = await events
			.first()
			.locator("[data-contract-rail]")
			.evaluate((element) => {
				const style = element.ownerDocument.defaultView?.getComputedStyle(element, "::after");
				return {
					border: style?.borderTopWidth,
					width: Number.parseFloat(style?.width ?? "0"),
					content: style?.content,
				};
			});
		assert.ok(
			connection.border === "1px" && connection.width > 100 && connection.content !== "none",
			"两节点之间必须保留可见连线",
		);
		await capture("01-resolved-wide.jpg");
		await track.getByRole("button", { name: "期待进展说明", exact: true }).hover();
		const hint = page.getByRole("tooltip");
		await hint.waitFor();
		assert.match(await hint.innerText(), /转化或有意义的否定/u);
		const hintBox = await hint.boundingBox();
		const windowSize = await page.evaluate(() => ({ width: innerWidth }));
		assert.ok(hintBox && hintBox.x >= 8 && hintBox.x + hintBox.width <= windowSize.width - 8);
		await page.keyboard.press("Escape");
		await events.last().locator("button[data-page]").press("Enter");
		await page.getByRole("heading", { name: "孙坚得玺与辞盟欺袁", exact: true }).waitFor();

		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 940));
		await page.waitForFunction(() => innerWidth === 1600);
		await visit("关羽归刘");
		await track.locator('[data-layout="horizontal"]').waitFor();
		assert.equal(await track.locator('[data-phase="advance"]').count(), 4);
		await events.nth(2).locator("button[data-page]").hover();
		await preview.waitFor();
		await preview.locator("[data-contract-excerpt]").filter({ hasText: /./u }).waitFor();
		await capture("02-six-horizontal-preview.jpg");
		const withinWindow = async () => {
			const box = await preview.boundingBox();
			const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
			assert.ok(
				box &&
					box.x >= 8 &&
					box.y >= 8 &&
					box.x + box.width <= size.width - 8 &&
					box.y + box.height <= size.height - 8,
			);
		};
		await withinWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1120, 940));
		await page.waitForFunction(() => innerWidth === 1120);
		await track.locator('[data-layout="vertical"]').waitFor();
		await preview.waitFor({ state: "hidden" });
		const boxes = await events.all();
		for (let i = 1; i < boxes.length; i++) {
			const a = await boxes[i - 1]?.boundingBox();
			const b = await boxes[i]?.boundingBox();
			assert.ok(a && b && a.y + a.height <= b.y + 1, "窄窗用连续纵线，不挤入一行");
		}
		await page.keyboard.press("Tab");
		await events.nth(2).locator("button[data-page]").focus();
		await preview.waitFor();
		await withinWindow();
		assert.equal(await preview.getAttribute("data-side"), "right", "纵排右侧有空间时，预览不应翻到左侧遮住导航");
		await capture("02-six-vertical-preview.jpg");
		await page.keyboard.press("Escape");
		await preview.waitFor({ state: "hidden" });
		await events.nth(2).locator("button[data-page]").press("Enter");
		await page.getByRole("heading", { name: "关羽斩颜良刘备免罪", exact: true }).waitFor();

		await visit("验收等待回应");
		await page.locator("article").getByText("等待回应", { exact: true }).waitFor();
		assert.equal(await track.getByText(/回应期限|到期|全书结束前/u).count(), 0);
		assert.equal(await events.count(), 1);
		await capture("03-pending.jpg");
		await visit("验收回应后继续推进");
		await track.getByText("回应后仍有推进，请核对", { exact: true }).waitFor();
		assert.deepEqual(await events.evaluateAll((items) => items.map((item) => item.getAttribute("data-ordinal"))), [
			"0",
			"2",
			"3",
		]);
		await capture("05-anomalies.jpg");
		await visit("验收同节建立推进回应");
		assert.equal(await events.count(), 1);
		assert.equal(await events.locator("[data-phase]").count(), 3);
		await capture("06-same-beat.jpg");
		await visit("验收空记录");
		await track.getByText("尚无建立、推进或回应记录。", { exact: true }).waitFor();
		assert.equal(await events.count(), 0);
		await capture("07-empty.jpg");
		await visit("验收多次推进");
		assert.equal(await events.count(), 30, "大量记录不能丢弃或藏到折叠入口里");
		await events.last().scrollIntoViewIfNeeded();
		await events.last().getByRole("button", { name: /^预览/u }).hover();
		await preview.waitFor();
		await withinWindow();
		await capture("08-dense-end.jpg");
		await page.keyboard.press("Escape");
		await events.last().locator("button[data-page]").press("Space");
		await page.getByRole("heading", { name: ordered[29]?.title ?? "", exact: true }).waitFor();

		await visit("传国玉玺下落");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await capture("09-medium.jpg");
		// 960px 窗口在右栏关闭时内容区仍有 624px，允许两节点横排；打开右栏验证真正的窄内容区。
		await page.getByRole("button", { name: "展开右栏", exact: true }).click();
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		assert.equal(await events.locator("[data-contract-order]:visible").count(), 2, "纵向路径每节只显示一次序号");
		await capture("10-narrow.jpg");
		const a = await events.first().boundingBox();
		const b = await events.last().boundingBox();
		assert.ok(
			a && b && a.y + a.height <= b.y + 1,
			`窄窗切为纵线，标题和摘录不覆盖：${JSON.stringify({ a, b, track: await track.boundingBox() })}`,
		);
		assert.equal(await track.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
		await capture("10-narrow.jpg");
		await events.last().getByRole("button", { name: /^预览/u }).click();
		await preview.waitFor();
		await withinWindow();
		await capture("11-narrow-preview.jpg");
		await preview.getByRole("button", { name: "打开情节", exact: true }).click();
		await page.getByRole("heading", { name: "孙坚得玺与辞盟欺袁", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
