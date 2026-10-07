import { posix } from "node:path";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { buildStateTimeline, formatDiagnostic, sha256Hex } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import {
	checkFindings,
	inspectStoryDesignCandidate,
	validateStoryProjectCandidate,
} from "../artifact/story-design-validator.js";
import { parseStoryImpactSubject, storyImpact } from "../artifact/story-impact.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import { searchStoryCandidate } from "../artifact/story-search.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import {
	type ConfinedEnvPolicy,
	type ConfinedExecutionEnv,
	conflictMessage,
	type FileMutation,
} from "./confined-env.js";
import { type HarnessTool, type HarnessToolResult, type ToolDetails, ToolRejection } from "./tool.js";
import { renderState, styleEvidenceFor } from "./write-context.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

function text(value: string): HarnessToolResult<undefined> {
	return { content: [{ type: "text", text: value }] };
}

/** 只读工具：同样的参数再调一次就拿回当前结果，边界折叠可以折它的大结果。 */
export function readTool<T extends TSchema, D extends ToolDetails>(
	tool: Omit<HarnessTool<T, D>, "rereadable">,
): HarnessTool<T, D> {
	return { ...tool, rereadable: true };
}

const ReadSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
	},
	{ additionalProperties: false },
);
/**
 * 写完顺手检查（SoL-Pi Action Fusion 的无 shell 版）：Writer 写一节要 write 三四次、每次后面再来一次
 * check（DeepSeek 一次只吐两三千字，见 packages/runtime/AGENTS.md），合进写入就省掉那一个模型来回。
 */
const CheckAfterWrite = Type.Optional(
	Type.Boolean({ description: "true 时写完立刻对整个候选跑一次确定性检查（同 check 工具），结论接在结果后面" }),
);
const WriteSchema = Type.Object(
	{ path: Type.String({ minLength: 1 }), content: Type.String(), check: CheckAfterWrite },
	{ additionalProperties: false },
);
const EditSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
		check: CheckAfterWrite,
	},
	{ additionalProperties: false },
);
const DeleteSchema = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const CopySchema = Type.Object(
	{
		from: Type.String({ minLength: 1, description: "源文件或目录" }),
		to: Type.String({ minLength: 1, description: "目标路径；源是目录时整棵按相对路径复制过去" }),
		check: CheckAfterWrite,
	},
	{ additionalProperties: false },
);
const MoveSchema = Type.Object(
	{
		from: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description: "要挪的文件或目录；只有一个时 to 就是它的新路径（改名），多个时 to 是目录、各自保留文件名",
		}),
		to: Type.String({ minLength: 1 }),
		check: CheckAfterWrite,
	},
	{ additionalProperties: false },
);
/** 一次复制的文件上限；斗破前 120 章的整份 Source Design 约 170 个文件。 */
const MAX_COPY_FILES = 1000;

/** 目录下的全部文件（逻辑路径）；源是文件时返回 undefined。读范围之外、symlink 与隐藏根目录照 list 的规则不出现。 */
async function filesUnder(
	env: ConfinedExecutionEnv,
	path: string,
	found: string[] = [],
): Promise<string[] | undefined> {
	let entries: string[];
	try {
		entries = await env.listEntries(path);
	} catch (error) {
		if (error instanceof ToolRejection && error.code === "not_a_directory") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (entry.endsWith("/")) await filesUnder(env, entry.slice(0, -1), found);
		else found.push(entry);
		if (found.length > MAX_COPY_FILES)
			throw new ToolRejection("copy_too_large", `${path} 下超过 ${MAX_COPY_FILES} 个文件，分几个子目录复制`);
	}
	return found;
}

function logicalPath(path: string): string {
	return posix
		.normalize(path)
		.replace(/^\.\/+/u, "")
		.replace(/\/+$/u, "");
}
const ListSchema = Type.Object(
	// 空字符串也当根目录：2026-10-01 斗破那一轮模型第一次列根目录就传了 ""，被 schema 拒了一次才改用路径。
	{ path: Type.Optional(Type.String({ description: "目录；缺省或空字符串是作品根目录" })) },
	{ additionalProperties: false },
);
/** 一次最多列这么多项；超了说还剩几项，模型可以往下一层列。 */
const MAX_LIST_ENTRIES = 300;

