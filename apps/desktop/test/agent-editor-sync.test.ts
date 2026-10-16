import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, openGate } from "./launch.js";

declare const window: { suiming: DesktopBridge };
type CallbackFixture = typeof globalThis & {
	workspaceTestCallbacks: { command: string; before?: boolean; release?: () => void };
};

async function fixture(flag: string) {
	const directory = await mkdtemp(join(tmpdir(), "suiming-save-send-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	for (const name of ["甲", "乙", "丙"]) await writeFile(join(root, `${name}.md`), `${name}的原文`);
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test", flag] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	app.on("window", (next) => next.on("pageerror", (error) => errors.push(error.message)));
	await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	const tabs = new Map<string, string>();
	for (const name of ["甲", "乙", "丙"]) {
		await page.keyboard.press("Meta+t");
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(`${name}.md`);
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill(`${name}的草稿`);
		tabs.set(name, (await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id")) ?? "");
	}
	const activate = (name: string) => page.locator(`[data-tab-id="${tabs.get(name)}"]`).click();
	const hold = (command: string, before = false) =>
		app.evaluate(
			(_, value) => {
				Object.assign((globalThis as CallbackFixture).workspaceTestCallbacks, value);
			},
			{ command, before },
		);
	const held = () =>
		eventually(
			() => app.evaluate(() => !!(globalThis as CallbackFixture).workspaceTestCallbacks.release),
			"回执已被截住",
		);
	const release = () => app.evaluate(() => (globalThis as CallbackFixture).workspaceTestCallbacks.release?.());
	const sessions = () => page.evaluate(() => window.suiming.invoke("session.list", {}));
	const disk = (name: string) => readFile(join(root, `${name}.md`), "utf8");
	const close = async () => {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	};
	return { app, page, root, input, editor, errors, activate, hold, held, release, sessions, disk, close };
}

async function gateReached(app: Awaited<ReturnType<typeof fixture>>["app"], name: string) {
	await eventually(
		() =>
			app.evaluate(
				(_, name) =>
					(globalThis as typeof globalThis & { testGateReached(name: string): boolean }).testGateReached(name),
				name,
			),
		name,
	);
}

test("只输入发送：按目标读写自动保存；迟到保存回执和旧 Agent 写入不丢继续输入", { timeout: 90000 }, async () => {
	const f = await fixture("--editor-sync-test");
	const { page, app, input, editor } = f;
	try {
		const before = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		await input.fill("处理甲乙，丙先不动");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await gateReached(app, "editor-start");
		assert.equal(await f.disk("甲"), "甲的原文");
		await f.activate("甲");
		await f.hold("workspace.file.save");
		await openGate(app, "editor-start");
		await f.held();
		assert.equal(await f.disk("甲"), "甲的草稿");
		await editor.fill("甲的草稿，继续输入");
		await input.fill("下一条要求还没发送");
		await f.release();
		await gateReached(app, "editor-after-read");
		assert.equal(await editor.innerText(), "甲的草稿，继续输入");
		assert.equal(await f.disk("乙"), "乙的原文");
		await f.activate("丙");
		await editor.focus();
		await openGate(app, "editor-after-read");
		await page.getByText("按需同步已完成，尚未提交版本。", { exact: true }).waitFor();
		assert.equal(await f.disk("甲"), "甲的草稿，继续输入，Agent 合并");
		assert.equal(await f.disk("乙"), "乙的草稿");
		assert.equal(await f.disk("丙"), "丙的原文");
		assert.equal(await editor.innerText(), "丙的草稿");
		assert.equal(await editor.evaluate((e) => e === e.ownerDocument.activeElement), true);
		assert.equal(await input.inputValue(), "下一条要求还没发送");
		assert.equal(
			(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId,
			before.revisionId,
		);
		await page.reload();
		await editor.waitFor();
		assert.equal(await editor.innerText(), "丙的草稿");
		assert.equal(await input.inputValue(), "下一条要求还没发送");
		assert.equal(await page.getByRole("button", { name: "保存范围", exact: true }).count(), 0);
		assert.deepEqual(f.errors, []);
	} finally {
		await f.close();
	}
});

test("自动保存第二文件失败：Agent 自己读取并合并；两次继续编辑都受版本保护", { timeout: 90000 }, async () => {
	const f = await fixture("--editor-conflict-test");
	const { app, page, input, editor } = f;
	try {
		await input.fill("保留作者与外部两边的修改，合并甲乙");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await gateReached(app, "editor-second");
		assert.equal(await f.disk("甲"), "甲的草稿");
		await writeFile(join(f.root, "乙.md"), "乙的外部改动");
		await openGate(app, "editor-second");
		await gateReached(app, "editor-merge");
		await f.activate("乙");
		await editor.fill("乙的草稿，继续输入");
		await openGate(app, "editor-merge");
		await gateReached(app, "editor-merge-again");
		assert.equal(await f.disk("乙"), "乙的外部改动", "旧合并结果没有覆盖两边");
		await f.hold("workspace.file.save");
		await openGate(app, "editor-merge-again");
		await f.held();
		await editor.fill("乙的草稿，继续输入，又写了一句");
		await f.release();
		await page.getByText("已合并作者草稿和外部内容，尚未提交版本。", { exact: true }).waitFor();
		assert.equal(await f.disk("乙"), "乙的外部改动，乙的草稿，继续输入");
		assert.equal(await editor.innerText(), "乙的草稿，继续输入，又写了一句");
		assert.equal(await f.disk("丙"), "丙的原文");
		await page.reload();
		await editor.waitFor();
		assert.equal(await editor.innerText(), "乙的草稿，继续输入，又写了一句");
		await page.keyboard.press("Meta+s");
		await page.getByRole("dialog").filter({ hasText: "外部" }).waitFor();
		assert.equal(
			await f.disk("乙"),
			"乙的外部改动，乙的草稿，继续输入",
			"迟到合并回执没有把新草稿错误设为可覆盖磁盘",
		);
		assert.deepEqual(f.errors, []);
	} finally {
		await f.close();
	}
});

for (const mode of ["reload", "close"] as const)
	test(`自动保存生命周期：${mode} 后 Agent 继续，不需要手动保存或重启对话`, { timeout: 90000 }, async () => {
		const f = await fixture("--editor-lifecycle-test");
		try {
			await f.input.fill("读取甲的最新内容");
			await f.page.getByRole("button", { name: "发送", exact: true }).click();
			await gateReached(f.app, "editor-start");
			if (mode === "reload") {
				await f.page.reload();
				await f.input.waitFor();
			} else {
				await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
				await eventually(
					() => f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0),
					"原窗口关闭",
				);
			}
			await openGate(f.app, "editor-start");
			await eventually(async () => (await f.disk("甲")) === "甲的草稿", "后台按需保存完成");
			const page = await f.app.firstWindow();
			await page.getByText("编辑器重接后已读取作者草稿。", { exact: true }).waitFor();
			assert.equal(await f.disk("乙"), "乙的原文");
			assert.equal(await f.disk("丙"), "丙的原文");
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

test("删除恢复也由 Agent 完成：先检查缺失与草稿，再明确写回原路径", { timeout: 60000 }, async () => {
	const f = await fixture("--editor-missing-test");
	try {
		await rm(join(f.root, "甲.md"));
		await f.input.fill("甲被误删了，请把编辑器草稿恢复到原路径，不提交版本");
		await f.page.getByRole("button", { name: "发送", exact: true }).click();
		await f.page.getByText("已按要求恢复甲的草稿，尚未提交版本。", { exact: true }).waitFor();
		assert.equal(await f.disk("甲"), "甲的草稿");
		assert.equal(await f.disk("乙"), "乙的原文");
		assert.equal(await f.editor.innerText(), "丙的草稿");
		assert.deepEqual(f.errors, []);
	} finally {
		await f.close();
	}
});
