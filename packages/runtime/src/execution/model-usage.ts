import type { ModelUsage } from "./types.js";

export function emptyModelUsage(): ModelUsage {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0 };
}

export function addModelUsage(left: ModelUsage | undefined, right: ModelUsage): ModelUsage {
	const base = left ?? emptyModelUsage();
	return {
		calls: base.calls + right.calls,
		...(base.confirmedCalls === undefined && right.confirmedCalls === undefined
			? {}
			: { confirmedCalls: (base.confirmedCalls ?? base.calls) + (right.confirmedCalls ?? right.calls) }),
		input: base.input + right.input,
		output: base.output + right.output,
		cacheRead: base.cacheRead + right.cacheRead,
		cacheWrite: base.cacheWrite + right.cacheWrite,
		reasoning: base.reasoning + right.reasoning,
		totalTokens: base.totalTokens + right.totalTokens,
		costUsd: base.costUsd + right.costUsd,
	};
}
