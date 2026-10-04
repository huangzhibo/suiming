import {
	type BoundDesign,
	buildStateTimeline,
	intentCoversBeat,
	type StateAssignment,
	type StoryBeat,
	verifyStoryText,
} from "@suiming/story";
import { isTargetArtifactIdentity, targetArtifactIdentity } from "../artifact/identity.js";
import { inspectStoryDesignCandidate } from "../artifact/story-design-validator.js";
import type { ArtifactCandidate, ArtifactIdentity, CandidateArtifact } from "../artifact/types.js";
import { SuimingHarnessError } from "./errors.js";
import { type WriterHost, writerSystemPrompt } from "./writing-methods.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** 非 previous 的前文最多从 previous 向前再扩展几步。 */
const PRIOR_TEXT_EXPANSION = 2;
/** 后文接缝只给开头这么多码点。 */
const OUTGOING_BOUNDARY_CODE_POINTS = 600;

export interface WriteContextTextSelection {
	storyBeatId: string;
	/** previous 连续向前扩展得到的为 continuous；refs.beat / 人物最近正文为 discontinuous。 */
	continuity: "continuous" | "discontinuous";
	reason: "refs.beat" | "refs.character" | "previous-expansion";
}

export interface CompiledWriteContext {
	storyBeatId: string;
	targetPath: string;
	/**
	 * Writer 的角色定义，与 Context 成对交付：谁消费是传输差异，不是内容差异。
	 * 与 `CompiledReviewContext.systemPrompt` 同一形状。
	 */
	systemPrompt: string;
	/** 渲染好的 Write Context，分区顺序固定。 */
	text: string;
	/** 进入 Context 的全部 artifact；`context compile` 把它作为 artifacts 清单交给 host。 */
	artifacts: ArtifactIdentity[];
	previousStoryBeatId?: string;
	nextStoryBeatId?: string;
	priorTexts: WriteContextTextSelection[];
	/** 目标 Beat 已有正文时为 true（修订模式）。 */
	hasCurrentText: boolean;
}

export interface StoryTextCheck {
	passed: boolean;
	codePoints: number;
	failures: string[];
}

function textArtifacts(candidate: ArtifactCandidate): Map<string, string> {
	const texts = new Map<string, string>();
	for (const artifact of candidate.artifacts) {
		if (!isTargetArtifactIdentity(artifact.identity) || artifact.identity.kind !== "story-text") continue;
		texts.set(artifact.identity.localId, decoder.decode(artifact.bytes));
	}
	return texts;
}

/**
 * 硬状态逐行打印，带作用域：客观、读者、人物各自知道什么是三件事。2026-10-02 之前只打 `subject.property = value`，
 * 读者与人物同时得知一个秘密时是两行一模一样的字，Writer 分不出谁知道。Write Context 与 frame 共用。
 */
export function renderState(state: ReadonlyMap<string, StateAssignment>): string {
	const scope = (value: string) =>
		value === "world" ? "客观" : value === "reader" ? "读者" : `人物 ${value.replace(/^character:/u, "")}`;
	const lines = [...state.values()]
		.map(
			(assignment) =>
				`${scope(assignment.scope)}：${assignment.subject}.${assignment.property} = ${JSON.stringify(assignment.value)}`,
		)
		.sort();
	return lines.length === 0 ? "（无硬状态）" : lines.join("\n");
}

/**
 * 覆盖这些 Beat 的 Intent 用 style_refs 选中的风格证据，按 Intent 顺序去重。写一节正文的 Writer 与审这段
 * 正文的 Reviewer 共用，两边看到的表达证据是同一份；没被选中的 reference 不是作品事实，谁都不默认带上。
 */
