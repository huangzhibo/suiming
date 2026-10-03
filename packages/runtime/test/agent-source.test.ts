import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { codePointCount, sliceCodePoints } from "../src/artifact/code-points.js";
import { agentTurn } from "../src/harness/agent.js";
import {
	findInMaterial,
	materialSegments,
	materialSpan,
	renderMaterialSpan,
	sourceMaterialText,
} from "../src/harness/material.js";
import {
	composeReviewFile,
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	reviewsIn,
	SuimingHarness,
	sourceCoverage,
	storyImpact,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "suiming-engine-source-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	return root;
}

function gateway(responses: Responses): ModelGateway {
	const provider = fauxProvider({
		provider: "suiming-source-faux",
		models: [{ id: "agent-model" }, { id: "reviewer-model" }, { id: "reader-model" }, { id: "extractor-model" }],
	});
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: provider.provider.id, model: "agent-model" },
			reviewer: { provider: provider.provider.id, model: "reviewer-model" },
			"source-reader": { provider: provider.provider.id, model: "reader-model" },
			"source-extractor": { provider: provider.provider.id, model: "extractor-model" },
		},
	});
}

const material =
	"第一段。黄盖在赤壁的木匣里找到火船，决定先不公开。\n第二段。他把火船藏在袖中，去见旧友。\n第三段。旧友劝他烧掉火船，他没有答应。\n";
const total = [...material].length;

const extractionFiles: Array<[string, string]> = [
	[
		"source/访谈/outline/story/index.yaml",
		"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001, beat-0002]\n",
	],
	[
		"source/访谈/outline/story/vol-0001/beat-0001.md",
		"---\nrefs:\n  character: [黄盖]\n  resource: [火船]\ncontracts:\n  open: [火船去向]\nchanges:\n  world:\n    火船.holder: 黄盖\n---\n黄盖在赤壁找到火船，决定先不公开。\n",
	],
	[
		"source/访谈/outline/story/vol-0001/beat-0002.md",
		"---\nrefs:\n  character: [黄盖, 旧友]\n  resource: [火船]\n  beat: [beat-0001]\ncontracts:\n  advance: [火船去向]\n---\n旧友劝黄盖烧掉火船，他没有答应。\n",
	],
	["source/访谈/world/characters/黄盖.md", "先核对证据再决定是否公开的人。\n"],
	["source/访谈/world/characters/旧友.md", "劝黄盖销毁证据的旧相识。\n"],
	["source/访谈/world/resources/火船.md", "能证明旧案的信件。\n"],
	[
		"source/访谈/outline/contracts/火船去向.md",
		"---\nsubjects:\n  character: [黄盖]\n  resource: [火船]\ndeadline: book_end\n---\n材料建立了火船最终去向的期待，边界内尚未回答。\n",
	],
];

function passReview() {
	return fauxAssistantMessage(
		fauxToolCall("submit_review", {
			verdict: "pass",
			summary: "extraction 忠实覆盖材料。",
			findings: [],
			uncovered: [],
			uncertainties: [],
		}),
	);
}

async function withProject<T>(body: (project: LocalProjectService, checkoutPath: string) => Promise<T>): Promise<T> {
	const checkoutPath = await fixture();
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "project-1" });
		await project.ingestSource({ sourceId: "访谈", name: "访谈.txt", original: new TextEncoder().encode(material) });
		return await body(project, checkoutPath);
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
const reply = (text: string) => fauxAssistantMessage(text);
/** 上一条工具结果的文本；faux provider 的 Context 里工具结果是 toolResult 消息。 */
function lastToolText(context: Context): string {
	const last = context.messages.at(-1);
	assert.equal(last?.role, "toolResult");
	const content = last?.content;
	assert.ok(Array.isArray(content));
	const body = content.find((part) => part.type === "text");
	assert.ok(body?.type === "text");
	return body.text;
}
const note = (sha: string, span: [number, number], handoff: string) =>
	`---\nspan: [${span[0]}, ${span[1]}]\nmaterial_sha256: ${sha}\n---\n${handoff}\n`;

/** 作者说一句话并跑完一个 turn；每次新建 session。 */
async function say(harness: SuimingHarness, text: string) {
	const session = await harness.createSession();
	// 收件箱不在 Harness 的端口上（harness 只读 inbox）；测试里的 project 都是 LocalProjectService。
	(harness.project as LocalProjectService).queueInbox(session.id, text);
	return { sessionId: session.id, ...(await harness.turn(session.id, {}, (handle) => agentTurn(handle))) };
}
/** Agent 自己读材料：先问覆盖率拿到材料 sha，读完把笔记写成 source/<id>/notes/1.md。 */
function reading(): Responses {
	return [
		call("source_coverage", { sourceId: "访谈" }),
		(context) => {
			const coverage = JSON.parse(lastToolText(context)) as { gaps: [number, number][]; materialSha256: string };
			assert.deepEqual(coverage.gaps, [[0, total]]);
			return call("read_source", { sourceId: "访谈", start: 0, end: total });
		},
		(context) => {
			// 与 Reviewer 的 read_material 同一种格式：一行区间与全文长度，空一行，原文不转义。
			assert.equal(lastToolText(context), `Source "访谈" [0, ${total})，全文 ${total} 码点。\n\n${material}`);
			return call("source_coverage", { sourceId: "访谈" });
		},
		(context) => {
			const { materialSha256 } = JSON.parse(lastToolText(context)) as { materialSha256: string };
			return call("write", {
				path: "source/访谈/notes/1.md",
				content: note(materialSha256, [0, total], "黄盖找到火船，拒绝烧毁。"),
			});
		},
		call("commit", { summary: "采用材料笔记" }),
		reply("读完并写下笔记"),
	];
}

