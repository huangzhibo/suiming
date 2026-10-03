import { applyStateAssignments } from "./step.js";
import type { StateAssignment, StateProjection } from "./types.js";

/**
 * 按 StoryBeat 展示顺序保存每个 Beat 之后的硬状态快照，让 Frame(t) 的多点查询不必反复重放全书。
 *
 * 每个 Beat 只在其 changes 非空且未被跳过时新建一份 Map，否则复用上一份；
 * 内存与"有变化的 Beat 数 × 状态数"成正比。`skipStoryBeatIds` 应传入 `evaluate` 报告失败的 Beat，
 * 使快照与 `appliedStoryBeatIds` 一致。
 */
export interface StateTimeline {
	/** 进入该 Beat 之前的状态；t 为第一个 Beat 时即 initial。 */
	stateBefore(storyBeatId: string): ReadonlyMap<string, StateAssignment>;
	/** 该 Beat 结束时的状态。 */
	stateAfter(storyBeatId: string): ReadonlyMap<string, StateAssignment>;
	/** 全书结束时的状态。 */
	readonly final: ReadonlyMap<string, StateAssignment>;
}

export function buildStateTimeline(
	projection: StateProjection,
	options: { skipStoryBeatIds?: ReadonlySet<string> } = {},
): StateTimeline {
	const skip = options.skipStoryBeatIds ?? new Set<string>();
	const before = new Map<string, ReadonlyMap<string, StateAssignment>>();
	const after = new Map<string, ReadonlyMap<string, StateAssignment>>();
	const changesByBeat = new Map(projection.changes.map((change) => [change.storyBeatId, change.assignments]));
	let current: ReadonlyMap<string, StateAssignment> = applyStateAssignments(new Map(), projection.initial);
	for (const beatId of projection.authorizedBeatIds) {
		before.set(beatId, current);
		const assignments = changesByBeat.get(beatId);
		if (assignments !== undefined && assignments.length > 0 && !skip.has(beatId)) {
			current = applyStateAssignments(current, assignments);
		}
		after.set(beatId, current);
	}
	const missing = (id: string): never => {
		throw new Error(`StoryBeat is outside the evaluated story: ${id}`);
	};
	return {
		stateBefore: (id) => before.get(id) ?? missing(id),
		stateAfter: (id) => after.get(id) ?? missing(id),
		final: current,
	};
}
