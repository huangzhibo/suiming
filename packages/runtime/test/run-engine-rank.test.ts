import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	runRankExperiment,
	SuimingHarness,
	SuimingHarnessError,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function gateway(responses: Responses, judgeModel = "judge-model"): ModelGateway {
	const provider = fauxProvider({
		provider: "suiming-rank-faux",
		models: [{ id: "agent-model" }, { id: "writer-model" }, { id: "judge-model" }],
	});
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: provider.provider.id, model: "agent-model" },
			reviewer: { provider: provider.provider.id, model: "agent-model" },
			writer: { provider: provider.provider.id, model: "writer-model" },
			judge: { provider: provider.provider.id, model: judgeModel },
		},
	});
}

async function withProject<T>(
	body: (project: LocalProjectService) => Promise<T>,
	extra: Record<string, string> = {},
): Promise<T> {
	const checkoutPath = await mkdtemp(join(tmpdir(), "suiming-engine-rank-"));
	await materializeOpenStoryDirectorySnapshot(checkoutPath, [
		...sampleWorkFiles(),
		...Object.entries(extra).map(([path, text]) => ({
			path,
			mediaType: "text/markdown; charset=utf-8",
			bytes: new TextEncoder().encode(text),
		})),
	]);
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "rank-1" });
		return await body(project);
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
}

/** 从 prompt 里读出本轮候选的盲标顺序，像评委一样只看到 甲 / 乙。 */
function userText(context: Context): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
}
function blindLabelsIn(context: Context): string[] {
	return [...userText(context).matchAll(/--- 候选(甲|乙|丙|丁) ---/gu)].map((match) => match[1] as string);
}

const candidates = [
	{ label: "flash", text: "李牧推开皇档的门。霉味先于灯光涌出来。他伸手取了信。" },
	{ label: "pro", text: "皇档的门吱呀一声。李牧站在门口，没有马上进去；等他出来时，袖子里多了一封信。" },
];

test("盲读评委：候选匿名打乱、每轮一个顺序、名次经校验后按原始 label 合并，结果作为执行对象持久化", async () => {
	await withProject(async (project) => {
		const orders: string[][] = [];
		const goals: boolean[] = [];
		// 评委第一轮把先出现的排第一，第二轮顺序反过来仍把先出现的排第一：两版平均名次相同，靠第一轮名次定序。
		const responses: Responses = [
			(context: Context) => {
				const labels = blindLabelsIn(context);
				orders.push(labels);
				goals.push(userText(context).includes("作者这次特别要比的：\n看谁更像人在现场"));
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: labels.map((label, index) => ({
							candidate: `候选${label}`,
							rank: index + 1,
							reason: `第 ${index + 1} 名的理由`,
							flaws: index === 0 ? [] : ["旁白替人物作证"],
						})),
						summary: "两版都能读，先出现的更紧。",
					}),
				);
			},
			(context: Context) => {
				const labels = blindLabelsIn(context);
				orders.push(labels);
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: labels.map((label, index) => ({
							candidate: label,
							rank: index + 1,
							reason: `第二轮第 ${index + 1} 名`,
							flaws: [],
						})),
						summary: "第二轮。",
					}),
				);
			},
		];
		const result = await runRankExperiment(new SuimingHarness({ project, models: gateway(responses) }), {
			storyBeatId: "beat-0001",
			candidates,
			goal: "看谁更像人在现场",
		});
		assert.equal(result.rounds, 2);
		// 作者想比的点原样交给评委（原来只断言它存进了 session 记录的 input，那个字段没人读，已删）。
		assert.deepEqual(goals, [true]);
		assert.deepEqual(result.judge, { provider: "suiming-rank-faux", model: "judge-model", sameModelAsWriter: false });
		assert.equal(orders.length, 2);
		assert.deepEqual(orders[0], ["甲", "乙"], "评委每轮看到的盲标固定，变的是盲标背后的候选");
		assert.deepEqual(result.ranking.map((item) => item.label).sort(), ["flash", "pro"]);
		for (const item of result.ranking) {
			assert.deepEqual(item.ranks.length, 2);
			assert.equal(item.averageRank, 1.5, "两轮里各排过一次第一和第二");
		}
		assert.equal(result.ranking[0]?.ranks[0], 1, "平均名次相同时第一轮第一的在前");
		assert.ok(result.ranking.some((item) => item.flaws.includes("旁白替人物作证")));
		assert.equal(result.roundResultObjectIds.length, 2);

		const snapshot = project.loadExecutionState();
		const session = snapshot.sessions.find((item) => item.id === result.session.id);
		assert.equal(session?.kind, "rank");
		assert.equal(session?.status, "idle");
		assert.deepEqual(session?.result?.kind, "object");
		const rounds = snapshot.tasks.filter((task) => task.sessionId === result.session.id);
		assert.deepEqual(
			rounds.map((task) => [task.kind, task.status]),
			[
				["rank.round", "completed"],
				["rank.round", "completed"],
			],
		);
		assert.ok(rounds.every((task) => task.model?.modelProfileId === "judge"));
		const stored = JSON.parse(
			new TextDecoder().decode((await project.readExecutionObject(session?.result?.id as string)).bytes),
		) as { ranking: { label: string }[]; judge: { model: string } };
		assert.equal(stored.ranking.length, 2);
		assert.equal(stored.judge.model, "judge-model");
		// 每轮结果里记着本轮顺序：作者能对照评委看的是哪一版。
		const round = JSON.parse(
			new TextDecoder().decode((await project.readExecutionObject(result.roundResultObjectIds[0] as string)).bytes),
		) as { result: { order: string[] } };
		const second = JSON.parse(
			new TextDecoder().decode((await project.readExecutionObject(result.roundResultObjectIds[1] as string)).bytes),
		) as { result: { order: string[] } };
		assert.deepEqual([...round.result.order].sort(), ["flash", "pro"]);
		assert.deepEqual(second.result.order, [...round.result.order].reverse(), "第二轮是第一轮的反序");
	});
});

