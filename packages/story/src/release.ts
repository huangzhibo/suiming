import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { stringify } from "yaml";
import { STORY_BEAT_ID_PATTERN } from "./book-patterns.js";
import { SHA256_PATTERN } from "./book-schema.js";
import { sha256Hex } from "./canonical.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { formatDiagnostic, SuimError } from "./errors.js";
import { REVIEW_ID_PATTERN } from "./review-file.js";

const ReleaseSpanWireSchema = Type.Object(
	{
		story_beat_id: Type.String({ pattern: STORY_BEAT_ID_PATTERN }),
		source_start: Type.Integer({ minimum: 0 }),
		source_end: Type.Integer({ minimum: 1 }),
		chapter_start: Type.Integer({ minimum: 0 }),
		chapter_end: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const ReleaseManifestWireSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		/** 发布时的 Canon revision；正文与 Design 之后有没有变由版本历史派生。 */
		revision: Type.String({ minLength: 1 }),
		/** 绑定的全书正文审稿：`review/<id>.md` 的 id。 */
		story_text_review: Type.Optional(Type.String({ pattern: REVIEW_ID_PATTERN })),
		story_text: Type.Array(
			Type.Object(
				{
					story_beat_id: Type.String({ pattern: STORY_BEAT_ID_PATTERN }),
					sha256: Type.String({ pattern: SHA256_PATTERN }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		layout: Type.Object(
			{
				target_code_points: Type.Integer({ minimum: 1 }),
				min_code_points: Type.Integer({ minimum: 1 }),
				max_code_points: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		chapters: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: "^ch-[0-9]{4}$" }),
					path: Type.String({ pattern: "^release/chapters/ch-[0-9]{4}\\.md$" }),
					code_points: Type.Integer({ minimum: 1 }),
					sha256: Type.String({ pattern: SHA256_PATTERN }),
					spans: Type.Array(ReleaseSpanWireSchema, { minItems: 1 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{
		$id: "https://suiming.dev/schemas/release-manifest-v1.json",
		additionalProperties: false,
	},
);

export type ReleaseManifestWire = Static<typeof ReleaseManifestWireSchema>;

export interface ReleaseStoryTextEvidence {
	storyBeatId: string;
	sha256: string;
}

export interface ReleaseSpan {
	storyBeatId: string;
	sourceStart: number;
	sourceEnd: number;
	chapterStart: number;
	chapterEnd: number;
}

export interface ReleaseChapter {
	id: string;
	path: string;
	codePoints: number;
	sha256: string;
	spans: ReleaseSpan[];
}

export interface ReleaseManifest {
	schemaVersion: 1;
	revision: string;
	storyTextReview?: string;
	storyText: ReleaseStoryTextEvidence[];
	layout: {
		targetCodePoints: number;
		minCodePoints: number;
		maxCodePoints: number;
	};
	chapters: ReleaseChapter[];
}

export interface ReleaseStoryTextInput {
	storyBeatId: string;
	text: string;
}

export interface DerivedReleaseChapter {
	id: string;
	path: string;
	text: string;
}

export interface DerivedRelease {
	manifest: ReleaseManifest;
	chapters: DerivedReleaseChapter[];
}

export interface DeriveReleaseInput {
	revision: string;
	storyTextReview?: string;
	storyText: readonly ReleaseStoryTextInput[];
	targetCodePoints?: number;
	minCodePoints?: number;
	maxCodePoints?: number;
}

export interface ReleaseVerificationFailure {
	code: "story_text_mismatch" | "chapter_mismatch" | "span_mismatch";
	message: string;
}

export interface ReleaseVerificationResult {
	passed: boolean;
	failures: ReleaseVerificationFailure[];
}

interface TextSegment {
	storyBeatId: string;
	sourceStart: number;
	globalStart: number;
	globalEnd: number;
}

function invalid(message: string, pointer = ""): never {
	throw new SuimError("invalid_release_manifest", message, [{ path: "release/manifest.yaml", pointer, message }]);
}

function assertLayout(minimum: number, target: number, maximum: number): void {
	if (![minimum, target, maximum].every((value) => Number.isSafeInteger(value) && value > 0)) {
		invalid("Release layout values must be positive integers", "/layout");
	}
	if (!(minimum <= target && target <= maximum)) {
		invalid("Release layout must satisfy min <= target <= max", "/layout");
	}
}

function spansForRange(segments: readonly TextSegment[], start: number, end: number): ReleaseSpan[] {
	return segments.flatMap((segment): ReleaseSpan[] => {
		const overlapStart = Math.max(start, segment.globalStart);
		const overlapEnd = Math.min(end, segment.globalEnd);
		if (overlapStart >= overlapEnd) return [];
		return [
			{
				storyBeatId: segment.storyBeatId,
				sourceStart: segment.sourceStart + overlapStart - segment.globalStart,
				sourceEnd: segment.sourceStart + overlapEnd - segment.globalStart,
				chapterStart: overlapStart - start,
				chapterEnd: overlapEnd - start,
			},
		];
	});
}

function splitCandidate(
	chars: readonly string[],
	start: number,
	minimum: number,
	target: number,
	maximum: number,
	predicate: (index: number) => boolean,
): number | undefined {
	const preferred = start + target;
	const end = Math.min(chars.length, start + maximum);
	const values: number[] = [];
	for (let index = start + minimum; index <= end; index += 1) {
		if ((chars.length - index === 0 || chars.length - index >= minimum) && predicate(index)) values.push(index);
	}
	return values.toSorted((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred))[0];
}

function nextBoundary(
	chars: readonly string[],
	start: number,
	minimum: number,
	target: number,
	maximum: number,
): number {
	const remaining = chars.length - start;
	// 剩余不足两章最小长度时无法同时满足 min 与 max：宁可让最后一章偏长，也不切出一章过短的尾巴。
	if (remaining <= maximum || remaining < minimum * 2) return chars.length;
	const paragraph = splitCandidate(
		chars,
		start,
		minimum,
		target,
		maximum,
		(index) => chars[index - 1] === "\n" && chars[index - 2] === "\n",
	);
	if (paragraph !== undefined) return paragraph;
	const sentence = splitCandidate(chars, start, minimum, target, maximum, (index) =>
		/[。！？!?]/u.test(chars[index - 1] ?? ""),
	);
	if (sentence !== undefined) return sentence;
	let boundary = Math.min(chars.length, start + target);
	if (chars.length - boundary < minimum) boundary = chars.length - minimum;
	return Math.max(start + 1, boundary);
}

function wire(manifest: ReleaseManifest): ReleaseManifestWire {
	return {
		schema_version: 1,
		revision: manifest.revision,
		...(manifest.storyTextReview === undefined ? {} : { story_text_review: manifest.storyTextReview }),
		story_text: manifest.storyText.map((item) => ({ story_beat_id: item.storyBeatId, sha256: item.sha256 })),
		layout: {
			target_code_points: manifest.layout.targetCodePoints,
			min_code_points: manifest.layout.minCodePoints,
			max_code_points: manifest.layout.maxCodePoints,
		},
		chapters: manifest.chapters.map((chapter) => ({
			id: chapter.id,
			path: chapter.path,
			code_points: chapter.codePoints,
			sha256: chapter.sha256,
			spans: chapter.spans.map((span) => ({
				story_beat_id: span.storyBeatId,
				source_start: span.sourceStart,
				source_end: span.sourceEnd,
				chapter_start: span.chapterStart,
				chapter_end: span.chapterEnd,
			})),
		})),
	};
}

export function parseReleaseManifest(input: unknown): ReleaseManifest {
	if (!Value.Check(ReleaseManifestWireSchema, input)) {
		const diagnostics = schemaDiagnostics(input, [...Value.Errors(ReleaseManifestWireSchema, input)], {
			path: "release/manifest.yaml",
		});
		throw new SuimError(
			"invalid_release_manifest",
			diagnostics.map(formatDiagnostic).join("; ") || "Release manifest does not match its schema",
			diagnostics,
		);
	}
	const value = input as ReleaseManifestWire;
	assertLayout(value.layout.min_code_points, value.layout.target_code_points, value.layout.max_code_points);
	const storyBeatIds = value.story_text.map((item) => item.story_beat_id);
	if (new Set(storyBeatIds).size !== storyBeatIds.length)
		invalid("Release StoryText ids must be unique", "/story_text");
	const knownStoryBeatIds = new Set(storyBeatIds);
	const chapters = value.chapters.map((chapter, chapterIndex): ReleaseChapter => {
		const expectedId = `ch-${String(chapterIndex + 1).padStart(4, "0")}`;
		if (chapter.id !== expectedId || chapter.path !== `release/chapters/${expectedId}.md`) {
			invalid("Release chapter ids and paths must be sequential", `/chapters/${chapterIndex}`);
		}
		let cursor = 0;
		const spans = chapter.spans.map((span, spanIndex): ReleaseSpan => {
			if (
				!knownStoryBeatIds.has(span.story_beat_id) ||
				span.source_start >= span.source_end ||
				span.chapter_start !== cursor ||
				span.chapter_start >= span.chapter_end ||
				span.chapter_end > chapter.code_points
			) {
				invalid("Release chapter span is invalid or discontinuous", `/chapters/${chapterIndex}/spans/${spanIndex}`);
			}
			cursor = span.chapter_end;
			return {
				storyBeatId: span.story_beat_id,
				sourceStart: span.source_start,
				sourceEnd: span.source_end,
				chapterStart: span.chapter_start,
				chapterEnd: span.chapter_end,
			};
		});
		if (cursor !== chapter.code_points) {
			invalid("Release chapter spans must cover the chapter", `/chapters/${chapterIndex}/spans`);
		}
		return {
			id: chapter.id,
			path: chapter.path,
			codePoints: chapter.code_points,
			sha256: chapter.sha256,
			spans,
		};
	});
	return {
		schemaVersion: 1,
		revision: value.revision,
		...(value.story_text_review === undefined ? {} : { storyTextReview: value.story_text_review }),
		storyText: value.story_text.map((item) => ({ storyBeatId: item.story_beat_id, sha256: item.sha256 })),
		layout: {
			targetCodePoints: value.layout.target_code_points,
			minCodePoints: value.layout.min_code_points,
			maxCodePoints: value.layout.max_code_points,
		},
		chapters,
	};
}

export function renderReleaseManifest(manifest: ReleaseManifest): string {
	return stringify(wire(manifest));
}

export function deriveRelease(input: DeriveReleaseInput): DerivedRelease {
	if (input.revision.trim().length === 0) invalid("Release revision must not be empty", "/revision");
	if (input.storyTextReview !== undefined && !new RegExp(REVIEW_ID_PATTERN).test(input.storyTextReview)) {
		invalid("Invalid review id", "/story_text_review");
	}
	if (input.storyText.length === 0) invalid("Release requires StoryText", "/story_text");
	const storyBeatIds = input.storyText.map((item) => item.storyBeatId);
	if (
		new Set(storyBeatIds).size !== storyBeatIds.length ||
		storyBeatIds.some((id) => !new RegExp(STORY_BEAT_ID_PATTERN).test(id))
	) {
		invalid("Release StoryText ids must be unique valid StoryBeat ids", "/story_text");
	}
	if (input.storyText.some((item) => item.text.length === 0))
		invalid("Release StoryText must not be empty", "/story_text");
	const targetCodePoints = input.targetCodePoints ?? 2500;
	const minCodePoints = input.minCodePoints ?? 2000;
	const maxCodePoints = input.maxCodePoints ?? 3000;
	assertLayout(minCodePoints, targetCodePoints, maxCodePoints);

	const stream: string[] = [];
	const segments: TextSegment[] = [];
	for (const item of input.storyText) {
		const chars = Array.from(item.text);
		const globalStart = stream.length;
		// 不用 spread：单个 Beat 的码点数可能超过 V8 的参数上限。
		for (const char of chars) stream.push(char);
		segments.push({
			storyBeatId: item.storyBeatId,
			sourceStart: 0,
			globalStart,
			globalEnd: stream.length,
		});
	}
	const boundaries = [0];
	while ((boundaries.at(-1) ?? 0) < stream.length) {
		boundaries.push(nextBoundary(stream, boundaries.at(-1) ?? 0, minCodePoints, targetCodePoints, maxCodePoints));
	}
	const chapters: DerivedReleaseChapter[] = [];
	const chapterEvidence: ReleaseChapter[] = [];
	for (let index = 0; index < boundaries.length - 1; index += 1) {
		const start = boundaries[index] as number;
		const end = boundaries[index + 1] as number;
		const text = stream.slice(start, end).join("");
		const id = `ch-${String(index + 1).padStart(4, "0")}`;
		const path = `release/chapters/${id}.md`;
		chapters.push({ id, path, text });
		chapterEvidence.push({
			id,
			path,
			codePoints: end - start,
			sha256: sha256Hex(text),
			spans: spansForRange(segments, start, end),
		});
	}
	const manifest: ReleaseManifest = {
		schemaVersion: 1,
		revision: input.revision,
		...(input.storyTextReview === undefined ? {} : { storyTextReview: input.storyTextReview }),
		storyText: input.storyText.map((item) => ({ storyBeatId: item.storyBeatId, sha256: sha256Hex(item.text) })),
		layout: { targetCodePoints, minCodePoints, maxCodePoints },
		chapters: chapterEvidence,
	};
	return { manifest: parseReleaseManifest(wire(manifest)), chapters };
}

export function verifyRelease(
	manifest: ReleaseManifest,
	chapters: readonly DerivedReleaseChapter[],
	storyText: readonly ReleaseStoryTextInput[],
): ReleaseVerificationResult {
	const failures: ReleaseVerificationFailure[] = [];
	const actualStoryText = storyText.map((item) => ({ storyBeatId: item.storyBeatId, sha256: sha256Hex(item.text) }));
	if (JSON.stringify(actualStoryText) !== JSON.stringify(manifest.storyText)) {
		failures.push({ code: "story_text_mismatch", message: "Release is not bound to the supplied StoryText" });
	}
	const byPath = new Map(chapters.map((chapter) => [chapter.path, chapter]));
	if (byPath.size !== chapters.length || chapters.length !== manifest.chapters.length) {
		failures.push({ code: "chapter_mismatch", message: "Release chapter set does not match its manifest" });
	}
	for (const chapter of manifest.chapters) {
		const content = byPath.get(chapter.path);
		if (
			content === undefined ||
			content.id !== chapter.id ||
			Array.from(content.text).length !== chapter.codePoints ||
			sha256Hex(content.text) !== chapter.sha256
		) {
			failures.push({ code: "chapter_mismatch", message: `Release chapter mismatch: ${chapter.path}` });
		}
	}
	const joinedStoryText = storyText.map((item) => item.text).join("");
	const joinedChapters = manifest.chapters.map((chapter) => byPath.get(chapter.path)?.text ?? "").join("");
	if (joinedStoryText !== joinedChapters) {
		failures.push({ code: "chapter_mismatch", message: "Release chapters do not losslessly reproduce StoryText" });
	}
	if (failures.length === 0) {
		const segments: TextSegment[] = [];
		let storyCursor = 0;
		for (const item of storyText) {
			const length = Array.from(item.text).length;
			segments.push({
				storyBeatId: item.storyBeatId,
				sourceStart: 0,
				globalStart: storyCursor,
				globalEnd: storyCursor + length,
			});
			storyCursor += length;
		}
		let chapterCursor = 0;
		for (const chapter of manifest.chapters) {
			const expected = spansForRange(segments, chapterCursor, chapterCursor + chapter.codePoints);
			if (JSON.stringify(expected) !== JSON.stringify(chapter.spans)) {
				failures.push({ code: "span_mismatch", message: `Release spans do not map ${chapter.path} to StoryText` });
				break;
			}
			chapterCursor += chapter.codePoints;
		}
	}
	return { passed: failures.length === 0, failures };
}
