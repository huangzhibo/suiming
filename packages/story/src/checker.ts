import type { Diagnostic } from "./errors.js";
import {
	type CheckResult,
	evaluate,
	type StateAssignment,
	type StateProjection,
	type StepFailure,
} from "./ir/index.js";
import { buildStateTimeline, type StateTimeline } from "./ir/timeline.js";
import type { BoundBook, CharacterEntry } from "./parse-book.js";
import { groupedReferencePointer } from "./reference-groups.js";
import {
	buildContractLifecycles,
	type ContractLifecycleEval,
	evaluateContractLifecycleScope,
} from "./story-contract.js";
import type { StoryBeat } from "./story-outline.js";

export interface DesignCheckResult {
	passed: boolean;
	state: CheckResult;
	/** 全部阻塞性诊断：硬状态失败、到期未闭合的 Contract、未声明即揭示的 secret。 */
	diagnostics: Diagnostic[];
	/** 不阻塞的提示：refs 疑似遗漏、已死人物再被引用、Contract subjects 未出现在锚点 Beat 的 refs。 */
	warnings: Diagnostic[];
	contracts: {
		checked: true;
		passed: boolean;
		results: ContractLifecycleEval[];
		/** 已 open、未 resolve、尚未到期的 Contract；全书未完待续与 Source 材料边界上合法。 */
		openContractIds: string[];
	};
}

function pointerSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function sameAssignment(left: StateAssignment, right: StateAssignment): boolean {
	return (
		left.subject === right.subject &&
		left.property === right.property &&
		left.value === right.value &&
		left.scope === right.scope
	);
}

function beatChangePointers(beat: StoryBeat): string[] {
	return [
		...Object.keys(beat.changes.world).map((path) => `/frontmatter/changes/world/${pointerSegment(path)}`),
		...Object.keys(beat.changes.reader).map((path) => `/frontmatter/changes/reader/${pointerSegment(path)}`),
		...Object.entries(beat.changes.character).flatMap(([characterId, assignments]) =>
			Object.keys(assignments).map(
				(path) => `/frontmatter/changes/character/${pointerSegment(characterId)}/${pointerSegment(path)}`,
			),
		),
	];
}

function stateFailureDiagnostic(design: BoundBook, failure: StepFailure): Diagnostic {
	if (failure.storyBeatId !== undefined) {
		const beat = design.story.beats.find((item) => item.id === failure.storyBeatId);
		if (beat !== undefined) {
			const change = design.stateProjection.changes.find((item) => item.storyBeatId === failure.storyBeatId);
			const assignment = failure.assignment;
			const assignmentIndex =
				assignment === undefined
					? -1
					: (change?.assignments.findIndex((item) => sameAssignment(item, assignment)) ?? -1);
			return {
				path: beat.path,
				pointer: beatChangePointers(beat)[assignmentIndex] ?? "/frontmatter/changes",
				message: failure.message,
				...(failure.actual === undefined ? {} : { actual: failure.actual }),
			};
		}
	}
	if (failure.assignment !== undefined) {
		const [kind, id] = failure.assignment.subject.split(":", 2);
		const entries =
			kind === "character"
				? design.characters
				: kind === "place"
					? design.places
					: kind === "resource"
						? design.resources
						: [];
		const entry = entries.find((item) => item.id === id);
		if (entry !== undefined) {
			return {
				path: entry.path,
				pointer: `/frontmatter/initial/${pointerSegment(failure.assignment.property)}`,
				message: failure.message,
				...(failure.actual === undefined ? {} : { actual: failure.actual }),
			};
		}
	}
	return { message: failure.message, ...(failure.actual === undefined ? {} : { actual: failure.actual }) };
}

/** 空 StoryOutline 是新作品的合法起点：投影只有 initial，没有 changes。 */
function storyProjection(design: BoundBook): StateProjection {
	const beatIds = design.story.beats.map((beat) => beat.id);
	const known = new Set(beatIds);
	return {
		profileVersion: design.stateProjection.profileVersion,
		initial: design.stateProjection.initial,
		changes: design.stateProjection.changes.filter((change) => known.has(change.storyBeatId)),
		authorizedBeatIds: beatIds,
	};
}

