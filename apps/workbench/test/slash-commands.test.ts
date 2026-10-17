import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_COMMANDS,
	commandMenu,
	expandCustom,
	goalIntent,
	parseSlash,
	slashCommands,
} from "../src/slash-commands.js";

// ADR-0038 决定三：`/` 命令只是入口。这里守的是解析与展开的确定性部分，菜单的键盘操作在桌面 E2E 里。
test("菜单只在还在输命令名时出现，按前缀筛；自定义命令接在内置后面，不能顶掉同名内置", () => {
	const commands = slashCommands([
		{ name: "写下一节", text: "按大纲写下一节正文：$ARGUMENTS" },
		{ name: "goal", text: "冒名的" },
	]);
	assert.equal(commands.filter((command) => command.name === "goal").length, 1);
	assert.equal(commands.at(-1)?.name, "写下一节");
	assert.deepEqual(
		commandMenu(commands, "/").map((command) => command.name),
		commands.map((command) => command.name),
	);
	assert.deepEqual(
		commandMenu(commands, "/写").map((command) => command.name),
		["写下一节"],
	);
	assert.deepEqual(commandMenu(commands, "/goal 写完第二卷"), [], "开始写参数就收起菜单");
	assert.deepEqual(commandMenu(commands, "随便说一句"), []);
	assert.deepEqual(commandMenu(commands, " /goal"), [], "不在行首不算命令");
	assert.ok(
		BUILTIN_COMMANDS.every((command) => !/\s/u.test(command.name)),
		"命令名里不能有空白",
	);
});

test("解析命令与参数；/goal 的参数分动作与目标原文；自定义命令按 $ARGUMENTS 展开", () => {
	assert.deepEqual(parseSlash("/goal 写完第二卷\n每节审稿"), { name: "goal", argument: "写完第二卷\n每节审稿" });
	assert.deepEqual(parseSlash("/讨论"), { name: "讨论", argument: "" });
	assert.equal(parseSlash("不是命令"), undefined);
	assert.deepEqual(goalIntent("pause"), { action: "pause" });
	assert.deepEqual(goalIntent("写完第二卷"), { objective: "写完第二卷" });
	assert.equal(goalIntent(""), undefined);
	assert.equal(expandCustom("按大纲写下一节正文：$ARGUMENTS", "beat-0003"), "按大纲写下一节正文：beat-0003");
	assert.equal(expandCustom("审一下这一卷", "第二卷"), "审一下这一卷\n\n第二卷", "没有占位符时参数接在后面");
	assert.equal(expandCustom("审一下这一卷", ""), "审一下这一卷");
});
