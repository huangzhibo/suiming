import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import type { Locator } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };
declare const innerWidth: number;
declare function requestAnimationFrame(callback: (time: number) => void): number;
// 短 fixture 全部在视口内；innerText 会把 contenteditable 的空行重复算入，逐行读取真实文档文本。
const editorText = (editor: Locator) =>
	editor.locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));
const focused = (locator: Locator) => locator.evaluate((element) => element === element.ownerDocument.activeElement);

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "suiming-external-files-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "黄盖望向江面。\n");
	await writeFile(join(root, "notes.md"), "# 辅助笔记\n\n保留原笔记。\n");
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(5000);
	const errors = collectPageErrors(page);
	await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	const snapshot = () => page.evaluate(() => window.suiming.invoke("workspace.show", {}));
	const initial = await snapshot();
	return {
		root,
		app,
		page,
		editor,
		errors,
		snapshot,
		initial,
		close: async () => {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

for (const target of ["world/characters/黄盖.md", "text/beat-0001.md", "notes.md"]) {
	test(`外部删除：${target} 的草稿、切页返回、重载和显式恢复`, { timeout: 60000 }, async () => {
		const { root, app, page, editor, errors, snapshot, initial, close } = await fixture();
		try {
			if (target === "notes.md") {
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
				await page.waitForFunction(() => innerWidth === 960);
			}
			if (target.startsWith("world/")) {
				await page.keyboard.press("Meta+t");
				await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("黄盖");
				await page.keyboard.press("Enter");
				await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
			} else if (target === "notes.md") {
				await page.keyboard.press("Meta+t");
				await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("notes.md");
				await page.keyboard.press("Enter");
			} else {
				await page.getByRole("radio", { name: "正文", exact: true }).click();
			}
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await eventually(() => focused(editor), "进入编辑聚焦");
			await page.keyboard.press("Meta+End");
			await page.keyboard.insertText("\n保留未保存的句子。");
			const draft = await editorText(editor);
			const tabId = await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id");
			const contentTop = (await page.locator(".cm-host").boundingBox())?.y;
			await rm(join(root, target));
			await page.getByRole("button", { name: "文件已移除", exact: true }).waitFor();
			assert.equal(await page.getByRole("dialog").count(), 0, "外部变化只标记状态，不弹层打断");
			assert.equal((await page.locator(".cm-host").boundingBox())?.y, contentTop, "文件状态不推移编辑内容");
			assert.equal(await editorText(editor), draft);
			assert.equal(await focused(editor), true, "外部变化不抢焦点");
			await page.keyboard.press("Meta+s");
			const recovery = page.getByRole("dialog", { name: "文件已移除", exact: true });
			await recovery.waitFor();
			assert.equal(await page.getByText("文件已被删除或移动", { exact: true }).count(), 0, "没有重复的横幅或卡片");
			const rect = await recovery.boundingBox();
			assert.ok(
				rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= (await page.evaluate(() => innerWidth)),
				"处理入口在窗口内",
			);
			await page.keyboard.press("Escape");
			await eventually(() => focused(editor), "关闭恢复入口返回原编辑器");
			await assert.rejects(readFile(join(root, target)), { code: "ENOENT" });
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).waitFor();
			await page.locator(`[data-tab-id="${tabId}"]`).locator("button").first().click();
			await eventually(() => focused(editor), "切页返回恢复编辑焦点");
			await page.keyboard.insertText("继续。");
			assert.equal(await editorText(editor), `${draft}继续。`, "光标恢复到原位置");
			await page.keyboard.press("Meta+z");
			assert.equal(await editorText(editor), draft, "切页后撤销仍可用");
			await page.keyboard.press("Meta+e");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await eventually(() => focused(editor), "缺失文档从阅读仍可回到草稿编辑");
			assert.equal(await editorText(editor), draft);
			await page.reload();
			await page.getByRole("button", { name: "文件已移除", exact: true }).waitFor();
			await eventually(() => focused(editor), "重载后恢复草稿编辑焦点");
			assert.equal(await editorText(editor), draft);
			await page.keyboard.press("Meta+w");
			const dialog = page.getByRole("dialog", { name: "保留未保存的修改？" });
			await dialog.waitFor();
			await dialog.getByRole("button", { name: "保存并继续", exact: true }).click();
			await dialog.getByRole("alert").waitFor();
			await page.keyboard.press("Escape");
			await eventually(() => focused(editor), "保存失败取消关闭回到草稿");
			await mkdir("/tmp/suiming-external-files-qa", { recursive: true });
			await page.screenshot({
				animations: "disabled",
				path: `/tmp/suiming-external-files-qa/${target.split("/").at(-1)}.png`,
			});
			await page.getByRole("button", { name: "文件已移除", exact: true }).click();
			await page.screenshot({
				animations: "disabled",
				path: `/tmp/suiming-external-files-qa/details-${target.split("/").at(-1)}.png`,
			});
			await page.getByRole("button", { name: "恢复到原路径", exact: true }).click();
			await eventually(
				async () =>
					(await readFile(join(root, target), "utf8").catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return null;
						throw error;
					})) === draft,
				"明确恢复草稿落盘",
			);
			await eventually(() => focused(editor), "恢复完成仍能继续输入");
			const after = await snapshot();
			assert.equal(after.revisionId, initial.revisionId, "保存只改变候选，不自动提交 Canon");
			assert.equal(after.revisions.length, initial.revisions.length);
			assert.deepEqual(errors, []);
		} finally {
			await close();
		}
	});
}

