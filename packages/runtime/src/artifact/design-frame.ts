import { compareCodeUnits, TARGET_DESIGN_KINDS } from "@suiming/story";
import { ArtifactError } from "./errors.js";
import { isTargetArtifactIdentity } from "./identity.js";
import { inspectStoryDesignCandidate } from "./story-design-validator.js";
import { type StoryImpactSubject, storyImpact } from "./story-impact.js";
import type { ArtifactCandidate, ArtifactIdentity, CandidateArtifact } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export const DESIGN_KINDS = new Set<string>(TARGET_DESIGN_KINDS);

/**
 * Design 全量码点不超过它时仍然全量渲染（ADR-0008 决定 3 的退化路径）。
 * 占位值：2 Beat 样例远低于它，eval-022 的 6.5 万码点远高于它；真实长篇跑过之后按 Context 尺寸与成本实测调整。
 */
export const DESIGN_FRAME_FULL_RENDER_CODE_POINTS = 24_000;

/**
 * 非 Beat seed（人物、地点、Contract 等）直接涉及的 Beat 按故事顺序载入到这个码点预算为止，其余进目录。
 * 占位值：eval-022 上关羽一人涉及 17 个 Beat、7 卷，不设预算等于全书。
 */
export const DESIGN_FRAME_EXTRA_BEAT_CODE_POINTS = 12_000;

export function designArtifacts(candidate: ArtifactCandidate): CandidateArtifact[] {
	return candidate.artifacts
		.filter((artifact) => isTargetArtifactIdentity(artifact.identity) && DESIGN_KINDS.has(artifact.identity.kind))
		.sort((left, right) => compareCodeUnits(left.path, right.path));
}

export function designArtifactIdentities(candidate: ArtifactCandidate): ArtifactIdentity[] {
	return designArtifacts(candidate).map((artifact) => artifact.identity);
}

export function designContextSelections(candidate: ArtifactCandidate): { identity: ArtifactIdentity }[] {
	return designArtifactIdentities(candidate).map((identity) => ({ identity }));
}

function artifactText(artifact: CandidateArtifact, path: string): string {
	try {
		return decoder.decode(artifact.bytes);
	} catch {
		throw new ArtifactError("invalid_design_context", `${path} is not valid UTF-8 text`);
	}
}

/** 按路径排序、逐个包在 BEGIN / END ARTIFACT 标记里的全文；Design、Frame 与审稿输入共用这一种写法。 */
export function renderArtifacts(artifacts: readonly CandidateArtifact[]): string {
	return [...artifacts]
		.sort((left, right) => compareCodeUnits(left.path, right.path))
		.map((artifact) => {
			const path = artifact.path;
			return `--- BEGIN ARTIFACT ${JSON.stringify(path)} ---\n${artifactText(artifact, path)}\n--- END ARTIFACT ${JSON.stringify(path)} ---`;
		})
		.join("\n\n");
}

/** 全量渲染 Target Design；host 的 `context compile design`、Design 与正文审稿、低于阈值时的 Frame 都用它。 */
export function renderDesign(candidate: ArtifactCandidate): string {
	return renderArtifacts(designArtifacts(candidate));
}

export interface DesignFrameOptions {
	/** 裁剪的入口：作者目标命中的主体、本次修改的主体、目标 Beat 等。 */
	seeds: readonly StoryImpactSubject[];
	fullRenderCodePoints?: number;
	extraBeatCodePoints?: number;
	/** 永不载入、只进目录的 Beat（例如人物时点视图里晚于时点的 Beat）；只在 framed 模式生效。 */
	excludeStoryBeatIds?: ReadonlySet<string>;
}

export interface DesignFrame {
	/** full：Design 低于阈值或无法绑定，全量渲染；framed：按 seeds 裁剪。 */
	mode: "full" | "framed";
	/** 交给模型的文本：载入的 artifact 全文，framed 时附未载入目录。 */
	text: string;
	/** 载入的 artifact。 */
	artifacts: ArtifactIdentity[];
	totalArtifacts: number;
	totalCodePoints: number;
	seeds: StoryImpactSubject[];
}

function identityKey(identity: ArtifactIdentity): string {
	return JSON.stringify(identity);
}

/**
 * Frame(Design, seeds)：Agent 会话开场、委派与 Design 视图的初始 Context（ADR-0008 决定 3）。
 * 始终载入 Intent、Story index、全部 Contract 与 world/core；按 seeds 的 `design impact` 闭包载入直接涉及的 Beat、
 * 这些 Beat 所在 Volume 的其余 Beat、被引用的人物 / 地点 / 资源 / World 文档；下游依赖 Beat 与其余 artifact
 * 只进目录，模型用 read 按需补读。
 */
