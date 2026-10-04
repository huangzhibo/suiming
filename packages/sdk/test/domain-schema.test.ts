import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as domainSchema from "../src/domain-schema.js";
import { LOCAL_COMMANDS, SUIM_CLI_COMMAND_DATA, SuimCliSessionListDataSchema } from "../src/index.js";

test("session.list 在两套命令目录下是同一个 schema", () => {
	// 过去 CLI 与桌面 IPC 各定义一份同名命令：CLI 缺 currentRevisionId / model / reason，
	// IPC 缺 createdAt / updatedAt / result，并把 usage 改写成派生的 unconfirmedCalls。
	// 同名不同形状不会在运行期相遇，但读 SDK 的人拿到哪一份取决于他 import 了哪个文件。
	const cli = SuimCliSessionListDataSchema.properties.sessions.items;
	const ipc = LOCAL_COMMANDS["session.list"].output.properties.sessions.items;
	assert.deepEqual(Object.keys(cli.properties).sort(), Object.keys(ipc.properties).sort());
	assert.deepEqual(cli, ipc);
});

test("任务摘要在两套命令目录下是同一个 schema", () => {
	// 2026-10-02 之前 IPC 的 session.tasks 与 CLI 的 session show 各投影一份：字段名一边 label 一边 kind，
	// 结果一边 resultObjectId 一边 result{kind,id}，IPC 还缺 model 与 failure。
	const cli = SUIM_CLI_COMMAND_DATA["session.show"].properties.tasks.items;
	const ipc = LOCAL_COMMANDS["session.tasks"].output.items;
	assert.deepEqual(cli, ipc);
	assert.ok("kind" in ipc.properties && !("label" in ipc.properties));
});

test("审稿摘要在两套命令目录下是同一份，桌面只在上面多带 paths 与 findings", () => {
	// 2026-10-02 之前 workspace.reviews 自己投影一份：layer / verdict 只是 Type.String()，没有 scope 与计数；
	// 「读 head 里的审稿并算时效」的循环在 IPC、CLI list、CLI show 各写了一遍。
	const cli = SUIM_CLI_COMMAND_DATA["review.list"].properties.reviews.items;
	const ipc = LOCAL_COMMANDS["workspace.reviews"].output.items;
	const ipcProperties: Record<string, unknown> = ipc.properties;
	for (const [key, schema] of Object.entries(cli.properties)) assert.deepEqual(ipcProperties[key], schema, key);
	assert.deepEqual(
		Object.keys(ipc.properties)
			.filter((key) => !(key in cli.properties))
			.sort(),
		["findings", "paths"],
	);
});

test("领域对象的 schema 只定义一次", () => {
	// 判据：除 domain-schema.ts 外，packages/sdk/src 不得再出现这些领域对象的 Type.Object /
	// Type.Union 定义。加新传输时把它们复制一份，是三套目录分叉的起点。
	const dir = fileURLToPath(new URL("../src/", import.meta.url));
	const owned = [
		"sessionStatusSchema",
		"sessionKindSchema",
		"executionFailureSchema",
		"modelUsageSchema",
		"sessionSummarySchema",
		"modelChoiceSchema",
		"thinkingLevelSchema",
		"revisionSummarySchema",
		"commitResultSchema",
		"taskSummarySchema",
		"modelBindingSchema",
		"modelProfileIdSchema",
		"reviewSummarySchema",
		"reviewScopeSchema",
		"reviewVerdictSchema",
		"reviewLayerSchema",
		"resultReferenceSchema",
		"modelThinkingSchema",
		"checkDiagnosticSchema",
		"checkSummarySchema",
		"rollbackResultSchema",
	];
	// 字面量联合还要按内容查：run-event.ts 曾内联重写 idle / running / paused，按名字匹配抓不到。
	const literalUnions = owned.flatMap((name) => {
		const schema = (domainSchema as Record<string, { anyOf?: { const?: unknown }[] }>)[name];
		const literals = schema?.anyOf?.map((member) => member.const);
		if (literals === undefined || !literals.every((value) => typeof value === "string")) return [];
		const body = literals.map((value) => `Type\\.Literal\\("${value}"\\)`).join(",\\s*");
		return [{ name, pattern: new RegExp(`Type\\.Union\\(\\[\\s*${body},?\\s*\\]`, "u") }];
	});
	assert.ok(literalUnions.some((union) => union.name === "sessionStatusSchema"));
	const offenders: string[] = [];
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && file !== "domain-schema.ts")) {
		const source = readFileSync(`${dir}${name}`, "utf8");
		for (const schema of owned) {
			if (new RegExp(`(const|let)\\s+${schema}\\s*=`, "u").test(source)) offenders.push(`${name}:${schema}`);
		}
		for (const union of literalUnions)
			if (union.pattern.test(source)) offenders.push(`${name}:${union.name}（内联）`);
	}
	assert.deepEqual(offenders, []);
});

