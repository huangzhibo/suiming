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
/** 解开的 checkpoint 留几份：作者往往在同一个 loop 里接连点开几个动作，整读一份要几十到两百多毫秒。 */
const CACHED_LOOPS = 4;

/**
 * 从跑这个动作的 loop 的 checkpoint 里读它的完整输入与输出（Harness 设计第 11 节）。事件流只带一句摘要，
 * 完整内容本来就在 checkpoint 里，点开时才读，不在事件里再存一份。checkpoint 对象内容寻址、不可变，按对象 id 缓存。
 */
export class ActionDetailReader {
	readonly #archive: CheckpointArchive;
	readonly #objects: { readExecutionObject(id: string): Promise<{ bytes: Uint8Array }> };
	readonly #loops = new Map<string, Promise<LoopCheckpoint>>();

	constructor(objects: ConstructorParameters<typeof CheckpointArchive>[0]) {
		this.#archive = new CheckpointArchive(objects);
		this.#objects = objects;
	}

	async read(checkpointId: string, actionId: string): Promise<ActionDetail | undefined> {
		const action = (await this.#loop(checkpointId)).actions.find((item) => item.id === actionId);
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

	#loop(checkpointId: string): Promise<LoopCheckpoint> {
		let loop = this.#loops.get(checkpointId);
		// 命中的挪到最新，挤掉的是最久没点的
		if (loop !== undefined) {
			this.#loops.delete(checkpointId);
			this.#loops.set(checkpointId, loop);
		} else {
			loop = this.#objects
				.readExecutionObject(checkpointId)
				.then(async ({ bytes }) => ((await this.#archive.read(bytes)) as { loop: LoopCheckpoint }).loop);
			this.#loops.set(checkpointId, loop);
			loop.catch(() => this.#loops.delete(checkpointId));
			for (const key of this.#loops.keys()) {
				if (this.#loops.size <= CACHED_LOOPS) break;
				this.#loops.delete(key);
			}
		}
		return loop;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
