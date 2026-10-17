import type { AuthorCommand, CollaborationMode, GoalAction } from "@suiming/sdk";

/**
 * 输入框的 `/` 命令（ADR-0038 决定三）：只是现有能力的入口，与按钮做同一件事，不新增能力。
 * 内置命令执行界面动作；自定义命令是作者存在配置目录里的常用话，发出去就是作者自己的消息。
 */
export type SlashCommand =
	| { kind: "goal"; name: "goal"; detail: string }
	| { kind: "mode"; name: string; detail: string; mode: CollaborationMode }
	| { kind: "model" | "new" | "commit"; name: string; detail: string }
	| { kind: "custom"; name: string; detail: string; text: string };

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
	{ kind: "goal", name: "goal", detail: "设目标：Agent 接着做到完成或需要你拍板；clear / pause / resume 改已有目标" },
	{ kind: "mode", name: "讨论", detail: "切到讨论模式：只读，Agent 只出方案", mode: "discuss" },
	{ kind: "mode", name: "协作", detail: "切到协作模式：Agent 改候选，由你提交", mode: "collaborate" },
	{ kind: "mode", name: "自主", detail: "切到自主模式：Agent 改完自己提交", mode: "autonomous" },
	{ kind: "model", name: "模型", detail: "打开模型与思考强度" },
	{ kind: "new", name: "新对话", detail: "开一段新对话" },
	{ kind: "commit", name: "提交", detail: "把已保存的修改提交为新版本，同「提交版本」" },
];

/** 自定义命令接在内置命令后面；与内置命令同名的不覆盖内置命令。 */
export function slashCommands(custom: readonly AuthorCommand[]): SlashCommand[] {
	const builtin = new Set(BUILTIN_COMMANDS.map((command) => command.name));
	return [
		...BUILTIN_COMMANDS,
		...custom
			.filter((command) => !builtin.has(command.name))
			.map((command) => ({
				kind: "custom" as const,
				name: command.name,
				detail: firstLine(command.text),
				text: command.text,
			})),
	];
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return [...line].length > 40 ? `${[...line].slice(0, 40).join("")}…` : line;
}

/** 输入是不是一条命令：以 `/` 开头，命令名到第一个空白为止，其后是参数。 */
export function parseSlash(input: string): { name: string; argument: string } | undefined {
	if (!input.startsWith("/")) return undefined;
	const match = /^\/(\S*)(?:\s+([\s\S]*))?$/u.exec(input);
	if (!match) return undefined;
	return { name: match[1] ?? "", argument: (match[2] ?? "").trim() };
}

/** 菜单里列哪些：还在输命令名（没有空白）时按前缀筛。 */
export function commandMenu(commands: readonly SlashCommand[], input: string): SlashCommand[] {
	if (!input.startsWith("/") || /\s/u.test(input)) return [];
	const prefix = input.slice(1).normalize("NFKC").toLowerCase();
	return commands.filter((command) => command.name.normalize("NFKC").toLowerCase().startsWith(prefix));
}

/** 自定义命令展开成作者的消息：`$ARGUMENTS` 换成参数；没有占位符时参数接在后面。 */
export function expandCustom(text: string, argument: string): string {
	if (text.includes("$ARGUMENTS")) return text.replaceAll("$ARGUMENTS", argument).trim();
	return argument ? `${text.trim()}\n\n${argument}` : text.trim();
}

/** `/goal` 的参数：clear / pause / resume 改已有目标，其余是新目标的原文。 */
export function goalIntent(argument: string): { action: GoalAction } | { objective: string } | undefined {
	if (argument === "") return undefined;
	if (argument === "clear" || argument === "pause" || argument === "resume") return { action: argument };
	return { objective: argument };
}
