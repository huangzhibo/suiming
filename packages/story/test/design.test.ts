import assert from "node:assert/strict";
import test from "node:test";
import {
	bindDesignDocuments,
	checkDesign,
	parseCharacterMarkdown,
	parseCreativeIntent,
	projectCharacterFamily,
	StoryParseError,
	verifyStoryText,
} from "../src/index.js";
import { twoBeatDesignDocuments } from "./fixture.js";

test("自然语言 Design 绑定为可检查的统一模型", () => {
	const design = bindDesignDocuments(twoBeatDesignDocuments());
	assert.equal(design.story.beats[1]?.refs.includes("beat:beat-0001"), true);
	assert.equal(design.stateProjection.initial[0]?.subject, "resource:火船");
	assert.equal(design.stateProjection.initial[0]?.value, "character:黄盖");
	assert.equal(design.contracts[0]?.id, "诈降");

	const full = checkDesign(design);
	assert.equal(full.passed, true);
	assert.equal(full.contracts.results[0]?.status, "resolved");
	assert.equal(
		full.state.finalState.some(
			(item) => item.subject === "resource:火船" && item.property === "consumed" && item.value === true,
		),
		true,
	);
});

test("index 声明 open_ended：全书未完待续时，已建立未回应的 book_end Contract 是进行中；Beat 期限与从未建立的照样报", () => {
	const docs = twoBeatDesignDocuments();
	// 全书期限、已在 beat-0001 建立、到最后一个 Beat 仍未回应：连载写到一半的常态
	docs.contracts[0] = {
		...(docs.contracts[0] as (typeof docs.contracts)[number]),
		markdown:
			"---\nsubjects:\n  character: [黄盖]\ndeadline: book_end\n---\n黄盖的投降是假的，约定之夜火船必须烧尽。",
	};
	docs.beats[1] = {
		...(docs.beats[1] as (typeof docs.beats)[number]),
		markdown: (docs.beats[1]?.markdown ?? "").replace("contracts:\n  resolve: [诈降]\n", ""),
	};
	const finished = checkDesign(bindDesignDocuments(docs));
	assert.equal(finished.passed, false, "没声明就是全书写完了，期待没兑现");
	assert.equal(finished.contracts.results[0]?.status, "outstanding");

	docs.storyIndex = { ...(docs.storyIndex as object), open_ended: true };
	const ongoing = checkDesign(bindDesignDocuments(docs));
	assert.equal(ongoing.passed, true);
	assert.deepEqual(ongoing.contracts.openContractIds, ["诈降"]);
	assert.deepEqual(ongoing.contracts.results, []);

	// 未完待续不豁免显式的 Beat 期限，也不豁免从来没建立过的期待
	docs.contracts.push(
		{ id: "限期", path: "outline/contracts/限期.md", markdown: "---\ndeadline: beat-0002\n---\n第二节前必须回应。" },
		{ id: "空头", path: "outline/contracts/空头.md", markdown: "---\ndeadline: book_end\n---\n从未建立。" },
	);
	docs.beats[0] = {
		...(docs.beats[0] as (typeof docs.beats)[number]),
		markdown: (docs.beats[0]?.markdown ?? "").replace("open: [诈降]", "open: [诈降, 限期]"),
	};
	const strict = checkDesign(bindDesignDocuments(docs));
	assert.equal(strict.passed, false);
	assert.deepEqual(
		strict.contracts.results.map((result) => [result.contractId, result.status]),
		[
			["限期", "outstanding"],
			["空头", "outstanding"],
		],
	);
});

test("Contract 没兑现的诊断说清是哪一种：从未建立、到期未兑现、全书结束未兑现、过期才兑现，提示写出要加的那一行", () => {
	const docs = twoBeatDesignDocuments();
	const contractDiagnostics = () =>
		(checkDesign(bindDesignDocuments(docs)).diagnostics ?? []).map((item) => [item.path, item.message, item.hint]);
	const beat = (index: number) => docs.beats[index] as (typeof docs.beats)[number];
	// beat-0002 不再兑现：期限就是 beat-0002
	docs.beats[1] = { ...beat(1), markdown: beat(1).markdown.replace("contracts:\n  resolve: [诈降]\n", "") };
	docs.contracts.push(
		{ id: "空头", path: "outline/contracts/空头.md", markdown: "---\ndeadline: book_end\n---\n从未建立。" },
		{ id: "悬案", path: "outline/contracts/悬案.md", markdown: "---\ndeadline: book_end\n---\n一直没回应。" },
		{ id: "迟到", path: "outline/contracts/迟到.md", markdown: "---\ndeadline: beat-0001\n---\n第一节就该回应。" },
	);
	docs.beats[0] = {
		...beat(0),
		markdown: beat(0).markdown.replace("open: [诈降]", "open: [诈降, 悬案, 迟到]"),
	};
	docs.beats[1] = {
		...beat(1),
		markdown: beat(1).markdown.replace("---\n", "---\ncontracts:\n  resolve: [迟到]\n"),
	};
	assert.deepEqual(contractDiagnostics(), [
		[
			"outline/contracts/诈降.md",
			"StoryContract 诈降：到期限 beat-0002 还没有兑现",
			"在 beat-0002 或更早的 StoryBeat 里写 contracts.resolve: [诈降]",
		],
		[
			"outline/contracts/空头.md",
			"StoryContract 空头：没有任何 StoryBeat 建立这个期待",
			"在建立这个期待的 StoryBeat 里写 contracts.open: [空头]",
		],
		[
			"outline/contracts/悬案.md",
			"StoryContract 悬案：到全书结束还没有兑现",
			"在兑现它的 StoryBeat 里写 contracts.resolve: [悬案]",
		],
		[
			"outline/contracts/迟到.md",
			"StoryContract 迟到：期限是 beat-0001，到 beat-0002 才兑现",
			"把 contracts.resolve: [迟到] 移到 beat-0001 或更早的 StoryBeat，或者改期限",
		],
	]);
});

