import { buildContractLifecycles, buildStateTimeline, type StateAssignment } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { inspectStoryDesignCandidate } from "../artifact/story-design-validator.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import type { ArtifactCandidate, ArtifactIdentity } from "../artifact/types.js";
import type { CompiledDesignView } from "./design-view-context.js";

export type StoryStatePhase = "before" | "changes" | "after";
export interface StoryStateTask {
	kind: "state";
	id: string;
	phase: StoryStatePhase;
	subject?: { kind: "character" | "resource" | "contract"; id: string };
}

const phaseLabels = { before: "进入前", changes: "本幕变化", after: "结束后" };
const properties: Record<string, string> = {
	location: "位置",
	holder: "持有者",
	consumed: "已消耗",
	destroyed: "已毁坏",
	dead: "已死亡",
	revealed: "已揭示",
};
const name = (value: string) => value.replace(/^(character|resource|place|secret):/u, "");
const valueText = (assignment: StateAssignment | undefined) =>
	assignment === undefined
		? "未记录"
		: typeof assignment.value === "boolean"
			? assignment.value
				? "是"
				: "否"
			: assignment.value === "none"
				? "无"
				: name(assignment.value);
const label = (assignment: StateAssignment) => {
	const scope =
		assignment.scope === "world" ? "客观" : assignment.scope === "reader" ? "读者" : name(assignment.scope);
	return `${scope} · ${name(assignment.subject)} · ${properties[assignment.property] ?? assignment.property}`;
};

