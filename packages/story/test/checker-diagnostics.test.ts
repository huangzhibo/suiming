import assert from "node:assert/strict";
import test from "node:test";
import {
	bindDesignDocuments,
	buildStateTimeline,
	checkDesign,
	type DesignDocuments,
	evaluate,
	StoryParseError,
} from "../src/index.js";
import { twoBeatDesignDocuments } from "./fixture.js";

function beat(documents: DesignDocuments, index: number) {
	const item = documents.beats[index];
	assert.ok(item);
	return item;
}

test("一次绑定报出全部跨文档错误，而不是首错即停", () => {
	const documents = twoBeatDesignDocuments();
	// 1. Beat 引用不存在的人物
	beat(documents, 0).markdown = beat(documents, 0).markdown.replace(
		"character: [黄盖]",
		"character: [黄盖, 不存在的人]",
	);
	// 2. Beat 依赖指向更晚的 Beat
	beat(documents, 0).markdown = beat(documents, 0).markdown.replace(
		"  secret: [苦肉计]",
		"  secret: [苦肉计]\n  beat: [beat-0002]",
	);
	// 3. Contract 引用不存在的 Beat 作为 deadline
	const contract = documents.contracts[0];
	assert.ok(contract);
	contract.markdown = contract.markdown.replace("deadline: beat-0002", "deadline: beat-0099");
	// 4. Intent subjects 引用不存在的地点
	const intent = documents.intents[0];
	assert.ok(intent);
	intent.markdown = intent.markdown.replace("---\nstyle_refs", "---\nsubjects:\n  place: [无此地]\nstyle_refs");
	// 5. 硬状态引用不存在的地点
	beat(documents, 0).markdown = beat(documents, 0).markdown.replace(
		"黄盖.location: 赤壁",
		"黄盖.location: 不存在的地方",
	);

	let caught: unknown;
	try {
		bindDesignDocuments(documents);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof StoryParseError);
	const messages = caught.diagnostics.map((item) => item.message);
	assert.equal(caught.diagnostics.length, 5, messages.join("\n"));
	assert.ok(messages.some((message) => message.includes("character:不存在的人")));
	assert.ok(messages.some((message) => message.includes("只能依赖故事顺序里更早的 Beat")));
	assert.ok(messages.some((message) => message.includes("beat-0099")));
	assert.ok(messages.some((message) => message.includes("place:无此地")));
	assert.ok(messages.some((message) => message.includes("不存在的地方")));
	assert.ok(caught.diagnostics.every((item) => item.severity === "error"));
});

test("单个文档解析失败只跳过该文档，其余文档继续参与检查", () => {
	const documents = twoBeatDesignDocuments();
	documents.characters.push({
		id: "坏人物",
		path: "world/characters/坏人物.md",
		markdown: "---\nunknown_field: 1\n---\n",
	});
	beat(documents, 1).markdown = beat(documents, 1).markdown.replace("character: [黄盖]", "character: [黄盖, 坏人物]");
	let caught: unknown;
	try {
		bindDesignDocuments(documents);
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof StoryParseError);
	const paths = new Set(caught.diagnostics.map((item) => item.path));
	assert.ok(paths.has("world/characters/坏人物.md"));
	assert.ok(paths.has("outline/story/vol-0001/beat-0002.md"));
});

test("未被引用的 World 文档只是 warning，不阻塞绑定", () => {
	const documents = twoBeatDesignDocuments();
	documents.world.push({ id: "闲置设定", path: "world/闲置设定.md", body: "暂时没有 Beat 依赖的规则。" });
	const design = bindDesignDocuments(documents);
	assert.equal(design.warnings.length, 1);
	assert.equal(design.warnings[0]?.severity, "warning");
	const check = checkDesign(design);
	assert.equal(check.passed, true);
	assert.ok(check.warnings.some((item) => item.path === "world/闲置设定.md"));
});

test("硬状态重放累积全部失败并跳过失败批次", () => {
	const result = evaluate({
		profileVersion: "state-projection-p0@2",
		initial: [],
		authorizedBeatIds: ["beat-0001", "beat-0002", "beat-0003"],
		changes: [
			{
				storyBeatId: "beat-0001",
				assignments: [{ subject: "character:甲", property: "dead", value: true, scope: "world" }],
			},
			{
				storyBeatId: "beat-0002",
				assignments: [{ subject: "character:甲", property: "dead", value: false, scope: "world" }],
			},
			{
				storyBeatId: "beat-0003",
				assignments: [{ subject: "resource:钥匙", property: "consumed", value: false, scope: "world" }],
			},
		],
	});
	assert.equal(result.passed, false);
	assert.deepEqual(
		result.failures.map((failure) => failure.code),
		["dead_state_reversed", "terminal_resource_reused"],
	);
	assert.deepEqual(result.appliedStoryBeatIds, ["beat-0001"]);
	assert.equal(result.finalState.find((item) => item.subject === "character:甲")?.value, true);
});