/** 与 lifecycle 的 message 一一对应：从未建立、未兑现（Beat 期限 / 全书）、过期才兑现。 */
function contractHint(result: ContractLifecycleEval): string {
	const id = result.contractId;
	if (result.openedAt === null) return `在建立这个期待的 StoryBeat 里写 contracts.open: [${id}]`;
	if (result.deadlineStoryBeatId === null) return `在兑现它的 StoryBeat 里写 contracts.resolve: [${id}]`;
	if (result.resolvedAt === null)
		return `在 ${result.deadlineStoryBeatId} 或更早的 StoryBeat 里写 contracts.resolve: [${id}]`;
	return `把 contracts.resolve: [${id}] 移到 ${result.deadlineStoryBeatId} 或更早的 StoryBeat，或者改期限`;
}

function contractDiagnostics(design: BoundBook, results: readonly ContractLifecycleEval[]): Diagnostic[] {
	return results
		.filter((result) => result.status === "outstanding")
		.map((result) => {
			const contract = design.contracts.find((item) => item.id === result.contractId);
			return {
				...(contract === undefined ? {} : { path: contract.path }),
				message: `StoryContract ${result.contractId}：${result.message}`,
				hint: contractHint(result),
			};
		});
}

/**
 * secret 只在某个 StoryBeat 的 refs.secret 里声明过，才允许在同一或更晚的 Beat 被 revealed。
 * 这是对抗拼写漂移的确定性边界：从未声明过的 secret 被揭示，几乎总是另一个 secret 的错误拼写。
 */
function undeclaredSecretDiagnostics(beats: readonly StoryBeat[]): Diagnostic[] {
	const declared = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	for (const beat of beats) {
		for (const ref of beat.refs) if (ref.startsWith("secret:")) declared.add(ref);
		// revealed 只属于 secret，不带 secret: 前缀的写法也是 secret（与 state-projection 的解析一致）。
		const revealed = [
			...Object.keys(beat.changes.world).map((path) => ["world", path] as const),
			...Object.keys(beat.changes.reader).map((path) => ["reader", path] as const),
			...Object.entries(beat.changes.character).flatMap(([characterId, assignments]) =>
				Object.keys(assignments).map((path) => [`character/${pointerSegment(characterId)}`, path] as const),
			),
		].filter(([, path]) => path.endsWith(".revealed"));
		for (const [scope, path] of revealed) {
			const subject = path.slice(0, -".revealed".length);
			const secret = subject.startsWith("secret:") ? subject : `secret:${subject}`;
			if (declared.has(secret)) continue;
			diagnostics.push({
				path: beat.path,
				pointer: `/frontmatter/changes/${scope}/${pointerSegment(path)}`,
				message: `${secret} 在任何 StoryBeat 于 refs.secret 声明它之前就被揭示了`,
				hint: "在它第一次起作用的那个 Beat 的 refs.secret 里声明，或者检查拼写",
			});
		}
	}
	return diagnostics;
}

function nameMentions(beat: StoryBeat, names: readonly string[]): boolean {
	return names.some((name) => beat.title?.includes(name) === true || beat.text.includes(name));
}

/** 正文提到人物名或别名但 refs 未引用：可能是遗漏，也可能是顺口提名，因此只作提示。 */
function unreferencedMentionWarnings(beats: readonly StoryBeat[], characters: readonly CharacterEntry[]): Diagnostic[] {
	const warnings: Diagnostic[] = [];
	for (const character of characters) {
		const ref = `character:${character.id}`;
		const names = [...new Set([character.name, ...character.aliases])].filter((name) => name.length >= 2);
		if (names.length === 0) continue;
		for (const beat of beats) {
			if (beat.refs.includes(ref) || beat.stateRefs.includes(ref)) continue;
			if (!nameMentions(beat, names)) continue;
			warnings.push({
				path: beat.path,
				pointer: "/frontmatter/refs",
				message: `${beat.id} 提到了${character.name}，但 refs 里没有 character:${character.id}`,
				hint: "如果此人之前的塑造在这里要起作用，就加上引用；只是顺带一提可以不管",
			});
		}
	}
	return warnings;
}

