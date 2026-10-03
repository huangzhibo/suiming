import { DiagnosticCollector } from "./collector.js";
import type { StoryContract } from "./parse-book.js";
import type { StoryOutline } from "./story-outline.js";

export type ContractOperation = "open" | "advance" | "resolve";

export interface ContractAnchor {
	operation: ContractOperation;
	storyBeatId: string;
	ordinal: number;
	path: string;
	pointer: string;
}

export interface ContractLifecycle {
	contractId: string;
	anchors: ContractAnchor[];
}

export interface ContractLifecycleEval {
	contractId: string;
	status: "resolved" | "outstanding";
	message: string;
	openedAt: string | null;
	resolvedAt: string | null;
	advancedAt: string[];
	deadlineStoryBeatId: string | null;
}

function operationPointer(operation: ContractOperation, index: number): string {
	return `/frontmatter/contracts/${operation}/${index}`;
}

export function buildContractLifecycles(
	story: StoryOutline,
	contracts: readonly StoryContract[],
	collector?: DiagnosticCollector,
): Map<string, ContractLifecycle> {
	const own = collector ?? new DiagnosticCollector();
	const known = new Set(contracts.map((contract) => contract.id));
	const lifecycles = new Map<string, ContractLifecycle>(
		contracts.map((contract) => [contract.id, { contractId: contract.id, anchors: [] }]),
	);
	for (const beat of story.beats) {
		const seen = new Set<string>();
		for (const operation of ["open", "advance", "resolve"] as const) {
			for (const [index, contractId] of beat.contracts[operation].entries()) {
				if (!known.has(contractId)) {
					own.report("missing_context_reference", [
						{
							path: beat.path,
							pointer: operationPointer(operation, index),
							message: `StoryContract 不存在：${contractId}`,
						},
					]);
					continue;
				}
				if (seen.has(contractId)) {
					own.report("invalid_document", [
						{
							path: beat.path,
							pointer: operationPointer(operation, index),
							message: "一个 StoryBeat 对同一个 StoryContract 只能做一种操作",
						},
					]);
					continue;
				}
				seen.add(contractId);
				lifecycles.get(contractId)?.anchors.push({
					operation,
					storyBeatId: beat.id,
					ordinal: beat.ordinal,
					path: beat.path,
					pointer: operationPointer(operation, index),
				});
			}
		}
	}
	for (const lifecycle of lifecycles.values()) {
		const opens = lifecycle.anchors.filter((anchor) => anchor.operation === "open");
		const resolves = lifecycle.anchors.filter((anchor) => anchor.operation === "resolve");
		for (const duplicate of [...opens.slice(1), ...resolves.slice(1)]) {
			own.report("invalid_document", [
				{
					path: duplicate.path,
					pointer: duplicate.pointer,
					message: `StoryContract ${lifecycle.contractId} 重复了 ${duplicate.operation}`,
					hint: "只保留一次 open 和一次 resolve，中间的推进用 advance。",
				},
			]);
		}
		const open = opens[0];
		const resolve = resolves[0];
		for (const anchor of lifecycle.anchors) {
			if (anchor.operation !== "open" && (open === undefined || anchor.ordinal <= open.ordinal)) {
				own.report("invalid_document", [
					{
						path: anchor.path,
						pointer: anchor.pointer,
						message: `${anchor.operation} 必须在 Contract 的 open 之后`,
						hint: `在更早的 StoryBeat 里加上 contracts.open: [${lifecycle.contractId}]。`,
					},
				]);
			}
			if (anchor.operation === "advance" && resolve !== undefined && anchor.ordinal >= resolve.ordinal) {
				own.report("invalid_document", [
					{
						path: anchor.path,
						pointer: anchor.pointer,
						message: "advance 必须在 Contract 的 resolve 之前",
						hint: "把 advance 挪到前面；如果 Contract 已经 resolve，就删掉它。",
					},
				]);
			}
		}
	}
	if (collector === undefined) own.throwIfFailed("StoryContract lifecycles");
	return lifecycles;
}

export interface ContractEvaluationScope {
	/** 故事在边界之后继续：`book_end` 的 deadline 不算到期。 */
	openEnded?: boolean;
}

export interface ContractLifecycleEvaluation {
	/** 已到期 Contract 的结构结论。 */
	results: ContractLifecycleEval[];
	/** 已 open、未 resolve 且尚未到期的 Contract：未完待续的全书或材料边界上合法的开放期待。 */
	openContractIds: string[];
}

export function evaluateContractLifecycleScope(
	story: StoryOutline,
	contracts: readonly StoryContract[],
	scope: ContractEvaluationScope = {},
): ContractLifecycleEvaluation {
	const lifecycles = buildContractLifecycles(story, contracts);
	const openEnded = scope.openEnded ?? false;
	const results: ContractLifecycleEval[] = [];
	const openContractIds: string[] = [];
	for (const contract of contracts) {
		const deadlineStoryBeatId = contract.deadline.kind === "story_beat" ? contract.deadline.storyBeatId : null;
		const deadlineOrdinal =
			deadlineStoryBeatId === null
				? undefined
				: story.beats.find((beat) => beat.id === deadlineStoryBeatId)?.ordinal;
		const due = deadlineStoryBeatId !== null || !openEnded;
		const anchors = lifecycles.get(contract.id)?.anchors ?? [];
		const open = anchors.find((anchor) => anchor.operation === "open");
		const resolve = anchors.find((anchor) => anchor.operation === "resolve");
		// 从未 open 的 Contract 不是"仍开放的期待"，未到期也按未闭合报告。
		if (!due && open !== undefined) {
			if (resolve === undefined) openContractIds.push(contract.id);
			continue;
		}
		const resolvedInTime =
			open !== undefined &&
			resolve !== undefined &&
			(deadlineOrdinal === undefined || resolve.ordinal <= deadlineOrdinal);
		results.push({
			contractId: contract.id,
			status: resolvedInTime ? "resolved" : "outstanding",
			message: resolvedInTime
				? "建立与兑现在结构上齐了；是否真的兑现要靠审稿判断"
				: open === undefined
					? "没有任何 StoryBeat 建立这个期待"
					: resolve === undefined
						? deadlineStoryBeatId === null
							? "到全书结束还没有兑现"
							: `到期限 ${deadlineStoryBeatId} 还没有兑现`
						: `期限是 ${deadlineStoryBeatId}，到 ${resolve.storyBeatId} 才兑现`,
			openedAt: open?.storyBeatId ?? null,
			resolvedAt: resolve?.storyBeatId ?? null,
			advancedAt: anchors.filter((anchor) => anchor.operation === "advance").map((anchor) => anchor.storyBeatId),
			deadlineStoryBeatId,
		});
	}
	return { results, openContractIds };
}