/** 按明确的 Beat 边界读取已有 Design；桌面和 host Context 共用，不保存第二份状态。 */
export function compileStoryStateContext(candidate: ArtifactCandidate, task: StoryStateTask): CompiledDesignView {
	const { design, check } = inspectStoryDesignCandidate(candidate);
	const beats = design.story.beats;
	const target = beats.find((beat) => beat.id === task.id);
	if (!target) throw new ArtifactError("story_beat_not_found", `StoryBeat not found: ${task.id}`);
	const sourceLink = (path: string) => {
		const title =
			beats.find((beat) => beat.path === path)?.title ?? path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path;
		const href = path.split("/").map(encodeURIComponent).join("/").replace(/\(/gu, "%28").replace(/\)/gu, "%29");
		return `[${title.replace(/[[\]]/gu, "\\$&")}](./${href})`;
	};
	const cutoff = target.ordinal - (task.phase === "before" ? 1 : 0);
	const prefix = beats.filter((beat) => beat.ordinal <= cutoff);
	const failures = check.state.failures.filter(
		(failure) => !failure.storyBeatId || prefix.some((beat) => beat.id === failure.storyBeatId),
	);
	if (failures.length)
		throw new ArtifactError("invalid_design_context", "该位置之前的硬状态未通过 Checker，无法可靠重放。");
	const timeline = buildStateTimeline(design.stateProjection);
	const before = timeline.stateBefore(target.id);
	const after = timeline.stateAfter(target.id);
	const current = task.phase === "before" ? before : after;
	const subject = task.subject;
	const ref = subject ? `${subject.kind}:${subject.id}` : undefined;
	if (subject) {
		const entries =
			subject.kind === "character"
				? design.characters
				: subject.kind === "resource"
					? design.resources
					: design.contracts;
		if (!entries.some((entry) => entry.id === subject.id))
			throw new ArtifactError("invalid_context_task", `观察主体不存在：${ref}`);
	}
	const matches = (assignment: StateAssignment | undefined) =>
		assignment !== undefined &&
		(!subject ||
			assignment.subject === ref ||
			assignment.scope === ref ||
			(assignment.property === "holder" && assignment.value === ref));
	const sourceByKey = new Map<string, string>();
	const identityForRef = (ref: string): ArtifactIdentity | undefined => {
		const split = ref.indexOf(":");
		return candidate.artifacts.find(
			(artifact) =>
				artifact.identity.namespace.kind === "target" &&
				artifact.identity.kind === ref.slice(0, split) &&
				artifact.identity.localId === ref.slice(split + 1),
		)?.identity;
	};
	for (const [key, assignment] of timeline.stateBefore(beats[0]?.id ?? target.id)) {
		const identity = identityForRef(assignment.subject);
		if (identity) sourceByKey.set(key, storyPackageCodec.pathForIdentity(identity, candidate));
	}
	// 比较已有快照，包含 holder / location 等原子规则隐含的清空；不自行重写状态规则。
	for (const beat of prefix) {
		const left = timeline.stateBefore(beat.id);
		const right = timeline.stateAfter(beat.id);
		for (const key of new Set([...left.keys(), ...right.keys()]))
			if (left.get(key)?.value !== right.get(key)?.value) sourceByKey.set(key, beat.path);
	}
	const lines: string[] = [];
	if (task.phase === "changes") {
		for (const key of new Set([...before.keys(), ...after.keys()])) {
			const left = before.get(key);
			const right = after.get(key);
			if (left?.value === right?.value || (!matches(left) && !matches(right))) continue;
			lines.push(
				`- ${label((right ?? left) as StateAssignment)}：${valueText(left)} → ${valueText(right)}（依据：${sourceLink(target.path)}）`,
			);
		}
	} else {
		for (const [key, assignment] of current) {
			if (!matches(assignment)) continue;
			const source = sourceByKey.get(key);
			lines.push(
				`- ${label(assignment)}：${valueText(assignment)}（依据：${source ? sourceLink(source) : "开场声明"}）`,
			);
		}
	}
	const contracts: string[] = [];
	const lifecycles = buildContractLifecycles(design.story, design.contracts);
	for (const contract of design.contracts) {
		if (
			subject &&
			(subject.kind === "contract" ? contract.id !== subject.id : !contract.subjects.includes(ref as string))
		)
			continue;
		const anchors = lifecycles.get(contract.id)?.anchors ?? [];
		const visible = anchors.filter((anchor) => anchor.ordinal <= cutoff);
		if (task.phase === "changes") {
			for (const anchor of visible.filter((anchor) => anchor.storyBeatId === target.id)) {
				const action = { open: "开启", advance: "推进", resolve: "兑现" }[anchor.operation];
				contracts.push(`- ${contract.id}：${action}（依据：${sourceLink(anchor.path)}）`);
			}
		} else {
			const resolved = visible.find((anchor) => anchor.operation === "resolve");
			const opened = visible.find((anchor) => anchor.operation === "open");
			const deadlineSpec = contract.deadline;
			const deadline =
				deadlineSpec.kind === "story_beat"
					? beats.find((beat) => beat.id === deadlineSpec.storyBeatId)?.ordinal
					: beats.at(-1)?.ordinal;
			const status = resolved
				? "已兑现"
				: !opened
					? "尚未开启"
					: deadline !== undefined && cutoff >= deadline
						? "已到期，未兑现"
						: "待兑现";
			const latest = visible.at(-1);
			contracts.push(`- ${contract.id}：${status}（依据：${sourceLink(latest?.path ?? contract.path)}）`);
		}
	}
	const identities = candidate.artifacts
		.filter(
			({ identity }) =>
				identity.namespace.kind === "target" &&
				(identity.kind === "story-index" ||
					["character", "place", "resource", "story-contract"].includes(identity.kind) ||
					(identity.kind === "story-beat" && prefix.some((beat) => beat.id === identity.localId))),
		)
		.map(({ identity }) => identity);
	// 进入前仍要绑定目标 Beat，以准确解释查询位置；正文与未来 Beat 不进入状态证据。
	if (!identities.some((identity) => identity.kind === "story-beat" && identity.localId === target.id))
		identities.push({ namespace: { kind: "target" }, kind: "story-beat", localId: target.id });
	return {
		text: [
			`## ${target.title ?? target.id} · ${phaseLabels[task.phase]}`,
			`观察范围：${subject ? subject.id : "全部人物、资源与承诺"}。按故事顺序读取已声明的 Design；未记录不等于没有发生，也不等于人物不知道。`,
			"### 硬状态",
			lines.join("\n") || (task.phase === "changes" ? "没有已声明的硬状态变化。" : "没有相关硬状态记录。"),
			"### 承诺",
			contracts.join("\n") || (task.phase === "changes" ? "本幕没有相关承诺动作。" : "没有相关承诺。"),
		].join("\n\n"),
		artifacts: identities.map((identity) => ({ identity })),
		view: {
			kind: "state",
			id: target.id,
			phase: task.phase,
			...(subject ? { subject } : {}),
			storyBeatIds: prefix.map((beat) => beat.id),
		},
	};
}
