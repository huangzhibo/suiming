import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	type AssistantMessage,
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	type CloudProjectStore,
	HOST_ADAPTER_ROOTS,
	LocalProjectLock,
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	NOOP_TELEMETRY,
	type OpenPackageFile,
	readOpenStoryDirectory,
} from "@suiming/runtime";
import { parse } from "smol-toml";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { InMemoryCloudProjectStore } from "../../../packages/runtime/test/in-memory-cloud.js";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { HOST_IDS, installHost } from "../src/host-install.js";
import {
	runSuimCli,
	SUIM_CLI_EXIT,
	SuimCliCloudCheckoutDataSchema,
	SuimCliCloudStatusDataSchema,
	SuimCliCloudSyncDataSchema,
	SuimCliContextCompileDataSchema,
	SuimCliDesignImpactDataSchema,
	SuimCliDiffDataSchema,
	SuimCliErrorSchema,
	SuimCliEventSchema,
	type SuimCliIo,
	SuimCliProjectStatusDataSchema,
	SuimCliRankDataSchema,
	SuimCliResponseSchema,
	SuimCliReviewRecordDataSchema,
	SuimCliReviewSchemaDataSchema,
	SuimCliRollbackDataSchema,
	SuimCliSessionEventsDataSchema,
	SuimCliSessionListDataSchema,
	SuimCliSessionShowDataSchema,
	SuimCliSessionTurnDataSchema,
	SuimCliSourceIngestDataSchema,
	SuimCliSuccessSchema,
	SuimCliTextCheckDataSchema,
} from "../src/index.js";

interface CliHarness {
	io: SuimCliIo;
	stdout: string[];
	stderr: string[];
	interrupt(): void;
}

interface CloudHarness {
	store: CloudProjectStore;
	endpoint: string;
	actorId: string;
}

const encoder = new TextEncoder();

// 测试不读开发者本机的 ~/.suiming：没传 gateway 的命令走默认解析时，只会看到这两个不存在的文件。
// 2026-10-03 在干净的 HOME 里模拟 CI 时查出，「另一个 CLI 往进行中的 session 补一句」靠本机配置才通过。
const NO_USER_CONFIG = join(tmpdir(), `suiming-cli-test-no-config-${process.pid}`);
process.env.SUIMING_CONFIG_PATH = join(NO_USER_CONFIG, "config.toml");
process.env.SUIMING_AUTH_PATH = join(NO_USER_CONFIG, "auth.json");

function extractedSourceFiles(sourceId: string): OpenPackageFile[] {
	const root = `source/${sourceId}`;
	const text = (path: string, value: string, mediaType = "text/markdown; charset=utf-8"): OpenPackageFile => ({
		path,
		mediaType,
		bytes: encoder.encode(value),
	});
	return [
		text(
			`${root}/source.yaml`,
			`schema_version: 1\nname: ${sourceId}.txt\nencoding: utf-8\n`,
			"application/yaml; charset=utf-8",
		),
		text(`${root}/original.bin`, "黄盖备下火船，准备诈降。", "application/octet-stream"),
		text(`${root}/material.txt`, "黄盖备下火船，准备诈降。\n", "text/plain; charset=utf-8"),
		text(
			`${root}/outline/story/index.yaml`,
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 来源\n    beat_ids: [beat-0001]\n",
			"application/yaml; charset=utf-8",
		),
		text(
			`${root}/outline/story/vol-0001/beat-0001.md`,
			"---\nrefs:\n  character: [黄盖]\ncontracts:\n  open: [火船去向]\n---\n黄盖备下火船，材料没有交代它最终去了哪里。\n",
		),
		text(`${root}/world/characters/黄盖.md`, "上阵前先算清退路。\n"),
		text(
			`${root}/outline/contracts/火船去向.md`,
			"---\nsubjects:\n  character: [黄盖]\ndeadline: book_end\n---\n材料已经建立火船去向的期待，但当前边界尚未回答。\n",
		),
	];
}

function harness(cwd: string, models?: ModelGateway, cloud?: CloudHarness): CliHarness {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const interruptHandlers = new Set<() => void>();
	return {
		stdout,
		stderr,
		interrupt: () => {
			for (const handler of interruptHandlers) handler();
		},
		io: {
			cwd: () => cwd,
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
			onInterrupt: (handler) => {
				interruptHandlers.add(handler);
				return () => interruptHandlers.delete(handler);
			},
			...(models === undefined ? {} : { resolveModelGateway: async () => models }),
			...(cloud === undefined
				? {}
				: {
						cloudDefaults: () => ({ endpoint: cloud.endpoint, actorId: cloud.actorId }),
						resolveCloudProjectStore: async () => cloud.store,
					}),
		},
	};
}

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-"));
	await materializeOpenStoryDirectorySnapshot(root, [...sampleWorkFiles(), ...extractedSourceFiles("原作")]);
	return root;
}

function response(output: readonly string[]): Record<string, unknown> {
	assert.equal(output.length, 1);
	return JSON.parse(output[0] as string) as Record<string, unknown>;
}

async function jsonCommand(cwd: string, args: readonly string[], models?: ModelGateway, cloud?: CloudHarness) {
	const cli = harness(cwd, models, cloud);
	const exitCode = await runSuimCli(["--json", ...args], cli.io);
	return { cli, exitCode, value: response(cli.stdout) };
}

function designRunGateway(
	content = "---\nstyle_refs: [style_contemporary_restraint]\n---\n主角不能靠巧合取胜，揭示必须带来不可恢复且当场可见的代价。\n",
): ModelGateway {
	const providerId = "suiming-cli-faux";
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "reviewer-model" }],
	});
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "intent/计谋的代价.md", content })),
		fauxAssistantMessage(fauxToolCall("review", { layer: "design" })),
		fauxAssistantMessage(
			fauxToolCall("submit_review", {
				verdict: "pass",
				summary: "目标已经形成明确 Design 约束。",
				findings: [],
				uncovered: [],
				uncertainties: [],
			}),
		),
		fauxAssistantMessage(fauxToolCall("commit", { summary: "保存设计与审查" })),
		fauxAssistantMessage("让诈降的代价当场可见"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "reviewer-model" },
		},
	});
}

function sourceReadGateway(): ModelGateway {
	const providerId = "suiming-cli-source-reader-faux";
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "reviewer-model" }, { id: "source-reader-model" }],
	});
	const total = [..."访谈记录：黄盖先核对火船。\n"].length;
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("read_source", { sourceId: "访谈", start: 0, end: total })),
		fauxAssistantMessage(fauxToolCall("source_coverage", { sourceId: "访谈" })),
		(context: Context) => {
			const last = context.messages.at(-1);
			const part = Array.isArray(last?.content) ? last.content.find((item) => item.type === "text") : undefined;
			const { materialSha256 } = JSON.parse(part?.type === "text" ? part.text : "{}") as { materialSha256: string };
			return fauxAssistantMessage(
				fauxToolCall("write", {
					path: "source/访谈/notes/1.md",
					content: `---\nspan: [0, ${total}]\nmaterial_sha256: ${materialSha256}\n---\nCLI 全文交接\n`,
				}),
			);
		},
		fauxAssistantMessage(fauxToolCall("commit", { summary: "保存笔记" })),
		fauxAssistantMessage("阅读完成"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "reviewer-model" },
			"source-reader": { provider: providerId, model: "source-reader-model" },
		},
	});
}

function sourceExtractGateway(): ModelGateway {
	const providerId = "suiming-cli-source-extractor-faux";
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "reviewer-model" }, { id: "source-extractor-model" }],
	});
	const write = (path: string, content: string) => fauxAssistantMessage(fauxToolCall("write", { path, content }));
	provider.setResponses([
		write(
			"source/访谈/outline/story/index.yaml",
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001]\n",
		),
		write(
			"source/访谈/outline/story/vol-0001/beat-0001.md",
			"---\nrefs:\n  character: [黄盖]\n  resource: [火船]\n---\n访谈记录黄盖先核对火船，再决定如何处理。\n",
		),
		write("source/访谈/world/characters/黄盖.md", "点火前先看风向的人。\n"),
		write("source/访谈/world/resources/火船.md", "黄盖核对的信件。\n"),
		fauxAssistantMessage(fauxToolCall("commit", { summary: "保存 extraction" })),
		fauxAssistantMessage("把访谈抽取为黄盖核对火船的事件。"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "reviewer-model" },
			"source-extractor": { provider: providerId, model: "source-extractor-model" },
		},
	});
}

function reviewGateway(providerId: string, summary: string): ModelGateway {
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "reviewer-model" }],
	});
	provider.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"review",
				providerId.includes("source") ? { layer: "source", sourceId: "访谈" } : { layer: "text" },
			),
		),
		fauxAssistantMessage(
			fauxToolCall("submit_review", { verdict: "pass", summary, findings: [], uncovered: [], uncertainties: [] }),
		),
		fauxAssistantMessage(fauxToolCall("commit", { summary: "保存审稿证据" })),
		fauxAssistantMessage(summary),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "reviewer-model" },
		},
	});
}

function sourceReviewGateway(): ModelGateway {
	return reviewGateway("suiming-cli-source-reviewer-faux", "访谈 extraction 忠实覆盖 MaterialEvidence。");
}

