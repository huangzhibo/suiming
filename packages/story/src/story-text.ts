import { sha256Hex } from "./canonical.js";
import { SuimError } from "./errors.js";
import { normalizeExactText } from "./intent-exact.js";
import type { CreativeIntent } from "./parse-book.js";
import type { StoryOutline } from "./story-outline.js";

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

function exactIntentFailures(
	story: StoryOutline,
	intents: readonly CreativeIntent[],
	textByStoryBeatId: ReadonlyMap<string, string>,
): StoryTextVerificationFailure[] {
	const ordinal = new Map(story.beats.map((beat) => [beat.id, beat.ordinal]));
	const failures: StoryTextVerificationFailure[] = [];
	for (const intent of intents) {
		if (intent.exactFragments.length === 0) continue;
		const from = intent.target.kind === "book" ? 0 : ordinal.get(intent.target.fromStoryBeatId);
		const to = intent.target.kind === "book" ? story.beats.length - 1 : ordinal.get(intent.target.toStoryBeatId);
		if (from === undefined || to === undefined || from > to) continue;
		const targetText = story.beats
			.filter((beat) => beat.ordinal >= from && beat.ordinal <= to)
			.map((beat) => textByStoryBeatId.get(beat.id) ?? "")
			.join("");
		const normalizedTarget = normalizeExactText(targetText);
		for (const [index, fragment] of intent.exactFragments.entries()) {
			if (normalizedTarget.includes(normalizeExactText(fragment))) continue;
			failures.push({
				storyBeatId: intent.target.kind === "book" ? (story.beats[0]?.id ?? "*") : intent.target.fromStoryBeatId,
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