test("Checker 把硬状态失败、未闭合 Contract 与未声明 secret 一次报全", () => {
	const documents = twoBeatDesignDocuments();
	// 硬状态冲突
	beat(documents, 1).markdown = beat(documents, 1).markdown.replace(
		"    火船.consumed: true\n",
		"    火船.consumed: true\n    火船.holder: 黄盖\n",
	);
	// 未声明的 secret 被揭示（拼写漂移）
	beat(documents, 1).markdown = beat(documents, 1).markdown.replace(
		"    secret:苦肉计.revealed: true\n  reader:",
		"    secret:苦肉计.revealed: true\n    secret:连环计.revealed: true\n  reader:",
	);
	// Contract 不再 resolve
	beat(documents, 1).markdown = beat(documents, 1).markdown.replace("contracts:\n  resolve: [诈降]\n", "");
	const check = checkDesign(bindDesignDocuments(documents));
	assert.equal(check.passed, false);
	const messages = check.diagnostics.map((item) => item.message);
	assert.equal(check.diagnostics.length, 3, messages.join("\n"));
	// 同一节里火船既烧尽又交给黄盖：诊断点名是哪件物品（2026-10-04 起硬状态诊断写中文）。
	assert.ok(messages.some((message) => message.includes("resource:火船") && message.includes("消耗或毁掉")));
	assert.ok(messages.some((message) => message.includes("secret:连环计")));
	assert.ok(messages.some((message) => message.includes("StoryContract 诈降")));
});

test("secret 的状态路径不带 secret: 前缀也按 secret 解析：revealed 只属于 secret，秘密又不对应文件", () => {
	// 2026-10-01 斗破真实运行：Agent 写了 changes.world.<id>.revealed，解析器去有文件的对象里找、报
	// missing secret identity，Agent 由此断定「本仓注册不了秘密」，把 7 条秘密降级成普通世界设定。
	const bare = twoBeatDesignDocuments();
	beat(bare, 1).markdown = beat(bare, 1).markdown.replaceAll("secret:苦肉计.revealed", "苦肉计.revealed");
	const passed = checkDesign(bindDesignDocuments(bare));
	assert.equal(passed.passed, true, passed.diagnostics.map((item) => item.message).join("\n"));

	const misspelt = twoBeatDesignDocuments();
	beat(misspelt, 1).markdown = beat(misspelt, 1).markdown.replace(
		"    secret:苦肉计.revealed: true\n  reader:",
		"    secret:苦肉计.revealed: true\n    连环计.revealed: true\n  reader:",
	);
	const failed = checkDesign(bindDesignDocuments(misspelt));
	assert.equal(failed.passed, false);
	const undeclared = failed.diagnostics.find((item) => item.message.includes("secret:连环计"));
	assert.ok(undeclared, failed.diagnostics.map((item) => item.message).join("\n"));
	assert.match(undeclared.hint ?? "", /refs\.secret/u);
	assert.ok(!failed.diagnostics.some((item) => item.message.includes("missing secret identity")));
});

