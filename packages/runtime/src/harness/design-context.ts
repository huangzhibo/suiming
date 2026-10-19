import { type BoundDesign, intentCoversBeat, type StoryBeat } from "@suiming/story";
import { bodyCharCount } from "../artifact/code-points.js";
import { inspectStoryDesignCandidate } from "../artifact/story-design-validator.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import { SuimingHarnessError } from "./errors.js";
import { textArtifacts } from "./write-context.js";
import { DESIGN_METHOD } from "./writing-methods.js";

/** 设计容量按最近这么多节有正文的 Beat 算：长篇前后写法会变，取近处。 */
const CAPACITY_WINDOW = 30;
/** 给定 Beat 前后各带几节 Design 原文。 */
const NEIGHBORS = 2;

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * 设计容量：按这部作品最近写成的正文算正文与 Design 的字数比。篇幅意图与 Design 分量对不上时，写手只能铺陈
 * （斗破续写里正文与 Design 之比到 8 以上，原作约 4.1）；能算的给数字，要不要补事、补多少由模型判断。
 */
export function designCapacity(candidate: ArtifactCandidate): string {
	const beats = inspectStoryDesignCandidate(candidate).design.story.beats;
	const texts = textArtifacts(candidate);
	const written = beats
		.filter((beat) => texts.has(beat.id) && bodyCharCount(beat.text) > 0)
		.slice(-CAPACITY_WINDOW)
		.map((beat) => ({ text: bodyCharCount(texts.get(beat.id) ?? ""), design: bodyCharCount(beat.text) }));
	if (written.length === 0)
		return "## 设计容量\n还没有正文，按比例估不出来；篇幅意图要的分量要由 Design 里实际发生的事撑起来。";
	const ratio = median(written.map((item) => item.text / item.design));
	return [
		"## 设计容量（按这部作品已有的正文算）",
		`最近 ${written.length} 节有正文：每节正文中位 ${Math.round(median(written.map((item) => item.text)))} 字，Design 中位 ${Math.round(median(written.map((item) => item.design)))} 字，正文约是 Design 的 ${ratio.toFixed(1)} 倍（逐节比值的中位数）。`,
		`按这个比例，一节要写 L 字正文，Design 约需 L ÷ ${ratio.toFixed(1)} 字。`,
	].join("\n");
}

/**
 * 适用的 Design 意图原文：给了 Beat 就是覆盖它的，续写就是全部。2026-10-19 验证时补：根 Agent 按审稿改 beat-0521 前取了
 * design_context，却没读意图，把抽自原作的「五星」改成「四星」；意图第一句就是「前一百二十章照原作建模，不改设定」。
 * 与 write_context 带意图同一个做法，改之前就在眼前。正文 Intent（文风）不带，那是写正文时的事。
 */
function renderIntents(book: BoundDesign, target: StoryBeat | undefined): string {
	const ordinals = new Map(book.story.beats.map((beat) => [beat.id, beat.ordinal]));
	const intents = book.intents.filter(
		(intent) => intent.appliesTo !== "text" && (target === undefined || intentCoversBeat(intent, target, ordinals)),
	);
	const heading = target === undefined ? "## 作品意图（Design）" : `## 覆盖 ${target.id} 的意图（Design）`;
	if (intents.length === 0) return `${heading}\n（没有）`;
	return [
		heading,
		...intents.map((intent) => {
			const range =
				intent.target.kind === "book"
					? "全书"
					: `${intent.target.fromStoryBeatId} → ${intent.target.toStoryBeatId}`;
			return `### ${intent.path}（范围 ${range}）\n${intent.body.trim()}`;
		}),
	].join("\n\n");
}

function renderBeat(beat: StoryBeat, total: number, written: boolean): string {
	return [
		`### ${beat.id}（${beat.path}；第 ${beat.ordinal + 1} / ${total} 节，${written ? "已有正文" : "没有正文"}；Design ${bodyCharCount(beat.text)} 字）`,
		beat.text.trim() || "（空）",
	].join("\n");
}

/**
 * 设计依据：设计方法、设计容量与给定 Beat 前后的 Design；不给 Beat 就取全书末尾，续写用。2026-10-19 补回旧 suim-design
 * 的方法时加（docs/validation/2026-10-19-old-skills-audit）。与 `write_context` 一样方法与依据成对交付：方法放进根 Agent
 * 常驻的提示，每次请求都要背着，随要做的那一步给才对。
 */
export function compileDesignContext(candidate: ArtifactCandidate, storyBeatId?: string): string {
	const book = inspectStoryDesignCandidate(candidate).design;
	const beats = book.story.beats;
	const texts = textArtifacts(candidate);
	let neighbors: readonly StoryBeat[];
	let heading: string;
	if (storyBeatId === undefined) {
		neighbors = beats.slice(-(NEIGHBORS + 1));
		heading = "## 全书末尾的 Design（续写从这里往后接）";
	} else {
		const index = beats.findIndex((beat) => beat.id === storyBeatId);
		if (index === -1)
			throw new SuimingHarnessError(
				"story_beat_not_found",
				`StoryBeat not found in the current Design: ${storyBeatId}`,
			);
		neighbors = beats.slice(Math.max(0, index - NEIGHBORS), index + NEIGHBORS + 1);
		heading = `## ${storyBeatId} 前后的 Design`;
	}
	return [
		DESIGN_METHOD,
		renderIntents(book, storyBeatId === undefined ? undefined : beats.find((beat) => beat.id === storyBeatId)),
		designCapacity(candidate),
		[
			heading,
			...(neighbors.length === 0
				? ["（还没有 Beat）"]
				: neighbors.map((beat) => renderBeat(beat, beats.length, texts.has(beat.id)))),
		].join("\n\n"),
	].join("\n\n");
}