export function selectedStyleEvidence(
	candidate: ArtifactCandidate,
	book: BoundDesign,
	storyBeatIds: readonly string[],
): CandidateArtifact[] {
	const ordinals = new Map(book.story.beats.map((beat) => [beat.id, beat.ordinal]));
	const beats = book.story.beats.filter((beat) => storyBeatIds.includes(beat.id));
	const ids = new Set<string>();
	for (const intent of book.intents)
		if (beats.some((beat) => intentCoversBeat(intent, beat, ordinals)))
			for (const id of intent.styleRefs) ids.add(id);
	return [...ids].flatMap((id) =>
		candidate.artifacts.filter(
			(item) =>
				isTargetArtifactIdentity(item.identity) &&
				item.identity.kind === "style-evidence" &&
				item.identity.localId === id,
		),
	);
}

function refIds(beat: StoryBeat, kind: string): string[] {
	const prefix = `${kind}:`;
	return beat.refs.filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length));
}

function head(text: string, codePoints: number): string {
	const points = Array.from(text);
	return points.length <= codePoints ? text : `${points.slice(0, codePoints).join("")}…`;
}

/**
 * 旧仓 design.md §5.3 的前文选取：先 refs.beat 对应正文，再为未覆盖的 refs.character 补最近一次更早正文，
 * 最后从 previous 向前扩展连续正文；按故事顺序去重，previous / current / next 不在其中。
 */
function selectPriorTexts(
	book: BoundDesign,
	target: StoryBeat,
	texts: ReadonlyMap<string, string>,
	previous: StoryBeat | undefined,
): WriteContextTextSelection[] {
	const beats = book.story.beats;
	const byId = new Map(beats.map((beat) => [beat.id, beat]));
	const excluded = new Set([target.id, previous?.id]);
	const selected = new Map<string, WriteContextTextSelection>();
	const pick = (beat: StoryBeat | undefined, reason: WriteContextTextSelection["reason"]) => {
		if (beat === undefined || excluded.has(beat.id) || selected.has(beat.id) || !texts.has(beat.id)) return;
		if (beat.ordinal >= target.ordinal) return;
		selected.set(beat.id, {
			storyBeatId: beat.id,
			continuity: reason === "previous-expansion" ? "continuous" : "discontinuous",
			reason,
		});
	};
	for (const id of refIds(target, "beat")) pick(byId.get(id), "refs.beat");
	const coveredCharacters = new Set<string>();
	for (const id of selected.keys())
		for (const character of refIds(byId.get(id) as StoryBeat, "character")) coveredCharacters.add(character);
	if (previous !== undefined) for (const character of refIds(previous, "character")) coveredCharacters.add(character);
	for (const character of refIds(target, "character")) {
		if (coveredCharacters.has(character)) continue;
		const latest = [...beats]
			.filter(
				(beat) =>
					beat.ordinal < target.ordinal && refIds(beat, "character").includes(character) && texts.has(beat.id),
			)
			.sort((left, right) => right.ordinal - left.ordinal)[0];
		pick(latest, "refs.character");
	}
	if (previous !== undefined) {
		for (let step = 1; step <= PRIOR_TEXT_EXPANSION; step += 1) {
			const beat = beats.find((item) => item.ordinal === previous.ordinal - step);
			if (beat === undefined) break;
			pick(beat, "previous-expansion");
		}
	}
	return [...selected.values()].sort(
		(left, right) => (byId.get(left.storyBeatId)?.ordinal ?? 0) - (byId.get(right.storyBeatId)?.ordinal ?? 0),
	);
}

/**
 * Write Context（ADR-0009 决定 13）：只装入当前 Beat 的自然语言 Design、它引用的世界基底、硬状态、
 * 本 Beat 实际触及的 Contract、适用 Intent 与 style evidence、按规则选出的真实前文与后文接缝。
 * 不装入其它 Beat 的细纲；其它未来信息由 Agent 的 brief 提供。
 */
/**
 * 这一节的样章：覆盖它的 Intent 用 style_refs 选中的 reference/style/<id>.md。作者认定「这部书该这么写」的依据，
 * 前文质量参差或没有前文时，文风以它为准。读者口径的评委与写正文时的段长对照共用。
 */