for (const [originalPath, renamedPath] of [
	["notes.md", "renamed.md"],
	["world/characters/黄盖.md", "world/characters/黄盖改名.md"],
] as const) {
	test(`外部重命名：${originalPath} 的新旧路径独立，外部恢复不抢对话焦点`, { timeout: 60000 }, async () => {
		const { root, page, editor, errors, snapshot, initial, close } = await fixture();
		try {
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(originalPath);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await eventually(() => focused(editor), "笔记编辑聚焦");
			await page.keyboard.press("Meta+End");
			await page.keyboard.insertText("\n旧路径未保存草稿。");
			const draft = await editorText(editor);
			const oldTab = await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id");
			const original = await readFile(join(root, originalPath), "utf8");
			await rename(join(root, originalPath), join(root, renamedPath));
			await page.getByRole("button", { name: "文件已移除", exact: true }).waitFor();
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(renamedPath);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			assert.equal(await editorText(editor), original, "新路径不能套用旧路径草稿");
			await page.locator(`[data-tab-id="${oldTab}"]`).locator("button").first().click();
			await eventually(() => focused(editor), "返回旧路径聚焦");
			assert.equal(await editorText(editor), draft);
			await page.reload();
			await page.getByRole("button", { name: "文件已移除", exact: true }).waitFor();
			await editor.waitFor();
			assert.equal(await editorText(editor), draft);
			await assert.rejects(readFile(join(root, originalPath)), { code: "ENOENT" });
			// 原路径被另一位写入者恢复时只更新冲突提示，不搬走草稿或抢走正在输入消息的焦点。
			const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
			await page.getByRole("button", { name: "文件已移除", exact: true }).click();
			await page.getByRole("dialog", { name: "文件已移除", exact: true }).waitFor();
			await composer.click();
			await composer.fill("尚未发送的消息");
			assert.equal(await focused(composer), true, "点击对话关闭详情，不被拉回编辑器");
			const external = `${original}\n外部新内容。`;
			await writeFile(join(root, originalPath), external);
			await page.getByRole("button", { name: "外部修改冲突", exact: true }).waitFor();
			assert.equal(await focused(composer), true);
			await page.keyboard.insertText("仍在这里。");
			assert.equal(await composer.inputValue(), "尚未发送的消息仍在这里。");
			assert.equal(await page.getByRole("button", { name: "恢复到原路径", exact: true }).count(), 0);
			await editor.click();
			await page.keyboard.press("Meta+s");
			await page.getByRole("dialog", { name: "外部修改冲突", exact: true }).waitFor();
			await page.keyboard.press("Escape");
			assert.equal(await readFile(join(root, originalPath), "utf8"), external);
			await page.getByRole("button", { name: "外部修改冲突", exact: true }).click();
			await page.getByRole("button", { name: "比较外部修改", exact: true }).click();
			await page.locator(".cm-merge-a .cm-content").filter({ hasText: "外部新内容" }).waitFor();
			await page.locator(".cm-merge-b .cm-content").filter({ hasText: "旧路径未保存草稿" }).waitFor();
			await page.locator(".cm-merge-b .cm-content").click();
			await page.keyboard.press("Meta+a");
			await page.keyboard.insertText(`${external}\n旧路径未保存草稿。`);
			await page.getByRole("button", { name: "外部修改冲突", exact: true }).click();
			await page.getByRole("button", { name: "以外部版本为合并基线", exact: true }).click();
			await page.getByText("外部版本已设为基线；编辑内容仍保留，请完成合并后保存。", { exact: true }).waitFor();
			await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
			await page.getByText("已保存", { exact: true }).waitFor();
			assert.equal(
				await readFile(join(root, originalPath), "utf8"),
				`${external}\n旧路径未保存草稿。`,
				"合并后保存",
			);
			assert.equal(await readFile(join(root, renamedPath), "utf8"), original);
			assert.equal((await snapshot()).revisionId, initial.revisionId);
			assert.deepEqual(errors, []);
		} finally {
			await close();
		}
	});
}

