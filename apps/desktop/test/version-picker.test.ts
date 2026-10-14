import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import git from "isomorphic-git";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

for (const count of [10, 100, 500])
	test(`${count} 个版本：精确检索、完整结果、键盘选择与跨版本文件保持`, { timeout: 90000 }, async () => {
		const exact = count >= 100 ? 21 : 2;
		const target = Math.floor(count / 2);
		const directory = await mkdtemp(join(tmpdir(), "suiming-version-scale-"));
		const root = join(directory, "work");
		await mkdir(root);
		await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
		(await LocalProjectService.init({ checkoutPath: root })).close();
		// 仅为版本规模制造同内容的提交链；不将合成历史当成创作或 Checker 证据。
		let head = await git.resolveRef({ fs, dir: root, ref: "refs/suiming/canon" });
		const tree = (await git.readCommit({ fs, dir: root, oid: head })).commit.tree;
		const ids = [head];
		for (let i = 2; i <= count; i++) {
			head = await git.writeCommit({
				fs,
				dir: root,
				commit: {
					tree,
					parent: [head],
					message: "规模验证\n",
					author: { name: "Test", email: "test@example.invalid", timestamp: i, timezoneOffset: 0 },
					committer: { name: "Test", email: "test@example.invalid", timestamp: i, timezoneOffset: 0 },
				},
			});
			ids.push(head);
		}
		await git.writeRef({ fs, dir: root, ref: "refs/suiming/canon", value: head, force: true });
		const app = await launchDesktop({ directory, project: root });
		const page = await app.firstWindow();
		page.setDefaultTimeout(20000);
		const errors = collectPageErrors(page);
		const button = (name: string) => page.getByRole("button", { name, exact: true });
		const search = page.getByRole("combobox", { name: "搜索版本", exact: true });
		const options = page.getByRole("option");
		try {
			await page.locator("[data-navigation-icons]").getByRole("button", { name: "材料", exact: true }).click();
			assert.equal(await page.getByRole("button", { name: /^r\d+ ·/ }).count(), Math.min(count, 10));
			if (count > 10) {
				await button("查找历史版本").click();
				await search.fill(String(count));
				await search.press("ArrowDown");
				await search.press("ArrowUp");
				await search.press("Enter");
			} else await page.getByRole("button", { name: new RegExp(`^r${count} ·`) }).click();
			await button("选择作品版本").click();
			await search.fill(`r${exact}`);
			assert.match(await options.first().innerText(), new RegExp(`^r${exact}\\s`));
			await search.press("Enter");
			await button("选择作品版本")
				.filter({ hasText: new RegExp(`^r${exact}$`) })
				.waitFor();
			await button("选择作品版本").click();
			const targetId = ids[target - 1];
			assert.ok(targetId);
			await search.fill(targetId.slice(0, 16));
			assert.equal(await options.count(), 1);
			await search.press("Enter");
			await button("选择作品版本")
				.filter({ hasText: new RegExp(`^r${target}$`) })
				.waitFor();
			await button("选择作品版本").click();
			await search.fill("不存在的版本");
			await page.getByText("没有匹配的版本", { exact: true }).waitFor();
			await search.fill("");
			assert.equal(await options.count(), count, "不能静默截断历史");
			assert.match(await options.first().innerText(), new RegExp(`^r${count}\\s`));
			await search.fill("r1");
			await search.press("Enter");
			await button("选择作品版本").filter({ hasText: /^r1$/ }).waitFor();
			await button("选择变更文件").click();
			await page.getByRole("combobox", { name: "搜索变更文件" }).fill("world/core.md");
			await page.getByRole("option", { name: /world\/core.md/ }).click();
			await button("选择作品版本").click();
			await search.fill(String(count));
			await search.press("Enter");
			await page.getByRole("heading", { name: "当前文件在这个版本没有变更" }).waitFor();
			assert.match(await button("选择变更文件").innerText(), /world\/core.md/);
			await page.reload();
			await button("选择作品版本")
				.filter({ hasText: new RegExp(`^r${count}$`) })
				.waitFor();
			assert.match(await button("选择变更文件").innerText(), /world\/core.md/);
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
			await page.waitForFunction(() => innerWidth === 960);
			await page.evaluate(
				() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
			);
			await button("选择作品版本").click();
			await search.fill(String(exact));
			assert.equal(
				await options.count(),
				Array.from({ length: count }, (_, index) => String(index + 1)).filter((value) =>
					value.startsWith(String(exact)),
				).length,
				"纯数字按版本号查找，不混入提交编号碰巧相同的片段",
			);
			const popup = page.locator("[data-version-picker]");
			await popup.evaluate((el) =>
				Promise.all(el.getAnimations().map((a: { finished: Promise<unknown> }) => a.finished.catch(() => {}))),
			);
			const box = await popup.boundingBox();
			assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 640);
			if (process.env.SUIMING_UI_CAPTURE) {
				await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
				await page.screenshot({ path: join(process.env.SUIMING_UI_CAPTURE, `version-${count}-narrow.png`) });
			}
			await search.press("Escape");
			await eventually(
				() => button("选择作品版本").evaluate((el) => el === el.ownerDocument.activeElement),
				"关闭后焦点回到版本按钮",
			);
			assert.deepEqual(errors, []);
		} catch (error) {
			console.error({ errors, url: page.url(), body: await page.locator("body").innerText() });
			await page.screenshot({ path: "/tmp/suiming-version-failure.png" });
			throw error;
		} finally {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