export function styleEvidenceFor(
	candidate: ArtifactCandidate,
	storyBeatId: string,
): { id: string; path: string; text: string }[] {
	const book = inspectStoryDesignCandidate(candidate).design;
	return selectedStyleEvidence(candidate, book, [storyBeatId]).map((artifact) => ({
		id: artifact.identity.localId,
		path: artifact.path,
		text: decoder.decode(artifact.bytes).trim(),
	}));
}

/**
 * 紧挨着某个 Beat 的连续前文：按故事顺序往前取正文，遇到没有正文的节就停，超过 codePoints 时最早那节只留结尾。
 * 读者口径的评委用它判断「像不像这部书接着往下写」；Writer 的前文另按 refs 与人物选取，见 selectPriorTexts。
 */
export function precedingStoryText(candidate: ArtifactCandidate, storyBeatId: string, codePoints: number): string {
	const beats = inspectStoryDesignCandidate(candidate).design.story.beats;
	const target = beats.find((beat) => beat.id === storyBeatId);
	if (target === undefined)
		throw new SuimingHarnessError(
			"story_beat_not_found",
			`StoryBeat not found in the current Design: ${storyBeatId}`,
		);
	const texts = textArtifacts(candidate);
	const parts: string[] = [];
	let remaining = codePoints;
	for (let ordinal = target.ordinal - 1; ordinal >= 0 && remaining > 0; ordinal -= 1) {
		const beat = beats.find((item) => item.ordinal === ordinal);
		const text = beat === undefined ? undefined : texts.get(beat.id)?.trim();
		if (text === undefined || text.length === 0) break;
		const points = Array.from(text);
		if (points.length <= remaining) {
			parts.unshift(text);
			remaining -= points.length;
		} else {
			parts.unshift(`……${points.slice(points.length - remaining).join("")}`);
			remaining = 0;
		}
	}
	return parts.join("\n\n");
}

