import type { SessionEvent, SuimingTurnSummary } from "@suiming/sdk";
import { TARGET_DESIGN_KINDS } from "@suiming/story";
import { artifactIdentityKey } from "../artifact/identity.js";
import type { ArtifactCandidate, ArtifactIdentity } from "../artifact/types.js";

const DESIGN_KINDS = new Set<string>(TARGET_DESIGN_KINDS);
/** 每类最多带这么多路径；count 是全数。一次大改不能把整部作品的文件名灌进事件。 */
const MAX_PATHS = 20;

type Category = keyof SuimingTurnSummary["changed"];

function categoryOf(identity: ArtifactIdentity): Category {
	if (identity.namespace.kind !== "target") return "other";
	if (identity.kind === "intent") return "intent";
	if (DESIGN_KINDS.has(identity.kind)) return "design";
	if (identity.kind === "story-text") return "text";
	if (identity.kind === "review") return "review";
	return "other";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
		Buffer.from(right.buffer, right.byteOffset, right.byteLength),
	);
}

/**
 * turn 结束时的对账（Harness 设计第 3 节）：turn 开始与结束时的 checkout 之差就是这一轮作品改了什么——
 * 谁改的都算，作者在编辑器里同时保存的也在内；提交了的与还没提交的都算。纯算术，不判断改得对不对、
 * 作者的目标达成没有，那由作者看作品定。
 */
export function turnSummary(
	start: ArtifactCandidate,
	end: ArtifactCandidate,
	counts: { authorMessages: number; revisions: number; uncommitted: number; textWithoutContext: string[] },
): SuimingTurnSummary {
	const before = new Map(start.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
	const after = new Map(end.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
	const changed: Record<Category, string[]> = { intent: [], design: [], text: [], review: [], other: [] };
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const previous = before.get(key);
		const next = after.get(key);
		if (previous !== undefined && next !== undefined && sameBytes(previous.bytes, next.bytes)) continue;
		const artifact = next ?? previous;
		if (artifact !== undefined) changed[categoryOf(artifact.identity)].push(artifact.path);
	}
	const summarize = (paths: string[]) => {
		const sorted = [...paths].sort();
		return { count: sorted.length, paths: sorted.slice(0, MAX_PATHS) };
	};
	return {
		authorMessages: counts.authorMessages,
		changed: {
			intent: summarize(changed.intent),
			design: summarize(changed.design),
			text: summarize(changed.text),
			review: summarize(changed.review),
			other: summarize(changed.other),
		},
		revisions: counts.revisions,
		uncommitted: counts.uncommitted,
		textWithoutContext: summarize(counts.textWithoutContext),
	};
}

const TEXT_PATH = /^text\/(.+)\.md$/u;

/**
 * 这一轮里没取写作依据就整篇写入的正文（2026-10-02 斗破留出评测：根 Agent 三节正文都凭 Frame 自己写，没调
 * write_context 也没委派 writer，没人发现）。写作方法与硬边界只跟着 Write Context 到；取过 write_context、
 * 委派过 writer 的 Beat 不算，writer 子任务自己的写入不算，`edit` 小改不算。从这一轮的动作事件算，纯算术。
 */
export function textWrittenWithoutContext(
	events: readonly SessionEvent[],
	writerTaskIds: ReadonlySet<string>,
): string[] {
	const informed = new Set<string>();
	const written = new Set<string>();
	for (const { event } of events) {
		if (event.type !== "ACTIVITY_SNAPSHOT" || event.activityType !== "suiming.action") continue;
		const action = event.content as { label?: string; target?: string; isError?: boolean };
		if (action.isError === true || action.target === undefined) continue;
		if (action.label === "write_context" || action.label === "delegate") informed.add(action.target);
		const beat = action.label === "write" ? TEXT_PATH.exec(action.target)?.[1] : undefined;
		if (beat !== undefined && !writerTaskIds.has(event.subagentRunId ?? "")) written.add(beat);
	}
	return [...written].filter((beat) => !informed.has(beat)).map((beat) => `text/${beat}.md`);
}
