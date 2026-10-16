import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkspace, saveWorkspace, workspaceLayout } from "../src/workspace-layout.js";

test("草稿读取故障不能伪装为空工作区，损坏记录不被默认值覆盖，恢复后仍能读回", (t) => {
	const values = new Map<string, string>();
	let unavailable = false;
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem(key: string) {
				if (unavailable) throw new Error("read unavailable");
				return values.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				values.set(key, value);
			},
		},
	});
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});
	assert.deepEqual(loadWorkspace("new").documents, {});
	const original = workspaceLayout();
	original.documents = { "text/test.md": { content: "未保存正文", baseContent: "原文", baseSHA: "sha" } };
	original.composerDrafts = {
		new: { goal: "未发送消息", attachments: [], pending: { id: "same-command", text: "待确认消息" } },
	};
	saveWorkspace("work", original);
	const raw = values.get("suiming.work.view");
	unavailable = true;
	assert.throws(() => saveWorkspace("work", loadWorkspace("work")), /草稿/);
	unavailable = false;
	assert.equal(values.get("suiming.work.view"), raw);
	assert.deepEqual(loadWorkspace("work"), original);
	for (const corrupt of [
		"{broken",
		"null",
		"[]",
		JSON.stringify({ documents: { a: { content: "留住我" } } }),
		JSON.stringify({ composerDrafts: { new: { goal: "留住我", attachments: [null] } } }),
	]) {
		values.set("suiming.work.view", corrupt);
		assert.throws(() => saveWorkspace("work", loadWorkspace("work")), /草稿/);
		assert.equal(values.get("suiming.work.view"), corrupt);
	}
});