export function compileWriteContext(
	candidate: ArtifactCandidate,
	storyBeatId: string,
	options: { host?: WriterHost } = {},
): CompiledWriteContext {
	const book = inspectStoryDesignCandidate(candidate).design;
	const beats = book.story.beats;
	const target = beats.find((beat) => beat.id === storyBeatId);
	if (target === undefined) {
		throw new SuimingHarnessError(
			"story_beat_not_found",
			`StoryBeat not found in the current Design: ${storyBeatId}`,
		);
	}
	const ordinals = new Map(beats.map((beat) => [beat.id, beat.ordinal]));
	const texts = textArtifacts(candidate);
	const previous = beats.find((beat) => beat.ordinal === target.ordinal - 1);
	const next = beats.find((beat) => beat.ordinal === target.ordinal + 1);
	const artifacts: ArtifactIdentity[] = [targetArtifactIdentity("story-beat", target.id)];
	const sections: string[] = [];

	// 1. target_story_design
	sections.push(
		[
			"## target_story_design",
			`${target.path}（顺序 ${target.ordinal + 1} / ${beats.length}，${target.volumeId}）`,
			`refs: ${target.refs.join(", ") || "无"}`,
			`contracts: open=[${target.contracts.open.join(", ")}] advance=[${target.contracts.advance.join(", ")}] resolve=[${target.contracts.resolve.join(", ")}]`,
			"",
			target.text.trim(),
		].join("\n"),
	);

	// 2. world_in_force
	const world: string[] = ["## world_in_force"];
	const identity = (kind: "character" | "place" | "resource") => {
		const entries = kind === "character" ? book.characters : kind === "place" ? book.places : book.resources;
		for (const id of refIds(target, kind)) {
			const entry = entries.find((item) => item.id === id);
			if (entry === undefined) continue;
			artifacts.push(targetArtifactIdentity(kind, entry.id));
			const initial = Object.entries(entry.initial)
				.map(([key, value]) => `${key}=${String(value)}`)
				.join(", ");
			world.push(
				`### ${kind} ${entry.name}（${entry.path}${entry.aliases.length === 0 ? "" : `，别名 ${entry.aliases.join("、")}`}${initial ? `，初始 ${initial}` : ""}）`,
				entry.body.trim() || "（无基底）",
				"",
			);
		}
	};
	identity("character");
	identity("place");
	identity("resource");
	for (const id of refIds(target, "world")) {
		const entry = book.world.find((item) => item.id === id);
		if (entry === undefined) continue;
		artifacts.push(targetArtifactIdentity("world", entry.id));
		world.push(`### world ${entry.id}（${entry.path}）`, entry.body.trim(), "");
	}
	if (world.length === 1) world.push("（本 Beat 未引用世界基底）");
	sections.push(world.join("\n").trimEnd());

	// 3. hard_state
	const timeline = buildStateTimeline(book.stateProjection);
	sections.push(
		[
			"## hard_state",
			"### 进入之前",
			renderState(timeline.stateBefore(target.id)),
			"### 结束之后",
			renderState(timeline.stateAfter(target.id)),
		].join("\n"),
	);

	// 4. authorial_lookahead：本 Beat 实际触及的 Contract
	const lookahead: string[] = ["## authorial_lookahead"];
	for (const [phase, ids] of [
		["open", target.contracts.open],
		["advance", target.contracts.advance],
		["resolve", target.contracts.resolve],
	] as const) {
		for (const id of ids) {
			const contract = book.contracts.find((item) => item.id === id);
			if (contract === undefined) continue;
			artifacts.push(targetArtifactIdentity("story-contract", contract.id));
			const deadline = contract.deadline.kind === "book_end" ? "book_end" : contract.deadline.storyBeatId;
			lookahead.push(
				`### ${phase} ${contract.id}（${contract.path}，deadline ${deadline}）`,
				contract.body.trim(),
				"",
			);
		}
	}
	if (lookahead.length === 1) lookahead.push("（本 Beat 不建立、推进或兑现 Contract）");
	sections.push(lookahead.join("\n").trimEnd());

	// 5. intent_and_style
	const intents = book.intents.filter((intent) => intentCoversBeat(intent, target, ordinals));
	const intentLines: string[] = ["## intent_and_style"];
	for (const intent of intents) {
		artifacts.push(targetArtifactIdentity("intent", intent.id));
		const targetLabel =
			intent.target.kind === "book" ? "全书" : `${intent.target.fromStoryBeatId} → ${intent.target.toStoryBeatId}`;
		intentLines.push(
			`### intent ${intent.id}（${intent.path}，${intent.appliesTo === "text" ? "正文 Intent" : "Design Intent"}，范围 ${targetLabel}）`,
			intent.body.trim(),
		);
		if (intent.exactFragments.length > 0) {
			intentLines.push(
				"必须逐字出现在范围正文中的片段：",
				...intent.exactFragments.map((fragment) => `> ${fragment}`),
			);
		}
		intentLines.push("");
	}
	// R0 观察：Writer 会猜测是否另有看不见的 exact 片段清单；这里把"没有"也说清楚。
	if (intents.every((intent) => intent.exactFragments.length === 0)) {
		intentLines.push("本 Beat 范围没有必须逐字出现的 exact 片段；check 只核对上面列出的内容。", "");
	}
	for (const artifact of selectedStyleEvidence(candidate, book, [storyBeatId])) {
		artifacts.push(artifact.identity);
		intentLines.push(
			`### style ${artifact.identity.localId}（${artifact.path}，质量证据，不是可粘贴素材）`,
			decoder.decode(artifact.bytes).trim(),
			"",
		);
	}
	if (intentLines.length === 1) intentLines.push("（没有适用于本 Beat 的 Intent）");
	sections.push(intentLines.join("\n").trimEnd());

	// 6. prior_story_text
	const priorTexts = selectPriorTexts(book, target, texts, previous);
	const prior: string[] = ["## prior_story_text"];
	for (const selection of priorTexts) {
		artifacts.push(targetArtifactIdentity("story-text", selection.storyBeatId));
		prior.push(
			`### text/${selection.storyBeatId}.md（${selection.continuity === "continuous" ? "与 previous 连续" : "非连续，只提供历史表达证据，不代表当前状态"}；来源 ${selection.reason}）`,
			(texts.get(selection.storyBeatId) ?? "").trim(),
			"",
		);
	}
	if (prior.length === 1) prior.push("（没有更早的相关正文）");
	sections.push(prior.join("\n").trimEnd());

	// 7. outgoing_story_text_boundary
	const outgoing: string[] = ["## outgoing_story_text_boundary"];
	const nextText = next === undefined ? undefined : texts.get(next.id);
	if (next !== undefined && nextText !== undefined) {
		artifacts.push(targetArtifactIdentity("story-text", next.id));
		outgoing.push(
			`### text/${next.id}.md 开头（只用于自然接入）`,
			head(nextText.trim(), OUTGOING_BOUNDARY_CODE_POINTS),
		);
	} else {
		outgoing.push("（后文尚无正文）");
	}
	sections.push(outgoing.join("\n"));

	// 8. immediate_story_text_input
	const immediate: string[] = ["## immediate_story_text_input"];
	const previousText = previous === undefined ? undefined : texts.get(previous.id);
	if (previous !== undefined && previousText !== undefined) {
		artifacts.push(targetArtifactIdentity("story-text", previous.id));
		immediate.push(`### previous text/${previous.id}.md（直接续写表面）`, previousText.trim(), "");
	} else {
		immediate.push(
			previous === undefined
				? "（这是第一个 Beat，没有 previous）"
				: `（previous ${previous.id} 尚无正文；不阻止写作）`,
			"",
		);
	}
	const currentText = texts.get(target.id);
	if (currentText !== undefined) {
		artifacts.push(targetArtifactIdentity("story-text", target.id));
		immediate.push(`### current text/${target.id}.md（待修正文）`, currentText.trim());
	} else {
		immediate.push(`### current text/${target.id}.md`, "（尚无正文）");
	}
	sections.push(immediate.join("\n").trimEnd());

	return {
		storyBeatId: target.id,
		targetPath: `text/${target.id}.md`,
		systemPrompt: writerSystemPrompt(options.host ?? "engine"),
		text: sections.join("\n\n"),
		artifacts,
		...(previous === undefined ? {} : { previousStoryBeatId: previous.id }),
		...(next === undefined ? {} : { nextStoryBeatId: next.id }),
		priorTexts,
		hasCurrentText: currentText !== undefined,
	};
}

