import { sha256Hex } from "./canonical.js";
import { SuimError } from "./errors.js";
import { normalizeExactText } from "./intent-exact.js";
import type { CreativeIntent } from "./parse-book.js";
import type { StoryBeat, StoryOutline } from "./story-outline.js";

export interface StoryTextDocument {
	storyBeatId: string;
	text: string;
}

export interface StoryTextFile {
	storyBeatId: string;
	sha256: string;
	codePoints: number;
}

export interface StoryTextVerificationFailure {
	storyBeatId: string;
	code: "missing_text" | "empty_text" | "orphan_text" | "exact_intent_missing";
	message: string;
}

export interface StoryTextVerificationResult {
	passed: boolean;
	checkedStoryBeatIds: string[];
	files: StoryTextFile[];
	failures: StoryTextVerificationFailure[];
}

/**
 * 这条 Intent 管不管这一节：全书 Intent 管每一节，区间 Intent 管首尾之间（含两端）。写作依据选 Intent、正文时效取
 * Design 闭包、`impact` 找受影响的节都用这一条，三处必须一致——写的时候读到的，才是改了会让正文过时的。
 */
export function intentCoversBeat(
	intent: CreativeIntent,
	beat: StoryBeat,
	ordinals: ReadonlyMap<string, number>,
): boolean {
	if (intent.target.kind === "book") return true;
	const from = ordinals.get(intent.target.fromStoryBeatId);
	const to = ordinals.get(intent.target.toStoryBeatId);
	return from !== undefined && to !== undefined && beat.ordinal >= from && beat.ordinal <= to;
}

/**
 * exact Intent 的逐字核对：范围内的正文拼起来，每段逐字要求都要出现。`only` 给定时只核对覆盖那一节、且范围正文
 * 已经齐全的 Intent（单节检查不该因为别的节还没写而报错），失败记在那一节上。
 */
function exactIntentFailures(
	story: StoryOutline,
	intents: readonly CreativeIntent[],
	textByStoryBeatId: ReadonlyMap<string, string>,
	only?: StoryBeat,
): StoryTextVerificationFailure[] {
	const ordinals = new Map(story.beats.map((beat) => [beat.id, beat.ordinal]));
	const failures: StoryTextVerificationFailure[] = [];
	for (const intent of intents) {
		if (intent.exactFragments.length === 0) continue;
		const range = story.beats.filter((beat) => intentCoversBeat(intent, beat, ordinals));
		if (range.length === 0) continue;
		if (only !== undefined) {
			if (!range.includes(only) || !range.every((beat) => textByStoryBeatId.has(beat.id))) continue;
		}
		const normalizedTarget = normalizeExactText(range.map((beat) => textByStoryBeatId.get(beat.id) ?? "").join(""));
		for (const [index, fragment] of intent.exactFragments.entries()) {
			if (normalizedTarget.includes(normalizeExactText(fragment))) continue;
			failures.push({
				storyBeatId: only?.id ?? (range[0] as StoryBeat).id,
				code: "exact_intent_missing",
				message: `${intent.id} 的第 ${index + 1} 段逐字要求没有出现在目标正文范围里`,
			});
		}
	}
	return failures;
}

export function verifyStoryText(
	story: StoryOutline,
	intents: readonly CreativeIntent[],
	documents: readonly StoryTextDocument[],
	storyBeatId?: string,
): StoryTextVerificationResult {
	const selected = storyBeatId === undefined ? story.beats : story.beats.filter((beat) => beat.id === storyBeatId);
	if (storyBeatId !== undefined && selected.length === 0) {
		throw new SuimError("story_beat_not_found", `StoryBeat not found: ${storyBeatId}`);
	}
	const textByStoryBeatId = new Map<string, string>();
	for (const document of documents) {
		if (textByStoryBeatId.has(document.storyBeatId)) {
			throw new SuimError("duplicate_story_text", `Duplicate StoryText for ${document.storyBeatId}`);
		}
		textByStoryBeatId.set(document.storyBeatId, document.text);
	}
	const failures: StoryTextVerificationFailure[] = [];
	for (const beat of selected) {
		const text = textByStoryBeatId.get(beat.id);
		if (text === undefined) {
			failures.push({ storyBeatId: beat.id, code: "missing_text", message: `还没有正文 text/${beat.id}.md` });
		} else if (text.trim().length === 0) {
			failures.push({ storyBeatId: beat.id, code: "empty_text", message: `text/${beat.id}.md 是空的` });
		}
	}
	if (storyBeatId === undefined) {
		const known = new Set(story.beats.map((beat) => beat.id));
		for (const document of documents) {
			if (known.has(document.storyBeatId)) continue;
			failures.push({
				storyBeatId: document.storyBeatId,
				code: "orphan_text",
				message: `text/${document.storyBeatId}.md 没有对应到恰好一个 StoryBeat`,
			});
		}
		if (!failures.some((failure) => failure.code === "missing_text" || failure.code === "empty_text")) {
			failures.push(...exactIntentFailures(story, intents, textByStoryBeatId));
		}
	} else if (failures.length === 0) {
		failures.push(...exactIntentFailures(story, intents, textByStoryBeatId, selected[0]));
	}
	return {
		passed: failures.length === 0,
		checkedStoryBeatIds: selected.map((beat) => beat.id),
		files: documents.map((document) => ({
			storyBeatId: document.storyBeatId,
			sha256: sha256Hex(document.text),
			codePoints: [...document.text].length,
		})),
		failures,
	};
}