test("Source 阅读顺序由 Agent 决定；笔记是普通文件，覆盖率从它派生，提取与 Review 都以它为准", async () => {
	await withProject(async (project, checkoutPath) => {
		const read = await say(new SuimingHarness({ project, models: gateway(reading()) }), "读一遍访谈材料并记笔记");
		assert.equal(read.failure, undefined);
		assert.deepEqual(project.loadExecutionState().tasks, [], "Agent 自己读，不必委派");
		const coverage = sourceCoverage(await project.checkoutCandidate(), "访谈");
		assert.deepEqual(coverage.gaps, []);
		assert.deepEqual(
			coverage.notes.map((item) => item.path),
			["source/访谈/notes/1.md"],
		);
		const extract = await say(
			new SuimingHarness({
				project,
				models: gateway([
					...extractionFiles.map(([path, content]) => call("write", { path, content })),
					call("commit", { summary: "采用 extraction" }),
					reply("抽取完成"),
				]),
			}),
			"把访谈材料抽取成 Source Design",
		);
		assert.equal(extract.failure, undefined);
		assert.ok((await readFile(join(checkoutPath, extractionFiles[0]?.[0] ?? ""), "utf8")).includes("beat-0001"));
		const reviewed = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("review", { layer: "source", sourceId: "访谈" }),
					passReview(),
					call("commit", { summary: "保存审稿" }),
					reply("独立审查已保存"),
				]),
			}),
			"独立审查访谈的抽取",
		);
		assert.equal(reviewed.failure, undefined);
		assert.deepEqual(
			project.loadExecutionState().tasks.map((task) => [task.kind, task.status]),
			[["review", "completed"]],
		);
		const reviews = reviewsIn(await project.checkoutCandidate());
		assert.equal(reviews.length, 1);
		assert.match(reviews[0]?.path ?? "", /^review\/source-/u);
		assert.deepEqual(reviews[0]?.file.scope, { kind: "source", sourceId: "访谈" });
		assert.equal(reviews[0]?.file.draft.verdict, "pass");
	});
});

test("委派的 source-reader 自己写笔记，但只能写这个 Source 的 notes/，不必把笔记塞进报告让父 Agent 抄", async () => {
	// 2026-10-02 斗破抽取：source-reader 原是只读，四个分段阅读的子任务都把整份笔记塞进 submit_task 的报告、
	// 留话「请代为落盘」，一个因输出过长被截断；父 Agent 只能把几万字再抄进文件。
	await withProject(async (project) => {
		const results: string[] = [];
		const read = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { profile: "source-reader", sourceId: "访谈", goal: "读完全文并写笔记" }),
					call("source_coverage", { sourceId: "访谈" }),
					(context) => {
						const { materialSha256 } = JSON.parse(lastToolText(context)) as { materialSha256: string };
						return call("write", {
							path: "source/访谈/notes/1.md",
							content: note(materialSha256, [0, total], "黄盖找到火船，拒绝烧毁。"),
						});
					},
					call("write", { path: "source/访谈/world/characters/黄盖.md", content: "越界写抽取。\n" }),
					(context) => {
						results.push(lastToolText(context));
						return call("submit_task", { summary: "笔记已写在 source/访谈/notes/1.md" });
					},
					call("commit", { summary: "采用材料笔记" }),
					reply("笔记由读材料的子任务写好并提交"),
				]),
			}),
			"把访谈材料读一遍",
		);
		assert.equal(read.failure, undefined);
		assert.match(results[0] ?? "", /permission_denied|不能写|无权/u, "抽取不归读者写");
		assert.deepEqual(sourceCoverage(await project.checkoutCandidate(), "访谈").gaps, []);
	});
});

test("读材料只有一份实现：按码点切、超过单次上限截断并说从哪接着读，区间不合法时拒绝", async () => {
	await withProject(async (project) => {
		const text = "一😀二\n三𠀀四";
		for (let start = 0; start <= [...text].length; start++)
			for (let end = start; end <= [...text].length; end++)
				assert.equal(sliceCodePoints(text, start, end), [...text].slice(start, end).join(""), `[${start}, ${end})`);
		assert.equal(codePointCount(text), [...text].length);

		const source = sourceMaterialText(await project.checkoutCandidate(), "访谈");
		assert.equal(source.codePoints, total);
		const cut = materialSpan(source, { start: 2, end: total }, 5);
		assert.deepEqual(cut.span, { start: 2, end: 7 });
		assert.equal(cut.text, [...material].slice(2, 7).join(""));
		assert.equal(
			renderMaterialSpan(source, cut, 5),
			`Source "访谈" [2, 7)，全文 ${total} 码点；单次最多 5 码点，已截断，下次从 7 读起。\n\n${cut.text}`,
		);
		for (const span of [
			{ start: 3, end: 3 },
			{ start: 0, end: total + 1 },
		])
			assert.throws(() => materialSpan(source, span), { code: "invalid_material_span" });
	});
});

test("现成的分段：在章标题处切成不超过上限的几段，号段不重叠；没有章标题就在空行处切", () => {
	// 10-03 前 24 章：分段要根 Agent 自己规划时，它只派了第一段，打算让前一段给后一段交代状态
	const chapter = (n: number) =>
		`===== 第${String(n).padStart(4, "0")}章 =====\n\n第${n}章\n\n𠀀${"斗".repeat(89)}\n\n${"气".repeat(90)}\n`;
	const book = Array.from({ length: 10 }, (_, index) => chapter(index + 1)).join("");
	const points = [...book];
	const segments = materialSegments(book, 800);
	assert.ok(segments.length > 1);
	assert.equal(segments[0]?.span[0], 0);
	assert.equal(segments.at(-1)?.span[1], points.length);
	segments.forEach((segment, index) => {
		const [start, end] = segment.span;
		assert.ok(end - start <= 800, `第 ${index + 1} 段 ${end - start} 码点`);
		if (index > 0) {
			assert.equal(start, segments[index - 1]?.span[1], "各段首尾相接");
			// 两行分章标记只认第一行，切口落在「=====」上，不落在紧跟的「第N章」上
			assert.match(points.slice(start, start + 8).join(""), /^===== 第/u, `第 ${index + 1} 段从章标题起`);
		}
		assert.deepEqual(segment.beatRange, { from: index * 100 + 1, to: index * 100 + 99 });
	});
	assert.deepEqual(materialSegments(book, points.length), [
		{ span: [0, points.length], beatRange: { from: 1, to: 9999 } },
	]);

	const plain = Array.from({ length: 12 }, (_, index) => `${String(index).repeat(60)}`).join("\n\n");
	const paragraphs = materialSegments(plain, 300);
	assert.ok(paragraphs.length > 1);
	for (const { span } of paragraphs.slice(1)) assert.equal([...plain].slice(span[0] - 2, span[0]).join(""), "\n\n");
});

