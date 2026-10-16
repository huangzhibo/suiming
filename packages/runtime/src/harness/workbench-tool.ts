import type { WorkbenchHandler, WorkbenchRequest } from "@suiming/sdk";
import { Type } from "typebox";
import type { ConfinedExecutionEnv } from "./confined-env.js";
import { type HarnessTool, ToolRejection } from "./tool.js";

const Parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("context"), Type.Literal("open"), Type.Literal("diff")]),
		path: Type.Optional(Type.String({ description: "作品内文件路径；打开正文用 text/<beat>.md" })),
		expectedLocation: Type.Optional(
			Type.String({ description: "先查询 context，使用返回的 location；作者切页后不抢回旧页面" }),
		),
		line: Type.Optional(Type.Integer({ minimum: 1, description: "定位源码的行号，从 1 起；不改文件" })),
		quote: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4000, description: "精确定位的引文；多处重复时同时传行号" }),
		),
		against: Type.Optional(Type.Union([Type.Literal("disk"), Type.Literal("canon")])),
	},
	{ additionalProperties: false },
);

/** 只有桌面根 Agent 获得界面能力，子任务与 CLI 不声明不可用的工具。 */
export function workbenchTools(handler: WorkbenchHandler | undefined, env: ConfinedExecutionEnv): HarnessTool[] {
	if (!handler) return [];
	const tool: HarnessTool<typeof Parameters> = {
		name: "workbench",
		description:
			"查看作者当前页面、视图、选区及打开文件的元数据，或应作者要求打开文档、定位原文、展示差异。发送时的界面上下文是历史快照，当前现场用 context 查询。仅当作者要求展示、定位、比较时使用 open/diff；后台创作不要反复切页。不会保存或提交文件，不替代 read/write。diff 的 disk 比较磁盘与作者草稿，canon 比较当前 Canon 与草稿/候选。定位打开源码编辑视图，但不抢键盘焦点。",
		parameters: Parameters,
		async execute(_id, params, signal) {
			let request: WorkbenchRequest;
			if (params.action === "context") request = { action: "context" };
			else {
				if (!params.path || !params.expectedLocation)
					throw new ToolRejection(
						"invalid_ui_target",
						"打开或比较前请先查询界面，并提供 path 与 expectedLocation",
					);
				const path = await env.readablePath(params.path);
				request =
					params.action === "diff"
						? {
								action: "diff",
								path,
								expectedLocation: params.expectedLocation,
								against: params.against ?? "canon",
							}
						: {
								action: "open",
								path,
								expectedLocation: params.expectedLocation,
								...(params.line !== undefined ? { line: params.line } : {}),
								...(params.quote ? { quote: params.quote } : {}),
							};
			}
			signal?.throwIfAborted();
			try {
				const context = await handler(request, signal);
				// 界面可能停在 host 接入文件；界面入口不能绕开 Agent 的读范围。
				if (context.active.path && !env.canRead(context.active.path))
					context.active = { page: "private", title: "非作品文件", view: context.active.view, unsaved: false };
				context.openDocuments = context.openDocuments.filter((item) => env.canRead(item.path));
				return { content: [{ type: "text", text: JSON.stringify(context) }] };
			} catch (error) {
				signal?.throwIfAborted();
				throw new ToolRejection("workbench_unavailable", error instanceof Error ? error.message : String(error));
			}
		},
	};
	return [tool];
}