function storyTextReviewGateway(): ModelGateway {
	return reviewGateway("suiming-cli-story-text-reviewer-faux", "全书正文完整兑现 current DesignCommit。");
}

function writeRunGateway(): ModelGateway {
	const providerId = "suiming-cli-writer-faux";
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "writer-model" }],
	});
	provider.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", {
				path: "text/beat-0001.md",
				content: "黄盖当众挨了军杖。\n\n他一声没吭。\n",
			}),
		),
		fauxAssistantMessage(fauxToolCall("commit", { summary: "采用正文" })),
		fauxAssistantMessage("正文已提交"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "agent-model" },
			writer: { provider: providerId, model: "writer-model" },
		},
	});
}

test("suim source ingest 原子导入本地文本并拒绝覆盖同名 Source", async () => {
	const checkoutPath = await fixture();
	const inputRoot = await mkdtemp(join(tmpdir(), "suiming-source-input-"));
	const inputPath = join(inputRoot, "访谈.txt");
	try {
		await writeFile(inputPath, "访谈记录：黄盖先核对火船。\n");
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const ingested = await jsonCommand(checkoutPath, [
			"source",
			"ingest",
			inputPath,
			"--id",
			"访谈",
			"--encoding",
			"utf-8",
		]);
		assert.equal(ingested.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(ingested.value.command, "source.ingest");
		assert.equal(Value.Check(SuimCliSuccessSchema, ingested.value), true);
		assert.equal(Value.Check(SuimCliSourceIngestDataSchema, ingested.value.data), true);
		assert.equal((ingested.value.data as { source: { state: string; name: string } }).source.state, "ingested");
		assert.equal((ingested.value.data as { source: { state: string; name: string } }).source.name, "访谈.txt");
		assert.equal(
			await readFile(join(checkoutPath, "source", "访谈", "material.txt"), "utf8"),
			"访谈记录：黄盖先核对火船。\n",
		);
		// 读材料、抽取、独立审查都是对 Agent 说一句话；前两件它自己做，审查才委派一个 Reviewer。
		for (const [text, models, taskKinds] of [
			["读一遍访谈材料并记笔记", sourceReadGateway(), []],
			["把访谈材料抽取成 Source Design", sourceExtractGateway(), []],
			["独立审查访谈的抽取", sourceReviewGateway(), ["review"]],
		] as const) {
			const result = await jsonCommand(checkoutPath, ["session", "send", text], models);
			assert.equal(result.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(result.value));
			assert.ok(Value.Check(SuimCliSessionTurnDataSchema, result.value.data));
			const data = result.value.data as { session: { id: string; status: string }; reply: string };
			assert.equal(data.session.status, "idle");
			assert.ok(data.reply.length > 0);
			const shown = await jsonCommand(checkoutPath, ["session", "show", data.session.id]);
			assert.ok(Value.Check(SuimCliSessionShowDataSchema, shown.value.data));
			assert.deepEqual(
				(shown.value.data as { tasks: { kind: string }[] }).tasks.map((task) => task.kind),
				[...taskKinds],
			);
		}
		const reports = await jsonCommand(checkoutPath, ["review", "list"]);
		assert.equal((reports.value.data as { reviews: unknown[] }).reviews.length, 1);

		const duplicate = await jsonCommand(checkoutPath, ["source", "ingest", inputPath, "--id", "访谈"]);
		assert.equal(duplicate.exitCode, SUIM_CLI_EXIT.conflict);
		assert.equal((duplicate.value.error as { code: string }).code, "source_already_exists");
		const missing = await jsonCommand(checkoutPath, [
			"source",
			"ingest",
			join(inputRoot, "missing.txt"),
			"--id",
			"缺失",
		]);
		assert.equal(missing.exitCode, SUIM_CLI_EXIT.notFound);
		assert.equal((missing.value.error as { code: string }).code, "source_input_not_found");
		const listed = await jsonCommand(checkoutPath, ["source", "list"]);
		assert.deepEqual(
			(listed.value.data as { sources: { sourceId: string; state: string }[] }).sources.map((source) => [
				source.sourceId,
				source.state,
			]),
			[
				["原作", "extracted"],
				["访谈", "extracted"],
			],
		);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
		await rm(inputRoot, { recursive: true, force: true });
	}
});

test("上一个进程崩溃留下的 running session：下一次 suim 打开时收敛回 idle，session send --session 接着跑", async () => {
	const checkoutPath = await fixture();
	const inputRoot = await mkdtemp(join(tmpdir(), "suiming-session-recovery-"));
	const inputPath = join(inputRoot, "访谈.txt");
	try {
		await writeFile(inputPath, "访谈记录：黄盖先核对火船。\n");
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		assert.equal(
			(await jsonCommand(checkoutPath, ["source", "ingest", inputPath, "--id", "访谈"])).exitCode,
			SUIM_CLI_EXIT.success,
		);
		const models = sourceReadGateway();
		const sessionId = "session-crashed";
		const project = await LocalProjectService.open(checkoutPath);
		try {
			const execution = project.createExecutionState();
			execution.createSession({
				commandId: "crash:create",
				id: sessionId,
				projectId: project.projectId,
				model: (await models.bind("main")).snapshot,
				baseRevisionId: project.project().headRevisionId,
			});
			project.queueInbox(sessionId, "读一遍访谈材料并记笔记");
			// 持有进程已经不在：lease 指向别的机器上的进程。
			execution.startTurn({
				commandId: "crash:start",
				sessionId,
				lease: { ownerId: "dead-owner", pid: 1, hostname: "elsewhere", acquiredAt: new Date().toISOString() },
			});
		} finally {
			project.close();
		}

		const listed = await jsonCommand(checkoutPath, ["session", "list"]);
		assert.ok(Value.Check(SuimCliSessionListDataSchema, listed.value.data));
		const recovered = (
			listed.value.data as { sessions: { id: string; status: string; lastFailure?: { code: string } }[] }
		).sessions[0];
		assert.equal(recovered?.status, "idle");
		assert.equal(recovered?.lastFailure?.code, "process_restart");

		const resumed = await jsonCommand(checkoutPath, ["session", "send", "--session", sessionId, "接着做"], models);
		assert.equal(resumed.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(resumed.value));
		assert.equal(resumed.value.command, "session.send");
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, resumed.value.data));
		const data = resumed.value.data as {
			session: { id: string; status: string; turn: number; lastFailure?: unknown };
		};
		assert.equal(data.session.id, sessionId);
		assert.equal(data.session.status, "idle");
		assert.equal(data.session.turn, 2);
		assert.equal(data.session.lastFailure, undefined);
		const shown = await jsonCommand(checkoutPath, ["session", "show", sessionId]);
		assert.deepEqual((shown.value.data as { tasks: unknown[] }).tasks, []);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
		await rm(inputRoot, { recursive: true, force: true });
	}
});