test("按字找原文：命中给码点区间与前后文，区间能直接交给 read_source 或当审稿锚点；Agent 与 Source Reviewer 都有", async () => {
	// 2026-10-02 审查：Agent、抽取者与 Source Reviewer 只能按码点区间盲读，核对一条主张要在 30 万码点里一段段翻；
	// host 一条 rg 就到。
	const text = "开头😀火船在此。中间。又见火船。";
	const found = findInMaterial(
		{ sourceId: "x", identity: { kind: "source-material" } as never, text, codePoints: [...text].length, sha256: "" },
		"火船",
		1,
	);
	assert.equal(found.total, 2);
	assert.equal(found.hits.length, 1, "只列前 limit 处，总数如实给");
	assert.deepEqual([found.hits[0]?.start, found.hits[0]?.end], [3, 5], "码点而不是 UTF-16 下标");
	assert.equal(sliceCodePoints(text, found.hits[0]?.start ?? 0, found.hits[0]?.end ?? 0), "火船");
	await withProject(async (project) => {
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("search_source", { sourceId: "访谈", query: "火船" }),
					(context) => {
						results.push(lastToolText(context));
						const [, start, end] = /\[(\d+), (\d+)\)/u.exec(lastToolText(context)) ?? [];
						return call("read_source", { sourceId: "访谈", start: Number(start), end: Number(end) });
					},
					(context) => {
						results.push(lastToolText(context));
						return reply("找到了");
					},
				]),
			}),
			"原文哪里提到火船",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(results[0] ?? "", /共 3 处/u);
		assert.match(results[1] ?? "", /\n\n火船$/u);
	});
	const { reviewerSystemPrompt } = await import("../src/harness/review-context.js");
	assert.match(reviewerSystemPrompt("source"), /search_material/u);
	assert.doesNotMatch(reviewerSystemPrompt("source", "host"), /search_material|read_material/u);
});

test("read_source 读不存在的 Source 或越界区间是回到 Agent 手里的工具错误，不掀掉 turn", async () => {
	await withProject(async (project) => {
		const results: string[] = [];
		const read = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { profile: "source-reader", sourceId: "不存在", goal: "读" }),
					(context) => {
						results.push(lastToolText(context));
						return call("read_source", { sourceId: "不存在", start: 0, end: 10 });
					},
					(context) => {
						results.push(lastToolText(context));
						return call("read_source", { sourceId: "访谈", start: 0, end: total + 1 });
					},
					(context) => {
						results.push(lastToolText(context));
						return reply("换个范围再读");
					},
				]),
			}),
			"读一下材料",
		);
		assert.equal(read.failure, undefined);
		assert.match(results[0] ?? "", /source_not_found/u, "委派给不存在的 Source 是工具错误");
		assert.match(results[1] ?? "", /source_not_found/u);
		assert.match(results[2] ?? "", /invalid_material_span/u);
	});
});

test("抽取写到一半、Source Design 有格式错误时，委派的子任务照常读原文和覆盖率；错误由 check 指出，turn 不崩", async () => {
	// 2026-10-02 斗破抽取：Design 里一处人物作用域写了 location，委派的子任务随后 read_source。读原文连带解析整个
	// Source Design，抛出的 StoryParseError 工具没转成拒绝、childOutcome 也不认，35 分钟的根 turn 就此结束。
	await withProject(async (project, checkoutPath) => {
		const broken = extractionFiles.map(([path, content]): [string, string] =>
			path.endsWith("beat-0002.md")
				? [
						path,
						content.replace(
							"contracts:",
							"changes:\n  character:\n    黄盖:\n      火船.holder: 旧友\ncontracts:",
						),
					]
				: [path, content],
		);
		for (const [path, content] of broken) {
			await mkdir(dirname(join(checkoutPath, path)), { recursive: true });
			await writeFile(join(checkoutPath, path), content);
		}
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { profile: "main", goal: "核对黄盖在材料里的原话" }),
					call("read_source", { sourceId: "访谈", start: 0, end: total }),
					(context) => {
						results.push(lastToolText(context));
						return call("source_coverage", { sourceId: "访谈" });
					},
					(context) => {
						results.push(lastToolText(context));
						return call("submit_task", { summary: "黄盖拒绝烧信" });
					},
					call("check", {}),
					(context) => {
						results.push(lastToolText(context));
						return reply("抽取里有一处作用域写错了，下一步改");
					},
				]),
			}),
			"核对一下黄盖的原话",
		);
		assert.equal(outcome.failure, undefined);
		assert.equal(results[0], `Source "访谈" [0, ${total})，全文 ${total} 码点。\n\n${material}`);
		assert.deepEqual((JSON.parse(results[1] ?? "{}") as { gaps: unknown }).gaps, [[0, total]]);
		assert.match(results[2] ?? "", /scope only carries secret revealed/u);
	});
});

test("笔记格式不对时 source_coverage 是回到 Agent 手里的工具错误，点名是哪份笔记", async () => {
	await withProject(async (project, checkoutPath) => {
		await mkdir(join(checkoutPath, "source/访谈/notes"), { recursive: true });
		await writeFile(join(checkoutPath, "source/访谈/notes/1.md"), note("f".repeat(64), [5, 2], "区间写反了。"));
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("source_coverage", { sourceId: "访谈" }),
					(context) => {
						results.push(lastToolText(context));
						return reply("先改笔记的区间");
					},
				]),
			}),
			"看看读到哪了",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(results[0] ?? "", /source\/访谈\/notes\/1\.md/u);
	});
});