/** 已确定死亡的人物在更晚 Beat 被引用：回忆或被谈论是合法的，但值得作者确认不是让死人出场。 */
function deadReferenceWarnings(beats: readonly StoryBeat[], timeline: StateTimeline): Diagnostic[] {
	const warnings: Diagnostic[] = [];
	const deadSince = new Map<string, string>();
	for (const beat of beats) {
		for (const [index, ref] of beat.refs.entries()) {
			const since = deadSince.get(ref);
			if (since === undefined) continue;
			warnings.push({
				path: beat.path,
				pointer: groupedReferencePointer("refs", beat.refs, index),
				message: `${ref} 已在 ${since} 死亡，却在 ${beat.id} 又被引用`,
				hint: "出现在回忆里或被别人谈起都没问题；确认这个 Beat 里此人没有亲自行动",
			});
		}
		const state = timeline.stateAfter(beat.id);
		for (const assignment of state.values()) {
			if (assignment.scope !== "world" || assignment.property !== "dead" || assignment.value !== true) continue;
			if (!deadSince.has(assignment.subject)) deadSince.set(assignment.subject, beat.id);
		}
	}
	return warnings;
}

/** Contract 的 subjects 在其 open / resolve 锚点 Beat 的 refs 中缺席：通常说明 refs 漏了，或 subjects 写错。 */
function contractSubjectWarnings(design: BoundBook, beats: readonly StoryBeat[]): Diagnostic[] {
	const warnings: Diagnostic[] = [];
	const lifecycles = buildContractLifecycles(design.story, design.contracts);
	const byId = new Map(beats.map((beat) => [beat.id, beat]));
	for (const contract of design.contracts) {
		const anchors = (lifecycles.get(contract.id)?.anchors ?? []).filter((anchor) => anchor.operation !== "advance");
		for (const anchor of anchors) {
			const beat = byId.get(anchor.storyBeatId);
			if (beat === undefined) continue;
			const routing = new Set([...beat.refs, ...beat.stateRefs]);
			for (const subject of contract.subjects) {
				if (routing.has(subject)) continue;
				warnings.push({
					path: beat.path,
					pointer: anchor.pointer,
					message: `${beat.id} 对 StoryContract ${contract.id} 做了 ${anchor.operation}，却没有引用它的主体 ${subject}`,
					hint: "把这个主体加进 refs；如果它其实不相关，就从 Contract 的 subjects 里删掉",
				});
			}
		}
	}
	return warnings;
}

export function checkDesign(design: BoundBook): DesignCheckResult {
	const projection = storyProjection(design);
	const state = evaluate(projection);
	const beats = design.story.beats;
	const evaluation = evaluateContractLifecycleScope(design.story, design.contracts, {
		openEnded: design.scope.openEnded,
	});
	const contractResults = evaluation.results;
	const contracts = {
		checked: true as const,
		passed: contractResults.every((item) => item.status === "resolved"),
		results: contractResults,
		openContractIds: evaluation.openContractIds,
	};
	const failedBeatIds = new Set(
		state.failures.flatMap((failure) => (failure.storyBeatId === undefined ? [] : [failure.storyBeatId])),
	);
	const timeline = buildStateTimeline(projection, { skipStoryBeatIds: failedBeatIds });
	const diagnostics = [
		...state.failures.map((failure) => stateFailureDiagnostic(design, failure)),
		...contractDiagnostics(design, contractResults),
		...undeclaredSecretDiagnostics(beats),
	].map((diagnostic) => ({ ...diagnostic, severity: "error" as const }));
	const warnings = [
		...design.warnings,
		...unreferencedMentionWarnings(beats, design.characters),
		...deadReferenceWarnings(beats, timeline),
		...contractSubjectWarnings(design, beats),
	].map((diagnostic) => ({ ...diagnostic, severity: "warning" as const }));
	return {
		passed: diagnostics.length === 0,
		state,
		diagnostics,
		warnings,
		contracts,
	};
}