/** 写入后的字数，与正文检查（checkStoryText 的 codePoints）同一口径：按码点计，含标点与换行。 */
function sizeAfter(mutation: FileMutation): string {
	if (mutation.bytes === null) return "";
	return `，${Array.from(Buffer.from(mutation.bytes).toString("utf8")).length} 字`;
}

const STORY_TEXT_PATH = /^text\/(.+)\.md$/u;

/** 正文的段落：空行分隔，`## 第N章` 这类标题不算；段长按去掉空白的字数。 */
function paragraphStats(content: string): { count: number; average: number } {
	const paragraphs = content
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("#"));
	const total = paragraphs.reduce((sum, paragraph) => sum + Array.from(paragraph.replace(/\s+/gu, "")).length, 0);
	return { count: paragraphs.length, average: paragraphs.length === 0 ? 0 : Math.round(total / paragraphs.length) };
}

/**
 * 写正文时附段落数与平均段长，并给出文风依据的段长：有作者选定的样章（reference/style）就对照样章，没有才对照
 * 故事顺序上的前一节——前文质量可能参差，前一节也可能是 Agent 自己写的。段落偏碎两次都是事后量出来的
 * （2026-10-03 续写平均段长 31–34 字，原作 51 字）；写的时候给出数，Writer 与根 Agent 才能当场校准。
 * 读不出 Design 时只给本节的数。
 */
async function storyTextShape(mutation: FileMutation, scan?: CandidateScanner): Promise<string> {
	const beat = STORY_TEXT_PATH.exec(mutation.path)?.[1];
	if (beat === undefined || mutation.bytes === null) return "";
	const own = paragraphStats(Buffer.from(mutation.bytes).toString("utf8"));
	let previous: { count: number; average: number } | undefined;
	let reference = "前一节";
	if (scan !== undefined) {
		try {
			const candidate = await scan();
			const evidence = styleEvidenceFor(candidate, beat);
			if (evidence.length > 0) {
				reference = "样章";
				previous = paragraphStats(evidence.map((item) => item.text).join("\n\n"));
				return `；段落 ${own.count}，平均段长 ${own.average} 字（${reference} ${previous.average} 字）`;
			}
			const order = inspectStoryDesignCandidate(candidate).design.story.beats.map((item) => item.id);
			const before = order[order.indexOf(beat) - 1];
			const artifact =
				before === undefined
					? undefined
					: candidate.artifacts.find(
							(item) =>
								item.identity.namespace.kind === "target" &&
								item.identity.kind === "story-text" &&
								item.identity.localId === before,
						);
			if (artifact !== undefined) previous = paragraphStats(new TextDecoder().decode(artifact.bytes));
		} catch {
			previous = undefined;
		}
	}
	return `；段落 ${own.count}，平均段长 ${own.average} 字${previous === undefined ? "" : `（${reference} ${previous.average} 字）`}`;
}

/**
 * 文件动作由 Suiming 执行：先算出要写的字节与写前的 hash（FileMutation），落盘前一刻再核对一次，
 * 作者或别的程序在这中间改过同一个文件就报写冲突，交给模型重读再改。
 */