test("委派的 source-extractor 拿到 Story Language 原文与抽取方法；方法只写抽取特有的，不转述语义", async () => {
	// 2026-10-02 斗破抽取（GPT-6.1 Sol）：抽取子任务只有通用子任务提示——120 章抽成一卷、id 全是英文、Beat 标题带
	// 章节括注、Contract 写成章节速记。当天补的抽取方法逐条转述了 Story Language 的语义，10-03 前 12 章小样本就撞上
	// 两处说法不一：方法说一卷是「一场冲突从起到落」，Story Language 对卷几乎什么都没写，模型照方法分了 4 卷。
	// 语义只有 Story Language 一份，抽取子任务直接拿到原文，方法只留抽取特有的。
	await withProject(async (project) => {
		let system = "";
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { profile: "source-extractor", sourceId: "访谈", goal: "抽取访谈材料" }),
					(context) => {
						// 系统提示在折好的 transcript 开头那条 system 消息里
						system = JSON.stringify(context.messages[0]);
						return call("submit_task", { summary: "先看方法" });
					},
					reply("好"),
				]),
			}),
			"抽取一下访谈",
		);
		assert.equal(outcome.failure, undefined);
		const { STORY_LANGUAGE_DOCS } = await import("@suiming/story");
		for (const topic of ["readme", "source", "outline", "character", "world", "state"]) {
			const doc = STORY_LANGUAGE_DOCS.find((item) => item.topic === topic);
			assert.ok(doc !== undefined && system.includes(JSON.stringify(doc.text).slice(1, -1)), `带着 ${topic} 原文`);
		}
		const { SOURCE_EXTRACTION_METHOD } = await import("../src/harness/writing-methods.js");
		assert.ok(system.includes(JSON.stringify(SOURCE_EXTRACTION_METHOD).slice(1, -1)));
		// 抽取特有的：忠实、自检
		assert.match(SOURCE_EXTRACTION_METHOD, /只记原作写了的/u);
		assert.match(SOURCE_EXTRACTION_METHOD, /写完自检一遍/u);
		// 这个 Agent 要纠正的写法留在方法里，不进 host 也读的 Story Language：10-03 重抽的 Beat 初稿是电报体，
		// 萧宁、萧玉缩成「宁」「玉」；人物档、World 里夹着 16 处「说法有出入」
		assert.match(SOURCE_EXTRACTION_METHOD, /人名不缩成单字.*不用顿号把几个动作压成一句/u);
		// 同日小样本：「不省主语」矫枉过正，一段里句句都是「萧炎」；同一个人的连续动作中文本来可以省主语
		assert.doesNotMatch(SOURCE_EXTRACTION_METHOD, /不省主语/u);
		assert.match(SOURCE_EXTRACTION_METHOD, /换了做事的人要写明是谁/u);
		assert.match(SOURCE_EXTRACTION_METHOD, /出入、章节对应与核对过程写在交付报告里/u);
		// 同日小样本的 Source 审稿：抽取把十一岁 / 十二岁、十段 / 九段替原文统一成了一种——「按最自洽的一种写」
		// 是 Target 意图里的话，Source 不读 Target 意图，统不统一是提升为 Target 时的决定
		assert.match(SOURCE_EXTRACTION_METHOD, /各节照那一处原文写/u);
		assert.match(SOURCE_EXTRACTION_METHOD, /不替原文挑一种/u);
		// 10-03 的 120 章 Source 审稿 4 个 minor 里 3 个是人物档里的防误读提醒：「不应让他凭现场记忆判断」「不据称呼建立实际祖孙血缘」
		assert.match(SOURCE_EXTRACTION_METHOD, /也不写「不能据此……」「不应让他……」这类写给续写者的提醒/u);
		assert.doesNotMatch(SOURCE_EXTRACTION_METHOD, /最自洽/u);
		// 去掉转述后同样的 12 章：refs.beat 从 26 条掉到 5 条、秘密从 8 个掉到 2 个。Story Language 定义了它们是什么，
		// 没说要主动用；这是这个 Agent 容易漏的，点名而不重述定义
		assert.match(SOURCE_EXTRACTION_METHOD, /容易漏用.*refs\.beat.*Secret/u);
		// 10-03 前 24 章两圈都没给薰儿身世、药老所求开 Contract，只登记了 Secret；一次审稿判 major，一次没看出来
		assert.match(SOURCE_EXTRACTION_METHOD, /读者一直在等答案的谜.*Secret 之外再开一个 Contract/u);
		// 10-03 的 120 章整合给 153 节分卷：逐个 copy 再 delete，三百来次工具调用
		assert.match(SOURCE_EXTRACTION_METHOD, /用 move 把 Beat 挪到各卷目录（一卷一次）/u);
		// 语义不在方法里再写一遍
		for (const restated of [/一场冲突/u, /core\.md/u, /deadline/u, /title 只写/u, /相邻顺序和主题相似/u])
			assert.doesNotMatch(SOURCE_EXTRACTION_METHOD, restated);
		// 章节括注的另一半原因在根 Agent：作者要它报章节对应，它把映射要求写进了委派给抽取子任务的 goal
		const { AGENT_PROMPT } = await import("../src/harness/agent.js");
		assert.match(AGENT_PROMPT, /章节对应、进度、出处、核对过程这类工作信息在回复里交代，不写进作品/u);
		// 10-03：第一轮 Source 审稿建议「比对记录留在 notes」，之后两轮修改写了 29 份核对笔记
		assert.match(AGENT_PROMPT, /材料笔记只记原文写了什么/u);
		// 同一次：Source 审稿三轮（8 → 7 → 5 条），第三轮的 major 与第一轮同类——第一轮只修了点名的那处
		assert.match(AGENT_PROMPT, /同类问题全书一起修/u);
		assert.match(AGENT_PROMPT, /只剩 minor 就修完收尾/u);
		assert.match(AGENT_PROMPT, /story_guide/u);
	});
});

