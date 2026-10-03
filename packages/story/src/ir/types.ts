import type { StateProperty, StepErrorCode } from "./profile.js";

export type StateValue = string | boolean;

export interface StateAssignment {
	subject: string;
	property: StateProperty;
	value: StateValue;
	scope: string;
}

export interface StateChange {
	storyBeatId: string;
	assignments: readonly StateAssignment[];
}

export interface StateProjection {
	profileVersion: "state-projection-p0@2";
	initial: readonly StateAssignment[];
	changes: readonly StateChange[];
	authorizedBeatIds: readonly string[];
}

export interface StepFailure {
	code: StepErrorCode;
	message: string;
	storyBeatId?: string;
	assignment?: StateAssignment;
	actual?: StateValue | "unknown";
}

export interface CheckResult {
	profileVersion: "state-projection-p0@2";
	passed: boolean;
	appliedStoryBeatIds: string[];
	finalState: StateAssignment[];
	authorizedBeatIds: string[];
	failures: StepFailure[];
}
