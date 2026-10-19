import assert from "node:assert/strict";
import test from "node:test";
import { reviewerSystemPrompt } from "../src/harness/review-context.js";

// 设计审稿清单 2026-10-19 从旧仓 suim-review 补回（docs/validation/2026-10-19-old-skills-audit）：斗破续写的设计审稿给了 pass，
// 放过了 20 处日常账目、只有原作一半的推进，篇幅意图一万字配 1,200 字的 Design 也没人指出。
test("设计审稿有清单：推进、容量、意图不靠宣言、不改作者定下的事实；host 版指向随 Skill 安装的 story-language/", () => {
	const engine = reviewerSystemPrompt("design");
	assert.match(engine, /推进：每节推进哪条目标线/u);
	assert.match(engine, /训练、赶路、起居与资源账目/u);
	assert.match(engine, /容量：篇幅意图要的分量 Design 撑不撑得起/u);
	assert.match(engine, /而不是靠情节设计里的宣言/u);
	assert.match(engine, /意图写明照原作或作者定下的事实有没有被改动/u);
	assert.match(engine, /story_guide/u);
	const host = reviewerSystemPrompt("design", "host");
	assert.match(host, /story-language\//u);
	assert.doesNotMatch(host, /story_guide|read \/ search \/ frame|submit_review/u);
});

// 审正文时带上范围前一节与后一节的开头，只查衔接（2026-10-19 补回）：斗破留出两次共 7 次 permission_denied，
// 都是 Reviewer 想看范围外的邻节；整卷拆块审时块间接缝原来没人审。
test("正文审稿带上范围前一节与后一节的开头，可读但不计入审稿主体", async () => {
	const { compileReviewContext } = await import("../src/harness/review-context.js");
	const { candidateFromOpenStoryFiles } = await import("../src/index.js");
	const { sampleWorkFiles } = await import("./sample-work.js");
	const encoder = new TextEncoder();
	const files = [
		...sampleWorkFiles(),
		...["beat-0001", "beat-0002"].map((id) => ({
			path: `text/${id}.md`,
			mediaType: "text/markdown; charset=utf-8",
			bytes: encoder.encode(`# ${id}\n\n${id} 的正文。\n`),
		})),
	];
	const candidate = candidateFromOpenStoryFiles(files, "review-neighbors");
	const second = compileReviewContext({
		candidate,
		layer: "text",
		scope: { kind: "selection", storyBeatIds: ["beat-0002"] },
	});
	assert.match(
		second.prompt,
		/# 范围前一节的正文（只查衔接，不在审查范围内）\n\n## text\/beat-0001\.md\n\n# beat-0001\n\nbeat-0001 的正文。/u,
	);
	assert.ok(second.readable?.("text/beat-0001.md"), "邻节可读");
	assert.deepEqual(second.subject, { kind: "beats", storyBeatIds: ["beat-0002"] }, "邻节不进审稿主体");
	const first = compileReviewContext({
		candidate,
		layer: "text",
		scope: { kind: "selection", storyBeatIds: ["beat-0001"] },
	});
	assert.match(first.prompt, /# 范围后一节的开头（只查衔接，不在审查范围内）\n\n## text\/beat-0002\.md/u);
	assert.doesNotMatch(first.prompt, /范围前一节/u);
	const book = compileReviewContext({ candidate, layer: "text" });
	assert.doesNotMatch(book.prompt, /范围前一节|范围后一节/u, "全书审稿没有邻节");
	assert.match(reviewerSystemPrompt("text"), /邻节只给你查衔接/u);
});

// 抽取方法从旧仓 suim-source 补回三条（2026-10-19）：人物基底的时间边界、相邻节的状态接续、笔记 span 只写实际读完的范围。
test("抽取方法写明人物基底只放进入故事前的事实、相邻节状态接得上、笔记 span 只写读完的范围", async () => {
	const { SOURCE_EXTRACTION_METHOD, SOURCE_SEGMENT_METHOD, SOURCE_COMPLETION_METHOD } = await import(
		"../src/harness/writing-methods.js"
	);
	assert.match(SOURCE_EXTRACTION_METHOD, /只放进入故事前已经成立的身份、经历、关系与能力/u);
	assert.match(SOURCE_EXTRACTION_METHOD, /逐个人物核对基底有没有混进后来的经历/u);
	assert.match(SOURCE_EXTRACTION_METHOD, /原作在幕后发生的变化（突破、伤愈、得失）也写进 Beat/u);
	assert.match(SOURCE_SEGMENT_METHOD, /span 只写实际读完的范围/u);
	assert.match(SOURCE_COMPLETION_METHOD, /补原作在幕后发生、这段里接不上的变化/u);
});
