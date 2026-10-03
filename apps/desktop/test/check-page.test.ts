import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

test("检查结果页：按文件列出诊断，绑定失败也列全，作品改动后提示过期", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-check-desktop-"));
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
	const check = page.getByRole("button", { name: "检查", exact: true });
	const details = page.getByRole("button", { name: "查看详情", exact: true });
	const beat1 = join(root, "outline/story/vol-0001/beat-0001.md");
	const beat2 = join(root, "outline/story/vol-0001/beat-0002.md");
	const original1 = await readFile(beat1, "utf8");
	const original2 = await readFile(beat2, "utf8");
	try {
		await page.getByRole("button", { name: "发送", exact: true }).waitFor();
		// 干净的作品：一句话结果，没有要看的详情。
		await check.click();
		await page.getByText("检查通过。", { exact: true }).waitFor();
		assert.equal(await details.count(), 0);

		// 设计层未通过：Contract 到期没有兑现。提示点名、给详情入口，详情页按文件归类。
		await writeFile(beat2, original2.replace("contracts:\n  resolve: [诈降]\n", ""));
		await check.click();
		await page.getByText(/^检查未通过：设计；1 处错误。/).waitFor();
		await details.click();
		await page.getByRole("heading", { name: "检查结果 · 1 处错误" }).waitFor();
		const contract = page.locator("[data-check-path='outline/contracts/诈降.md']");
		await contract.getByRole("listitem").filter({ hasText: "诈降" }).waitFor();
		assert.doesNotMatch(
			(await contract.getByRole("listitem").textContent()) ?? "",
			/outline\/contracts\//,
			"按文件归类后，每行不再重复路径",
		);
		await page.getByText("还有 2 个情节没有正文，不阻塞提交", { exact: true }).waitFor();
		await mkdir("/tmp/suiming-desktop-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/check-design.png" });
		// 文件组的标题打开那份文件，后退回到同一份结果。
		await contract.getByRole("button", { name: "诈降", exact: true }).click();
		await page
			.getByText(/公开真相必须让黄盖/)
			.first()
			.waitFor();
		await page.getByRole("button", { name: "后退", exact: true }).click();
		await page.getByRole("heading", { name: "检查结果 · 1 处错误" }).waitFor();

		// 改了作品：结果标为可能过期。绑定期失败（引用不存在的人物）也是检查的答案，诊断带字段位置。
		await writeFile(beat1, original1.replace("character: [黄盖]", "character: [黄盖, 不存在]"));
		await page.getByText("作品在这次检查之后有改动，结果可能已过期。", { exact: true }).waitFor();
		await page.getByRole("button", { name: "重新检查", exact: true }).click();
		await page.getByText("无法检查", { exact: true }).waitFor();
		assert.equal(await page.getByText(/^检查未通过/).count(), 0, "页面重新检查后，上一次的提示收掉");
		const unbound = page.locator("[data-check-path='outline/story/vol-0001/beat-0001.md']");
		await unbound.getByText("/frontmatter/refs/character/1", { exact: true }).waitFor();
		await unbound.getByText(/找不到引用 character:不存在/).waitFor();
		assert.equal(
			await page.getByText("作品在这次检查之后有改动，结果可能已过期。", { exact: true }).count(),
			0,
			"重新检查后不再提示过期",
		);
		await page.screenshot({ path: "/tmp/suiming-desktop-qa/check-unbound.png" });
		// 在结果页上从导航轨检查：页面自己更新，不再另给一句话（一屏说两遍）。
		await check.click();
		await page.getByRole("button", { name: "正在检查…" }).waitFor({ state: "detached" });
		assert.equal(await page.getByText(/检查没有跑完/).count(), 0, "结果页上不再另给一句话提示");

		// 修好后从导航轨检查：打开着的结果页跟着更新。
		await writeFile(beat1, original1);
		await writeFile(beat2, original2);
		await page.getByText("作品在这次检查之后有改动，结果可能已过期。", { exact: true }).waitFor();
		await check.click();
		await page.getByRole("heading", { name: "检查结果", exact: true }).waitFor();
		await page.getByText("没有诊断。", { exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
