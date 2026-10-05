import { Type } from "@earendil-works/pi-ai";
import { sha256Hex } from "@suiming/story";
import { designFrame } from "../artifact/design-frame.js";
import { ArtifactError } from "../artifact/errors.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import { executionJsonBytes } from "../execution/execution-object-codec.js";
import type { SessionRecord } from "../execution/types.js";
import { SuimingHarnessError } from "./errors.js";
import { withConstitution } from "./prompts.js";
import type { SuimingHarness, TurnOptions } from "./suiming-harness.js";
import { ToolRejection } from "./tool.js";
import { submitTool } from "./tools.js";
import { compileWriteContext, precedingStoryText, styleEvidenceFor } from "./write-context.js";

/**
 * 盲读评委（路线图 R 节，2026-09-06 作者提出）：同一个 StoryBeat 的多版正文匿名打乱后交给隔离的评委，
 * 按作者盲读记录里的口径排序。它只做预筛与回归，不是作品裁决，也不是 Reward：
 * - 评委用 `judge` profile，应与 Writer 不同的模型；结果记下是否与 Writer 同模型；
 * - 同一批候选跑多个顺序（默认两个：一正一反）取平均名次，压位置偏差；
 * - 每轮是一个只读 Task，结果作为 Task 结果持久化，不新增任何记录类型；
 * - 与作者盲读的一致率由作者记录对照，不在这里计算。
 */
export interface RankCandidate {
	label: string;
	text: string;
}

export type StartRankRunInput = Pick<TurnOptions, "signal" | "onEvent"> & {
	storyBeatId: string;
	candidates: readonly RankCandidate[];
	/** 评委轮数（每轮一个不同的候选顺序），1 到 4，默认 2。 */
	rounds?: number;
	/** 作者这次特别想比的点，原样交给评委。 */
	goal?: string;
	/** 评委口径，默认 constitution。见 RankRubric。 */
	rubric?: RankRubric;
};

/**
 * 评委口径。constitution：按本作宪法与写作准则评，给 Design 与意图，用来在本作的几份候选里挑一份。
 * reader：不带本作的宪法与写作准则、不给 Design，只给紧挨着的前文，问哪一版更像这部书接着往下写、更让人想读下去；
 * 用来对照原作或别处的参照稿。2026-10-03 斗破留出评测：默认口径与 Writer 用同一份 AI 味清单，对照原作时
 * 36 轮 35 轮判 Agent 胜，扣原作的理由正是那些条目——等于用 Writer 的考纲给原作阅卷。
 */
export type RankRubric = "constitution" | "reader";
export const RANK_RUBRICS: readonly RankRubric[] = ["constitution", "reader"];
/** 读者口径给评委的前文上限（码点），约四五章网文；够听出口气与节奏，不必整部书。 */
const READER_PRIOR_TEXT_CODE_POINTS = 12_000;

export interface RankedCandidate {
	label: string;
	averageRank: number;
	ranks: number[];
	reasons: string[];
	flaws: string[];
}

export interface RankRoundResult {
	/** 本轮的候选顺序：按盲标顺序排列的原始 label。 */
	order: string[];
	ranking: { label: string; rank: number; reason: string; flaws: string[] }[];
	summary: string;
}

export interface RankRunResult {
	storyBeatId: string;
	session: SessionRecord;
	rounds: number;
	rubric: RankRubric;
	judge: { provider: string; model: string; sameModelAsWriter: boolean };
	ranking: RankedCandidate[];
	roundResultObjectIds: string[];
}

/**
 * 每轮评委最多 3 次请求：漏排、并列或未知盲标由工具拒绝后重交，3 次够用。创作路径没有预算，
 * 这是 harness 里唯一的固定上限——评委只读、不改作品，卡住了宁可失败也不该无限重试。
 */
const JUDGE_MAX_TURNS = 3;
const MAX_ROUNDS = 4;
const BLIND_LABELS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"] as const;

export const JUDGE_SYSTEM_PROMPT =
	"你是隔离的盲读评委，替作者预筛同一个 StoryBeat 的多版正文。按一个中文长篇连载读者的口径读：人物能否让人投入、场面有没有张力、读完想不想读下一章。以下算作 AI 味与体验缺陷：旁白替人物作证或释义、同一信息或同一笔账反复复述、条件与责任写成逐项条款、人物没有页面动作或信息就改变主意、提前总结后文才发生的后果、Design 作者层的句子被搬进正文、场内时间线互相矛盾。Design 与 Intent 只用来判断正文是否兑现了本 Beat 该发生的事和风格约束，交代更全不加分，篇幅长不加分。候选顺序随机且没有来源信息：不要猜来源，不要偏好长的或先出现的。给每一版一个 1 到 n 的名次（不并列）、一句理由和它的主要缺陷，只调用 submit_ranking 提交。";