test("suim --json 从 init 到 host diff、check、commit、history 与 export 形成稳定 contract", async () => {
	const checkoutPath = await fixture();
	const exportRoot = await mkdtemp(join(tmpdir(), "suiming-cli-export-"));
	try {
		const initialized = await jsonCommand(checkoutPath, ["init", checkoutPath]);
		assert.equal(initialized.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, initialized.value), true);
		assert.equal(initialized.value.command, "project.init");
		const initialRevisionId = (initialized.value.data as { headRevisionId: string }).headRevisionId;

		const clean = await jsonCommand(checkoutPath, ["status"]);
		assert.equal(clean.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliResponseSchema, clean.value), true);
		assert.equal((clean.value.data as { state: string }).state, "clean");

		const searched = await jsonCommand(checkoutPath, ["search", "火攻", "--kind", "character"]);
		assert.equal(searched.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, searched.value), true);
		assert.equal(searched.value.command, "read.search");
		assert.deepEqual(
			(searched.value.data as { hits: { path: string }[] }).hits.map((hit) => hit.path),
			["world/characters/黄盖.md"],
		);

		const sources = await jsonCommand(checkoutPath, ["source", "list"]);
		assert.equal(sources.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, sources.value), true);
		assert.equal(sources.value.command, "source.list");
		assert.deepEqual(
			(sources.value.data as { sources: { sourceId: string; state: string }[] }).sources.map((source) => [
				source.sourceId,
				source.state,
			]),
			[["原作", "extracted"]],
		);

		const ran = await jsonCommand(checkoutPath, ["session", "send", "让诈降的代价当场可见"], designRunGateway());
		assert.equal(ran.exitCode, 0, JSON.stringify(ran.value));
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, ran.value.data));
		const sessionId = (ran.value.data as { session: { id: string } }).session.id;
		const persistedEvents = await jsonCommand(checkoutPath, ["session", "events", sessionId]);
		assert.ok(Value.Check(SuimCliSessionEventsDataSchema, persistedEvents.value.data));
		const persisted = (persistedEvents.value.data as { events: import("@suiming/sdk").SessionEvent[] }).events;
		assert.equal(persisted.filter((event) => event.event.type === "RUN_STARTED").length, 1, "一个 turn 一对");
		assert.equal(persisted.at(-1)?.event.type, "RUN_FINISHED");
		assert.equal(new Set(persisted.map((event) => event.id)).size, persisted.length);
		const shown = await jsonCommand(checkoutPath, ["session", "show", sessionId]);
		assert.deepEqual(
			(shown.value.data as { tasks: { kind: string }[] }).tasks.map((task) => task.kind),
			["review"],
		);
		const reports = await jsonCommand(checkoutPath, ["review", "list"]);
		const reviewId = (reports.value.data as { reviews: { id: string }[] }).reviews[0]?.id as string;
		const report = await jsonCommand(checkoutPath, ["review", "show", reviewId]);
		assert.equal(report.exitCode, 0, JSON.stringify(report.value));
		const shownReview = (
			report.value.data as { review: { path: string; current: boolean; draft: { verdict: string } } }
		).review;
		assert.equal(shownReview.path, `review/${reviewId}.md`);
		assert.equal(shownReview.current, true);
		assert.equal(shownReview.draft.verdict, "pass");
		const written = await jsonCommand(
			checkoutPath,
			["session", "send", "写 beat-0001 的正文：第一场，犹豫之后取信。"],
			writeRunGateway(),
		);
		assert.equal(written.exitCode, 0, JSON.stringify(written.value));
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, written.value.data));
		await writeFile(join(checkoutPath, "text", "beat-0002.md"), "约定那夜，二十艘火船一齐点火，冲进了曹营。\n");
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, 0);
		const reviewed = await jsonCommand(
			checkoutPath,
			["session", "send", "独立审查全书正文"],
			storyTextReviewGateway(),
		);
		assert.equal(reviewed.exitCode, 0, JSON.stringify(reviewed.value));
		const latestReports = await jsonCommand(checkoutPath, ["review", "list"]);
		const textReviewData = {
			reviewReport: (latestReports.value.data as { reviews: { id: string; layer: string }[] }).reviews.find(
				(item) => item.layer === "text",
			) as { id: string },
		};

		const missingRelease = await jsonCommand(checkoutPath, ["release", "status"]);
		assert.equal(missingRelease.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, missingRelease.value), true);
		assert.equal((missingRelease.value.data as { state: string }).state, "missing");
		const published = await jsonCommand(checkoutPath, [
			"release",
			"publish",
			"--review",
			textReviewData.reviewReport.id,
			"--min-code-points",
			"10",
			"--target-code-points",
			"20",
			"--max-code-points",
			"30",
		]);
		assert.equal(published.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, published.value), true);
		assert.equal(published.value.command, "release.publish");
		assert.equal((published.value.data as { created: boolean }).created, true);
		assert.equal((published.value.data as { reviewVerdict: string }).reviewVerdict, "pass");
		assert.ok((published.value.data as { manifest: { chapters: unknown[] } }).manifest.chapters.length > 0);
		const currentRelease = await jsonCommand(checkoutPath, ["release", "status"]);
		assert.equal(currentRelease.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, currentRelease.value), true);
		assert.equal(currentRelease.value.command, "release.status");
		assert.equal((currentRelease.value.data as { state: string }).state, "current");
		const publishedAgain = await jsonCommand(checkoutPath, [
			"release",
			"publish",
			"--review",
			textReviewData.reviewReport.id,
			"--min-code-points",
			"10",
			"--target-code-points",
			"20",
			"--max-code-points",
			"30",
		]);
		assert.equal(publishedAgain.exitCode, SUIM_CLI_EXIT.success);
		assert.equal((publishedAgain.value.data as { created: boolean }).created, false);

		const beatPath = join(checkoutPath, "outline", "story", "vol-0001", "beat-0002.md");
		const beat = await readFile(beatPath, "utf8");
		await writeFile(beatPath, beat.replace("各船同时点火", "二十艘船同时点火"));

		const diff = await jsonCommand(checkoutPath, ["diff"]);
		assert.equal(diff.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, diff.value), true);
		assert.equal(diff.value.command, "project.diff");
		assert.equal(JSON.stringify(diff.value).includes("bytes"), false);
		assert.equal(JSON.stringify(diff.value).includes("ChangeSet"), false);

		const checked = await jsonCommand(checkoutPath, ["check"]);
		assert.equal(checked.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, checked.value), true);
		// checker 与桌面的 workspace.check 是同一个投影（checkSummary）；passed 与 changedFiles
		// 由它给出，host 不必自己与三个布尔。
		assert.deepEqual(checked.value.data, {
			passed: true,
			changedFiles: 1,
			designPassed: true,
			statePassed: true,
			storyTextPassed: true,
			storyTextFailures: [],
			sourceCount: 1,
			diagnostics: [],
		});

		const committed = await jsonCommand(checkoutPath, ["commit"]);
		assert.equal(committed.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, committed.value), true);
		assert.equal((committed.value.data as { created: boolean }).created, true);

		const history = await jsonCommand(checkoutPath, ["history"]);
		assert.equal(history.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, history.value), true);
		const revisionCount = (history.value.data as { revisions: unknown[] }).revisions.length;
		assert.ok(revisionCount >= 7);
		const previousHeadRevisionId = (history.value.data as { headRevisionId: string }).headRevisionId;
		const rolledBack = await jsonCommand(checkoutPath, ["rollback", initialRevisionId]);
		assert.equal(rolledBack.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(rolledBack.value));
		assert.equal(rolledBack.value.command, "project.rollback");
		assert.equal(Value.Check(SuimCliRollbackDataSchema, rolledBack.value.data), true);
		assert.deepEqual(
			{
				created: (rolledBack.value.data as { created: boolean }).created,
				targetRevisionId: (rolledBack.value.data as { targetRevisionId: string }).targetRevisionId,
				previousHeadRevisionId: (rolledBack.value.data as { previousHeadRevisionId: string })
					.previousHeadRevisionId,
			},
			{ created: true, targetRevisionId: initialRevisionId, previousHeadRevisionId },
		);
		assert.ok((rolledBack.value.data as { changes: unknown[] }).changes.length > 0);
		const rolledBackHistory = await jsonCommand(checkoutPath, ["history"]);
		assert.equal((rolledBackHistory.value.data as { revisions: unknown[] }).revisions.length, revisionCount + 1);

		const outputPath = join(exportRoot, "story");
		const exported = await jsonCommand(checkoutPath, ["export", outputPath]);
		assert.equal(exported.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, exported.value), true);
		assert.equal((await readOpenStoryDirectory(outputPath)).files.length > 0, true);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
		await rm(exportRoot, { recursive: true, force: true });
	}
});

