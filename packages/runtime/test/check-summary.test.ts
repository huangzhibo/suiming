import assert from "node:assert/strict";
import test from "node:test";
import { checkSummary } from "../src/index.js";

type Checked = Parameters<typeof checkSummary>[0];

function checked(failures: { storyBeatId: string; code: string; message: string }[]): Checked {
	return {
		diff: { entries: [] },
		inspection: {
			check: { passed: true, state: { passed: true }, diagnostics: [], warnings: [] },
			storyText: { passed: failures.length === 0, failures },
			sources: [],
		},
	} as unknown as Checked;
}

test("missing_text 不阻塞提交，其它正文失败才阻塞", () => {
	// 既有约定：missing_text 只表示全书还没写完。把 passed 定成「三项全过」会让一部写到一半的
	// 长篇永远报未通过——eval-022 有 63 个 missing_text，那是正常状态。
	const half = checkSummary(checked([{ storyBeatId: "beat-0069", code: "missing_text", message: "missing" }]));
	assert.equal(half.passed, true);
	assert.equal(half.storyTextPassed, false, "storyTextPassed 仍如实说全书没写完");

	const broken = checkSummary(checked([{ storyBeatId: "beat-0001", code: "empty_text", message: "empty" }]));
	assert.equal(broken.passed, false);
});

test("diagnostics 汇总设计与 Source 的错误和警告：message 是拼好的整句，位置与 detail 另给一份供界面按文件归类", () => {
	const summary = checkSummary({
		diff: { entries: [] },
		inspection: {
			check: {
				passed: false,
				state: { passed: true },
				diagnostics: [{ path: "outline/contracts/真相的代价.md", message: "到期未兑现", severity: "error" }],
				warnings: [
					{
						path: "outline/story/vol-0001/beat-0001.md",
						pointer: "/frontmatter/refs",
						message: "提到了李牧但未引用",
						severity: "warning",
					},
				],
			},
			storyText: { passed: true, failures: [] },
			sources: [
				{
					sourceId: "原作",
					check: {
						diagnostics: [
							{
								path: "source/原作/source.yaml",
								line: 3,
								column: 5,
								message: "Source 自己的问题",
								hint: "补上引用",
							},
						],
						warnings: [],
					},
				},
				{
					sourceId: "第二份",
					check: { diagnostics: [], warnings: [{ message: "没有位置的提醒", severity: "warning" }] },
				},
				{ sourceId: "未抽取" },
			],
		},
	} as unknown as Checked);
	assert.equal(summary.passed, false);
	assert.deepEqual(summary.diagnostics, [
		{
			severity: "error",
			path: "outline/contracts/真相的代价.md",
			detail: "到期未兑现",
			message: "outline/contracts/真相的代价.md：到期未兑现",
		},
		{
			severity: "warning",
			path: "outline/story/vol-0001/beat-0001.md",
			pointer: "/frontmatter/refs",
			detail: "提到了李牧但未引用",
			message: "outline/story/vol-0001/beat-0001.md#/frontmatter/refs：警告：提到了李牧但未引用",
		},
		{
			severity: "error",
			path: "source/原作/source.yaml",
			line: 3,
			column: 5,
			detail: "Source 自己的问题；提示：补上引用",
			message: "source/原作/source.yaml:3:5：Source 自己的问题；提示：补上引用",
		},
		{ severity: "warning", detail: "没有位置的提醒", message: "警告：没有位置的提醒" },
	]);
});

test("passed 与 Agent 的 check 同一个判定：Source 抽取的错误也算要修的问题，警告不算", () => {
	const withSource = (diagnostics: unknown[], warnings: unknown[]) =>
		checkSummary({
			diff: { entries: [] },
			inspection: {
				check: { passed: true, state: { passed: true }, diagnostics: [], warnings: [] },
				storyText: { passed: true, failures: [] },
				sources: [{ sourceId: "原作", check: { diagnostics, warnings } }],
			},
		} as unknown as Checked);
	assert.equal(withSource([], [{ message: "提到但未引用", severity: "warning" }]).passed, true);
	const broken = withSource([{ path: "source/原作/outline/story/index.yaml", message: "Source 自己的问题" }], []);
	assert.equal(broken.designPassed, true, "Target 的设计本身没问题");
	assert.equal(broken.passed, false, "2026-10-02 之前这里是 true，诊断里却列着一条错误");
});