export const READER_JUDGE_SYSTEM_PROMPT =
	"你是读过这部中文网络小说前文的老读者，隔离盲读同一节接下来的几种写法。只按读者的感受排：哪一版读起来最像这部书接着往下写——人物说话的样子、叙述的口气、节奏、段落与对白的疏密、这部书惯常交代事情的方式；哪一版更让你想接着读。作者选定了样章时，文风以样章为准，前文只用来判断接不接得上；没有样章时，前文自己的写法就是标准。不要拿任何写作规范或你自己的审美去纠正这个标准，不要因为一版更规范、更干净、更克制就偏好它，也不要因为它更像原作就默认它好——像不像、想不想读，按读到的感受判断。候选顺序随机且没有来源信息：不要猜来源，不要偏好长的或先出现的。给每一版一个 1 到 n 的名次（不并列）、一句理由和它的主要缺陷（哪里不像前文、哪里读着出戏或想跳过），只调用 submit_ranking 提交。";

const SubmitRankingSchema = Type.Object(
	{
		ranking: Type.Array(
			Type.Object(
				{
					candidate: Type.String({ minLength: 1, description: "候选的盲标，如 甲" }),
					rank: Type.Integer({ minimum: 1, description: "1 最好" }),
					reason: Type.String({ minLength: 1, description: "一句理由" }),
					flaws: Type.Array(Type.String({ minLength: 1 }), { description: "主要缺陷，按系统提示里的口径点名" }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		summary: Type.String({ minLength: 1, description: "整批候选的一句总评" }),
	},
	{ additionalProperties: false },
);

function blindLabel(index: number): string {
	return BLIND_LABELS[index] ?? `候选${index + 1}`;
}

/** 由候选内容决定的稳定打乱：续跑与复跑得到同一顺序，作者才能对照评委看的是哪一版。 */
function seededOrder(candidates: readonly RankCandidate[], round: number): number[] {
	const seed = Number.parseInt(
		sha256Hex(candidates.map((item) => `${item.label}\n${item.text}`).join("\n\n")).slice(0, 8),
		16,
	);
	const order = candidates.map((_, index) => index);
	let state = seed >>> 0;
	for (let i = order.length - 1; i > 0; i -= 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		[order[i], order[j]] = [order[j] as number, order[i] as number];
	}
	if (round === 1) return order;
	if (round === 2) return [...order].reverse();
	const shift = round - 1;
	return order.map((_, index) => order[(index + shift) % order.length] as number);
}

function validateCandidates(candidates: readonly RankCandidate[]): void {
	if (candidates.length < 2) throw new SuimingHarnessError("invalid_goal", "rank needs at least two candidates");
	if (candidates.length > BLIND_LABELS.length) {
		throw new SuimingHarnessError("invalid_goal", `rank accepts at most ${BLIND_LABELS.length} candidates`);
	}
	const labels = new Set<string>();
	for (const candidate of candidates) {
		const label = candidate.label.trim();
		if (label.length === 0) throw new SuimingHarnessError("invalid_goal", "rank candidate label must not be empty");
		if (labels.has(label)) throw new SuimingHarnessError("invalid_goal", `rank candidate label repeats: ${label}`);
		labels.add(label);
		if (candidate.text.trim().length === 0) {
			throw new SuimingHarnessError("invalid_goal", `rank candidate ${label} is empty`);
		}
	}
}

function intentAndStyle(base: ArtifactCandidate, storyBeatId: string): string {
	// Write Context 已经按本 Beat 选好 Intent 与 style evidence；评委只拿这一段，不拿已有正文。
	const text = compileWriteContext(base, storyBeatId).text;
	const start = text.indexOf("## intent_and_style");
	if (start === -1) return "";
	const next = text.indexOf("\n## ", start + 1);
	return (next === -1 ? text.slice(start) : text.slice(start, next)).trim();
}

function roundResultOf(value: unknown): RankRoundResult {
	const record = value as Partial<RankRoundResult> | undefined;
	if (record === undefined || !Array.isArray(record.order) || !Array.isArray(record.ranking)) {
		throw new ArtifactError("invalid_task_result", "Rank round result is malformed");
	}
	return {
		order: record.order.map(String),
		ranking: record.ranking.map((item) => ({
			label: String(item.label),
			rank: Number(item.rank),
			reason: String(item.reason),
			flaws: Array.isArray(item.flaws) ? item.flaws.map(String) : [],
		})),
		summary: typeof record.summary === "string" ? record.summary : "",
	};
}

/** 盲读评委：脚本驱动的 session（kind = rank），不改作品，只把每轮排序与合并结果作为执行对象持久化。 */
export async function runRankExperiment(engine: SuimingHarness, input: StartRankRunInput): Promise<RankRunResult> {
	const storyBeatId = input.storyBeatId.trim();
	if (storyBeatId.length === 0) throw new SuimingHarnessError("invalid_goal", "storyBeatId must not be empty");
	const candidates = input.candidates.map((item) => ({ label: item.label.trim(), text: item.text }));
	validateCandidates(candidates);
	const rounds = Math.min(MAX_ROUNDS, Math.max(1, Math.trunc(input.rounds ?? 2)));
	const goal = input.goal?.trim();
	const rubric = input.rubric ?? "constitution";
	if (!RANK_RUBRICS.includes(rubric)) throw new SuimingHarnessError("invalid_goal", `unknown rank rubric: ${rubric}`);
	const created = await engine.createSession({ kind: "rank" });
	const outcome = await engine.turn(
		created.id,
		{
			...(input.signal === undefined ? {} : { signal: input.signal }),
			...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
		},
		async (session) => {
			const base = session.base;
			let frame: ReturnType<typeof designFrame>;
			try {
				frame = designFrame(base, { seeds: [{ kind: "beat", id: storyBeatId }] });
			} catch {
				throw new ArtifactError(
					"story_beat_not_found",
					`StoryBeat not found in the current Design: ${storyBeatId}`,
				);
			}
			if (!frame.text.includes(`/${storyBeatId}.md"`)) {
				throw new ArtifactError(
					"story_beat_not_found",
					`StoryBeat not found in the current Design: ${storyBeatId}`,
				);
			}
			const intents = rubric === "constitution" ? intentAndStyle(base, storyBeatId) : "";
			const prior = rubric === "reader" ? precedingStoryText(base, storyBeatId, READER_PRIOR_TEXT_CODE_POINTS) : "";
			// 真实创作里前文质量参差、甚至没有前文；作者选定的样章才是「这部书该这么写」
			const samples = rubric === "reader" ? styleEvidenceFor(base, storyBeatId) : [];

			const judge = await engine.bindModel("judge");
			let sameModelAsWriter = false;
			try {
				const writer = await engine.bindModel("writer");
				sameModelAsWriter =
					writer.snapshot.provider === judge.snapshot.provider && writer.snapshot.model === judge.snapshot.model;
			} catch {
				// Writer profile 绑不上（例如没有凭据）时无法比较，按不同处理。
			}

			const roundResults: RankRoundResult[] = [];
			const roundResultObjectIds: string[] = [];
			for (let round = 1; round <= rounds; round += 1) {
				const order = seededOrder(candidates, round);
				const blindToLabel = new Map(
					order.map((index, position) => [blindLabel(position), candidates[index]?.label as string]),
				);
				const listing = order
					.map(
						(index, position) =>
							`--- 候选${blindLabel(position)} ---\n${candidates[index]?.text.trim()}\n--- 候选${blindLabel(position)} 结束 ---`,
					)
					.join("\n\n");
				let submitted: RankRoundResult | undefined;
				const result = await session.executeTask({
					key: `rank.round:${round}`,
					profileId: "judge",
					policy: "read",
					readable: () => false,
					systemPrompt: rubric === "reader" ? READER_JUDGE_SYSTEM_PROMPT : withConstitution(JUDGE_SYSTEM_PROMPT),
					prompt: (rubric === "reader"
						? [
								`接下来这一节有 ${candidates.length} 种写法，第 ${round} / ${rounds} 轮（每轮顺序不同）。`,
								goal === undefined ? "" : `作者这次特别要比的：\n${goal}`,
								samples.length === 0
									? ""
									: `# 作者选定的样章（这部书该怎么写，文风以它为准）\n\n${samples.map((item) => `## ${item.id}\n${item.text}`).join("\n\n")}`,
								"# 前文（紧挨着这一节）",
								prior.length > 0 ? prior : "（没有前文）",
								"# 这一节的几种写法",
								listing,
							]
						: [
								`StoryBeat：${storyBeatId}，${candidates.length} 版候选，第 ${round} / ${rounds} 轮（每轮顺序不同）。`,
								goal === undefined ? "" : `作者这次特别要比的：\n${goal}`,
								"# 本 Beat 的 Design（只用来判断兑现与约束）",
								frame.text,
								intents,
								"# 候选正文",
								listing,
							]
					)
						.filter((part) => part.length > 0)
						.join("\n\n"),
					maxTurns: JUDGE_MAX_TURNS,
					tools: () => [
						submitTool({
							name: "submit_ranking",
							description: `提交本轮 ${candidates.length} 版候选的完整名次：每个盲标恰好一次，名次 1 到 ${candidates.length} 各用一次。`,
							parameters: SubmitRankingSchema,
							onSubmit: (params) => {
								const seen = new Set<string>();
								const ranks = new Set<number>();
								const ranking = params.ranking.map((item) => {
									const blind = item.candidate.replace(/^候选/u, "").trim();
									const label = blindToLabel.get(blind);
									if (label === undefined)
										throw new ToolRejection("invalid_ranking", `未知的候选盲标：${item.candidate}`);
									if (seen.has(blind)) throw new ToolRejection("invalid_ranking", `候选${blind} 出现了两次`);
									seen.add(blind);
									if (item.rank > candidates.length)
										throw new ToolRejection("invalid_ranking", `名次 ${item.rank} 超出候选数`);
									if (ranks.has(item.rank))
										throw new ToolRejection("invalid_ranking", `名次 ${item.rank} 用了两次，不能并列`);
									ranks.add(item.rank);
									return {
										label,
										rank: item.rank,
										reason: item.reason.trim(),
										flaws: item.flaws.map((flaw) => flaw.trim()),
									};
								});
								if (seen.size !== candidates.length) {
									throw new ToolRejection(
										"invalid_ranking",
										`只给了 ${seen.size} 版名次，共 ${candidates.length} 版都要排`,
									);
								}
								submitted = {
									order: order.map((index) => candidates[index]?.label as string),
									ranking: ranking.sort((left, right) => left.rank - right.rank),
									summary: params.summary.trim(),
								};
								return "已记录本轮名次。";
							},
						}),
					],
					result: () => submitted,
					resultMediaType: "application/vnd.suiming.rank-round-result+json",
				});
				roundResults.push(roundResultOf(result.result));
				roundResultObjectIds.push(result.resultObjectId);
			}

			const ranking: RankedCandidate[] = candidates.map((candidate) => {
				const entries = roundResults.map(
					(result) =>
						result.ranking.find((item) => item.label === candidate.label) as RankRoundResult["ranking"][number],
				);
				const ranks = entries.map((entry) => entry.rank);
				return {
					label: candidate.label,
					averageRank: ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length,
					ranks,
					reasons: entries.map((entry) => entry.reason),
					flaws: [...new Set(entries.flatMap((entry) => entry.flaws))],
				};
			});
			ranking.sort(
				(left, right) =>
					left.averageRank - right.averageRank ||
					(left.ranks[0] as number) - (right.ranks[0] as number) ||
					left.label.localeCompare(right.label),
			);

			const summary = {
				schemaVersion: 1,
				storyBeatId,
				rounds,
				rubric,
				judge: { provider: judge.snapshot.provider, model: judge.snapshot.model, sameModelAsWriter },
				ranking,
				roundResultObjectIds,
			};
			const object = await engine.project.saveExecutionObject(
				"application/vnd.suiming.rank-result+json",
				executionJsonBytes(summary),
			);
			session.throwIfInterrupted();
			session.execution.recordSessionResult(`${session.sessionId}:result`, session.sessionId, {
				kind: "object",
				id: object.id,
			});
			return { judge: summary.judge, ranking, roundResultObjectIds };
		},
	);
	if (outcome.value === undefined)
		throw new SuimingHarnessError(
			outcome.failure?.code ?? "run_interrupted",
			outcome.failure?.message ?? "盲读评比被打断",
		);
	return { storyBeatId, session: outcome.session, rounds, rubric, ...outcome.value };
}