test("session send --events 在最终响应之前逐行输出 SessionEvent 信封：这个 turn 从 RUN_STARTED 起的持久事件一条不少", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const cli = harness(checkoutPath, designRunGateway());
		const exitCode = await runSuimCli(["--json", "session", "send", "--events", "让诈降的代价当场可见"], cli.io);
		assert.equal(exitCode, SUIM_CLI_EXIT.success, cli.stdout.at(-1));
		const lines = cli.stdout.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
		const final = lines.at(-1) as Record<string, unknown>;
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, final.data));
		const streamed = lines.slice(0, -1);
		assert.ok(streamed.length > 0);
		for (const line of streamed) assert.ok(Value.Check(SuimCliEventSchema, line), JSON.stringify(line));
		const sessionId = (final.data as { session: { id: string } }).session.id;
		const persisted = (
			(await jsonCommand(checkoutPath, ["session", "events", sessionId])).value.data as {
				events: { id: string; event: { type: string } }[];
			}
		).events;
		// 新 session 的创建快照在 turn 之前落盘，RUN_STARTED 之后紧跟着一份新的完整快照，不必补发。
		// 2026-10-04 补这条测试时发现 RUN_STARTED 本身也没流出来：订阅晚于 startTurn 落盘。
		const started = persisted.findIndex((event) => event.event.type === "RUN_STARTED");
		assert.ok(started >= 0);
		assert.deepEqual(
			streamed.map((line) => (line.event as { id: string }).id),
			persisted.slice(started).map((event) => event.id),
			"流式输出的就是这个 turn 持久化之后的事件，不多不少",
		);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("Cloud CLI 只同步 committed revision，并贯通 import、link、push、checkout、pull 与 unlink", async () => {
	const primaryPath = await fixture();
	const peerPath = await fixture();
	const checkoutRoot = await mkdtemp(join(tmpdir(), "suiming-cloud-checkout-"));
	const checkoutPath = join(checkoutRoot, "story");
	const cloud: CloudHarness = {
		store: new InMemoryCloudProjectStore(),
		endpoint: "https://cloud.example.test/api",
		actorId: "author-1",
	};
	try {
		assert.equal((await jsonCommand(primaryPath, ["init", primaryPath])).exitCode, SUIM_CLI_EXIT.success);
		const imported = await jsonCommand(
			primaryPath,
			[
				"cloud",
				"import",
				"cloud-story",
				"--endpoint",
				cloud.endpoint,
				"--actor",
				cloud.actorId,
				"--idempotency-key",
				"import-1",
			],
			undefined,
			cloud,
		);
		assert.equal(imported.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(imported.value));
		assert.equal(imported.value.command, "cloud.import");
		assert.equal(Value.Check(SuimCliSuccessSchema, imported.value), true);

		const initialStatus = await jsonCommand(
			primaryPath,
			["cloud", "status", "--actor", cloud.actorId],
			undefined,
			cloud,
		);
		assert.equal(initialStatus.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(initialStatus.value));
		assert.equal(Value.Check(SuimCliCloudStatusDataSchema, initialStatus.value.data), true);
		assert.equal((initialStatus.value.data as { state: string }).state, "in_sync");

		assert.equal((await jsonCommand(peerPath, ["init", peerPath])).exitCode, SUIM_CLI_EXIT.success);
		const linked = await jsonCommand(
			peerPath,
			["cloud", "link", "cloud-story", "--endpoint", cloud.endpoint, "--actor", cloud.actorId],
			undefined,
			cloud,
		);
		assert.equal(linked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(linked.value));
		assert.equal(linked.value.command, "cloud.link");
		const peerUnlinked = await jsonCommand(peerPath, ["cloud", "unlink", "--actor", cloud.actorId], undefined, cloud);
		assert.equal(peerUnlinked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(peerUnlinked.value));

		const intentPath = join(primaryPath, "intent", "计谋的代价.md");
		await writeFile(intentPath, `${await readFile(intentPath, "utf8")}\n本地追加约束。\n`);
		assert.equal((await jsonCommand(primaryPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const pushed = await jsonCommand(
			primaryPath,
			["cloud", "push", "--actor", cloud.actorId, "--idempotency-key", "push-1"],
			undefined,
			cloud,
		);
		assert.equal(pushed.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(pushed.value));
		assert.equal(Value.Check(SuimCliCloudSyncDataSchema, pushed.value.data), true, JSON.stringify(pushed.value.data));
		assert.equal((pushed.value.data as { before: { state: string } }).before.state, "local_ahead");

		const checkedOut = await jsonCommand(
			primaryPath,
			["cloud", "checkout", "cloud-story", checkoutPath, "--endpoint", cloud.endpoint, "--actor", cloud.actorId],
			undefined,
			cloud,
		);
		assert.equal(checkedOut.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(checkedOut.value));
		assert.equal(
			Value.Check(SuimCliCloudCheckoutDataSchema, checkedOut.value.data),
			true,
			JSON.stringify(checkedOut.value.data),
		);

		const characterPath = join(checkoutPath, "world", "characters", "黄盖.md");
		await writeFile(characterPath, `${await readFile(characterPath, "utf8")}\nCloud checkout 追加事实。\n`);
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const checkoutPush = await jsonCommand(
			checkoutPath,
			["cloud", "push", "--actor", cloud.actorId, "--idempotency-key", "push-2"],
			undefined,
			cloud,
		);
		assert.equal(checkoutPush.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(checkoutPush.value));

		const cloudAhead = await jsonCommand(
			primaryPath,
			["cloud", "status", "--actor", cloud.actorId],
			undefined,
			cloud,
		);
		assert.equal((cloudAhead.value.data as { state: string }).state, "cloud_ahead");
		const pulled = await jsonCommand(primaryPath, ["cloud", "pull", "--actor", cloud.actorId], undefined, cloud);
		assert.equal(pulled.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(pulled.value));
		assert.equal(Value.Check(SuimCliCloudSyncDataSchema, pulled.value.data), true);
		assert.match(await readFile(join(primaryPath, "world", "characters", "黄盖.md"), "utf8"), /Cloud checkout/u);

		const unlinked = await jsonCommand(primaryPath, ["cloud", "unlink", "--actor", cloud.actorId], undefined, cloud);
		assert.equal(unlinked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(unlinked.value));
		const statusAfterUnlink = await jsonCommand(
			primaryPath,
			["cloud", "status", "--actor", cloud.actorId],
			undefined,
			cloud,
		);
		assert.equal(statusAfterUnlink.exitCode, SUIM_CLI_EXIT.notFound);
		assert.equal((statusAfterUnlink.value.error as { code: string }).code, "cloud_sync_not_linked");
	} finally {
		await rm(primaryPath, { recursive: true, force: true });
		await rm(peerPath, { recursive: true, force: true });
		await rm(checkoutRoot, { recursive: true, force: true });
	}
});

test("suim 退出时统一由 shutdown 导出并关闭观测实例，成功与失败路径都执行", async () => {
	const checkoutPath = await fixture();
	try {
		const calls: string[] = [];
		const telemetry = {
			context: NOOP_TELEMETRY.context,
			flush: async () => {
				calls.push("flush");
			},
			shutdown: async () => {
				calls.push("shutdown");
			},
		};
		const init = harness(checkoutPath);
		init.io.telemetry = telemetry;
		assert.equal(await runSuimCli(["--json", "init"], init.io), SUIM_CLI_EXIT.success);
		assert.deepEqual(calls, [], "没有用到模型或引擎的命令不创建观测实例");
		const ok = harness(checkoutPath, designRunGateway());
		ok.io.telemetry = telemetry;
		assert.equal(
			await runSuimCli(["--json", "session", "send", "让诈降的代价当场可见"], ok.io),
			SUIM_CLI_EXIT.success,
			ok.stdout.join(""),
		);
		assert.deepEqual(calls, ["shutdown"]);
		const failing = harness(checkoutPath, designRunGateway());
		failing.io.telemetry = telemetry;
		assert.notEqual(
			await runSuimCli(["--json", "session", "resume", "session-that-does-not-exist"], failing.io),
			SUIM_CLI_EXIT.success,
		);
		assert.deepEqual(calls, ["shutdown", "shutdown"]);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("确定性校验失败、project lock、缺失项目和 usage 使用稳定错误码与 exit code", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init", checkoutPath])).exitCode, SUIM_CLI_EXIT.success);
		await writeFile(
			join(checkoutPath, "world", "characters", "黄盖.md"),
			"---\nname: 黄盖\nfamily:\n  parent: [不存在的人]\n---\n错误引用。\n",
		);
		const firstBeat = join(checkoutPath, "outline", "story", "vol-0001", "beat-0001.md");
		await writeFile(
			firstBeat,
			(await readFile(firstBeat, "utf8")).replace("character: [黄盖]", "character: [黄盖, 无名氏]"),
		);
		const invalid = await jsonCommand(checkoutPath, ["check"]);
		assert.equal(invalid.exitCode, SUIM_CLI_EXIT.validation);
		assert.equal(Value.Check(SuimCliErrorSchema, invalid.value), true);
		assert.equal(invalid.value.ok, false);
		// 绑定期的问题一次全给：host 不该改一处、跑一次才看见下一处（斗破 host 抽取时 400 处只露出第一处）
		const reported =
			(invalid.value.error as { diagnostics?: { path?: string; message: string }[] }).diagnostics ?? [];
		// 两处注入的问题都在，引用坏人物的级联问题也一并列出
		assert.ok(
			reported.some(
				(item) => item.path === "world/characters/黄盖.md" && item.message.includes("/frontmatter/family"),
			),
		);
		assert.ok(
			reported.some(
				(item) => item.path === "outline/story/vol-0001/beat-0001.md" && item.message.includes("character:无名氏"),
			),
		);
		assert.ok(reported.every((item) => item.message.length > 0));

		const lock = await LocalProjectLock.acquire(checkoutPath);
		try {
			const locked = await jsonCommand(checkoutPath, ["commit"]);
			assert.equal(locked.exitCode, SUIM_CLI_EXIT.conflict);
			assert.equal(Value.Check(SuimCliErrorSchema, locked.value), true);
			assert.deepEqual(locked.value.error, {
				code: "project_locked",
				message: (locked.value.error as { message: string }).message,
				retryable: true,
			});
		} finally {
			await lock.release();
		}

		const missing = await jsonCommand(join(checkoutPath, "missing"), ["status"]);
		assert.equal(missing.exitCode, SUIM_CLI_EXIT.notFound);
		assert.equal(Value.Check(SuimCliErrorSchema, missing.value), true);

		const usage = await jsonCommand(checkoutPath, ["does-not-exist"]);
		assert.equal(usage.exitCode, SUIM_CLI_EXIT.usage);
		assert.equal(Value.Check(SuimCliErrorSchema, usage.value), true);
		assert.equal(usage.value.command, "usage");
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("设计能绑定但 Checker 不通过时，check 成功返回逐条诊断，host 看得见是哪里没过", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init", checkoutPath])).exitCode, SUIM_CLI_EXIT.success);
		const beatPath = join(checkoutPath, "outline", "story", "vol-0001", "beat-0002.md");
		await writeFile(beatPath, (await readFile(beatPath, "utf8")).replace("contracts:\n  resolve: [诈降]\n", ""));
		const checked = await jsonCommand(checkoutPath, ["check"]);
		assert.equal(checked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(checked.value));
		assert.equal(Value.Check(SuimCliSuccessSchema, checked.value), true);
		const data = checked.value.data as {
			passed: boolean;
			designPassed: boolean;
			diagnostics: { severity: string; path?: string; message: string }[];
		};
		assert.equal(data.passed, false);
		assert.equal(data.designPassed, false);
		const errors = data.diagnostics.filter((item) => item.severity === "error");
		assert.equal(errors.length > 0, true);
		assert.ok(
			errors.some((item) => item.message.includes("诈降")),
			JSON.stringify(errors),
		);

		// 作者声明全书未完待续：期限是 book_end 的期待建立了还没回应，算进行中
		const contractPath = join(checkoutPath, "outline", "contracts", "诈降.md");
		await writeFile(
			contractPath,
			(await readFile(contractPath, "utf8")).replace("deadline: beat-0002", "deadline: book_end"),
		);
		const indexPath = join(checkoutPath, "outline", "story", "index.yaml");
		const unfinished = await jsonCommand(checkoutPath, ["check"]);
		assert.equal((unfinished.value.data as { designPassed: boolean }).designPassed, false, "没声明就是全书写完了");
		await writeFile(
			indexPath,
			(await readFile(indexPath, "utf8")).replace("schema_version: 2\n", "schema_version: 2\nopen_ended: true\n"),
		);
		const ongoing = await jsonCommand(checkoutPath, ["check"]);
		assert.equal(ongoing.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(ongoing.value));
		assert.equal((ongoing.value.data as { passed: boolean }).passed, true, JSON.stringify(ongoing.value));
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("作者未提交的修改与 Agent 的改动是同一份候选：一次 commit 一起进版本", async () => {
	const checkoutPath = await fixture();
	try {
		await jsonCommand(checkoutPath, ["init"]);
		const characterPath = join(checkoutPath, "world/characters/黄盖.md");
		const original = await readFile(characterPath, "utf8");
		await writeFile(characterPath, `${original}作者补的一句：他记得每一笔账。\n`);
		const providerId = "suiming-cli-shared-candidate-faux";
		const provider = fauxProvider({
			provider: providerId,
			models: [{ id: "agent-model" }, { id: "reviewer-model" }],
		});
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", {
					path: "intent/计谋的代价.md",
					content: "---\nstyle_refs: [style_contemporary_restraint]\n---\n主角诈降的代价当场可见。\n",
				}),
			),
			fauxAssistantMessage(fauxToolCall("commit", { summary: "完善设计" })),
			fauxAssistantMessage("已经提交，你那句也一起进版本了。"),
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const gateway = new ModelGateway(models, {
			profiles: {
				main: { provider: providerId, model: "agent-model" },
				reviewer: { provider: providerId, model: "reviewer-model" },
			},
		});
		const sent = await jsonCommand(checkoutPath, ["session", "send", "完善设计并提交"], gateway);
		assert.equal(sent.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(sent.value));
		const session = (sent.value.data as { session: { status: string; lastFailure?: unknown } }).session;
		assert.equal(session.status, "idle");
		assert.equal(session.lastFailure, undefined);
		// 没有 worktree，也就没有「作者的 checkout 脏了就挡住 Agent」：两个人的改动是同一份 diff。
		const status = await jsonCommand(checkoutPath, ["status"]);
		assert.equal((status.value.data as { state: string }).state, "clean");
		const diff = await jsonCommand(checkoutPath, ["diff"]);
		assert.deepEqual((diff.value.data as { entries: unknown[] }).entries, []);
		assert.match(await readFile(characterPath, "utf8"), /他记得每一笔账/);
		assert.match(await readFile(join(checkoutPath, "intent/计谋的代价.md"), "utf8"), /当场可见/);
		const history = await jsonCommand(checkoutPath, ["history"]);
		assert.equal((history.value.data as { revisions: unknown[] }).revisions.length, 2);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("另一个 CLI 用 session send --session 往进行中的 session 补一句：模型停下时在同一 turn 里收到", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const providerId = "suiming-cli-inbox-faux";
		const provider = fauxProvider({
			provider: providerId,
			models: [{ id: "agent-model" }, { id: "reviewer-model" }],
		});
		let injectedContextSeen = false;
		let injectResponse: Record<string, unknown> | undefined;
		provider.setResponses([
			async () => {
				// 模型第一轮只说话；同时"另一个进程"通过 CLI 往 inbox 里补一句。
				const listed = await jsonCommand(checkoutPath, ["session", "list"]);
				const sessionId = (listed.value.data as { sessions: { id: string }[] }).sessions[0]?.id as string;
				const injected = await jsonCommand(
					checkoutPath,
					["session", "send", "--session", sessionId, "把代价写成黄盖落下终身的伤。"],
					gateway,
				);
				injectResponse = injected.value;
				return fauxAssistantMessage("我先看看现状。");
			},
			(context: Context) => {
				const last = context.messages.at(-1);
				injectedContextSeen =
					last?.role === "user" && typeof last.content === "string" && last.content.includes("落下终身的伤");
				return fauxAssistantMessage(
					fauxToolCall("write", {
						path: "intent/计谋的代价.md",
						content: "---\nstyle_refs: [style_contemporary_restraint]\n---\n黄盖诈降的代价是落下终身的伤。\n",
					}),
				);
			},
			fauxAssistantMessage(fauxToolCall("commit", { summary: "代价具体化为落下终身的伤" })),
			fauxAssistantMessage("代价具体且当场可见。"),
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const gateway = new ModelGateway(models, {
			profiles: {
				main: { provider: providerId, model: "agent-model" },
				reviewer: { provider: providerId, model: "reviewer-model" },
			},
		});
		const ran = await jsonCommand(checkoutPath, ["session", "send", "让诈降的代价当场可见"], gateway);
		assert.equal(ran.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(ran.value));
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, ran.value.data));
		const data = ran.value.data as { session: { id: string; turn: number }; reply: string };
		assert.equal(data.reply, "代价具体且当场可见。");
		assert.equal(data.session.turn, 1, "补的那句在同一个 turn 里处理，不另开 turn");
		assert.ok(injectResponse !== undefined);
		assert.equal(injectResponse.ok, true, JSON.stringify(injectResponse));
		assert.equal(injectResponse.command, "session.send");
		assert.equal(
			(injectResponse.data as { session: { status: string } }).session.status,
			"running",
			"别的进程只排队，不等 turn",
		);
		assert.ok(injectedContextSeen, "补充的话应作为 user message 出现在下一次模型调用的 Context 里");

		const events = await jsonCommand(checkoutPath, ["session", "events", data.session.id]);
		const injectedEvents = (events.value.data as { events: import("@suiming/sdk").SessionEvent[] }).events.filter(
			(record) =>
				record.event.type === "TEXT_MESSAGE_CONTENT" && record.event.metadata?.suiming?.inboxSequence === 2,
		);
		assert.equal(injectedEvents.length, 1);
		assert.ok(JSON.stringify(injectedEvents[0]).includes("落下终身的伤"));
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("suim session send 收到 SIGINT：run_interrupted、exit 7、session 回 idle 且工作区保留，再发一句接着跑", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const providerId = "suiming-cli-interrupt-faux";
		const provider = fauxProvider({
			provider: providerId,
			models: [{ id: "agent-model" }, { id: "reviewer-model" }],
		});
		const cli = harness(checkoutPath, undefined);
		let interrupted = false;
		provider.setResponses([
			async (): Promise<AssistantMessage> => {
				// 模型调用进行中，作者按下 Ctrl+C：这一轮结束时 turn 收口回 idle。
				cli.interrupt();
				interrupted = true;
				return fauxAssistantMessage("我先看看现状。");
			},
			fauxAssistantMessage(
				fauxToolCall("write", {
					path: "intent/计谋的代价.md",
					content: "---\nstyle_refs: [style_contemporary_restraint]\n---\n主角诈降的代价当场可见。\n",
				}),
			),
			fauxAssistantMessage(fauxToolCall("commit", { summary: "让诈降的代价当场可见" })),
			fauxAssistantMessage("代价当场可见。"),
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const gateway = new ModelGateway(models, {
			profiles: {
				main: { provider: providerId, model: "agent-model" },
				reviewer: { provider: providerId, model: "reviewer-model" },
			},
		});
		cli.io.resolveModelGateway = async () => gateway;
		const exitCode = await runSuimCli(["--json", "session", "send", "让诈降的代价当场可见"], cli.io);
		const value = response(cli.stdout);
		assert.equal(interrupted, true);
		assert.equal(value.ok, false, JSON.stringify(value));
		assert.equal((value.error as { code: string }).code, "run_interrupted");
		assert.equal(exitCode, SUIM_CLI_EXIT.interrupted);

		const listed = await jsonCommand(checkoutPath, ["session", "list"]);
		const sessions = (listed.value.data as { sessions: { id: string; status: string; lastFailure?: unknown }[] })
			.sessions;
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0]?.status, "idle");
		assert.equal(sessions[0]?.lastFailure, undefined, "作者的中断不是故障");
		const resumed = await jsonCommand(
			checkoutPath,
			["session", "send", "--session", sessions[0]?.id as string, "接着做"],
			gateway,
		);
		assert.equal(resumed.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(resumed.value));
		assert.ok(Value.Check(SuimCliSessionTurnDataSchema, resumed.value.data));
		assert.equal((resumed.value.data as { reply: string }).reply, "代价当场可见。");
		const after = (await jsonCommand(checkoutPath, ["session", "list"])).value.data as {
			sessions: { status: string; turn: number }[];
		};
		assert.deepEqual(
			after.sessions.map((session) => [session.status, session.turn]),
			[["idle", 2]],
		);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("suim --version 打印版本并以 0 退出；没有 --json 也只输出 JSON envelope", async () => {
	const checkoutPath = await fixture();
	try {
		const version = harness(checkoutPath);
		assert.equal(await runSuimCli(["--version"], version.io), SUIM_CLI_EXIT.success);
		assert.match(version.stdout.join(""), /^\d+\.\d+\.\d+/u);

		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const plain = harness(checkoutPath);
		assert.equal(await runSuimCli(["status"], plain.io), SUIM_CLI_EXIT.success);
		const value = response(plain.stdout);
		assert.equal(Value.Check(SuimCliSuccessSchema, value), true, JSON.stringify(value));
		assert.equal(value.command, "project.status");
		// status 与 diff 曾经是同一条命令的两个名字：同一行实现、同一个 schema、输出逐字相同，
		// SKILL 却教 host 先 status 再 diff。现在 status 回答「在哪、有没有改、改了多少」。
		assert.equal(Value.Check(SuimCliProjectStatusDataSchema, value.data), true, JSON.stringify(value.data));
		assert.equal(Value.Check(SuimCliDiffDataSchema, value.data), false, "status 不再返回 diff 的形状");
		const status = value.data as Static<typeof SuimCliProjectStatusDataSchema>;
		assert.equal(status.state, "clean");
		assert.equal(status.candidate.uncommittedChanges, 0);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("host 领域命令：text check、design impact、context compile、review schema 与 review record 形成 host-native 的 Review 闭环；审稿是 checkout 里的文件", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		await mkdir(join(checkoutPath, "text"), { recursive: true });
		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖走入赤壁，在木匣中找到火船。\n");
		await writeFile(join(checkoutPath, "text", "beat-0002.md"), "约定那夜，二十艘火船一齐点火，直冲曹营。\n");

		const checked = await jsonCommand(checkoutPath, ["text", "check", "beat-0001"]);
		assert.equal(checked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(checked.value));
		assert.equal(Value.Check(SuimCliTextCheckDataSchema, checked.value.data), true, JSON.stringify(checked.value));
		assert.deepEqual(
			(checked.value.data as { state: string; passed: boolean; codePoints: number }).state,
			"dirty",
			"text check 在 dirty checkout 上直接检查候选",
		);
		assert.equal((checked.value.data as { passed: boolean }).passed, true);
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);

		const impact = await jsonCommand(checkoutPath, ["design", "impact", "character:黄盖"]);
		assert.equal(impact.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(impact.value));
		assert.equal(Value.Check(SuimCliDesignImpactDataSchema, impact.value.data), true, JSON.stringify(impact.value));
		assert.deepEqual((impact.value.data as { impact: { storyBeatIds: string[] } }).impact.storyBeatIds, [
			"beat-0001",
			"beat-0002",
		]);

		const compiled = await jsonCommand(checkoutPath, [
			"context",
			"compile",
			"review:text:beat-0001",
			"--output",
			join(checkoutPath, ".suiming", "contexts", "review.md"),
		]);
		assert.equal(compiled.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(compiled.value));
		assert.equal(
			Value.Check(SuimCliContextCompileDataSchema, compiled.value.data),
			true,
			JSON.stringify(compiled.value),
		);
		const context = compiled.value.data as { outputPath: string; text: string; artifacts: { path: string }[] };
		assert.equal(await readFile(context.outputPath, "utf8"), context.text);
		assert.ok(context.artifacts.some((artifact) => artifact.path === "text/beat-0001.md"));

		const schema = await jsonCommand(checkoutPath, ["review", "schema"]);
		assert.equal(Value.Check(SuimCliReviewSchemaDataSchema, schema.value.data), true);
		assert.equal((schema.value.data as { schema: { type: string } }).schema.type, "object");

		const draftPath = join(checkoutPath, ".suiming", "review-draft.json");
		await writeFile(
			draftPath,
			JSON.stringify({
				verdict: "pass",
				summary: "beat-0001 的正文兑现了苦肉计的过程。",
				findings: [],
				uncovered: [],
				uncertainties: [],
			}),
		);
		const recorded = await jsonCommand(checkoutPath, [
			"review",
			"record",
			draftPath,
			"--layer",
			"text",
			"--beat",
			"beat-0001",
		]);
		assert.equal(recorded.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(recorded.value));
		assert.equal(
			Value.Check(SuimCliReviewRecordDataSchema, recorded.value.data),
			true,
			JSON.stringify(recorded.value),
		);
		const report = (
			recorded.value.data as { review: { id: string; path: string; verdict: string; revision: string } }
		).review;
		assert.equal(report.verdict, "pass");
		assert.equal(report.path, `review/${report.id}.md`);
		// 审稿写进 checkout，是 dirty candidate；commit 后才进版本并可列出。
		assert.match(await readFile(join(checkoutPath, report.path), "utf8"), /^---\nlayer: text\n/u);
		assert.equal((await jsonCommand(checkoutPath, ["status"])).value.data && true, true);
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const listed = await jsonCommand(checkoutPath, ["review", "list"]);
		const listedReview = (listed.value.data as { reviews: { id: string; current: boolean }[] }).reviews.find(
			(item) => item.id === report.id,
		);
		assert.ok(listedReview);
		assert.equal(listedReview.current, true);
		// 改了被审正文再提交：审稿还在，但不再 current。
		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖当众挨了军杖。\n");
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const relisted = await jsonCommand(checkoutPath, ["review", "list"]);
		assert.equal(
			(relisted.value.data as { reviews: { id: string; current: boolean; changed: string[] }[] }).reviews.find(
				(item) => item.id === report.id,
			)?.current,
			false,
		);

		const badLayer = await jsonCommand(checkoutPath, ["review", "record", draftPath, "--layer", "nope"]);
		assert.equal(badLayer.exitCode, SUIM_CLI_EXIT.validation);
		await writeFile(
			draftPath,
			JSON.stringify({
				verdict: "revise",
				summary: "引文对不上。",
				findings: [
					{
						severity: "minor",
						anchor: { kind: "artifact", path: "text/beat-0001.md" },
						issue: "转述而不是引用。",
						evidence: "这句话不在正文里",
						repairLayer: "text",
					},
				],
				uncovered: [],
				uncertainties: [],
			}),
		);
		const badQuote = await jsonCommand(checkoutPath, ["review", "record", draftPath, "--layer", "text"]);
		assert.equal(badQuote.exitCode, SUIM_CLI_EXIT.validation);
		assert.equal((badQuote.value.error as { code: string }).code, "review_quote_not_found");
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("suim init 从空目录开始一部作品：脚手架 Design、Intent 与 host adapter 文件，重复安装只刷新标记段", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-new-"));
	const intentPath = join(root, "intent.txt");
	await writeFile(intentPath, "# 作品意图\n\n一部关于代价的长篇。\n", "utf8");
	const work = join(root, "my-book");
	try {
		const initialized = await jsonCommand(root, [
			"init",
			work,
			"--intent-file",
			intentPath,
			"--agent",
			"codex",
			"--agent",
			"claude-code",
		]);
		assert.equal(initialized.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, initialized.value), true);
		const written = (initialized.value.data as { written: string[] }).written;
		for (const path of [
			"outline/story/index.yaml",
			"intent/book.md",
			".agents/skills/suiming/SKILL.md",
			".agents/skills/suiming/story-language/README.md",
			".agents/skills/suiming/story-language/state.md",
			".codex/agents/suim_storytext_writer.toml",
			"AGENTS.md",
			".claude/skills/suiming/SKILL.md",
			"CLAUDE.md",
			".gitignore",
		]) {
			assert.ok(written.includes(path), `${path} 应写入`);
		}
		assert.equal(await readFile(join(work, "intent/book.md"), "utf8"), "# 作品意图\n\n一部关于代价的长篇。\n");
		assert.match(
			await readFile(join(work, "AGENTS.md"), "utf8"),
			/BEGIN suiming[\s\S]*\.agents\/skills\/suiming\/SKILL\.md[\s\S]*END suiming/u,
		);
		assert.match(await readFile(join(work, "CLAUDE.md"), "utf8"), /\.claude\/skills\/suiming\/SKILL\.md/u);
		// Suiming 应用里的 Agent 也会读入口文件；「先读 Skill」只点名给 host，否则它照着去读被藏起的 Skill。
		assert.match(await readFile(join(work, "AGENTS.md"), "utf8"), /Suiming 应用里的 Agent[^\n]*不是写给你的/u);
		assert.match(await readFile(join(work, ".gitignore"), "utf8"), /^\.suiming\/$/mu);

		// 脚手架就是可提交的 Design：登记后 checkout clean，Checker 通过
		// clean 由 status 回答，Checker 结果由 check 回答——两条命令不再返回同一份数据。
		const status = await jsonCommand(work, ["status"]);
		assert.equal(status.exitCode, SUIM_CLI_EXIT.success);
		assert.equal((status.value.data as { state: string }).state, "clean");
		const checked = await jsonCommand(work, ["check"]);
		assert.equal(checked.exitCode, SUIM_CLI_EXIT.success);
		assert.equal((checked.value.data as { designPassed: boolean }).designPassed, true);

		// 作者在 AGENTS.md 前面加自己的约束，刷新 Skill 后保留且标记段不叠加
		const agentsPath = join(work, "AGENTS.md");
		await writeFile(agentsPath, `# 我的约束\n\n不要改书名。\n\n${await readFile(agentsPath, "utf8")}`, "utf8");
		const reinstalled = await jsonCommand(work, ["update", "--agent", "codex"]);
		assert.equal(reinstalled.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, reinstalled.value), true);
		const agents = await readFile(agentsPath, "utf8");
		assert.ok(agents.startsWith("# 我的约束"));
		assert.equal(agents.split("BEGIN suiming").length, 2);
		assert.equal((await readFile(join(work, ".gitignore"), "utf8")).split("BEGIN suiming").length, 2);

		// host 查字段形状：design guide 不需要 Local Project，由 schema 渲染
		const guide = await jsonCommand(root, ["design", "guide"]);
		assert.equal(guide.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, guide.value), true);
		assert.match((guide.value.data as { guide: string }).guide, /^# Target Story Language machine shape/u);
		assert.match((guide.value.data as { guide: string }).guide, /dead: 主体 character/u);

		// 已有 Intent 不被 --intent-file 覆盖；未知 host 是 validation 错误
		const again = await jsonCommand(work, ["init", work, "--intent-file", intentPath]);
		assert.equal(again.exitCode, SUIM_CLI_EXIT.conflict);
		assert.equal((again.value.error as { code: string }).code, "local_project_already_initialized");
		const badHost = await jsonCommand(work, ["update", "--agent", "cursor"]);
		assert.equal(badHost.exitCode, SUIM_CLI_EXIT.validation);
		assert.equal((badHost.value.error as { code: string }).code, "unsupported_host");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host 接入文件除入口文件与 .gitignore 外都落在 HOST_ADAPTER_ROOTS 之下：Suiming Agent 的文件工具靠这张根表挡住它们", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-hosts-"));
	try {
		for (const host of HOST_IDS) {
			const { written } = await installHost(root, host);
			for (const path of written) {
				if (["AGENTS.md", "CLAUDE.md", ".gitignore"].includes(path)) continue;
				assert.ok(
					HOST_ADAPTER_ROOTS.has(path.split("/")[0] ?? ""),
					`${host} 写了 ${path}，不在 HOST_ADAPTER_ROOTS 里`,
				);
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("update 发现已安装接入并保留作者模型配置；损坏的配置不会被覆盖", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-update-"));
	try {
		assert.equal((await jsonCommand(root, ["update", "--agent", "grok"])).exitCode, SUIM_CLI_EXIT.notFound);
		assert.equal((await jsonCommand(root, ["init"])).exitCode, 0);
		const absent = await jsonCommand(root, ["update"]);
		assert.equal((absent.value.error as { code: string }).code, "invalid_cli_usage");
		const before = (await jsonCommand(root, ["status"])).value.data;
		const installed = await jsonCommand(root, ["update", "--agent", "codex", "--agent", "grok", "--agent", "grok"]);
		assert.equal(installed.exitCode, 0, JSON.stringify(installed.value));
		assert.equal(installed.value.command, "project.update");
		assert.deepEqual(
			(installed.value.data as { hosts: { host: string }[] }).hosts.map((item) => item.host),
			["codex", "grok"],
		);
		const agentPath = join(root, ".codex/agents/suim_candidate.toml");
		const original = await readFile(agentPath, "utf8");
		await writeFile(
			agentPath,
			`${original.replace('description = "', 'description = "过时描述：')}\nmodel = "author-model"\nmodel_reasoning_effort = "high"\n[author_options]\nkeep = true\n`,
		);
		const refreshed = await jsonCommand(root, ["update"]);
		assert.equal(refreshed.exitCode, 0, JSON.stringify(refreshed.value));
		assert.deepEqual(
			(refreshed.value.data as { hosts: { host: string }[] }).hosts.map((item) => item.host),
			["codex", "grok"],
		);
		const config = parse(await readFile(agentPath, "utf8"));
		assert.equal(config.model, "author-model");
		assert.equal(config.model_reasoning_effort, "high");
		assert.deepEqual(config.author_options, { keep: true });
		assert.equal(config.description, parse(original).description);
		assert.equal(config.developer_instructions, parse(original).developer_instructions);
		assert.deepEqual((await jsonCommand(root, ["status"])).value.data, before, "接入刷新不改变 Canon 或候选");
		const malformed = 'model = "未闭合';
		await writeFile(agentPath, malformed);
		const skillPath = join(root, ".agents/skills/suiming/SKILL.md");
		await writeFile(skillPath, "更新前的接入指示");
		const rejected = await jsonCommand(root, ["update"]);
		assert.equal((rejected.value.error as { code: string }).code, "invalid_agent_config");
		assert.equal(await readFile(agentPath, "utf8"), malformed);
		assert.equal(await readFile(skillPath, "utf8"), "更新前的接入指示");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("init 失败不补写意图或遗留 scaffold，修正后可以重新初始化", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-init-failure-"));
	const intentPath = join(root, "intent.txt");
	await writeFile(intentPath, "# 意图\n主角必须为选择付出代价。\n");
	const initialized = join(root, "initialized");
	const invalid = join(root, "invalid");
	try {
		assert.equal((await jsonCommand(root, ["init", initialized])).exitCode, 0);
		const before = (await jsonCommand(initialized, ["status"])).value.data;
		const again = await jsonCommand(initialized, ["init", "--intent-file", intentPath]);
		assert.equal((again.value.error as { code: string }).code, "local_project_already_initialized");
		await assert.rejects(readFile(join(initialized, "intent/book.md")), { code: "ENOENT" });
		assert.deepEqual((await jsonCommand(initialized, ["status"])).value.data, before);
		await mkdir(join(invalid, "world/characters"), { recursive: true });
		const badPath = join(invalid, "world/characters/bad.md");
		const broken = "---\ninvalid: [\n---\n原有内容\n";
		await writeFile(badPath, broken);
		const failed = await jsonCommand(root, ["init", invalid, "--intent-file", intentPath]);
		assert.equal(failed.value.ok, false);
		await assert.rejects(readFile(join(invalid, "outline/story/index.yaml")), { code: "ENOENT" });
		await assert.rejects(readFile(join(invalid, "intent/book.md")), { code: "ENOENT" });
		assert.equal(await readFile(badPath, "utf8"), broken);
		await writeFile(badPath, "一个始终追问证据的人。\n");
		assert.equal((await jsonCommand(root, ["init", invalid, "--intent-file", intentPath])).exitCode, 0);
		assert.equal(((await jsonCommand(invalid, ["status"])).value.data as { state: string }).state, "clean");
		assert.equal(
			(await jsonCommand(root, ["init", join(root, "unused"), "--project-id", "manual"])).exitCode,
			SUIM_CLI_EXIT.usage,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("design impact --source 查 Source 的抽取：回头修前文时召回得到引用这个人物的 Beat", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const inputPath = join(checkoutPath, "访谈.txt");
		await writeFile(inputPath, "第一段。黄盖找到火船。\n", "utf8");
		assert.equal(
			(await jsonCommand(checkoutPath, ["source", "ingest", inputPath, "--id", "访谈"])).exitCode,
			SUIM_CLI_EXIT.success,
		);
		const files: [string, string][] = [
			[
				"outline/story/index.yaml",
				"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001]\n",
			],
			["outline/story/vol-0001/beat-0001.md", "---\nrefs:\n  character: [黄盖]\n---\n黄盖找到火船。\n"],
			["world/characters/黄盖.md", "先核对证据再决定是否公开的人。\n"],
		];
		for (const [path, content] of files) {
			await mkdir(dirname(join(checkoutPath, "source", "访谈", path)), { recursive: true });
			await writeFile(join(checkoutPath, "source", "访谈", path), content, "utf8");
		}
		const impact = await jsonCommand(checkoutPath, ["design", "impact", "character:黄盖", "--source", "访谈"]);
		assert.equal(impact.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(impact.value));
		assert.equal(Value.Check(SuimCliDesignImpactDataSchema, impact.value.data), true, JSON.stringify(impact.value));
		const result = (impact.value.data as { impact: { storyBeatIds: string[]; paths: string[] } }).impact;
		assert.deepEqual(result.storyBeatIds, ["beat-0001"]);
		assert.ok(result.paths.includes("source/访谈/outline/story/vol-0001/beat-0001.md"));
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("host 自己读材料：context compile source:read 给出材料 sha，笔记写成 source/<id>/notes/<n>.md，覆盖率由 source list 派生", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const material = "第一段。黄盖找到火船。\n第二段。他去见旧友。\n";
		const inputPath = join(checkoutPath, "访谈.txt");
		await writeFile(inputPath, material, "utf8");
		assert.equal(
			(await jsonCommand(checkoutPath, ["source", "ingest", inputPath, "--id", "访谈"])).exitCode,
			SUIM_CLI_EXIT.success,
		);
		const total = [...material].length;
		const compiled = await jsonCommand(checkoutPath, ["context", "compile", `source:read:访谈:0:${total}`]);
		assert.equal(compiled.exitCode, SUIM_CLI_EXIT.success);
		assert.equal(Value.Check(SuimCliSuccessSchema, compiled.value), true);
		const data = compiled.value.data as { source: { span: { end: number }; materialSha256: string } };
		assert.equal(data.source.span.end, total);
		assert.match(data.source.materialSha256, /^[a-f0-9]{64}$/u);
		const unread = await jsonCommand(checkoutPath, ["source", "list"]);
		const sourceOf = (listed: typeof unread) =>
			(
				listed.value.data as {
					sources: {
						sourceId: string;
						coverage: { gaps: [number, number][]; covered: [number, number][]; notes: { path: string }[] };
					}[];
				}
			).sources.find((item) => item.sourceId === "访谈");
		assert.deepEqual(sourceOf(unread)?.coverage.gaps, [[0, total]]);
		await assert.rejects(readFile(join(checkoutPath, "source", "访谈", "notes", "1.md")));
		assert.notEqual(
			(await jsonCommand(checkoutPath, ["context", "compile", "review:source:访谈"])).exitCode,
			SUIM_CLI_EXIT.success,
			"没读完不能审",
		);

		await mkdir(join(checkoutPath, "source", "访谈", "notes"), { recursive: true });
		await writeFile(
			join(checkoutPath, "source", "访谈", "notes", "1.md"),
			`---\nspan: [0, ${total}]\nmaterial_sha256: ${data.source.materialSha256}\n---\n黄盖备好火船后去见周瑜。\n`,
			"utf8",
		);
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const listed = await jsonCommand(checkoutPath, ["source", "list"]);
		const coverage = sourceOf(listed)?.coverage;
		assert.deepEqual(coverage?.gaps, []);
		assert.deepEqual(coverage?.covered, [[0, total]]);
		assert.deepEqual(
			coverage?.notes.map((note) => note.path),
			["source/访谈/notes/1.md"],
		);
		// 读完了但还没有抽取：没有可审的东西（以前这里会编译出一份「尚无 extraction 文件」的输入）
		const unextracted = await jsonCommand(checkoutPath, ["context", "compile", "review:source:访谈"]);
		assert.equal(unextracted.exitCode, SUIM_CLI_EXIT.validation);
		assert.equal((unextracted.value.error as { code: string }).code, "source_not_extracted");
		assert.match((unextracted.value.error as { message: string }).message, /suim commit/u);
		await mkdir(join(checkoutPath, "source", "访谈", "outline", "story", "vol-0001"), { recursive: true });
		await writeFile(
			join(checkoutPath, "source", "访谈", "outline", "story", "index.yaml"),
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001]\n",
		);
		await writeFile(
			join(checkoutPath, "source", "访谈", "outline", "story", "vol-0001", "beat-0001.md"),
			"---\ntitle: 访旧友\n---\n黄盖拿着火船去见旧友，核对来历。\n",
		);
		assert.equal((await jsonCommand(checkoutPath, ["commit"])).exitCode, SUIM_CLI_EXIT.success);
		const review = await jsonCommand(checkoutPath, ["context", "compile", "review:source:访谈"]);
		assert.equal(review.exitCode, SUIM_CLI_EXIT.success, "读完并提交抽取后 Source Review 可编译");
		const reviewText = (review.value.data as { text: string }).text;
		assert.ok(reviewText.includes("黄盖备好火船后去见周瑜。"));
		assert.ok(reviewText.includes("黄盖拿着火船去见旧友，核对来历。"));
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

function rankRunGateway(): ModelGateway {
	const providerId = "suiming-cli-rank-faux";
	const provider = fauxProvider({
		provider: providerId,
		models: [{ id: "agent-model" }, { id: "reviewer-model" }, { id: "judge-model" }],
	});
	provider.setResponses(
		Array.from({ length: 2 }, () => (context: Context) => {
			const prompt = context.messages
				.filter((message) => message.role === "user")
				.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
				.join("\n");
			const labels = [...prompt.matchAll(/--- 候选(甲|乙) ---/gu)].map((match) => match[1] as string);
			return fauxAssistantMessage(
				fauxToolCall("submit_ranking", {
					ranking: labels.map((label, index) => ({
						candidate: label,
						rank: index + 1,
						reason: "先出现的更紧",
						flaws: [],
					})),
					summary: "两版都能读。",
				}),
			);
		}),
	);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: providerId, model: "agent-model" },
			reviewer: { provider: providerId, model: "reviewer-model" },
			judge: { provider: providerId, model: "judge-model" },
		},
	});
}

test("suim run rank：多版候选文件匿名交给评委，输出合并名次与评委模型，符合 contract", async () => {
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		await mkdir(join(checkoutPath, ".suim-host"), { recursive: true });
		const first = join(checkoutPath, ".suim-host", "flash.md");
		const second = join(checkoutPath, ".suim-host", "pro.md");
		await writeFile(first, "军杖落到第三十下。\n", "utf8");
		await writeFile(second, "赤壁的门吱呀一声。\n", "utf8");
		const ranked = await jsonCommand(
			checkoutPath,
			["rank", "beat-0001", "--candidate", first, second, "--goal", "看谁更像人在现场"],
			rankRunGateway(),
		);
		assert.equal(ranked.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(ranked.value).slice(0, 400));
		assert.equal(
			Value.Check(SuimCliSuccessSchema, ranked.value),
			true,
			JSON.stringify([...Value.Errors(SuimCliSuccessSchema, ranked.value)].slice(0, 4).map((e) => e.message)),
		);
		assert.equal(ranked.value.command, "rank");
		assert.ok(Value.Check(SuimCliRankDataSchema, ranked.value.data));
		const data = ranked.value.data as {
			sessionId: string;
			rounds: number;
			rubric: string;
			judge: { model: string; sameModelAsWriter: boolean };
			ranking: { label: string; ranks: number[] }[];
		};
		assert.equal(data.rounds, 2);
		assert.equal(data.rubric, "constitution", "默认按本作宪法与写作准则评");
		assert.equal(data.judge.model, "judge-model");
		// 只有 ChatGPT 订阅、没配评委时评委落回写正文的模型，结果里只有一个布尔值；host 要知道这时名次只能当参考
		const skill = await readFile(new URL("../../../integrations/shared/suiming/SKILL.md", import.meta.url), "utf8");
		assert.match(skill, /`judge\.sameModelAsWriter` 为 true 时评委就是写正文的模型/u);
		assert.deepEqual(data.ranking.map((item) => item.label).sort(), ["flash", "pro"]);
		const shown = await jsonCommand(checkoutPath, ["session", "show", data.sessionId]);
		const rank = shown.value.data as { session: { kind: string }; tasks: { kind: string; status: string }[] };
		assert.equal(rank.session.kind, "rank");
		assert.deepEqual(
			rank.tasks.map((task) => [task.kind, task.status]),
			[
				["rank.round", "completed"],
				["rank.round", "completed"],
			],
		);

		// 对照原作或参照稿：读者口径的评委不带本作准则，只看前文
		const reader = await jsonCommand(
			checkoutPath,
			["rank", "beat-0001", "--candidate", first, second, "--rubric", "reader"],
			rankRunGateway(),
		);
		assert.equal(reader.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(reader.value).slice(0, 400));
		assert.ok(Value.Check(SuimCliRankDataSchema, reader.value.data));
		assert.equal((reader.value.data as { rubric: string }).rubric, "reader");
		const unknown = await jsonCommand(
			checkoutPath,
			["rank", "beat-0001", "--candidate", first, second, "--rubric", "宽松"],
			rankRunGateway(),
		);
		assert.equal((unknown.value.error as { code: string }).code, "invalid_cli_usage");
		assert.match(
			await readFile(new URL("../../../integrations/shared/suiming/SKILL.md", import.meta.url), "utf8"),
			/--rubric reader/u,
		);

		const bad = await jsonCommand(checkoutPath, ["rank", "beat-0001", "--candidate", first], rankRunGateway());
		assert.notEqual(bad.exitCode, SUIM_CLI_EXIT.success);
		assert.equal((bad.value.error as { code: string }).code, "invalid_goal");
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("session interrupt：paused 的放弃核对回 idle；在别的进程里跑的如实报错，不假装停了", async () => {
	// 2026-10-02 之前这条命令只读出状态就返回，exit 0：paused 的停不掉，running 的也没停，看上去却成功了。
	const checkoutPath = await fixture();
	try {
		assert.equal((await jsonCommand(checkoutPath, ["init"])).exitCode, SUIM_CLI_EXIT.success);
		const project = await LocalProjectService.open(checkoutPath);
		try {
			const execution = project.createExecutionState();
			const live = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() };
			execution.createSession({ commandId: "p:create", id: "paused", projectId: project.projectId });
			execution.startTurn({ commandId: "p:start", sessionId: "paused", lease: { ownerId: "p", ...live } });
			execution.endTurn({
				commandId: "p:pause",
				sessionId: "paused",
				status: "paused",
				failure: { code: "model_call_unknown", message: "结果未知", retryable: true },
			});
			// 持有进程还活着（就是测试进程本身），但不是这次 suim 调用：它只能在那边停。
			execution.createSession({ commandId: "r:create", id: "running", projectId: project.projectId });
			execution.startTurn({ commandId: "r:start", sessionId: "running", lease: { ownerId: "r", ...live } });
		} finally {
			project.close();
		}

		const abandoned = await jsonCommand(checkoutPath, ["session", "interrupt", "paused"]);
		assert.equal(abandoned.exitCode, SUIM_CLI_EXIT.success, JSON.stringify(abandoned.value));
		assert.equal((abandoned.value.data as { session: { status: string } }).session.status, "idle");

		const elsewhere = await jsonCommand(checkoutPath, ["session", "interrupt", "running"]);
		assert.equal(elsewhere.exitCode, SUIM_CLI_EXIT.conflict);
		const error = elsewhere.value.error as { code: string; message: string };
		assert.equal(error.code, "session_not_active_in_process");
		assert.match(error.message, /另一个进程/u);
	} finally {
		await rm(checkoutPath, { recursive: true, force: true });
	}
});
