import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewFile, type ReviewFile, renderReviewFile, SuimError } from "../src/index.js";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function textReview(): ReviewFile {
	return {
		layer: "text",
		scope: { kind: "beats", storyBeatIds: ["beat-0001"] },
		revision,
		subjects: new Map([["text/beat-0001.md", digest]]),
		draft: {
			verdict: "revise",
			summary: "取得火船的过程没有阻力。",
			findings: [
				{
					severity: "minor",
					anchor: { kind: "artifact", path: "text/beat-0001.md" },
					issue: "读者感受不到火船是唯一筹码。",
					evidence: "黄盖走入赤壁，在木匣中找到火船。",
					repairLayer: "text",
					suggestion: "写出手指遇到封蜡时的停顿。",
				},
			],
			uncovered: [],
			uncertainties: ["旧友是否知情"],
		},
	};
}

test("审稿文件是普通 Markdown：frontmatter 记层、范围、版本与 finding，正文是 summary；渲染与解析互逆", () => {
	const rendered = renderReviewFile(textReview());
	assert.match(
		rendered,
		/^---\nlayer: text\nscope:\n {2}- beat-0001\nrevision: a{40}\nsubjects:\n {2}text\/beat-0001\.md: sha256:b{64}\nverdict: revise\n/u,
	);
	assert.match(rendered, /repair_layer: text/u, "wire 字段用 snake_case，和其它 frontmatter 一致");
	const parsed = parseReviewFile(rendered, "review/text-1.md");
	assert.deepEqual(parsed, textReview());

	const sourceReview: ReviewFile = {
		layer: "source",
		scope: { kind: "source", sourceId: "访谈" },
		revision,
		subjects: new Map([["source/访谈/material.txt", digest]]),
		draft: { verdict: "pass", summary: "extraction 忠实。", findings: [], uncovered: [], uncertainties: [] },
	};
	assert.deepEqual(parseReviewFile(renderReviewFile(sourceReview), "review/source-1.md"), sourceReview);
	const bookReview: ReviewFile = { ...sourceReview, layer: "design", scope: { kind: "book" } };
	assert.match(renderReviewFile(bookReview), /\nscope: book\n/u);
	assert.deepEqual(parseReviewFile(renderReviewFile(bookReview), "review/design-1.md"), bookReview);
});

test("范围必须配得上层：source 审稿只能审一个 Source，design 审稿只能审全书；verdict 与 finding 仍按 ReviewDraft 规则", () => {
	const code = (error: unknown) => (error instanceof SuimError ? error.code : undefined);
	assert.throws(
		() => parseReviewFile(renderReviewFile({ ...textReview(), layer: "source" }), "review/x.md"),
		(error) => code(error) === "invalid_review_file",
	);
	assert.throws(
		() =>
			parseReviewFile(
				renderReviewFile({
					...textReview(),
					layer: "design",
					scope: { kind: "beats", storyBeatIds: ["beat-0001"] },
				}),
				"review/x.md",
			),
		(error) => code(error) === "invalid_review_file",
	);
	assert.throws(
		() =>
			parseReviewFile(
				`---\nlayer: text\nscope: book\nrevision: ${revision}\nsubjects: {}\nverdict: pass\nfindings: []\n---\n`,
				"review/x.md",
			),
		(error) => code(error) === "invalid_review_file",
		"没有 summary 正文",
	);
	assert.throws(
		() =>
			parseReviewFile(
				`---\nlayer: text\nscope: book\nrevision: ${revision}\nverdict: pass\nfindings: []\n---\n没有 subjects。\n`,
				"review/x.md",
			),
		(error) => code(error) === "invalid_review_file",
		"没有 subjects：时效无从判起，不是可选字段",
	);
	assert.throws(
		() =>
			parseReviewFile(
				`---\nlayer: text\nscope: book\nrevision: ${revision}\nsubjects:\n  text/beat-0001.md: deadbeef\nverdict: pass\nfindings: []\n---\n摘要格式不对。\n`,
				"review/x.md",
			),
		(error) => code(error) === "invalid_review_file",
		"subjects 的值必须是 sha256:<64 hex>",
	);
	assert.throws(
		() =>
			parseReviewFile(
				`---\nlayer: text\nscope: book\nrevision: ${revision}\nsubjects: {}\nverdict: pass\nfindings:\n  - severity: major\n    anchor:\n      kind: artifact\n      path: text/beat-0001.md\n    issue: 有问题\n    evidence: 原文\n    repair_layer: text\n---\npass 却带 finding。\n`,
				"review/x.md",
			),
		(error) => code(error) === "invalid_review_draft",
	);
	assert.throws(
		() => parseReviewFile("---\nlayer: text\n---\n缺字段\n", "review/x.md"),
		(error) => code(error) === "invalid_review_file",
	);
});