export function fileTools(
	env: ConfinedExecutionEnv,
	policy: ConfinedEnvPolicy,
	scan?: CandidateScanner,
): HarnessTool[] {
	/** 改动已经落盘之后再检查：检查不过也如实返回，模型据此接着改，不回滚写入。 */
	const written = async (summary: string, check: boolean | undefined) =>
		text(check && scan ? `${summary}\n\n检查：${formatCheck(await scan())}` : summary);
	const read: HarnessTool<typeof ReadSchema> = {
		name: "read",
		description: "读取作品中的 UTF-8 文件。offset 从 1 开始，默认最多 2000 行。",
		parameters: ReadSchema,
		rereadable: true,
		async execute(_id, params, signal) {
			const content = await env.readTextFile(params.path, signal);
			const lines = content.split("\n");
			const start = (params.offset ?? 1) - 1;
			const end = Math.min(lines.length, start + (params.limit ?? 2000));
			if (start >= lines.length) throw new ToolRejection("invalid_read_range", `文件只有 ${lines.length} 行`);
			return text(
				lines
					.slice(start, end)
					.map((line, i) => `${start + i + 1}: ${line}`)
					.join("\n") + (end < lines.length ? `\n[还有 ${lines.length - end} 行；用 offset 继续读取]` : ""),
			);
		},
	};
	// 没有 shell，找审稿、资料、正文这类文件的准确路径只能靠它；Frame 只列 Design，search 只按内容找。
	const list: HarnessTool<typeof ListSchema> = {
		name: "list",
		description: "列出作品目录里一层的文件与子目录（子目录以 / 结尾），用来找文件的准确路径；不读内容。",
		parameters: ListSchema,
		rereadable: true,
		async execute(_id, params) {
			const entries = await env.listEntries(params.path || ".");
			const shown = entries.slice(0, MAX_LIST_ENTRIES);
			return text(
				shown.length === 0
					? "（空目录）"
					: shown.join("\n") +
							(entries.length > shown.length ? `\n[还有 ${entries.length - shown.length} 项未列出]` : ""),
			);
		},
	};
	const write: HarnessTool<typeof WriteSchema> = {
		name: "write",
		description:
			"创建或完整替换允许范围内的作品文件。结果给出写入后的字数（按码点计，含标点与换行，与正文检查同一口径）；汇报篇幅以它为准，不要估算。带 check: true 时一并返回对整个候选的确定性检查结论，省掉紧跟着的一次 check。",
		parameters: WriteSchema,
		async execute(_id, params, signal) {
			const mutation = await env.prepareWrite(params.path, params.content);
			await env.applyMutation(mutation, signal);
			return written(
				`已写入 ${mutation.path}${sizeAfter(mutation)}${await storyTextShape(mutation, scan)}`,
				params.check,
			);
		},
	};
	const edit: HarnessTool<typeof EditSchema> = {
		name: "edit",
		description:
			"在作品文件中精确替换唯一一段 oldText；必须先读取文件。结果给出改后的字数；带 check: true 时一并返回确定性检查结论。",
		parameters: EditSchema,
		async execute(_id, params, signal) {
			const original = await env.readTextFile(params.path, signal);
			if (
				!original.includes(params.oldText) ||
				original.indexOf(params.oldText) !== original.lastIndexOf(params.oldText)
			)
				throw new ToolRejection("edit_not_unique", "oldText 必须在文件中恰好出现一次");
			const mutation = await env.prepareWrite(params.path, original.replace(params.oldText, params.newText));
			// 在读和准备之间有外部修改时不能把新文件当成刚才读到的输入。
			if (mutation.before !== sha256Hex(original))
				throw new ToolRejection("file_write_conflict", conflictMessage(params.path));
			await env.applyMutation(mutation, signal);
			return written(
				`已修改 ${mutation.path}${sizeAfter(mutation)}${await storyTextShape(mutation, scan)}`,
				params.check,
			);
		},
	};
	const remove: HarnessTool<typeof DeleteSchema> = {
		name: "delete",
		description: "删除允许范围内的作品文件。删除只改当前候选；提交时 Checker 会检查是否有引用指向它。",
		parameters: DeleteSchema,
		async execute(_id, params, signal) {
			const mutation = await env.prepareWrite(params.path, null);
			// 删一个本来就不存在的文件不是「成功」，是模型记错了路径：如实拒绝，别让它以为删掉了。
			if (mutation.before === null) throw new ToolRejection("file_not_found", params.path);
			await env.applyMutation(mutation, signal);
			return text(`已删除 ${mutation.path}`);
		},
	};
	// 2026-10-02 斗破抽取：没有它时「原样提升」只能逐个 read 再让模型整篇重打一遍 write，一百多个文件、半个多小时，还可能抄走样。
	const copy: HarnessTool<typeof CopySchema> = {
		name: "copy",
		description:
			"把允许范围内的一个文件或整个目录原样复制到新路径：目录按相对路径整棵复制，同名文件覆盖。内容不经过你，比 read 再 write 快，也不会抄错；Source 原样提升为 Target 用它（如 source/<id>/world → world）。带 check: true 时一并返回确定性检查结论。",
		parameters: CopySchema,
		async execute(_id, params, signal) {
			const from = logicalPath(params.from);
			const to = logicalPath(params.to);
			if (to === from || to.startsWith(`${from}/`))
				throw new ToolRejection("copy_into_itself", `不能把 ${from} 复制进它自己（${to}）`);
			const files = await filesUnder(env, from);
			if (files?.length === 0) throw new ToolRejection("copy_empty", `${from} 是空目录`);
			const pairs =
				files === undefined
					? [[from, to] as const]
					: files.map((file) => {
							if (!file.startsWith(`${from}/`)) throw new Error(`listed ${file} outside ${from}`);
							return [file, `${to}/${file.slice(from.length + 1)}`] as const;
						});
			const mutations: FileMutation[] = [];
			for (const [source, target] of pairs)
				mutations.push(await env.prepareWrite(target, await env.readBinaryFile(source, signal)));
			for (const mutation of mutations) await env.applyMutation(mutation, signal);
			const created = mutations.filter((mutation) => mutation.before === null).length;
			const unchanged = mutations.filter((mutation) => mutation.before === mutation.after).length;
			return written(
				`已复制 ${from} → ${to}：${mutations.length} 个文件（新建 ${created}，覆盖 ${mutations.length - created - unchanged}，内容未变 ${unchanged}）`,
				params.check,
			);
		},
	};
	// 2026-10-03 斗破 120 章：整合给 153 节分卷，只能逐个 copy 再 delete。换卷是改 index.yaml 加 mv 文件两步。
	const move: HarnessTool<typeof MoveSchema> = {
		name: "move",
		description:
			"把允许范围内的文件或目录挪到新位置，原处不留：from 只有一个时 to 是它的新路径（改名），多个时 to 是目录、各自保留文件名。把 Beat 换卷就是改 index.yaml 再 move 文件。目标已有不同内容时拒绝，不覆盖。带 check: true 时一并返回确定性检查结论。",
		parameters: MoveSchema,
		async execute(_id, params, signal) {
			const to = logicalPath(params.to);
			const pairs: (readonly [string, string])[] = [];
			for (const raw of params.from) {
				const from = logicalPath(raw);
				const target = params.from.length === 1 ? to : `${to}/${posix.basename(from)}`;
				if (target === from || target.startsWith(`${from}/`))
					throw new ToolRejection("move_into_itself", `不能把 ${from} 挪进它自己（${target}）`);
				const files = await filesUnder(env, from);
				if (files?.length === 0) throw new ToolRejection("move_empty", `${from} 是空目录`);
				if (files === undefined) pairs.push([from, target]);
				else for (const file of files) pairs.push([file, `${target}/${file.slice(from.length + 1)}`]);
			}
			const mutations: FileMutation[] = [];
			for (const [source, target] of pairs) {
				const bytes = await env.readBinaryFile(source, signal);
				const write = await env.prepareWrite(target, bytes);
				if (write.before !== null && write.before !== write.after)
					throw new ToolRejection(
						"move_target_exists",
						`${target} 已经有别的内容，不覆盖；先看一眼它，确实不要了再删`,
					);
				mutations.push(write, await env.prepareWrite(source, null));
			}
			for (const mutation of mutations) await env.applyMutation(mutation, signal);
			return written(`已挪到 ${to}：${pairs.length} 个文件`, params.check);
		},
	};
	return policy === "write" ? [read, list, edit, write, copy, move, remove] : [read, list];
}