/**
 * 单个 Beat 的确定性正文检查：文件存在且非空，Design 仍可绑定；
 * 覆盖该 Beat 的 exact Intent 在范围正文齐全时逐字核对。
 */
export function checkStoryText(candidate: ArtifactCandidate, storyBeatId: string): StoryTextCheck {
	let book: BoundDesign;
	try {
		book = inspectStoryDesignCandidate(candidate).design;
	} catch (error) {
		return {
			passed: false,
			codePoints: 0,
			failures: [`Design 无法绑定：${error instanceof Error ? error.message : String(error)}`],
		};
	}
	const texts = textArtifacts(candidate);
	const documents = [...texts.entries()].map(([id, text]) => ({ storyBeatId: id, text }));
	const failures: string[] = [];
	let perBeat: ReturnType<typeof verifyStoryText>;
	try {
		perBeat = verifyStoryText(book.story, book.intents, documents, storyBeatId);
	} catch (error) {
		return { passed: false, codePoints: 0, failures: [error instanceof Error ? error.message : String(error)] };
	}
	failures.push(...perBeat.failures.map((failure) => `${failure.code}: ${failure.message}`));
	const codePoints = Array.from(texts.get(storyBeatId) ?? "").length;
	return { passed: failures.length === 0, codePoints, failures };
}
