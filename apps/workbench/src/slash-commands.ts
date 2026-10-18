import type { GoalAction } from "@suiming/sdk";

/**
 * 输入框的 `/` 命令（ADR-0039）：管这段对话怎么跑——目标、讨论、模型，打字时不用离开键盘。离开这段对话或改作品的动作
 * （新对话、提交版本）走按钮，不配命令。命令名用中文，与界面一致；`aliases` 是不开输入法也能打的英文名。
 */
export interface SlashCommand {
	kind: "goal" | "discuss" | "model";
	name: string;
	aliases: readonly string[];
	detail: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		kind: "goal",
		name: "目标",
		aliases: ["goal"],
		detail: "设目标：Agent 接着做到完成或需要你拍板；暂停 / 继续 / 清除 改已有目标",
	},
	{ kind: "discuss", name: "讨论", aliases: ["plan"], detail: "打开或关上讨论：开着时只读，Agent 只出方案" },
	{ kind: "model", name: "模型", aliases: ["model"], detail: "换这段对话的模型与思考强度，从下一轮起生效" },
];

/** 菜单里这一行的说明：讨论是开关，按当前状态写明选了会怎样（Codex 的菜单也在行里给当前值）。 */
export function commandDetail(command: SlashCommand, discussing: boolean): string {
	if (command.kind !== "discuss") return command.detail;
	return discussing ? "关上讨论：Agent 照常改作品、自己提交" : "打开讨论：Agent 只读，只出方案，等你关上再动手";
}

const fold = (text: string) => text.normalize("NFKC").toLowerCase();
const names = (command: SlashCommand) => [command.name, ...command.aliases].map(fold);

/** 输入是不是一条命令：以 `/` 开头，命令名到第一个空白为止，其后是参数。 */
export function parseSlash(input: string): { name: string; argument: string } | undefined {
	if (!input.startsWith("/")) return undefined;
	const match = /^\/(\S*)(?:\s+([\s\S]*))?$/u.exec(input);
	if (!match) return undefined;
	return { name: match[1] ?? "", argument: (match[2] ?? "").trim() };
}

/** 按命令名或别名找命令。 */
export function findCommand(name: string): SlashCommand | undefined {
	return SLASH_COMMANDS.find((command) => names(command).includes(fold(name)));
}

/** 菜单里列哪些：还在输命令名（没有空白）时，按命令名或别名的前缀筛。 */
export function commandMenu(input: string): SlashCommand[] {
	if (!input.startsWith("/") || /\s/u.test(input)) return [];
	const prefix = fold(input.slice(1));
	return SLASH_COMMANDS.filter((command) => names(command).some((name) => name.startsWith(prefix)));
}

const GOAL_ACTION_WORDS = new Map<string, GoalAction>([
	["暂停", "pause"],
	["继续", "resume"],
	["清除", "clear"],
	["pause", "pause"],
	["resume", "resume"],
	["clear", "clear"],
]);

/** `/目标` 的参数：暂停 / 继续 / 清除（及英文 pause / resume / clear）改已有目标，其余是新目标的原文。 */
export function goalIntent(argument: string): { action: GoalAction } | { objective: string } | undefined {
	if (argument === "") return undefined;
	const action = GOAL_ACTION_WORDS.get(fold(argument));
	return action ? { action } : { objective: argument };
}
