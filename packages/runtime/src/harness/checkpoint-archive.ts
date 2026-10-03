import { createHash } from "node:crypto";
import { executionJsonBytes, parseExecutionJson } from "../execution/execution-object-codec.js";

type Node =
	| null
	| boolean
	| number
	| string
	| { ref: string }
	| { array: Node[] }
	| { chunks: Node[] }
	| { object: [string, Node][] };
interface ObjectPort {
	saveExecutionObject(mediaType: string, bytes: Uint8Array): Promise<{ id: string }>;
	readExecutionObject(id: string): Promise<{ bytes: Uint8Array }>;
}
const ENCODING = "suiming-checkpoint-tree-1";
const NODE_MEDIA_TYPE = "application/vnd.suiming.harness-node+json";
/** 按 JSON 记住的小节点上限；超过就清空重来，最近的节点很快会再记上。 */
const NODE_REFS_LIMIT = 50_000;
const NODE_REF_MAX_JSON = 8192;

/** 在已有 execution object 内共享不可变片段；恢复点只增加发生变化的节点。 */
export class CheckpointArchive {
	readonly #objects: ObjectPort;
	readonly #written = new Map<string, Promise<string>>();
	readonly #encoded = new WeakMap<object, Promise<Node>>();
	/**
	 * 未冻结的节点（调用 / 动作记录、数组分块、根）每次保存都会重建，内容多半没变。按 JSON 记住它们的
	 * 引用，没变的节点只花一次查表，不再每次序列化、算哈希、查库——否则一个会话里每次保存的成本
	 * 随调用数线性增长（2026-10-01 Harness 审查 F1 的余项）。大节点几乎都是冻结的消息，由 #encoded 按身份缓存。
	 */
	readonly #refs = new Map<string, Promise<string>>();
	constructor(objects: ObjectPort) {
		this.#objects = objects;
	}

	async #put(value: unknown, mediaType = NODE_MEDIA_TYPE): Promise<string> {
		const bytes = executionJsonBytes(value);
		const hash = createHash("sha256").update(mediaType).update(bytes).digest("hex");
		let pending = this.#written.get(hash);
		if (!pending) {
			pending = this.#objects.saveExecutionObject(mediaType, bytes).then(({ id }) => id);
			this.#written.set(hash, pending);
			pending.catch(() => this.#written.delete(hash));
		}
		return pending;
	}

	async write(value: unknown): Promise<{ id: string }> {
		const encode = (value: unknown): Promise<Node> => {
			// 只缓存 loop 已冻结的不可变片段；外层的调用列表仍会追加。
			if (value === null || typeof value !== "object" || !Object.isFrozen(value)) return encodeValue(value);
			let pending = this.#encoded.get(value);
			if (!pending) {
				pending = encodeValue(value);
				this.#encoded.set(value, pending);
				pending.catch(() => this.#encoded.delete(value));
			}
			return pending;
		};
		const encodeValue = async (value: unknown): Promise<Node> => {
			let node: Node;
			if (value instanceof Uint8Array)
				return encode({ encoding: "base64", bytes: Buffer.from(value).toString("base64") });
			if (Array.isArray(value)) {
				if (value.length > 16) {
					const chunks: unknown[][] = [];
					for (let index = 0; index < value.length; index += 16) chunks.push(value.slice(index, index + 16));
					node = { chunks: await Promise.all(chunks.map(encode)) };
				} else node = { array: await Promise.all(value.map(encode)) };
			} else if (value !== null && typeof value === "object")
				node = {
					object: await Promise.all(
						Object.entries(value)
							.filter(([, item]) => item !== undefined)
							.map(async ([key, item]): Promise<[string, Node]> => [key, await encode(item)]),
					),
				};
			else node = (value ?? null) as Node;
			// 小节点留在父节点，避免每个布尔值和 id 都产生数据库行。
			const json = JSON.stringify(node);
			if (json.length <= (typeof node === "string" ? 2048 : 256)) return node;
			if (json.length > NODE_REF_MAX_JSON) return { ref: await this.#put(node) };
			let ref = this.#refs.get(json);
			if (!ref) {
				if (this.#refs.size >= NODE_REFS_LIMIT) this.#refs.clear();
				ref = this.#put(node);
				this.#refs.set(json, ref);
				ref.catch(() => this.#refs.delete(json));
			}
			return { ref: await ref };
		};
		return {
			id: await this.#put(
				{ encoding: ENCODING, root: await encode(value) },
				"application/vnd.suiming.harness-checkpoint+json",
			),
		};
	}

	async read(bytes: Uint8Array): Promise<unknown> {
		const value = parseExecutionJson(bytes, "Harness checkpoint") as { encoding?: string; root: Node };
		// 历史恢复点的语义不变；旧的内联 JSON 可直接读取，后续写入统一使用片段引用。
		if (value.encoding !== ENCODING) return value;
		const loaded = new Map<string, Node>();
		const decode = async (node: Node, depth = 0): Promise<unknown> => {
			if (depth > 100) throw new Error("Checkpoint object reference is too deep or cyclic");
			if (node === null || typeof node !== "object") return node;
			if ("ref" in node) {
				let stored = loaded.get(node.ref);
				if (stored === undefined) {
					stored = parseExecutionJson(
						(await this.#objects.readExecutionObject(node.ref)).bytes,
						"Checkpoint node",
					) as Node;
					loaded.set(node.ref, stored);
				}
				return decode(stored, depth + 1);
			}
			if ("array" in node) return Promise.all(node.array.map((item) => decode(item, depth + 1)));
			if ("chunks" in node) return (await Promise.all(node.chunks.map((item) => decode(item, depth + 1)))).flat();
			if ("object" in node)
				return Object.fromEntries(
					await Promise.all(node.object.map(async ([key, item]) => [key, await decode(item, depth + 1)])),
				);
			throw new Error("Invalid checkpoint node");
		};
		return decode(value.root);
	}
}
