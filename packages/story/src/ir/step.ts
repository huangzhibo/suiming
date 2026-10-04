import { failure, stateKey, valueIn } from "./holds.js";
import { PROFILE_VERSION, TERMINAL_RESOURCE_PROPERTIES } from "./profile.js";
import type { CheckResult, StateAssignment, StateChange, StateProjection, StepFailure } from "./types.js";

function orderedState(state: ReadonlyMap<string, StateAssignment>): StateAssignment[] {
	return [...state.values()].sort((left, right) => {
		const leftKey = stateKey(left);
		const rightKey = stateKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function result(
	projection: StateProjection,
	state: ReadonlyMap<string, StateAssignment>,
	applied: readonly string[],
	failures: readonly StepFailure[],
): CheckResult {
	return {
		profileVersion: PROFILE_VERSION,
		passed: failures.length === 0,
		appliedStoryBeatIds: [...applied],
		finalState: orderedState(state),
		authorizedBeatIds: [...projection.authorizedBeatIds],
		failures: [...failures],
	};
}

function changeFailure(
	change: StateChange | undefined,
	code: StepFailure["code"],
	message: string,
	assignment?: StateAssignment,
	actual?: StepFailure["actual"],
): StepFailure {
	return failure(code, message, {
		...(change === undefined ? {} : { storyBeatId: change.storyBeatId }),
		...(assignment === undefined ? {} : { assignment }),
		...(actual === undefined ? {} : { actual }),
	});
}

function worldAssignment(
	subject: string,
	property: StateAssignment["property"],
	value: StateAssignment["value"],
): StateAssignment {
	return { subject, property, value, scope: "world" };
}

function resourceIsTerminal(state: ReadonlyMap<string, StateAssignment>, resource: string): boolean {
	return TERMINAL_RESOURCE_PROPERTIES.some(
		(property) => valueIn(state, worldAssignment(resource, property, true)) === true,
	);
}

function validateBatch(
	state: ReadonlyMap<string, StateAssignment>,
	assignments: readonly StateAssignment[],
	change?: StateChange,
): StepFailure | undefined {
	const assigned = new Map<string, StateAssignment>();
	for (const assignment of assignments) {
		const key = stateKey(assignment);
		const previous = assigned.get(key);
		if (previous !== undefined && previous.value !== assignment.value) {
			return changeFailure(
				change,
				"conflicting_assignment",
				`同一节的 changes 给 ${assignment.subject}.${assignment.property} 写了两个不同的值`,
				assignment,
				previous.value,
			);
		}
		assigned.set(key, assignment);
		if (assignment.scope !== "world") continue;
		if (assignment.property === "dead" && assignment.value === false) {
			return changeFailure(
				change,
				"dead_state_reversed",
				`${assignment.subject}.dead 是终止状态：死亡发生之前不写这一项，不要写 dead: false`,
				assignment,
			);
		}
		if (assignment.property === "dead" && valueIn(state, assignment) === true && assignment.value !== true) {
			return changeFailure(
				change,
				"dead_state_reversed",
				`${assignment.subject} 已经死亡，不能再改回活着`,
				assignment,
				true,
			);
		}
		const terminalProperty = (TERMINAL_RESOURCE_PROPERTIES as readonly string[]).includes(assignment.property);
		if (terminalProperty && assignment.value === false) {
			return changeFailure(
				change,
				"terminal_resource_reused",
				`${assignment.subject}.${assignment.property} 是终止状态：发生之前不写这一项，不要写 false`,
				assignment,
			);
		}
		if (
			(assignment.property === "holder" || assignment.property === "location") &&
			assignment.value !== "none" &&
			resourceIsTerminal(state, assignment.subject)
		) {
			return changeFailure(
				change,
				"terminal_resource_reused",
				`${assignment.subject} 已经被消耗或毁掉，不能再有人持有或放在某处`,
				assignment,
			);
		}
	}

	const byResource = new Map<string, StateAssignment[]>();
	for (const assignment of assignments) {
		if (assignment.scope !== "world" || !assignment.subject.startsWith("resource:")) continue;
		const values = byResource.get(assignment.subject) ?? [];
		values.push(assignment);
		byResource.set(assignment.subject, values);
	}
	for (const values of byResource.values()) {
		const holder = values.find((item) => item.property === "holder" && item.value !== "none");
		const location = values.find((item) => item.property === "location" && item.value !== "none");
		const terminal = values.find(
			(item) => (TERMINAL_RESOURCE_PROPERTIES as readonly string[]).includes(item.property) && item.value === true,
		);
		if (holder !== undefined && location !== undefined) {
			return changeFailure(
				change,
				"conflicting_assignment",
				`同一节里 ${location.subject} 不能既交给人持有、又放在某个地点`,
				location,
			);
		}
		if (terminal !== undefined && (holder !== undefined || location !== undefined)) {
			return changeFailure(
				change,
				"conflicting_assignment",
				`同一节里 ${terminal.subject} 不能既被消耗或毁掉、又交给人或放在某处`,
				holder ?? location,
			);
		}
	}
	return undefined;
}

/**
 * 硬状态的写入规则，不做校验：写入批次，再按资源终止与 holder / location 互清规则收敛。
 * `evaluate` 与状态时间线共用这一份实现，避免两处漂移。
 */
export function applyStateAssignments(
	previous: ReadonlyMap<string, StateAssignment>,
	assignments: readonly StateAssignment[],
): Map<string, StateAssignment> {
	const candidate = new Map(previous);
	for (const assignment of assignments) candidate.set(stateKey(assignment), assignment);

	const touchedResources = new Set(
		assignments
			.filter((assignment) => assignment.scope === "world" && assignment.subject.startsWith("resource:"))
			.map((assignment) => assignment.subject),
	);
	for (const resource of touchedResources) {
		if (resourceIsTerminal(candidate, resource)) {
			const holder = worldAssignment(resource, "holder", "none");
			const location = worldAssignment(resource, "location", "none");
			candidate.set(stateKey(holder), holder);
			candidate.set(stateKey(location), location);
			continue;
		}
		const holder = candidate.get(stateKey(worldAssignment(resource, "holder", "none")));
		const location = candidate.get(stateKey(worldAssignment(resource, "location", "none")));
		const holderChanged = assignments.some(
			(assignment) =>
				assignment.scope === "world" && assignment.subject === resource && assignment.property === "holder",
		);
		const locationChanged = assignments.some(
			(assignment) =>
				assignment.scope === "world" && assignment.subject === resource && assignment.property === "location",
		);
		if (holderChanged && holder?.value !== "none") {
			const cleared = worldAssignment(resource, "location", "none");
			candidate.set(stateKey(cleared), cleared);
		} else if (locationChanged && location?.value !== "none") {
			const cleared = worldAssignment(resource, "holder", "none");
			candidate.set(stateKey(cleared), cleared);
		}
	}
	return candidate;
}

function applyBatch(
	state: Map<string, StateAssignment>,
	assignments: readonly StateAssignment[],
	change?: StateChange,
): StepFailure | undefined {
	const validationFailure = validateBatch(state, assignments, change);
	if (validationFailure !== undefined) return validationFailure;
	const candidate = applyStateAssignments(state, assignments);
	state.clear();
	for (const [key, assignment] of candidate) state.set(key, assignment);
	return undefined;
}

/**
 * 按 StoryBeat 顺序重放硬状态。失败的批次不写入状态但不终止重放，
 * 因此一次调用返回全部可定位的失败；`appliedStoryBeatIds` 只含成功应用的 Beat。
 */
export function evaluate(projection: StateProjection): CheckResult {
	const state = new Map<string, StateAssignment>();
	const applied: string[] = [];
	const failures: StepFailure[] = [];
	const initialFailure = applyBatch(state, projection.initial);
	if (initialFailure !== undefined) failures.push(initialFailure);

	const ordinal = new Map(projection.authorizedBeatIds.map((id, index) => [id, index]));
	let previousOrdinal = -1;
	for (const change of projection.changes) {
		const currentOrdinal = ordinal.get(change.storyBeatId);
		if (currentOrdinal === undefined) {
			failures.push(
				changeFailure(
					change,
					"change_outside_story",
					"state change references a StoryBeat outside the evaluated story",
				),
			);
			continue;
		}
		if (currentOrdinal <= previousOrdinal) {
			failures.push(
				changeFailure(
					change,
					"change_order_invalid",
					"state changes must follow StoryBeat order and occur once per Beat",
				),
			);
			continue;
		}
		previousOrdinal = currentOrdinal;
		const changeFailureResult = applyBatch(state, change.assignments, change);
		if (changeFailureResult !== undefined) {
			failures.push(changeFailureResult);
			continue;
		}
		applied.push(change.storyBeatId);
	}
	return result(projection, state, applied, failures);
}
