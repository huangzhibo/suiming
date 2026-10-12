import { paragraphSpans } from "../anchors.js";
import { stripFrontmatter } from "../model.js";
import type { AxisModel, ContractLane } from "./layout.js";

export const CONTRACT_PHASES = ["open", "advance", "resolve"] as const;
export type ContractPhase = (typeof CONTRACT_PHASES)[number];

/** 局部路径只组织实际锚点；同一节的多个阶段合并，异常保留在其真实位置。 */
export function contractJourney(model: AxisModel, lane: ContractLane) {
	const ordinals = [...new Set(CONTRACT_PHASES.flatMap((phase) => lane[phase]))].sort((a, b) => a - b);
	return ordinals.flatMap((ordinal) => {
		const beat = model.beats[ordinal];
		if (!beat) return [];
		const phases = CONTRACT_PHASES.filter((phase) => lane[phase].includes(ordinal));
		const warnings: string[] = [];
		if (lane.late.includes(ordinal)) warnings.push("回应后仍有推进，请核对");
		if (phases.includes("resolve") && lane.deadlineIndex >= 0 && ordinal > lane.deadlineIndex)
			warnings.push("晚于回应期限");
		return [{ beat, phases, deadline: lane.deadlineIndex === ordinal, warnings }];
	});
}

/** 来源首段的短摘录，不把邻近情节解释成期待的因果，也不另生成摘要。 */
export function contractExcerpt(content: string): string {
	const paragraph = paragraphSpans(stripFrontmatter(content))[0]?.text.replace(/\s+/gu, " ").trim() ?? "";
	const points = [...paragraph];
	return points.length > 96 ? `${points.slice(0, 96).join("")}…` : paragraph;
}
