import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactError } from "@suiming/runtime";
import { STORY_LANGUAGE_DOCS } from "@suiming/story";
import { parse, stringify } from "smol-toml";
import { HOST_FILES } from "./host-files.js";

/**
 * 作品仓的 host adapter 安装：把共享 Skill、Skill 目录下的 Story Language 文档、Codex 自定义 agent、
 * 入口文件里的 Suiming 段和 .gitignore 段写进作品目录。全部是仓库辅助文件，codec 不把它们当作品；
 * 重复安装只刷新内容，不叠加。
 */
export const HOST_IDS = ["codex", "claude-code", "grok"] as const;
export type HostId = (typeof HOST_IDS)[number];

export function parseHostId(value: string): HostId {
	if ((HOST_IDS as readonly string[]).includes(value)) return value as HostId;
	throw new ArtifactError("unsupported_host", `不支持的 host ${value}；可选：${HOST_IDS.join("、")}`);
}

interface HostLayout {
	skillPath: string;
	entryFile: "AGENTS.md" | "CLAUDE.md";
}

const LAYOUTS: Readonly<Record<HostId, HostLayout>> = {
	codex: { skillPath: ".agents/skills/suiming/SKILL.md", entryFile: "AGENTS.md" },
	"claude-code": { skillPath: ".claude/skills/suiming/SKILL.md", entryFile: "CLAUDE.md" },
	grok: { skillPath: ".grok/skills/suiming/SKILL.md", entryFile: "AGENTS.md" },
};

export function hostSkillPath(host: HostId): string {
	return LAYOUTS[host].skillPath;
}

export async function installedHosts(root: string): Promise<HostId[]> {
	const installed: HostId[] = [];
	for (const host of HOST_IDS) {
		if ((await readText(join(root, hostSkillPath(host)))) !== undefined) installed.push(host);
	}
	return installed;
}

const ENTRY_BEGIN = "<!-- BEGIN suiming -->";
const ENTRY_END = "<!-- END suiming -->";
const IGNORE_BEGIN = "# BEGIN suiming";
const IGNORE_END = "# END suiming";
const IGNORE_BLOCK = `${IGNORE_BEGIN}\n.suiming/\n.suim-host/\n${IGNORE_END}\n`;

/**
 * 入口段与 host 无关：一个作品仓可以同时装多个 host，Codex 与 Grok 共用 AGENTS.md，段落必须对谁都成立。
 * 「谁」也包括 Suiming 应用里的 Agent：AGENTS.md 是各家 agent 通行的指令文件，它见到就会读（2026-10-01 回归
 * 18 次里读了 4 次），读到「先读 Skill」就去读——Skill 对它藏着，读不到也用不上。所以读 Skill 的指示点名给 host。
 */
const ENTRY_BLOCK = [
	ENTRY_BEGIN,
	"## Suiming 作品仓",
	"",
	"这是一部用 Suiming 创作的长篇作品：作品文件就是 Canon 的 checkout，已提交的 ProjectRevision 才是权威。审稿与材料笔记是普通作品文件；不要修改 `.suiming/**`。",
	"",
	"- **Codex、Claude Code、Grok**：开始任何创作前先读本仓已安装的 Suiming Skill（Codex 在 `.agents/skills/suiming/SKILL.md`，可显式调用 `$suiming`；Claude Code 在 `.claude/skills/suiming/SKILL.md`，Grok 在 `.grok/skills/suiming/SKILL.md`，可显式调用 `/suiming`），按其中的设计、正文、审稿、Source 循环工作，用 `suim --json` 做确定性检查、Context 编译、审稿记录和提交。用 `suim update` 刷新已安装的接入文件。",
	"- **Suiming 应用里的 Agent**（桌面或 `suim session send`）：Skill 不是写给你的，你也读不到；照你自己的工具与说明工作。作者要作品长期遵守的约束在 `intent/**`。",
	ENTRY_END,
	"",
].join("\n");

/** 用标记段替换或追加：已有标记就整段替换，否则追加到文件末尾；文件不存在就新建。 */
function mergeManagedBlock(existing: string | undefined, block: string, begin: string, end: string): string {
	if (existing === undefined || existing.trim().length === 0) return block;
	const start = existing.indexOf(begin);
	const stop = existing.indexOf(end, start);
	if (start !== -1 && stop !== -1) {
		return `${existing.slice(0, start)}${block.trimEnd()}${existing.slice(stop + end.length)}`;
	}
	return `${existing.trimEnd()}\n\n${block}`;
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeText(root: string, relative: string, text: string, written: string[]): Promise<void> {
	const path = join(root, relative);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
	written.push(relative);
}

export interface HostInstallResult {
	host: HostId;
	skillVersion: string;
	written: string[];
}

export async function installHost(root: string, host: HostId): Promise<HostInstallResult> {
	const layout = LAYOUTS[host];
	const written: string[] = [];
	// 先解析全部角色配置，任何一份损坏都不能被模板覆盖，也不应留下半次刷新。
	const agents: { path: string; text: string }[] = [];
	if (host === "codex") {
		for (const agent of HOST_FILES.codexAgents) {
			const path = `.codex/agents/${agent.name}`;
			const existing = await readText(join(root, path));
			try {
				agents.push({
					path,
					text: existing === undefined ? agent.text : stringify({ ...parse(existing), ...parse(agent.text) }),
				});
			} catch {
				throw new ArtifactError(
					"invalid_agent_config",
					`${path} 的 TOML 无效；请修正后再运行 suim update，原文件未覆盖。`,
				);
			}
		}
	}
	await writeText(root, layout.skillPath, HOST_FILES.skill.markdown, written);
	const skillDir = dirname(layout.skillPath);
	for (const document of STORY_LANGUAGE_DOCS) {
		await writeText(root, `${skillDir}/story-language/${document.name}`, document.text, written);
	}
	for (const agent of agents) await writeText(root, agent.path, agent.text, written);
	const entryPath = join(root, layout.entryFile);
	await writeText(
		root,
		layout.entryFile,
		mergeManagedBlock(await readText(entryPath), ENTRY_BLOCK, ENTRY_BEGIN, ENTRY_END),
		written,
	);
	const ignorePath = join(root, ".gitignore");
	await writeText(
		root,
		".gitignore",
		mergeManagedBlock(await readText(ignorePath), IGNORE_BLOCK, IGNORE_BEGIN, IGNORE_END),
		written,
	);
	return { host, skillVersion: HOST_FILES.skill.version, written };
}

export async function readIntentFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new ArtifactError("intent_file_not_found", `创作意图文件不存在：${path}`);
		}
		throw error;
	}
}