export function designFrame(candidate: ArtifactCandidate, options: DesignFrameOptions): DesignFrame {
	const all = designArtifacts(candidate);
	const totalCodePoints = all.reduce((sum, artifact) => {
		try {
			return sum + Array.from(decoder.decode(artifact.bytes)).length;
		} catch {
			return sum;
		}
	}, 0);
	const threshold = options.fullRenderCodePoints ?? DESIGN_FRAME_FULL_RENDER_CODE_POINTS;
	const full = (): DesignFrame => ({
		mode: "full",
		text: renderArtifacts(all),
		artifacts: all.map((artifact) => artifact.identity),
		totalArtifacts: all.length,
		totalCodePoints,
		seeds: [...options.seeds],
	});
	if (totalCodePoints <= threshold) return full();

	let inspected: ReturnType<typeof inspectStoryDesignCandidate>;
	try {
		inspected = inspectStoryDesignCandidate(candidate);
	} catch {
		// 绑不上的 Design 没有 refs 闭包可言，退回全量，让模型自己看到全部问题。
		return full();
	}
	const design = inspected.design;
	const excluded = options.excludeStoryBeatIds ?? new Set<string>();
	const loaded = new Set<string>();
	const load = (kind: string, localId: string) =>
		loaded.add(identityKey({ namespace: { kind: "target" }, kind, localId }));

	for (const artifact of all) {
		if (!isTargetArtifactIdentity(artifact.identity)) continue;
		const { kind, localId } = artifact.identity;
		if (kind === "intent" || kind === "story-index" || kind === "story-contract")
			loaded.add(identityKey(artifact.identity));
		if (kind === "world" && localId === "core") loaded.add(identityKey(artifact.identity));
	}
	// Beat seed 直接涉及的 Beat：所在卷整卷载入，前后文因果在同一卷里最密。
	// 其它 seed（人物、地点、Contract……）涉及的 Beat 可能横跨全书，只按故事顺序载入到预算为止。
	const targetBeats = new Set<string>();
	const extraBeats = new Set<string>();
	for (const seed of options.seeds) {
		// 全书 Intent 与 world/core 的 impact 是整本书；它们本来就始终载入，不能把全书 Beat 都拉进 Frame。
		if (seed.kind === "intent" || (seed.kind === "world" && seed.id === "core")) continue;
		let impact: ReturnType<typeof storyImpact>;
		try {
			impact = storyImpact(candidate, seed);
		} catch {
			continue;
		}
		for (const id of impact.storyBeatIds) (seed.kind === "beat" ? targetBeats : extraBeats).add(id);
		for (const id of impact.characterIds) load("character", id);
		for (const id of impact.placeIds) load("place", id);
		for (const id of impact.resourceIds) load("resource", id);
		for (const id of impact.worldIds) load("world", id);
		for (const id of impact.contractIds) load("story-contract", id);
		for (const id of impact.intentIds) load("intent", id);
	}
	const targetVolumes = new Set(
		design.story.volumes.filter((volume) => volume.beats.some((beat) => targetBeats.has(beat.id))).map((v) => v.id),
	);
	for (const beat of design.story.beats) {
		if (excluded.has(beat.id)) continue;
		if (targetBeats.has(beat.id) || targetVolumes.has(beat.volumeId)) load("story-beat", beat.id);
	}
	let extraBudget = options.extraBeatCodePoints ?? DESIGN_FRAME_EXTRA_BEAT_CODE_POINTS;
	const codePointsOf = new Map(
		all.map((artifact) => {
			try {
				return [identityKey(artifact.identity), Array.from(decoder.decode(artifact.bytes)).length] as const;
			} catch {
				return [identityKey(artifact.identity), 0] as const;
			}
		}),
	);
	for (const beat of design.story.beats) {
		const key = identityKey({ namespace: { kind: "target" }, kind: "story-beat", localId: beat.id });
		if (excluded.has(beat.id) || !extraBeats.has(beat.id) || loaded.has(key)) continue;
		const size = codePointsOf.get(key) ?? 0;
		if (size > extraBudget) continue;
		loaded.add(key);
		extraBudget -= size;
	}

	const loadedArtifacts = all.filter((artifact) => loaded.has(identityKey(artifact.identity)));
	const skipped = all.filter((artifact) => !loaded.has(identityKey(artifact.identity)));
	const titleOf = new Map(design.story.beats.map((beat) => [beat.id, beat]));
	const index = skipped
		.map((artifact) => {
			const path = artifact.path;
			if (isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-beat") {
				const beat = titleOf.get(artifact.identity.localId);
				const refs = beat === undefined ? "" : beat.refs.join(", ");
				const involved = excluded.has(artifact.identity.localId)
					? " · 晚于时点，不作为证据"
					: extraBeats.has(artifact.identity.localId)
						? " · 直接涉及本次主体"
						: "";
				return `- ${path}${beat?.title === undefined ? "" : ` — ${beat.title}`}${refs ? ` · refs: ${refs}` : ""}${involved}`;
			}
			return `- ${path}`;
		})
		.join("\n");
	const header = `（选择性 Context：全书 Design 共 ${all.length} 个文件、约 ${Math.round(totalCodePoints / 1000)} 千码点，本次按 ${
		options.seeds.map((seed) => `${seed.kind}:${seed.id}`).join("、") || "作者目标"
	} 载入 ${loadedArtifacts.length} 个。未载入的文件列在文末目录，需要时用 read 读取。）`;
	return {
		mode: "framed",
		text: `${header}\n\n${renderArtifacts(loadedArtifacts)}\n\n## 未载入的 Design 目录\n${index || "（无）"}`,
		artifacts: loadedArtifacts.map((artifact) => artifact.identity),
		totalArtifacts: all.length,
		totalCodePoints,
		seeds: [...options.seeds],
	};
}

/** Frame 载入的 artifact 清单（`context compile` 返回给 host）；只保留仍存在于当前候选里的（模型可能删了文件）。 */
export function frameSelections(frame: DesignFrame, candidate: ArtifactCandidate): { identity: ArtifactIdentity }[] {
	const present = new Set(candidate.artifacts.map((artifact) => identityKey(artifact.identity)));
	return frame.artifacts.filter((identity) => present.has(identityKey(identity))).map((identity) => ({ identity }));
}