for (const target of ["world/characters/黄盖.md", "notes.md"]) {
	test(`外部删除无草稿：${target} 不留旧正文，恢复后可编辑`, { timeout: 60000 }, async () => {
		const { root, page, editor, errors, close } = await fixture();
		try {
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(target);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
			const path = join(root, target);
			const original = await readFile(path, "utf8");
			await rm(path);
			await page
				.getByText(target === "notes.md" ? "文件不存在：notes.md" : "这个文件已不在作品目录中", { exact: true })
				.waitFor();
			assert.equal(
				await page.getByText(target === "notes.md" ? "保留原笔记。" : "江东老将", { exact: false }).count(),
				0,
			);
			await page.reload();
			await page
				.getByText(target === "notes.md" ? "文件不存在：notes.md" : "这个文件已不在作品目录中", { exact: true })
				.waitFor();
			await writeFile(path, original);
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await eventually(() => focused(editor), "外部恢复后编辑入口可用");
			assert.equal(await editorText(editor), original);
			assert.deepEqual(errors, []);
		} finally {
			await close();
		}
	});
}

test("未创建的正文：首次草稿不误报外部删除，重载后可以正常保存", { timeout: 45000 }, async () => {
	const { root, page, editor, errors, close } = await fixture();
	try {
		await page.locator('.beat-row[data-page$="beat-0002.md"]').click();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await eventually(() => focused(editor), "首次正文可直接编辑");
		await page.keyboard.insertText("首次写下的正文。");
		await page.locator('.tab-btn[data-active="true"] [aria-label="未保存"]').waitFor();
		assert.equal(await page.getByText("文件已被删除或移动", { exact: true }).count(), 0);
		await page.reload();
		await eventually(() => focused(editor), "新正文草稿重载后恢复焦点");
		assert.equal(await editorText(editor), "首次写下的正文。");
		assert.equal(await page.getByText("文件已被删除或移动", { exact: true }).count(), 0);
		await page.keyboard.press("Meta+s");
		await page.getByText("已保存", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, "text/beat-0002.md"), "utf8"), "首次写下的正文。");
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("情节设计被移动：正文草稿不随页面对象消失，读编切换和重载仍保存到正文", { timeout: 45000 }, async () => {
	const { root, page, editor, errors, close } = await fixture();
	try {
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await eventually(() => focused(editor), "编辑正文");
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("仍属于正文的草稿。");
		const draft = await editorText(editor);
		const design = "outline/story/vol-0001/beat-0001.md";
		const original = await readFile(join(root, design), "utf8");
		await rm(join(root, design));
		await page.getByRole("radio", { name: "正文", exact: true }).waitFor({ state: "hidden" });
		await page.keyboard.press("Meta+e");
		await page.getByRole("heading", { name: "这个文件已不在作品目录中", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await eventually(() => focused(editor), "设计缺失时仍能回到正文草稿");
		assert.equal(await editorText(editor), draft);
		await page.reload();
		await eventually(() => focused(editor), "重载保留正文目标");
		assert.equal(await editorText(editor), draft);
		await page.keyboard.press("Meta+s");
		await page.getByText("已保存", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, "text/beat-0001.md"), "utf8"), draft);
		await assert.rejects(readFile(join(root, design)), { code: "ENOENT" });
		await writeFile(join(root, design), original);
		await page.getByRole("radio", { name: "正文", exact: true }).waitFor();
		assert.equal(await editorText(editor), draft);
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("文档外壳：正常编辑不增加工具行，窄窗操作与反馈不挤占内容", { timeout: 45000 }, async () => {
	const { app, page, editor, errors, close } = await fixture();
	try {
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await eventually(() => focused(editor), "进入编辑");
		const toolbar = page.getByRole("toolbar", { name: "文档工具", exact: true });
		const before = await page.locator(".cm-host").boundingBox();
		await page.keyboard.insertText("未保存的修改。");
		const save = page.getByRole("button", { name: "保存 ⌘S", exact: true });
		await save.waitFor();
		assert.equal(
			await toolbar.getByRole("button", { name: "保存 ⌘S", exact: true }).count(),
			1,
			"保存必须在既有工具栏中",
		);
		const after = await page.locator(".cm-host").boundingBox();
		assert.equal(after?.y, before?.y, "修改不推移编辑内容");
		assert.equal(await page.getByText("未保存", { exact: true }).count(), 0, "只通过标签标记未保存");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert.equal(await toolbar.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), true);
		await save.click();
		await page.getByText("已保存", { exact: true }).waitFor();
		await eventually(() => focused(editor), "按钮保存后继续编辑");
		assert.equal((await page.locator(".cm-host").boundingBox())?.y, before?.y, "保存反馈不挤占内容");
		await mkdir("/tmp/suiming-document-shell-qa", { recursive: true });
		await page.screenshot({ animations: "disabled", path: "/tmp/suiming-document-shell-qa/normal-narrow.png" });
		await page.keyboard.insertText("继续修改。");
		await page.getByRole("img", { name: "未保存", exact: true }).waitFor();
		assert.equal(await page.getByText("已保存", { exact: true }).count(), 0, "继续输入后不残留已保存反馈");
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("文件状态详情：外部冲突解除后收起，再次冲突不自动展开", { timeout: 45000 }, async () => {
	const { root, page, editor, errors, close } = await fixture();
	try {
		await page.keyboard.press("Meta+t");
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("notes.md");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await eventually(() => focused(editor), "开始编辑");
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("作者草稿。");
		const draft = await editorText(editor);
		const path = join(root, "notes.md");
		const original = await readFile(path, "utf8");
		await writeFile(path, `${original}外部修改。`);
		const trigger = page.getByRole("button", { name: "外部修改冲突", exact: true });
		await trigger.click();
		const details = page.getByRole("dialog", { name: "外部修改冲突", exact: true });
		await details.waitFor();
		await writeFile(path, original);
		await details.waitFor({ state: "hidden" });
		await trigger.waitFor({ state: "hidden" });
		await editor.click();
		await writeFile(path, `${original}另一次外部修改。`);
		await trigger.waitFor();
		assert.equal(await details.count(), 0, "新的后台冲突只显示状态入口");
		assert.equal(await focused(editor), true);
		assert.equal(await editorText(editor), draft);
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});