test("refs 遗漏与已死人物再被引用是 warning", () => {
	const documents = twoBeatDesignDocuments();
	documents.characters.push({
		id: "蔡瑁",
		path: "world/characters/蔡瑁.md",
		markdown: "---\naliases: [德珪]\n---\n曹操的水军都督，中了反间计被斩。",
	});
	// beat-0001 让蔡瑁死亡并引用他；beat-0002 正文提到他的字德珪但 refs 未引用
	beat(documents, 0).markdown = beat(documents, 0)
		.markdown.replace("character: [黄盖]", "character: [黄盖, 蔡瑁]")
		.replace("    黄盖.location: 赤壁\n", "    黄盖.location: 赤壁\n    蔡瑁.dead: true\n");
	beat(documents, 1).markdown = beat(documents, 1)
		.markdown.replace("character: [黄盖]", "character: [黄盖, 蔡瑁]")
		.replace("约定之夜，黄盖的火船冲进曹营", "约定之夜，曹营里没了懂水战的德珪，黄盖的火船冲进曹营");
	const check = checkDesign(bindDesignDocuments(documents));
	assert.equal(check.passed, true);
	const messages = check.warnings.map((item) => item.message);
	assert.ok(
		messages.some((message) => message.includes("已在 beat-0001 死亡")),
		messages.join("\n"),
	);

	const omitted = twoBeatDesignDocuments();
	omitted.characters.push({
		id: "蔡瑁",
		path: "world/characters/蔡瑁.md",
		markdown: "---\naliases: [德珪]\n---\n曹操的水军都督，中了反间计被斩。",
	});
	beat(omitted, 1).markdown = beat(omitted, 1).markdown.replace(
		"约定之夜，黄盖的火船冲进曹营",
		"约定之夜，曹营里没了懂水战的德珪，黄盖的火船冲进曹营",
	);
	const omittedCheck = checkDesign(bindDesignDocuments(omitted));
	assert.ok(
		omittedCheck.warnings.some((item) => item.message.includes("提到了蔡瑁")),
		omittedCheck.warnings.map((item) => item.message).join("\n"),
	);
});

test("Contract subjects 未出现在 open / resolve Beat 的 refs 里是 warning", () => {
	const documents = twoBeatDesignDocuments();
	beat(documents, 0).markdown = beat(documents, 0).markdown.replace("  resource: [火船]\n", "");
	const check = checkDesign(bindDesignDocuments(documents));
	assert.equal(check.passed, true);
	assert.ok(check.warnings.some((item) => item.message.includes("却没有引用它的主体 resource:火船")));
});

test("人物或读者 scope 只承载 secret revealed", () => {
	const documents = twoBeatDesignDocuments();
	beat(documents, 1).markdown = beat(documents, 1).markdown.replace(
		"  reader:\n    secret:苦肉计.revealed: true\n",
		"  reader:\n    secret:苦肉计.revealed: true\n  character:\n    黄盖:\n      黄盖.dead: true\n",
	);
	assert.throws(
		() => bindDesignDocuments(documents),
		(error: unknown) =>
			error instanceof StoryParseError &&
			error.diagnostics.some((item) => item.message.includes("only carries secret revealed")),
	);
});

test("状态时间线按 Beat 给出前后快照，资源持有与位置互清", () => {
	const timeline = buildStateTimeline({
		profileVersion: "state-projection-p0@2",
		initial: [{ subject: "resource:钥匙", property: "holder", value: "character:甲", scope: "world" }],
		authorizedBeatIds: ["beat-0001", "beat-0002", "beat-0003"],
		changes: [
			{
				storyBeatId: "beat-0001",
				assignments: [{ subject: "resource:钥匙", property: "location", value: "place:井底", scope: "world" }],
			},
			{
				storyBeatId: "beat-0003",
				assignments: [{ subject: "resource:钥匙", property: "consumed", value: true, scope: "world" }],
			},
		],
	});
	const key = (property: string) => JSON.stringify(["world", "resource:钥匙", property]);
	assert.equal(timeline.stateBefore("beat-0001").get(key("holder"))?.value, "character:甲");
	assert.equal(timeline.stateAfter("beat-0001").get(key("holder"))?.value, "none");
	assert.equal(timeline.stateAfter("beat-0001").get(key("location"))?.value, "place:井底");
	assert.equal(timeline.stateBefore("beat-0003").get(key("location"))?.value, "place:井底");
	assert.equal(timeline.stateAfter("beat-0003").get(key("location"))?.value, "none");
	assert.equal(timeline.final.get(key("consumed"))?.value, true);
	assert.throws(() => timeline.stateAfter("beat-0099"));
});

test("空 StoryOutline 是新作品的合法起点：一个空卷、没有 Beat 的 Design 通过 Checker", () => {
	const documents = twoBeatDesignDocuments();
	documents.storyIndex = { schema_version: 2, volumes: [{ id: "vol-0001", title: "第一卷", beat_ids: [] }] };
	documents.beats = [];
	documents.contracts = [];
	const check = checkDesign(bindDesignDocuments(documents));
	assert.equal(check.passed, true, check.diagnostics.map((item) => item.message).join("\n"));
	assert.deepEqual(check.diagnostics, []);
	assert.deepEqual(check.state.failures, []);
});
