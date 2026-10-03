import assert from "node:assert/strict";
import test from "node:test";
import { paneLayout } from "../src/pane-layout.js";
import { DEFAULT_VIEW } from "../src/view-state.js";

test("默认三栏优先保证正文与对话空间，中等窗口压缩后仍保留完整布局", () => {
	const wide = paneLayout(1460, DEFAULT_VIEW, "right");
	assert.equal(wide.leftWidth, 244);
	assert.equal(wide.rightWidth, 384);
	assert.equal(1460 - 44 - wide.leftWidth - wide.rightWidth, 788);
	for (const [width, left, right, main] of [
		[1280, 244, 384, 608],
		[1160, 244, 272, 600],
		[1104, 200, 260, 600],
	] as const) {
		const layout = paneLayout(width, DEFAULT_VIEW, "right");
		assert.ok(layout.showLeft && layout.showRight);
		assert.equal(layout.leftWidth, left);
		assert.equal(layout.rightWidth, right);
		assert.equal(width - 44 - layout.leftWidth - layout.rightWidth, main);
	}
	assert.equal(paneLayout(1103, DEFAULT_VIEW, "right").showLeft, false);
	assert.deepEqual(paneLayout(1460, DEFAULT_VIEW, "right"), wide);
});

test("窗口适配保留宽度偏好，窄窗口优先主动打开的一侧并保护正文宽度", () => {
	const view = { ...DEFAULT_VIEW, leftWidth: 360, rightWidth: 400 };
	const wide = paneLayout(1460, view, "right");
	assert.equal(wide.leftWidth, 360);
	assert.equal(wide.rightWidth, 400);
	assert.ok(wide.showLeft && wide.showRight);
	for (const priority of ["left", "right"] as const) {
		const narrow = paneLayout(960, view, priority);
		assert.equal(narrow.showLeft, priority === "left");
		assert.equal(narrow.showRight, priority === "right");
		assert.equal(priority === "left" ? narrow.leftWidth : narrow.rightWidth, 316);
	}
	assert.deepEqual(paneLayout(1460, view, "right"), wide);
	assert.equal(paneLayout(960, { ...view, right: false }, "right").showLeft, true);
	assert.equal(paneLayout(960, { ...view, sideOpen: false }, "left").showRight, true);
});

test("拖拽上限保留另一栏与 600px 正文；Agent 展开不被普通正文约束", () => {
	const layout = paneLayout(1280, DEFAULT_VIEW, "right");
	const adjusted = paneLayout(1280, { ...DEFAULT_VIEW, rightWidth: layout.rightMax }, "right");
	assert.ok(adjusted.showLeft && adjusted.showRight);
	assert.equal(1280 - 44 - adjusted.leftWidth - adjusted.rightWidth, 600);
	const expanded = paneLayout(960, { ...DEFAULT_VIEW, expanded: true }, "right");
	assert.ok(expanded.showLeft && expanded.showRight && expanded.rightExpanded);
	assert.equal(expanded.leftMax, 480);
});
