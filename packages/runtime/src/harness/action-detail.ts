import { CheckpointArchive } from "./checkpoint-archive.js";
import type { LoopCheckpoint } from "./loop.js";

/** 对话里点开一个动作时看到的完整输入与输出；还没交回的动作没有 output。 */
export interface ActionDetail {
	tool: string;
	input: Record<string, unknown>;
	output?: string;
	isError: boolean;
	truncated: boolean;
}

/** 一次最多给这么多码点；斗破 120 章那次对话里最长的工具结果约 4 万字。 */
const MAX_OUTPUT_CODE_POINTS = 100_000;
/** 最近恢复点的入口保留四份；具体节点复用 Archive 的有界缓存。 */
const CACHED_CHECKPOINTS = 4;

/**
 * 从跑这个动作的 loop 的 checkpoint 里读它的完整输入与输出（Harness 设计第 11 节）。事件流只带一句摘要，
 * 完整内容本来就在 checkpoint 里，点开时才读，不在事件里再存一份。checkpoint 对象内容寻址、不可变，按对象 id 缓存。
 */
export class ActionDetailReader {
	readonly #archive: CheckpointArchive;
	readonly #objects: { readExecutionObject(id: string): Promise<{ bytes: Uint8Array }> };
	readonly #checkpoints = new Map<string, Promise<Uint8Array>>();

	constructor(objects: ConstructorParameters<typeof CheckpointArchive>[0]) {
		this.#archive = new CheckpointArchive(objects);
		this.#objects = objects;
	}

	async read(checkpointId: string, actionId: string): Promise<ActionDetail | undefined> {
		const action = (await this.#archive.readArrayEntry(
			await this.#checkpoint(checkpointId),
			["loop", "actions"],
			"id",
			actionId,
		)) as LoopCheckpoint["actions"][number] | undefined;
		if (action === undefined) return undefined;
		const text = action.message?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		const codePoints = text === undefined ? [] : Array.from(text);
		const truncated = codePoints.length > MAX_OUTPUT_CODE_POINTS;
		return {
			tool: action.call.name,
			// 模型给的参数可能不是对象（pi-ai 把 null、[] 原样解析出来，动作以 invalid_tool_arguments 失败），原样放进一项
			input: isRecord(action.call.arguments) ? action.call.arguments : { arguments: action.call.arguments },
			...(text === undefined
				? {}
				: { output: truncated ? codePoints.slice(0, MAX_OUTPUT_CODE_POINTS).join("") : text }),
			isError: action.message?.isError ?? false,
			truncated,
		};
	}

	#checkpoint(checkpointId: string): Promise<Uint8Array> {
		let pending = this.#checkpoints.get(checkpointId);
		if (pending !== undefined) this.#checkpoints.delete(checkpointId);
		else {
			pending = this.#objects.readExecutionObject(checkpointId).then(({ bytes }) => bytes);
			void pending.catch(() => {
				if (this.#checkpoints.get(checkpointId) === pending) this.#checkpoints.delete(checkpointId);
			});
		}
		this.#checkpoints.set(checkpointId, pending);
		for (const key of this.#checkpoints.keys()) {
			if (this.#checkpoints.size <= CACHED_CHECKPOINTS) break;
			this.#checkpoints.delete(key);
		}
		return pending;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
