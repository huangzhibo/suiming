import { Type } from "@earendil-works/pi-ai";
import { CANDIDATE_REVISION, ReviewDraftSchema, type ReviewVerdict } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { composeReviewFile } from "../artifact/review-authoring.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import { readMaterialTool, searchMaterialTool } from "./material.js";
import {
	type CompiledReviewContext,
	compileReviewContext,
	type ReviewLayer,
	type ReviewScope,
} from "./review-context.js";
import { formatSourceCheck } from "./source-context.js";
import { storyGuideTool } from "./source-tools.js";
import type { TaskHandle, TaskSpec } from "./suiming-harness.js";
import { type HarnessTool, ToolRejection } from "./tool.js";
import { checkTool, fileTools, frameTool, freezeReadTool, searchTool, submitTool } from "./tools.js";

export type { ReviewLayer, ReviewScope } from "./review-context.js";

const EmptySchema = Type.Object({}, { additionalProperties: false });

export interface ReviewTaskInput {
	layer: ReviewLayer;
	/** 被审查的候选（独立 Review 是 checkout 里的当前候选）。 */
	candidate: ArtifactCandidate;
	/** design：作者目标。 */
	goal?: string;
	/** source：被审查的 Source。 */
	sourceId?: string;
	/** text：审查范围，缺省整部正文。 */
	scope?: ReviewScope;
}

/** submit_review 交付的结果：审稿文件已写进 checkout，随下一次 commit 进版本。 */
export interface ReviewSubmission {
	id: string;
	path: string;
	verdict: ReviewVerdict;
	summary: string;
}

export interface ReviewTaskHandle {
	spec: Omit<TaskSpec, "key" | "parent">;
	/** 从 Task 的持久化结果取回交付；续跑复用已完成 Task 时只有结果对象，没有闭包。 */
	reportOf(result: unknown): ReviewSubmission;
}

function sourceCheckTool(handle: TaskHandle, sourceId: string): HarnessTool {
	// 与 design / text 分支的 checkTool 一样必须冻结：停在 effect_pending 的 check 动作靠 prepare 的结果收口，
	// 否则恢复落到 action_effect_unknown，每次续跑都在同一点暂停。
	return freezeReadTool({
		name: "check",
		label: "check",
		description: `对 source/${sourceId} 运行 Source Checker。`,
		parameters: EmptySchema,
		async execute() {
			return {
				content: [{ type: "text", text: formatSourceCheck(await handle.scan(), sourceId) }],
				details: undefined,
			};
		},
	});
}

function layerTools(handle: TaskHandle, compiled: CompiledReviewContext): HarnessTool[] {
	if (compiled.layer === "source") {
		const sourceId = compiled.subject.kind === "source" ? compiled.subject.sourceId : "";
		return [
			...fileTools(handle.env, "read"),
			readMaterialTool({ material: compiled.material as NonNullable<CompiledReviewContext["material"]> }),
			searchMaterialTool({ material: compiled.material as NonNullable<CompiledReviewContext["material"]> }),
			sourceCheckTool(handle, sourceId),
			storyGuideTool(),
		];
	}
	return [...fileTools(handle.env, "read"), searchTool(handle.scan), checkTool(handle.scan), frameTool(handle.scan)];
}

const SUBMIT_DESCRIPTIONS: Readonly<Record<ReviewLayer, string>> = {
	design:
		"提交对当前 Design 候选的独立 ReviewDraft。finding 必须锚定实际 artifact path，evidence 必须逐字引用该文件里的原文；pass 的 findings/uncovered 必须为空，revise 必须有 finding。",
	source:
		"提交对 Source extraction 的独立 ReviewDraft；finding 锚在要修的 Source artifact path 上，没有对应文件时锚原文 span；evidence 逐字引用那个文件或原作的原句，repairLayer 必须为 source。",
	text: "提交对范围内正文的独立 ReviewDraft；finding 锚定实际 path，evidence 必须逐字引用该文件里的原文，repairLayer 只能为 design 或 text。",
};

/**
 * 唯一的 Review 实现，layer 是参数（ADR-0009 决定 30）：Reviewer 只读作品，看到该层的完整输入与确定性诊断，
 * 用同一个 submit_review 交付 ReviewDraft。交付时校验 schema、范围与逐字引文，然后把审稿写成
 * `review/<id>.md`——一个普通作品文件，随下一次 commit 进版本；「它对当前稿还算不算数」由版本历史派生。
 */
export function reviewTask(input: ReviewTaskInput): ReviewTaskHandle {
	let submission: ReviewSubmission | undefined;
	const candidate = input.candidate;
	const compiled = compileReviewContext({
		candidate,
		layer: input.layer,
		...(input.goal === undefined ? {} : { goal: input.goal }),
		...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
		...(input.scope === undefined ? {} : { scope: input.scope }),
	});
	const scope = compiled.subject;
	const spec: Omit<TaskSpec, "key" | "parent"> = {
		profileId: "reviewer",
		// Reviewer 只写自己的审稿文件，作品其它部分对它只读。
		policy: "write",
		writable: (path) => path.startsWith("review/"),
		...(compiled.readable === undefined ? {} : { readable: compiled.readable }),
		maxTurns: Number.MAX_SAFE_INTEGER,
		systemPrompt: compiled.systemPrompt,
		prompt: compiled.prompt,
		tools: (handle) => [
			...layerTools(handle, compiled),
			submitTool({
				name: "submit_review",
				description: SUBMIT_DESCRIPTIONS[compiled.layer],
				parameters: ReviewDraftSchema,
				onSubmit: async (params) => {
					let composed: ReturnType<typeof composeReviewFile>;
					try {
						composed = composeReviewFile(await handle.scan(), {
							layer: compiled.layer,
							scope,
							revision: CANDIDATE_REVISION,
							draft: params,
						});
					} catch (error) {
						if (error instanceof ArtifactError)
							throw new ToolRejection(error.code, error.message, { cause: error });
						throw error;
					}
					await handle.env.writeFile(composed.path, composed.content);
					submission = {
						id: composed.id,
						path: composed.path,
						verdict: composed.file.draft.verdict,
						summary: composed.file.draft.summary,
					};
					return `已写入 ${composed.path}（${composed.file.draft.verdict}）。`;
				},
			}),
		],
		result: () => submission,
		resultMediaType: "application/vnd.suiming.review-result+json",
	};
	const reportOf = (result: unknown): ReviewSubmission => {
		const value = result as Partial<ReviewSubmission> | undefined;
		if (
			typeof value?.id !== "string" ||
			typeof value.path !== "string" ||
			typeof value.verdict !== "string" ||
			typeof value.summary !== "string"
		)
			throw new ArtifactError("invalid_task_result", "Review result is malformed");
		return { id: value.id, path: value.path, verdict: value.verdict as ReviewVerdict, summary: value.summary };
	};
	return { spec, reportOf };
}