export type CandidateScanner = () => Promise<ArtifactCandidate>;

const SearchSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "精确文本或中文双字片段；也匹配 artifact id" }),
		kinds: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description: "限定 artifact kind，如 story-beat、character、contract、intent",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		sourceId: Type.Optional(
			Type.String({ minLength: 1, description: "查这份 Source 的抽取（Beat、人物、World…）；缺省查 Target" }),
		),
	},
	{ additionalProperties: false },
);

function snippet(
	candidate: ArtifactCandidate,
	hit: { identity: ArtifactCandidate["artifacts"][number]["identity"]; range?: { start: number; end: number } },
): string {
	if (hit.range === undefined) return "";
	const artifact = candidate.artifacts.find((item) => JSON.stringify(item.identity) === JSON.stringify(hit.identity));
	if (artifact === undefined) return "";
	const codePoints = Array.from(decoder.decode(artifact.bytes));
	const start = Math.max(0, hit.range.start - 40);
	const end = Math.min(codePoints.length, hit.range.end + 40);
	return codePoints.slice(start, end).join("").replace(/\s+/gu, " ");
}

/** 结构化 Story Search：缺省查 Target，带 sourceId 查那份 Source 的抽取；返回路径、命中词与片段。 */
export function searchTool(scan: CandidateScanner): HarnessTool<typeof SearchSchema, undefined> {
	return readTool({
		name: "search",
		description:
			"在当前作品目录中做精确文本 / 标识检索，返回命中的 artifact 路径与片段；带 sourceId 查那份 Source 的抽取（原文按字找用 search_source）。语义检索不可用。",
		parameters: SearchSchema,
		async execute(_toolCallId, params) {
			const candidate = await scan();
			const result = searchStoryCandidate(
				candidate,
				{ kind: "project_revision", projectRevisionId: candidate.baseRevisionId },
				{
					query: params.query,
					namespace:
						params.sourceId === undefined ? { kind: "target" } : { kind: "source", sourceId: params.sourceId },
					...(params.kinds === undefined ? {} : { kinds: params.kinds }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				},
			);
			if (result.hits.length === 0) return text("没有命中。");
			return text(
				result.hits
					.map((hit) => {
						const excerpt = snippet(candidate, hit);
						return `- ${hit.path} (${hit.match}; ${hit.matchedTerms.join(", ")})${excerpt ? `\n  …${excerpt}…` : ""}`;
					})
					.join("\n"),
			);
		},
	});
}

const ImpactSchema = Type.Object(
	{
		subject: Type.String({
			minLength: 1,
			description:
				"<kind>:<id>，kind 是 beat、character、place、resource、world、contract、intent 之一，如 character:诸葛亮",
		}),
		sourceId: Type.Optional(Type.String({ minLength: 1, description: "查这份 Source 的抽取；缺省查 Target" })),
	},
	{ additionalProperties: false },
);

/**
 * 改一个人物、物品、Beat 之前召回可能受影响的文件：直接涉及它的 Beat、经 refs.beat 依赖它们的下游、相关的人物 /
 * 地点 / 物品 / World / Contract（与 `suim design impact` 同一个 storyImpact）。只召回，不判断语义，不是编辑的前置门。
 * 抽取读到后文揭示、要回头补前面的铺垫时，靠它找前文。
 */
export function impactTool(scan: CandidateScanner): HarnessTool<typeof ImpactSchema, undefined> {
	return readTool({
		name: "impact",
		description:
			"改一个人物、物品、地点、World、Contract 或 Beat 之前，按 refs 与 refs.beat 召回可能受影响的 Beat 与文件路径（改 Beat 时也带上紧接着的下一节）；带 sourceId 查那份 Source 的抽取。只召回，不判断语义。",
		parameters: ImpactSchema,
		async execute(_toolCallId, params) {
			const candidate = await scan();
			try {
				return text(
					JSON.stringify(storyImpact(candidate, parseStoryImpactSubject(params.subject), params.sourceId)),
				);
			} catch (error) {
				// 分段抽取时 Beat 已经写了、index 要等整合才有：这是抽取的正常中间态，不是坏掉的 Source。
				// 10-03 前 24 章第五圈，分段的 extractor impact 自己的 Beat，这个错误掀掉了子任务和根 turn。
				if (error instanceof ArtifactError && error.code === "source_story_index_missing")
					throw new ToolRejection(
						error.code,
						`Source ${params.sourceId} 还没有 outline/story/index.yaml：分段抽取时 Beat 还没进目录，impact 要等整合写出 index 才查得了；现在找涉及某人某物的 Beat 用 search（带 sourceId）。`,
						{ cause: error },
					);
				if (error instanceof ArtifactError && !/corrupt|integrity|store|lock|conflict/u.test(error.code))
					throw new ToolRejection(error.code, error.message, { cause: error });
				throw error;
			}
		},
	});
}

const CheckSchema = Type.Object({}, { additionalProperties: false });

/** 提交用同一个 Checker；这里让模型随时看到会被拒的问题、拦不住但要修的问题与 warning。 */
export function checkTool(scan: CandidateScanner): HarnessTool<typeof CheckSchema, undefined> {
	return readTool({
		name: "check",
		description:
			"对当前工作目录运行确定性 Checker（schema、引用、顺序、Contract、硬状态、已有正文）。结论三种：PASSED 没有问题；ISSUES 可以提交，但列出的设计或正文问题要修，阶段提交时先留着也要在回复里告诉作者；FAILED 提交会被拒绝，先修。",
		parameters: CheckSchema,
		async execute() {
			return text(formatCheck(await scan()));
		},
	});
}

/**
 * PASSED / ISSUES / FAILED 与 CLI、桌面的「通过 / 未通过 / 无法检查」一一对应（判定都是 checkFindings）。
 * 2026-10-02 之前只有 PASSED / FAILED：这里只复用提交闸，设计层错误不拦提交，于是 Agent 对一份
 * Contract 没兑现的候选看到「PASSED」，CLI 与桌面却说「未通过：设计」。
 */
export function formatCheck(candidate: ArtifactCandidate): string {
	try {
		const inspected = validateStoryProjectCandidate(candidate);
		const findings = checkFindings(inspected);
		const issues = [
			...findings.errors.map((item) => `- error: ${formatDiagnostic(item)}`),
			...findings.textFailures.map(
				(failure) => `- error: ${failure.storyBeatId} 正文（${failure.code}）：${failure.message}`,
			),
		];
		const warnings = findings.warnings.map((item) => `- warning: ${formatDiagnostic(item)}`);
		const open = inspected.check.contracts.openContractIds;
		return [
			issues.length === 0
				? "PASSED"
				: `ISSUES：可以提交，但有 ${issues.length} 处问题要修；阶段提交时先留着，也要在回复里告诉作者还差什么`,
			...issues,
			...(open.length === 0 ? [] : [`未闭合但尚未到期的 Contract：${open.join(", ")}`]),
			...(warnings.length === 0 ? [] : ["warnings：", ...warnings]),
		].join("\n");
	} catch (error) {
		const coded = error as { code?: string; diagnostics?: unknown[] };
		const diagnostics = Array.isArray(coded.diagnostics)
			? coded.diagnostics.map((item) => `- ${formatDiagnostic(item as Parameters<typeof formatDiagnostic>[0])}`)
			: [];
		return [
			`FAILED ${coded.code ?? "check_failed"}: ${error instanceof Error ? error.message : String(error)}`,
			...diagnostics,
		].join("\n");
	}
}

const FrameSchema = Type.Object(
	{ storyBeatId: Type.String({ minLength: 1, description: "StoryBeat id，如 beat-0012" }) },
	{ additionalProperties: false },
);

/** Frame(t)：某个 Beat 前后的确定性硬状态与它的 refs / Contract；只投影事实，不做解读。 */
export function frameTool(scan: CandidateScanner): HarnessTool<typeof FrameSchema, undefined> {
	return readTool({
		name: "frame",
		description: "查看某个 StoryBeat 之前与之后的硬状态（位置、持有、生死等），以及它引用的实体与 Contract。",
		parameters: FrameSchema,
		async execute(_toolCallId, params) {
			const candidate = await scan();
			let inspected: ReturnType<typeof inspectStoryDesignCandidate>;
			try {
				inspected = inspectStoryDesignCandidate(candidate);
			} catch (error) {
				return text(`当前 Design 无法绑定：${error instanceof Error ? error.message : String(error)}`);
			}
			const beat = inspected.design.story.beats.find((item) => item.id === params.storyBeatId);
			if (beat === undefined) return text(`未知 StoryBeat：${params.storyBeatId}`);
			const timeline = buildStateTimeline(inspected.design.stateProjection);
			const path = storyPackageCodec.pathForIdentity(
				{ namespace: { kind: "target" }, kind: "story-beat", localId: beat.id },
				candidate,
			);
			return text(
				[
					`# ${beat.id}${beat.title === undefined ? "" : ` ${beat.title}`} (${path}, 顺序 ${beat.ordinal})`,
					`refs: ${beat.refs.join(", ") || "无"}`,
					`contracts: open=[${beat.contracts.open.join(", ")}] advance=[${beat.contracts.advance.join(", ")}] resolve=[${beat.contracts.resolve.join(", ")}]`,
					"",
					"## 进入之前",
					renderState(timeline.stateBefore(beat.id)),
					"",
					"## 结束之后",
					renderState(timeline.stateAfter(beat.id)),
				].join("\n"),
			);
		},
	});
}

export interface SubmitToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** 确定性校验并记录提交；抛出的错误会作为工具错误回到模型，由模型在预算内修复。 */
	onSubmit(params: Static<TParameters>): Promise<string> | string;
}

