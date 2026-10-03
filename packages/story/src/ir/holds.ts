import type { StepErrorCode } from "./profile.js";
import type { StateAssignment, StateValue, StepFailure } from "./types.js";

export function stateKey(item: Pick<StateAssignment, "scope" | "subject" | "property">): string {
	return JSON.stringify([item.scope, item.subject, item.property]);
}

export function failure(
	code: StepErrorCode,
	message: string,
	options: {
		assignment?: StateAssignment;
		actual?: StateValue | "unknown";
		storyBeatId?: string;
	} = {},
): StepFailure {
	return { code, message, ...options };
}

export function valueIn(state: ReadonlyMap<string, StateAssignment>, query: StateAssignment): StateValue | "unknown" {
	return state.get(stateKey(query))?.value ?? "unknown";
}
