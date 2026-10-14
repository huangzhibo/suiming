import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

for (const size of [100_000, 1_000_000])
	test(`长正文 ${size} 字：撤销、比较往返、逐块还原、重载与保存保留全文`, { timeout: 90000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "suiming-long-editor-"));
		const root = join(directory, "work");
		const path = "text/beat-0001.md";
		let original = "";
		for (let i = 0; original.length < size; i++)
			original += `第${i}段：${"江上的风穿过船舷，黄盖抬头望向对岸，记住每一步的代价。".repeat(3)}\n\n`;
		original += "结尾标记。\n";
		const committed = original.replace(/第(\d+)段：/gu, (line, n: string) =>
			Number(n) % 100 === 0 ? `${line}修订记录。` : line,
		);
		await mkdir(root);
		await materializeOpenStoryDirectorySnapshot(root, [
			...sampleWorkFiles(),
			{ path, mediaType: "text/markdown", bytes: new TextEncoder().encode(original) },
		]);
		const project = await LocalProjectService.init({ checkoutPath: root });
		await writeFile(join(root, path), committed);
		await project.commitCheckout();
		project.close();
		const app = await launchDesktop({ directory, project: root });
		const page = await app.firstWindow();
		page.setDefaultTimeout(20000);
		const errors = collectPageErrors(page);
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		const snapshot = () =>
			page.evaluate(() =>
				JSON.parse(Object.values(localStorage).find((value) => value.includes('"groups"')) ?? "{}"),
			);
		const source = () =>
			page.locator(".tab-btn").first().getByRole("button", { name: "beat-0001", exact: true }).click();
		const compare = async () => {
			await page.getByRole("button", { name: "更多", exact: true }).click();
			await page.getByRole("menuitem", { name: "查看版本差异", exact: true }).click();
			await page.locator(".cm-merge-b .cm-content").waitFor();
		};
		try {
			await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
			await page.getByRole("radio", { name: "正文", exact: true }).click();
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await editor.focus();
			await page.keyboard.press("Meta+End");
			await page.keyboard.insertText("作者补写。\n");
			const draft = `${committed}作者补写。\n`;
			assert.equal((await snapshot()).documents[path].content, draft);
			await page.keyboard.press("Meta+z");
			assert.equal((await snapshot()).documents[path], undefined);
			await page.keyboard.press("Meta+Shift+z");
			assert.equal((await snapshot()).documents[path].content, draft);
			await page.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await editor.focus();
			await page.keyboard.press("Meta+z");
			assert.equal((await snapshot()).documents[path], undefined, "阅读与编辑切换仍能撤销");
			await page.keyboard.press("Meta+Shift+z");
			await compare();
			await source();
			await editor.focus();
			await page.keyboard.press("Meta+z");
			assert.equal((await snapshot()).documents[path], undefined, "切页返回仍能撤销原来的补写");
			await page.keyboard.press("Meta+Shift+z");
			assert.equal((await snapshot()).documents[path].content, draft);
			await compare();
			await page.getByRole("button", { name: "选择比较基线", exact: true }).click();
			await page.getByRole("option", { name: /^r1 / }).click();
			await page
				.getByText(new RegExp(`(?:^|/ )${(committed.match(/修订记录。/gu)?.length ?? 0) + 1} 处差异$`))
				.first()
				.waitFor();
			await page.getByRole("button", { name: "下一处差异", exact: true }).click();
			await page.getByRole("button", { name: "还原当前差异", exact: true }).click();
			await page
				.locator(".cm-merge-b .cm-scroller")
				.evaluate(
					(element) =>
						new Promise<void>((resolve) =>
							element.ownerDocument.defaultView?.requestAnimationFrame(() =>
								element.ownerDocument.defaultView?.requestAnimationFrame(() => resolve()),
							),
						),
				);
			const firstVisible = (side = "b") =>
				page.locator(`.cm-merge-${side} .cm-scroller`).evaluate((element) => {
					const top = element.getBoundingClientRect().top;
					const lines = Array.from(element.querySelectorAll(".cm-line")) as {
						getBoundingClientRect(): { bottom: number };
						textContent: string | null;
					}[];
					return lines.find((line) => line.getBoundingClientRect().bottom > top)?.textContent;
				});
			let lastViewport = "";
			let stableFrames = 0;
			await eventually(async () => {
				const viewport = JSON.stringify([await firstVisible("a"), await firstVisible()]);
				stableFrames = viewport === lastViewport ? stableFrames + 1 : 0;
				lastViewport = viewport;
				return stableFrames >= 3;
			}, "还原后两栏完成换行和对齐测量");
			const visible = await firstVisible();
			const visibleBefore = await firstVisible("a");
			assert.ok(visible && visibleBefore);
			const reverted = (await snapshot()).documents[path]?.content ?? committed;
			assert.notEqual(reverted, draft);
			assert.ok(Math.abs(reverted.length - draft.length) <= 8, "逐块还原不能吞掉相隔的其他修改");
			await source();
			assert.equal((await snapshot()).documents[path]?.content ?? committed, reverted);
			await page.locator(".tab-btn").nth(1).getByRole("button").first().click();
			await page
				.locator(".cm-merge-b .cm-scroller")
				.evaluate(
					(element) =>
						new Promise<void>((resolve) =>
							element.ownerDocument.defaultView?.requestAnimationFrame(() =>
								element.ownerDocument.defaultView?.requestAnimationFrame(() => resolve()),
							),
						),
				);
			await eventually(
				async () => (await firstVisible()) === visible && (await firstVisible("a")) === visibleBefore,
				"比较页返回保持两栏长文的可见段落",
				2000,
			).catch(async () => {
				assert.deepEqual(
					{ before: await firstVisible("a"), current: await firstVisible() },
					{ before: visibleBefore, current: visible },
				);
			});
			await editor.focus();
			await page.keyboard.press("Meta+z");
			assert.equal((await snapshot()).documents[path].content, draft, "比较页返回后也能撤销逐块还原");
			await source();
			await editor.focus();
			await page.keyboard.press("Meta+z");
			assert.equal((await snapshot()).documents[path].content, draft, "别页改过正文后不重放过期撤销记录");
			await page.locator(".tab-btn").nth(1).getByRole("button").first().click();
			if (process.env.SUIMING_UI_CAPTURE) {
				await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
				await page.screenshot({ path: join(process.env.SUIMING_UI_CAPTURE, `long-diff-${size}.png`) });
			}
			await page.getByRole("button", { name: "切换为单栏差异", exact: true }).click();
			await page.locator('.cm-host[data-layout="unified"]').waitFor();
			await page
				.getByText(new RegExp(`(?:^|/ )${(committed.match(/修订记录。/gu)?.length ?? 0) + 1} 处差异$`))
				.waitFor();
			await editor.focus();
			await page.keyboard.press("Meta+End");
			await page.keyboard.insertText("单栏补写。\n");
			const final = `${draft}单栏补写。\n`;
			assert.equal((await snapshot()).documents[path].content, final);
			await page.reload();
			await editor.waitFor();
			assert.equal((await snapshot()).documents[path].content, final, "未保存的长正文重载后逐字保留");
			await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
			await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
			assert.equal(await readFile(join(root, path), "utf8"), final);
			await page.reload();
			await editor.waitFor();
			await editor.focus();
			await page.keyboard.press("Meta+End");
			await editor.getByText("单栏补写。", { exact: true }).waitFor();
			assert.equal(await readFile(join(root, path), "utf8"), final);
			assert.deepEqual(errors, []);
			if (process.env.SUIMING_UI_CAPTURE) {
				await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
				await page.screenshot({ path: join(process.env.SUIMING_UI_CAPTURE, `long-editor-${size}.png`) });
			}
		} finally {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