test("委派的 source-reader 与 source-extractor：Reader 判断标准与 host 同源，不带宪法与 Target 意图，读写都限在这个 Source", async () => {
	// 2026-10-02 审查：两个 source 角色拿的是通用子任务提示加宪法，输入是 Target 的 Frame（含 intent/**），读范围不限；
	// host 的 Reader 契约刻意不带宪法，Skill 也说 Source 任务不读 Target Intent——抽取应当与 Target 无关。
	await withProject(async (project, checkoutPath) => {
		await mkdir(join(checkoutPath, "review"), { recursive: true });
		await writeFile(join(checkoutPath, "review/source-20261003-000000-abcd.md"), "加列毕的父子关系写反了。\n");
		const seen: { system: string; prompt: string }[] = [];
		const results: string[] = [];
		const capture = (context: Context) => {
			const [system, prompt] = context.messages;
			seen.push({ system: JSON.stringify(system), prompt: JSON.stringify(prompt) });
		};
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { profile: "source-reader", sourceId: "访谈", goal: "读全文写笔记" }),
					(context) => {
						capture(context);
						return call("read", { path: "intent/计谋的代价.md" });
					},
					(context) => {
						results.push(lastToolText(context));
						return call("submit_task", { summary: "先停" });
					},
					call("delegate", { profile: "source-extractor", sourceId: "访谈", goal: "抽取" }),
					(context) => {
						capture(context);
						// 10-03 重抽时 extractor 第一步列 Source 目录本身就被拒：读范围只认 source/<id>/ 开头的路径
						return call("list", { path: "source/访谈" });
					},
					(context) => {
						results.push(lastToolText(context));
						// 同一次：根 Agent 派它按 Source 审稿修改，它读不到审稿文件，只能靠父 Agent 在 goal 里转述意见
						return call("read", { path: "review/source-20261003-000000-abcd.md" });
					},
					(context) => {
						results.push(lastToolText(context));
						// 同一次：两轮按审稿修改的子任务把核对过程写成 29 份「修订核对」笔记，混进读原文的记录
						return call("write", {
							path: "source/访谈/notes/核对01.md",
							content: note("f".repeat(64), [0, 2], "核对过，不能写成对练。"),
						});
					},
					(context) => {
						results.push(lastToolText(context));
						return call("submit_task", { summary: "先停" });
					},
					reply("好"),
				]),
			}),
			"读并抽取访谈",
		);
		assert.equal(outcome.failure, undefined);
		const { SOURCE_READER_METHOD } = await import("../src/harness/writing-methods.js");
		const { SOURCE_RANGE_HOST_SYSTEM_PROMPT } = await import("../src/harness/host-context.js");
		assert.ok(SOURCE_RANGE_HOST_SYSTEM_PROMPT.includes(SOURCE_READER_METHOD), "host 的 Reader 契约用同一份判断标准");
		assert.ok(seen[0]?.system.includes(JSON.stringify(SOURCE_READER_METHOD).slice(1, -1)));
		// 10-03 小样本：「宁详勿略」之后笔记是原文的 62%–79%，逐段复述场面，另有约五分之一是读取区间、
		// 「此处不能补写」这类流程话——抽取读它与读原文差不多贵，笔记就没了用处
		assert.doesNotMatch(SOURCE_READER_METHOD, /宁详勿略/u);
		assert.match(SOURCE_READER_METHOD, /不复述场面/u);
		assert.match(SOURCE_READER_METHOD, /读取过程/u);
		assert.match(SOURCE_READER_METHOD, /两到三成/u);
		for (const { system, prompt } of seen) {
			assert.doesNotMatch(system, /故事创作宪法/u);
			assert.doesNotMatch(prompt, /主角不能靠巧合取胜/u, "不带 Target 意图");
			assert.match(prompt, /全文 \d+ 码点/u, "输入是这个 Source 的覆盖情况");
		}
		assert.match(results[0] ?? "", /permission_denied|不能读|无权/u, "Source 角色读不到 Target 意图");
		assert.doesNotMatch(results[1] ?? "", /permission_denied/u, "能列出这个 Source 的目录本身");
		assert.match(results[1] ?? "", /material\.txt/u);
		assert.match(results[2] ?? "", /加列毕的父子关系写反了/u, "能读这个 Source 的审稿");
		assert.match(results[3] ?? "", /permission_denied/u, "笔记归读原文的人写，抽取与修改不写");
	});
});

test("Source 审稿也查抽取是否合 Story Language 语义；host 版指向随 Skill 安装的 story-language/", async () => {
	// 2026-10-02 GPT 版的 Source 审稿只查忠实度：速记 Beat、群体人物档、World 流程档、零个秘密一条没提。
	const { reviewerSystemPrompt } = await import("../src/harness/review-context.js");
	const engine = reviewerSystemPrompt("source");
	assert.match(engine, /Story Language 的语义/u);
	assert.match(engine, /story_guide/u);
	assert.match(engine, /材料边界.*开放.*不算错/u);
	// 10-03 重抽的电报体 Beat 与按语：审稿要能指出来
	assert.match(engine, /速记.*简称.*按语/u);
	assert.match(engine, /不要让人把核对记录写进笔记/u);
	// 同一次审稿：锚点与引文的说法让它把要修的文件写进 issue、锚到原文区间
	assert.match(engine, /锚在要修的 Source artifact path 上/u);
	assert.match(engine, /逐字引用那个文件或原作的原句/u);
	const host = reviewerSystemPrompt("source", "host");
	assert.match(host, /story-language\//u);
	assert.doesNotMatch(host, /story_guide/u);
	await withProject(async (project) => {
		let reviewer = "";
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("source_coverage", { sourceId: "访谈" }),
					(context) => {
						const { materialSha256 } = JSON.parse(lastToolText(context)) as { materialSha256: string };
						return call("write", {
							path: "source/访谈/notes/1.md",
							content: note(materialSha256, [0, total], "全文。"),
						});
					},
					...extractionFiles.map(([path, content]) => call("write", { path, content })),
					call("review", { layer: "source", sourceId: "访谈" }),
					(context) => {
						reviewer = JSON.stringify(context.messages[0]);
						return passReview();
					},
					reply("审完了"),
				]),
			}),
			"审一下访谈的抽取",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(reviewer, /story_guide/u, "Source Reviewer 能查语义主题");
	});
});

