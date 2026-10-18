import assert from "node:assert/strict";
import test from "node:test";
import {
	commandDetail,
	commandMenu,
	findCommand,
	goalIntent,
	parseSlash,
	SLASH_COMMANDS,
} from "../src/slash-commands.js";

// ADR-0039：`/` 命令管这段对话怎么跑：目标、讨论、模型。这里守的是解析与筛选的确定性部分，菜单的键盘操作在桌面 E2E 里。
const names = (input: string) => commandMenu(input).map((command) => command.name);

test("菜单只有 /目标、/讨论 与 /模型，只在还在输命令名时出现；按中文名或英文别名的前缀筛", () => {
	assert.deepEqual(names("/"), ["目标", "讨论", "模型"]);
	assert.deepEqual(names("/目"), ["目标"]);
	assert.deepEqual(names("/g"), ["目标"], "不开输入法也能打出 /目标");
	assert.deepEqual(names("/PL"), ["讨论"]);
	assert.deepEqual(names("/mo"), ["模型"]);
	assert.deepEqual(names("/新对话"), [], "离开这段对话的动作走按钮，不配命令");
	assert.deepEqual(names("/提交"), [], "改作品的动作走按钮，不配命令");
	assert.deepEqual(names("/目标 写完第二卷"), [], "开始写参数就收起菜单");
	assert.deepEqual(names("随便说一句"), []);
	assert.deepEqual(names(" /目标"), [], "不在行首不算命令");
	for (const command of SLASH_COMMANDS)
		assert.ok(
			[command.name, ...command.aliases].every((name) => !/\s/u.test(name)),
			"命令名里不能有空白",
		);
});

test("解析命令与参数；按名字或别名找命令；/目标 的参数分动作与目标原文", () => {
	assert.deepEqual(parseSlash("/目标 写完第二卷\n每节审稿"), { name: "目标", argument: "写完第二卷\n每节审稿" });
	assert.deepEqual(parseSlash("/讨论"), { name: "讨论", argument: "" });
	assert.equal(parseSlash("不是命令"), undefined);
	assert.equal(findCommand("goal")?.kind, "goal");
	assert.equal(findCommand("讨论")?.kind, "discuss");
	assert.equal(findCommand("Model")?.kind, "model");
	assert.equal(findCommand("新对话"), undefined);
	assert.deepEqual(goalIntent("暂停"), { action: "pause" });
	assert.deepEqual(goalIntent("Resume"), { action: "resume" });
	assert.deepEqual(goalIntent("清除"), { action: "clear" });
	assert.deepEqual(goalIntent("写完第二卷"), { objective: "写完第二卷" });
	assert.deepEqual(goalIntent("constructor"), { objective: "constructor" }, "不把对象原型上的名字当动作");
	assert.equal(goalIntent(""), undefined);
});

test("讨论那一行按当前状态写明选了会怎样，其余命令用固定说明", () => {
	const discuss = findCommand("讨论");
	const goal = findCommand("目标");
	assert.ok(discuss && goal);
	assert.match(commandDetail(discuss, false), /^打开讨论/);
	assert.match(commandDetail(discuss, true), /^关上讨论/);
	assert.equal(commandDetail(goal, true), goal.detail);
});