test("盲读评委：漏排、并列或未知盲标被工具拒绝并让评委重交；评委与 Writer 同模型时如实标出", async () => {
	await withProject(async (project) => {
		let attempts = 0;
		const responses: Responses = [
			(context: Context) => {
				attempts += 1;
				const labels = blindLabelsIn(context);
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: [{ candidate: labels[0] as string, rank: 1, reason: "只排了一版", flaws: [] }],
						summary: "漏排",
					}),
				);
			},
			(context: Context) => {
				attempts += 1;
				const labels = blindLabelsIn(context);
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: labels.map((label) => ({ candidate: label, rank: 1, reason: "并列", flaws: [] })),
						summary: "并列",
					}),
				);
			},
			(context: Context) => {
				attempts += 1;
				const labels = blindLabelsIn(context);
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: labels.map((label, index) => ({
							candidate: label,
							rank: index + 1,
							reason: "好了",
							flaws: [],
						})),
						summary: "第三次才对",
					}),
				);
			},
		];
		const result = await runRankExperiment(
			new SuimingHarness({ project, models: gateway(responses, "writer-model") }),
			{
				storyBeatId: "beat-0001",
				candidates,
				rounds: 1,
			},
		);
		assert.equal(attempts, 3);
		assert.equal(result.rounds, 1);
		assert.equal(result.judge.sameModelAsWriter, true);
		assert.equal(result.ranking.length, 2);

		await assert.rejects(
			runRankExperiment(new SuimingHarness({ project, models: gateway([]) }), {
				storyBeatId: "beat-0001",
				candidates: [candidates[0] as (typeof candidates)[number]],
			}),
			(error: unknown) => error instanceof SuimingHarnessError && error.code === "invalid_goal",
		);
		await assert.rejects(
			runRankExperiment(new SuimingHarness({ project, models: gateway([]) }), {
				storyBeatId: "beat-0099",
				candidates,
			}),
			(error: unknown) => error instanceof SuimingHarnessError && error.code === "story_beat_not_found",
		);
	});
});

test("读者口径的评委：不带宪法与写作准则、不看 Design，只拿紧挨着的前文，问哪一版更像这部书接着往下写", async () => {
	// 2026-10-03 斗破留出评测：默认评委与 Writer 用同一份 AI 味清单、还带宪法，对照原作时 36 轮 35 轮判 Agent 胜，
	// 扣原作的理由正是那些条目——等于用 Writer 的考纲给原作阅卷。作者定：另加不带本作准则的评委专门对照原作。
	const prior = "## 第1章\n\n“斗之力，三段！”望着测验魔石碑，少年面无表情。\n\n族人的嘲讽从台下传来。\n";
	await withProject(
		async (project) => {
			let system = "";
			let prompt = "";
			const responses: Responses = [
				(context: Context) => {
					system = JSON.stringify(context.messages[0]);
					prompt = userText(context);
					const labels = blindLabelsIn(context);
					return fauxAssistantMessage(
						fauxToolCall("submit_ranking", {
							ranking: labels.map((label, index) => ({
								candidate: label,
								rank: index + 1,
								reason: "口气接得上前文",
								flaws: [],
							})),
							summary: "读者口径。",
						}),
					);
				},
			];
			const result = await runRankExperiment(new SuimingHarness({ project, models: gateway(responses) }), {
				storyBeatId: "beat-0002",
				candidates,
				rounds: 1,
				rubric: "reader",
			});
			assert.equal(result.rubric, "reader");
			assert.match(prompt, /少年面无表情/u, "紧挨着的前文交给评委");
			assert.doesNotMatch(prompt, /本 Beat 的 Design/u, "不给 Design");
			assert.doesNotMatch(prompt, /intent_and_style/u, "不给意图与风格");
			assert.doesNotMatch(system, /旁白替人物作证/u, "不带 Writer 的写作准则");
			assert.doesNotMatch(system, /故事创作宪法|宪法/u, "不带宪法");
			assert.match(system, /没有样章时，前文自己的写法就是标准/u);
			// 样例作品的意图选了一份样章：作者认定的写法交给评委，文风以它为准（前文质量参差或没有前文时只能靠它）
			assert.match(prompt, /作者选定的样章/u);
			assert.match(prompt, /短句，少解释/u);
			const stored = JSON.parse(
				new TextDecoder().decode(
					(
						await project.readExecutionObject(
							project.loadExecutionState().sessions.find((item) => item.id === result.session.id)?.result
								?.id as string,
						)
					).bytes,
				),
			) as { rubric: string };
			assert.equal(stored.rubric, "reader");
		},
		{ "text/beat-0001.md": prior },
	);
});

test("默认仍按本作宪法与写作准则评，结果标明口径", async () => {
	await withProject(async (project) => {
		let system = "";
		const responses: Responses = [
			(context: Context) => {
				system = JSON.stringify(context.messages[0]);
				const labels = blindLabelsIn(context);
				return fauxAssistantMessage(
					fauxToolCall("submit_ranking", {
						ranking: labels.map((label, index) => ({
							candidate: label,
							rank: index + 1,
							reason: "好",
							flaws: [],
						})),
						summary: "默认。",
					}),
				);
			},
		];
		const result = await runRankExperiment(new SuimingHarness({ project, models: gateway(responses) }), {
			storyBeatId: "beat-0001",
			candidates,
			rounds: 1,
		});
		assert.equal(result.rubric, "constitution");
		assert.match(system, /旁白替人物作证/u);
	});
});