test("一次回复里委派的多个 source-reader 同时跑，各写各的笔记，结果按派出顺序交还", async () => {
	await withProject(async (project) => {
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					fauxAssistantMessage([
						fauxToolCall("delegate", { profile: "source-reader", sourceId: "访谈", goal: "读前半" }),
						fauxToolCall("delegate", { profile: "source-reader", sourceId: "访谈", goal: "读后半" }),
					]),
					// 两个子任务并发取用 faux 回复，顺序不定，所以回复对称
					call("submit_task", { summary: "读完一段" }),
					call("submit_task", { summary: "读完一段" }),
					(context) => {
						results.push(
							...context.messages
								.filter((message) => message.role === "toolResult")
								.map((message) => JSON.stringify(message.content)),
						);
						return reply("两段都读完了");
					},
				]),
			}),
			"分两段读访谈",
		);
		assert.equal(outcome.failure, undefined);
		const tasks = project.loadExecutionState().tasks;
		assert.equal(tasks.length, 2);
		assert.deepEqual(
			tasks.map((task) => task.status),
			["completed", "completed"],
		);
		const [first, second] = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		assert.ok((second?.createdAt ?? "") <= (first?.updatedAt ?? ""), "第二个在第一个结束前就开始了");
		assert.equal(results.length, 2);
	});
});

test("Source 审稿锚在抽取文件上的 finding 可以引原作：「抽取写成 A、原作是 B」要修的是那个文件", async () => {
	// 10-03 斗破 Source 审稿：一条 finding 锚在 加列毕.md、引的是原作那句，被 review_quote_not_found 拒掉；重交时 8 条全改锚
	// 原文区间，要修的文件只剩 issue 里的一句话，审稿页锚不到文件上。Source 层的真源是原作，引它与引被审文件一样能逐字核对。
	await withProject(async (project, checkoutPath) => {
		for (const [path, content] of extractionFiles) {
			await mkdir(dirname(join(checkoutPath, path)), { recursive: true });
			await writeFile(join(checkoutPath, path), content);
		}
		const candidate = await project.checkoutCandidate();
		const compose = (evidence: string, layer: "source" | "design" = "source") =>
			composeReviewFile(candidate, {
				layer,
				scope: layer === "source" ? { kind: "source", sourceId: "访谈" } : { kind: "book" },
				revision: "candidate",
				draft: {
					verdict: "revise",
					summary: "旧友的人物档漏了他劝烧火船。",
					findings: [
						{
							severity: "minor",
							anchor: { kind: "artifact", path: "source/访谈/world/characters/旧友.md" },
							issue: "人物档没写他劝黄盖烧掉火船。",
							evidence,
							repairLayer: layer,
						},
					],
					uncovered: [],
					uncertainties: [],
				},
			});
		assert.doesNotThrow(() => compose("「旧友劝他烧掉火船，他没有答应。」"), "引原作");
		assert.doesNotThrow(
			() => compose("档里写「劝黄盖销毁证据的旧相识」，原作是「旧友劝他烧掉火船」"),
			"两边各引一句",
		);
		const quoteMissing = (error: unknown) => (error as { code?: string }).code === "review_quote_not_found";
		assert.throws(() => compose("「旧友亲手烧掉了火船」"), quoteMissing, "两边都没有的转述照样拒绝");
		assert.throws(() => compose("「旧友劝他烧掉火船」", "design"), quoteMissing, "只有 Source 层能引原作");
	});
});

test("delegate 的说明要求把独立的几段在同一次回复里一起派出", async () => {
	// 10-03 重抽：能并行之后根 Agent 仍先派一个 source-reader 试水，等它读完（11 分半）才一次派出其余五个（12 分钟），读原文的时间翻了一倍。
	// Codex 与 Claude Code 都在提示里明说「能并行就一起派」，只写「会同时执行」模型不会主动这么做。
	await withProject(async (project) => {
		let system = "";
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					(context) => {
						system = JSON.stringify(context.messages[0]);
						return reply("好");
					},
				]),
			}),
			"读一下访谈",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(system, /同一次回复里一起派出/u);
		assert.match(system, /不要先派一段试水/u);
	});
});

test("Target 层审稿读不到 Source：Design 与正文的 Reviewer 只看 Target", async () => {
	// Skill 的审稿循环：Target Review 不读 Source。design 层的 Reviewer 原来不限读范围，能翻原作；
	// 在忠实抽取的评测作品里，它拿原作当标准就成了「像不像原作」，不是 Design 本身成不成立。
	await withProject(async (project) => {
		const seen: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("review", { layer: "design" }),
					call("read", { path: "source/访谈/material.txt" }),
					(context) => {
						seen.push(lastToolText(context));
						return call("read", { path: "outline/story/index.yaml" });
					},
					(context) => {
						seen.push(lastToolText(context));
						return passReview();
					},
					reply("审完了"),
				]),
			}),
			"审一下设计",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(seen[0] ?? "", /permission_denied/u);
		assert.match(seen[1] ?? "", /beat-0001/u, "Target 照常可读");
	});
});

test("impact 与 search 也查 Source 的抽取：读到后文要回头修人物档与前面的 Beat 时召回得到", async () => {
	// Source extraction 与 Target 是同一套 Design 语义，查询原来只认 Target：抽取读到后文揭示、要回头补铺垫时，
	// 找不到前面哪些 Beat 涉及这个人物或物品。CLI 的 search 早有 --source，Agent 的 search 与 impact 都没有。
	await withProject(async (project, checkoutPath) => {
		for (const [path, content] of extractionFiles) {
			await mkdir(dirname(join(checkoutPath, path)), { recursive: true });
			await writeFile(join(checkoutPath, path), content);
		}
		const candidate = await project.checkoutCandidate();
		const person = storyImpact(candidate, { kind: "character", id: "黄盖" }, "访谈");
		assert.deepEqual(person.storyBeatIds, ["beat-0001", "beat-0002"]);
		assert.ok(person.paths.includes("source/访谈/world/characters/黄盖.md"));
		assert.ok(person.paths.includes("source/访谈/outline/story/vol-0001/beat-0001.md"));
		assert.deepEqual(storyImpact(candidate, { kind: "beat", id: "beat-0001" }, "访谈").dependentStoryBeatIds, [
			"beat-0002",
		]);

		const results: string[] = [];
		let extractor = "";
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("impact", { subject: "resource:火船", sourceId: "访谈" }),
					(context) => {
						results.push(lastToolText(context));
						return call("search", { query: "旧友", sourceId: "访谈" });
					},
					(context) => {
						results.push(lastToolText(context));
						return call("delegate", { profile: "source-extractor", sourceId: "访谈", goal: "回头补铺垫" });
					},
					(context) => {
						extractor = JSON.stringify(context.messages[0]);
						return call("submit_task", { summary: "先停" });
					},
					reply("好"),
				]),
			}),
			"查一下火船涉及哪些节",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(results[0] ?? "", /source\/访谈\/outline\/story\/vol-0001\/beat-0002\.md/u);
		assert.match(results[1] ?? "", /source\/访谈\/world\/characters\/旧友\.md/u);
		assert.doesNotMatch(results[1] ?? "", /material\.txt/u, "原文按字检索走 search_source");
		assert.match(extractor, /"impact"/u, "抽取子任务也拿得到 impact");
	});
});

