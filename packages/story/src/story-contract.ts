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
						hint: "核对事件与期待的边界：按实际内容修正 advance 或 resolve，不要仅为通过检查挪动标记。",
					},
				]);
			}
		}
	}
	if (collector === undefined) own.throwIfFailed("StoryContract lifecycles");
	return lifecycles;
}

export interface ContractEvaluationScope {
	/** 故事或材料在此边界之后继续，允许已建立的期待保持开放。 */
	openEnded?: boolean;
}

export interface ContractLifecycleEvaluation {
	/** 已回应与结构缺口；不对叙事质量作结论。 */
	results: ContractLifecycleEval[];
	/** 未完待续的作品或材料边界上，已建立、尚未回应的期待。 */
	openContractIds: string[];
}

export function evaluateContractLifecycleScope(
	story: StoryOutline,
	contracts: readonly StoryContract[],
	scope: ContractEvaluationScope = {},
): ContractLifecycleEvaluation {
	const lifecycles = buildContractLifecycles(story, contracts);
	const results: ContractLifecycleEval[] = [];
	const openContractIds: string[] = [];
	for (const contract of contracts) {
		const anchors = lifecycles.get(contract.id)?.anchors ?? [];
		const open = anchors.find((anchor) => anchor.operation === "open");
		const resolve = anchors.find((anchor) => anchor.operation === "resolve");
		if (scope.openEnded && open && !resolve) {
			openContractIds.push(contract.id);
			continue;
		}
		const resolved = open !== undefined && resolve !== undefined;
		results.push({
			contractId: contract.id,
			status: resolved ? "resolved" : "outstanding",
			message: resolved
				? "已有建立与回应记录；回应是否充分由审稿判断"
				: !open
					? "没有任何 StoryBeat 建立这个期待"
					: "作品声明完结，但没有回应记录",
			openedAt: open?.storyBeatId ?? null,
			resolvedAt: resolve?.storyBeatId ?? null,
			advancedAt: anchors.filter((anchor) => anchor.operation === "advance").map((anchor) => anchor.storyBeatId),
		});
	}
	return { results, openContractIds };
}
