import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bodyCharCount } from "../src/artifact/code-points.js";
import { inspectStoryDesignCandidate } from "../src/artifact/story-design-validator.js";
import { compileDesignContext, designCapacity } from "../src/harness/design-context.js";
import { DESIGN_METHOD } from "../src/harness/writing-methods.js";
import {
	candidateFromOpenStoryFiles,
	compileHostContext,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

// 2026-10-19 补回旧 suim-design 的方法（docs/validation/2026-10-19-old-skills-audit）：设计方法随 design_context 交付，
// 容量按这部作品已有的正文算。斗破续写里篇幅意图一万字配 1,200 字的 Design，写手只好铺陈。

const encoder = new TextEncoder();

function withTexts(texts: Record<string, string>) {
	const files = [
		...sampleWorkFiles(),
		...Object.entries(texts).map(([path, text]) => ({
			path,
			mediaType: "text/markdown; charset=utf-8",
			bytes: encoder.encode(text),
		})),
	];
	return candidateFromOpenStoryFiles(files, "design-context-test");
}

test("设计依据带设计方法、设计容量与全书末尾的 Design；还没有正文时说估不出来", () => {
	const context = compileDesignContext(withTexts({}));
	assert.ok(context.startsWith(DESIGN_METHOD), "方法在最前面");
	assert.match(context, /还没有正文，按比例估不出来/u);
	assert.match(context, /## 全书末尾的 Design（续写从这里往后接）/u);
	assert.match(
		context,
		/### beat-0002（outline\/story\/vol-0001\/beat-0002\.md；第 2 \/ 2 节，没有正文；Design \d+ 字）/u,
	);
});

test("设计容量按已有正文算正文与 Design 的字数比，并给出按篇幅估 Design 的算法", () => {
	// beat-0001 的正文是 Design 的四倍：比值的中位数就是 4.0
	const first = inspectStoryDesignCandidate(withTexts({})).design.story.beats[0];
	assert.ok(first);
	const design = bodyCharCount(first.text);
	const candidate = withTexts({ "text/beat-0001.md": `# 苦肉计\n\n${"字".repeat(design * 4)}\n` });
	const capacity = designCapacity(candidate);
	assert.match(capacity, /最近 1 节有正文/u);
	assert.match(capacity, new RegExp(`Design 中位 ${design} 字`, "u"));
	assert.match(capacity, /正文约是 Design 的 4\.0 倍/u);
	assert.match(capacity, /一节要写 L 字正文，Design 约需 L ÷ 4\.0 字/u);
	// 给了 Beat 就取它前后的 Design，并标出哪节已有正文
	const around = compileDesignContext(candidate, "beat-0002");
	assert.match(around, /## beat-0002 前后的 Design/u);
	// 覆盖这一节的意图原文跟着来：改之前就在眼前（2026-10-19 验证时，Agent 没读意图就把抽自原作的 Design 改反了）
	assert.match(around, /## 覆盖 beat-0002 的意图（Design）\n\n### intent\/[^\n]+（范围 /u);
	assert.match(around, /### beat-0001（[^）]*已有正文/u);
	assert.throws(
		() => compileDesignContext(candidate, "beat-0099"),
		(error: unknown) => (error as { code?: string }).code === "story_beat_not_found",
	);
});

test("host 的 context compile design 带同一份设计方法与设计容量", async () => {
	const checkoutPath = await mkdtemp(join(tmpdir(), "suiming-design-context-"));
	await materializeOpenStoryDirectorySnapshot(checkoutPath, sampleWorkFiles());
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "design-context" });
		const compiled = await compileHostContext(project, "design");
		assert.ok(compiled.systemPrompt.includes(DESIGN_METHOD), "与 design_context 同一份方法");
		assert.match(compiled.text, /^## 设计容量/u);
		// 带时点的人物视图交给模拟人物的子 agent，只要阅读契约，不带设计方法
		const view = await compileHostContext(project, "design:character:黄盖:at:beat-0002");
		assert.ok(!view.systemPrompt.includes(DESIGN_METHOD));
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
});