test("分段抽取：带 span 与 beatRange 的 source-extractor 直接读原文写这段的 Beat，只写自己号段与这段的笔记", async () => {
	// Harness 设计第 9 节「Source 抽取的分工」：分段抽取 → 整合 → 补全 → 统一修。各段直接写 Beat（写好的 Beat 就是笔记
	// 该有的样子），不建全书对象；号段与笔记路径由范围定，并行时写入不重叠。
	await withProject(async (project) => {
		let system = "";
		let prompt = "";
		const results: string[] = [];
		const step = (next: () => ReturnType<typeof call>) => (context: Context) => {
			results.push(lastToolText(context));
			return next();
		};
		const beat = (id: string) => `source/访谈/outline/story/vol-0001/${id}.md`;
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", {
						profile: "source-extractor",
						sourceId: "访谈",
						goal: "抽取第一段",
						span: [0, total],
						beatRange: { from: 101, to: 199 },
					}),
					(context) => {
						system = JSON.stringify(context.messages[0]);
						prompt = JSON.stringify(context.messages[1]);
						return call("write", {
							path: beat("beat-0101"),
							content: "---\nrefs:\n  character: [黄盖]\n---\n黄盖找到火船。\n",
						});
					},
					step(() => call("write", { path: beat("beat-0201"), content: "越过号段。\n" })),
					step(() =>
						call("write", { path: "source/访谈/world/characters/黄盖.md", content: "全书对象归整合。\n" }),
					),
					step(() =>
						call("write", {
							path: "source/访谈/notes/0101-0199.md",
							content: note("f".repeat(64), [0, total], "黄盖找到火船，拒绝烧毁。"),
						}),
					),
					step(() => call("submit_task", { summary: "这段写完" })),
					reply("好"),
				]),
			}),
			"分段抽取访谈",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(system, /分段抽取/u);
		assert.match(prompt, /beat-0101–beat-0199/u, "号段写进输入");
		assert.match(prompt, /source\/访谈\/notes\/0101-0199\.md/u, "笔记路径写进输入");
		assert.doesNotMatch(results[0] ?? "", /permission_denied/u, "号段内的 Beat 能写");
		assert.match(results[1] ?? "", /permission_denied/u, "号段外的 Beat 不能写");
		assert.match(results[2] ?? "", /permission_denied/u, "人物档归整合");
		assert.doesNotMatch(results[3] ?? "", /permission_denied/u, "这段的笔记能写");
	});
});

test("分段抽取时还没有 index，impact 查这份 Source 是回到子任务手里的拒绝，指向 search；子任务照常交付，turn 不崩", async () => {
	// 10-03 前 24 章第五圈：两段并行，第二段的 extractor 写完 Beat 后 impact 自己的 beat-0103，
	// sourceExtractionDesign 抛 source_story_index_missing，子任务失败、根 turn 跟着失败，第一段 14 分钟白跑。
	await withProject(async (project) => {
		const results: string[] = [];
		const step = (next: () => ReturnType<typeof call>) => (context: Context) => {
			results.push(lastToolText(context));
			return next();
		};
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", {
						profile: "source-extractor",
						sourceId: "访谈",
						goal: "抽取第一段",
						span: [0, total],
						beatRange: { from: 101, to: 199 },
					}),
					call("write", {
						path: "source/访谈/outline/story/vol-0001/beat-0101.md",
						content: "---\ntitle: 收到火船\nrefs:\n  character: [黄盖]\n---\n黄盖收到旧友寄来的火船。\n",
					}),
					step(() => call("impact", { subject: "beat:beat-0101", sourceId: "访谈" })),
					step(() => call("search", { query: "火船", sourceId: "访谈" })),
					step(() => call("submit_task", { summary: "写完这段" })),
					reply("好"),
				]),
			}),
			"分段抽取访谈",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(results[1] ?? "", /source_story_index_missing/u);
		assert.match(results[1] ?? "", /search/u, "告诉它现在怎么查");
		assert.match(results[2] ?? "", /beat-0101\.md/u, "search 不依赖 index，照常命中");
		assert.deepEqual(
			project.loadExecutionState().tasks.map((task) => task.status),
			["completed"],
		);
	});
});

test("补全：已有 index 时带范围的 source-extractor 拿到整份抽取，带着后文回头读这段原文，只改自己号段的 Beat", async () => {
	// 没被强调的伏笔只有知道后文揭示才认得出，所以查漏放在整合之后；它是抽取的第二遍，不是只读的审稿。
	await withProject(async (project, checkoutPath) => {
		for (const [path, content] of extractionFiles) {
			await mkdir(dirname(join(checkoutPath, path)), { recursive: true });
			await writeFile(join(checkoutPath, path), content);
		}
		let system = "";
		let prompt = "";
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", {
						profile: "source-extractor",
						sourceId: "访谈",
						goal: "补全第一段",
						span: [0, total],
						beatRange: { from: 1, to: 1 },
					}),
					(context) => {
						system = JSON.stringify(context.messages[0]);
						prompt = JSON.stringify(context.messages[1]);
						return call("edit", {
							path: "source/访谈/outline/story/vol-0001/beat-0001.md",
							oldText: "决定先不公开",
							newText: "决定先不公开，把它藏进袖中",
						});
					},
					(context) => {
						results.push(lastToolText(context));
						return call("write", {
							path: "source/访谈/outline/story/vol-0001/beat-0002.md",
							content: "越界。\n",
						});
					},
					(context) => {
						results.push(lastToolText(context));
						return call("submit_task", { summary: "补了藏信；beat-0002 应连 refs.beat 到 beat-0001（已连）" });
					},
					reply("好"),
				]),
			}),
			"补全访谈第一段",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(system, /补全/u);
		assert.doesNotMatch(system, /分段抽取：/u);
		assert.match(prompt, /旧友劝黄盖烧掉火船/u, "输入里带着整份抽取");
		assert.doesNotMatch(results[0] ?? "", /permission_denied/u);
		assert.match(results[1] ?? "", /permission_denied/u, "别的段的 Beat 列进交付，不动手");
	});
});