/** 终止型工具：成功即结束该 Task 的内循环。 */
export function submitTool<TParameters extends TSchema>(
	options: SubmitToolOptions<TParameters>,
): HarnessTool<TParameters, undefined> {
	return {
		name: options.name,
		submission: true,
		description: options.description,
		parameters: options.parameters,
		async execute(_id, params) {
			let summary: string;
			try {
				summary = await options.onSubmit(params);
			} catch (error) {
				const code = (error as { code?: unknown } | undefined)?.code;
				if (
					typeof code === "string" &&
					error instanceof Error &&
					(/^(invalid_|unknown_|missing_|duplicate_|unsupported_)/u.test(code) ||
						/(_check_failed|_not_found|_mismatch)$/u.test(code))
				) {
					throw new ToolRejection(code, error.message, { cause: error });
				}
				throw error;
			}
			return { ...text(summary), terminate: true };
		},
	};
}

/**
 * 模型自己生成摘要，下一请求才采用；旧消息与动作记录不删除。opening 给的话，压缩时重取一份开场快照替换会话开场那份：
 * 根 Agent 的开场是会话开始时的作品快照，一次压缩之前通常已经提交过好几个版本。
 */
export function compactContextTool(opening?: () => Promise<string>): HarnessTool {
	const parameters = Type.Object(
		{ summary: Type.String({ minLength: 1, maxLength: 12000 }) },
		{ additionalProperties: false },
	);
	return {
		name: "compact_context",
		description:
			"将已处理的执行上下文压缩为带来源的摘要。保留目标、作者指令、尚未交付的计划、结果引用和待验证判断。原始消息仍持久保存，summary 不成为 Canon。",
		parameters,
		async execute(_id, params: { summary: string }) {
			return {
				...(opening === undefined ? {} : { contextOpening: await opening() }),
				content: [
					{
						type: "text",
						text: "执行摘要已记下：之后的请求里，这次回复之前的模型回复与工具结果只由这份 summary 代表（不是作品事实），作者的消息原样保留；原始执行记录仍在执行存储里。",
					},
				],
				contextSummary: params.summary,
			};
		},
	};
}
