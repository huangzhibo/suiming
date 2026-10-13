import type { ResourceLane } from "./layout.js";

/** 同一个情节的多项变化共享一个来源，字段和值照原记录保留。 */
export function resourceEventGroups(events: ResourceLane["events"]) {
	const groups = new Map<number, ResourceLane["events"]>();
	for (const event of events) groups.set(event.ordinal, [...(groups.get(event.ordinal) ?? []), event]);
	return [...groups].sort(([a], [b]) => a - b).map(([ordinal, events]) => ({ ordinal, events }));
}