test("Checker 报告硬状态冲突的原始 StoryBeat 位置", () => {
	const documents = twoBeatDesignDocuments();
	const second = documents.beats[1];
	assert.ok(second);
	second.markdown = second.markdown.replace(
		"    火船.consumed: true\n",
		"    火船.consumed: true\n    火船.holder: 黄盖\n",
	);
	const result = checkDesign(bindDesignDocuments(documents));
	assert.equal(result.passed, false);
	assert.equal(result.state.failures[0]?.code, "conflicting_assignment");
	assert.equal(result.diagnostics?.[0]?.path, "outline/story/vol-0001/beat-0002.md");
	assert.equal(result.diagnostics?.[0]?.pointer, "/frontmatter/changes/world/火船.holder");
});

test("StoryBeat 依赖必须指向更早且真实存在的 Beat", () => {
	const documents = twoBeatDesignDocuments();
	const first = documents.beats[0];
	assert.ok(first);
	first.markdown = first.markdown.replace("  secret: [苦肉计]", "  secret: [苦肉计]\n  beat: [beat-0002]");
	assert.throws(
		() => bindDesignDocuments(documents),
		(error: unknown) => error instanceof StoryParseError && error.code === "story_dependency_not_prior",
	);
});

test("Character 只保存人物入口与最小家族正向边，反向关系由视图派生", () => {
	const father = parseCharacterMarkdown("以结束乱世为志，也逐渐把秩序等同于自己。", "曹操");
	const son = parseCharacterMarkdown(
		"---\nfamily:\n  - kind: parent\n    character: 曹操\n    role: 生父\n---\n敬爱父亲，却会在危局中作出自己的选择。",
		"曹昂",
	);
	const family = projectCharacterFamily([father, son], "曹操");
	assert.deepEqual(family.characterIds, ["曹操", "曹昂"]);
	assert.equal(family.links[0]?.subjectCharacterId, "曹昂");
	assert.equal(family.links[0]?.relatedCharacterId, "曹操");
});

test("Intent 的解释与必须原样保留的片段共存于一个 Markdown artifact", () => {
	const intent = parseCreativeIntent(
		"---\napplies_to: text\n---\n用反话表现人物表面推辞、实际享受。\n\n~~~exact\n哎呀，你们真是害苦了朕啊\n~~~",
		"公众记忆",
	);
	assert.equal(intent.appliesTo, "text");
	assert.deepEqual(intent.exactFragments, ["哎呀，你们真是害苦了朕啊"]);
});

test("StoryText 完整性与 exact Intent 由纯验证器检查", () => {
	const documents = twoBeatDesignDocuments();
	documents.intents.push({
		id: "保留原句",
		path: "intent/保留原句.md",
		markdown: "---\napplies_to: text\n---\n结尾必须保留确认过的短句。\n\n~~~exact\n此事到此为止\n~~~",
	});
	const design = bindDesignDocuments(documents);
	const incomplete = verifyStoryText(design.story, design.intents, [
		{ storyBeatId: "beat-0001", text: "黄盖读完火船。" },
	]);
	assert.deepEqual(
		incomplete.failures.map((failure) => failure.code),
		["missing_text"],
	);

	const missingExact = verifyStoryText(design.story, design.intents, [
		{ storyBeatId: "beat-0001", text: "黄盖读完火船。" },
		{ storyBeatId: "beat-0002", text: "他烧掉火船，转身离开。" },
	]);
	assert.equal(missingExact.failures[0]?.code, "exact_intent_missing");

	const complete = verifyStoryText(design.story, design.intents, [
		{ storyBeatId: "beat-0001", text: "黄盖读完火船。" },
		{ storyBeatId: "beat-0002", text: "他烧掉火船：此事到此为止。" },
	]);
	assert.equal(complete.passed, true);
});