test("commit 只说建没建新版本，rollback 还要说恢复到哪、改了什么", () => {
	// 桌面此前两条都只回 { revisionId, created }，CLI 的 rollback 则带 targetRevisionId /
	// previousHeadRevisionId / changes。恢复历史版本是作者要能复核的动作，桌面不该少拿。
	assert.deepEqual(Object.keys(LOCAL_COMMANDS["project.commit"].output.properties).sort(), ["created", "revision"]);
	assert.deepEqual(Object.keys(LOCAL_COMMANDS["project.rollback"].output.properties).sort(), [
		"changes",
		"created",
		"previousHeadRevisionId",
		"revision",
		"targetRevisionId",
	]);
});

test("同名命令在 CLI 与桌面下是同一份 payload", () => {
	// 信封归传输（CLI 有 suim.cli.v1 外壳，IPC 是裸的），payload 不能有两种形状。
	// check 与 commit 曾经在 CLI 侧多包一层 diff——那是 status 与 diff 还没分开时的便利。
	for (const name of ["project.check", "project.commit", "project.rollback"] as const) {
		assert.deepEqual(SUIM_CLI_COMMAND_DATA[name], LOCAL_COMMANDS[name].output, `${name} 的 payload 不同`);
	}
});

test("project.diff 两侧不同是有理由的，不是分叉", () => {
	// 写明理由免得下次被当成漏网：CLI 给 artifact 身份、sha 与被忽略的文件，要先构建完整候选（读 git），
	// host 拿它决定提交什么；桌面只要「哪些文件变了」，比较页选中哪个再用 workspace.file.read 读两侧。
	// 桌面这条在比较页开着时每次刷新都跑，所以只比按版本缓存的 blob id。2026-10-02 之前它一次带上全部
	// 改动文件的正文（理由是渲染层读不到文件），而界面只渲染其中一个；按路径读之后那个理由不成立了。
	const cli = SUIM_CLI_COMMAND_DATA["project.diff"];
	const ipc = LOCAL_COMMANDS["project.diff"].output;
	assert.notDeepEqual(cli, ipc);
	assert.ok("entries" in cli.properties, "CLI 侧是 artifact 级条目");
	assert.equal(ipc.type, "array");
	assert.deepEqual(Object.keys(ipc.items.properties).sort(), ["kind", "path"], "IPC 侧只有文件清单，不带正文");
	assert.deepEqual(LOCAL_COMMANDS["revision.diff"].output, ipc, "两条 diff 同一种清单");
});

test("session.send / resume / interrupt 两侧不同也是有理由的：CLI 同步跑完一个 turn，桌面是异步回执", () => {
	// 写明理由免得被当成漏网的分叉（2026-10-02 协议面审查列过它）：CLI 的 suim session send 在进程里把这个 turn
	// 跑完再回整轮结果（session 状态、head、最后一条回复），host 拿到就能接着干；桌面的同名命令只把话放进 inbox
	// 就返回，回复从事件流里 attach。interrupt 同理：CLI 只能放弃 paused 的核对，桌面能停本进程里跑着的 turn。
	for (const name of ["session.send", "session.resume", "session.interrupt"] as const)
		assert.notDeepEqual(SUIM_CLI_COMMAND_DATA[name], LOCAL_COMMANDS[name].output, name);
	assert.ok("reply" in SUIM_CLI_COMMAND_DATA["session.send"].properties, "CLI 回整轮结果");
	assert.ok("sessionId" in LOCAL_COMMANDS["session.send"].output.properties, "桌面回回执");
});