test("带号段的 source-extractor 同一次回复里并行；不带范围的拿到整合的做法；source_coverage 按窗口给分段大小", async () => {
	await withProject(async (project) => {
		let coverage = "";
		let integrator = "";
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("source_coverage", { sourceId: "访谈" }),
					(context) => {
						coverage = lastToolText(context);
						return fauxAssistantMessage([
							fauxToolCall("delegate", {
								profile: "source-extractor",
								sourceId: "访谈",
								goal: "第一段",
								span: [0, 20],
								beatRange: { from: 101, to: 199 },
							}),
							fauxToolCall("delegate", {
								profile: "source-extractor",
								sourceId: "访谈",
								goal: "第二段",
								span: [20, total],
								beatRange: { from: 201, to: 299 },
							}),
						]);
					},
					// 两个子任务并发取用 faux 回复，顺序不定，所以回复对称
					call("submit_task", { summary: "写完一段" }),
					call("submit_task", { summary: "写完一段" }),
					call("delegate", { profile: "source-extractor", sourceId: "访谈", goal: "整合" }),
					(context) => {
						integrator = JSON.stringify(context.messages[0]);
						return call("submit_task", { summary: "整合完" });
					},
					reply("好"),
				]),
			}),
			"分段抽取访谈",
		);
		assert.equal(outcome.failure, undefined);
		// faux 模型的窗口是 128000，分段取两成（中文约一字一 token）
		const plan = JSON.parse(coverage) as { segmentCodePoints?: number; segments?: unknown };
		assert.equal(plan.segmentCodePoints, 25600);
		assert.deepEqual(plan.segments, [{ span: [0, total], beatRange: { from: 1, to: 9999 } }], "一段装得下就一段");
		const tasks = project
			.loadExecutionState()
			.tasks.filter((task) => task.status === "completed")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		assert.equal(tasks.length, 3);
		assert.ok((tasks[1]?.createdAt ?? "") <= (tasks[0]?.updatedAt ?? ""), "第二段在第一段结束前就开始了");
		assert.match(integrator, /整合/u);
	});
});

test("delegate 的说明写明 Source 抽取的计划：分段抽取、整合、补全、统一修、审稿一轮", async () => {
	await withProject(async (project) => {
		let system = "";
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					(context) => {
						system = JSON.stringify(context.messages[0]);
						return reply("好");
					},
				]),
			}),
			"抽取访谈",
		);
		assert.match(system, /分段抽取.*整合.*补全.*统一修.*review 一轮/u);
		// 10-03 前 12 章第三圈：一段装得下，根 Agent 派了一个不带范围的抽取，没人写笔记，只好自己把原文读一遍补覆盖
		assert.match(system, /只有一段也这样派：笔记由它写/u);
		// 10-03 前 24 章：根 Agent 只派了第一段，goal 里要它「说明本段引向下一段的状态」，打算串行交接
		assert.match(system, /segments 的每一段各委派一个/u);
		assert.match(system, /不要让前一段给后一段交代状态/u);
	});
});

test("story_guide 带 topic 返回 Story Language 语义原文，不带时照旧给字段形状", async () => {
	await withProject(async (project) => {
		const results: string[] = [];
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("story_guide", { topic: "character" }),
					(context) => {
						results.push(lastToolText(context));
						return call("story_guide", { namespace: "source", sourceId: "访谈" });
					},
					(context) => {
						results.push(lastToolText(context));
						return reply("读完了");
					},
				]),
			}),
			"先看人物档怎么写",
		);
		assert.equal(outcome.failure, undefined);
		assert.match(results[0] ?? "", /^# Character/u);
		assert.match(results[1] ?? "", /^# Source Story Language machine shape/u);
	});
});

test("笔记没覆盖全文时 Source Review 是回到 Agent 手里的工具错误；补上笔记后可审", async () => {
	await withProject(async (project) => {
		let rejected = 0;
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("source_coverage", { sourceId: "访谈" }),
					(context) => {
						const { materialSha256 } = JSON.parse(lastToolText(context)) as { materialSha256: string };
						return call("write", {
							path: "source/访谈/notes/1.md",
							content: note(materialSha256, [0, 10], "只读了开头。"),
						});
					},
					call("review", { layer: "source", sourceId: "访谈" }),
					(context) => {
						assert.match(lastToolText(context), /material_coverage_incomplete|没有覆盖/u);
						rejected++;
						return call("source_coverage", { sourceId: "访谈" });
					},
					(context) => {
						const { materialSha256, gaps } = JSON.parse(lastToolText(context)) as {
							materialSha256: string;
							gaps: [number, number][];
						};
						assert.deepEqual(gaps, [[10, total]]);
						return call("write", {
							path: "source/访谈/notes/2.md",
							content: note(materialSha256, [10, total], "其余部分：他去见旧友，旧友劝烧信。"),
						});
					},
					// 读完还要有抽取才有可审的东西
					call("write", {
						path: "source/访谈/outline/story/index.yaml",
						content:
							"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001]\n",
					}),
					call("write", {
						path: "source/访谈/outline/story/vol-0001/beat-0001.md",
						content: "---\ntitle: 火船\n---\n他拿着火船去见旧友，旧友劝他烧信。\n",
					}),
					call("review", { layer: "source", sourceId: "访谈" }),
					passReview(),
					call("commit", { summary: "笔记与审稿一起提交" }),
					reply("补读后审查通过"),
				]),
			}),
			"读访谈材料并审查",
		);
		assert.equal(rejected, 1);
		assert.equal(outcome.failure, undefined);
		assert.equal(project.loadExecutionState().sessions.length, 1);
		const committed = await project.checkoutCandidate();
		assert.deepEqual(sourceCoverage(committed, "访谈").gaps, []);
		assert.equal(reviewsIn(committed).length, 1);
	});
});
