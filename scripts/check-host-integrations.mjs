import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUIM_CLI_COMMANDS } from "@suiming/sdk";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "integrations/shared/suiming/SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const errors = [];

const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
if (frontmatter === undefined) {
	errors.push("shared Skill is missing YAML frontmatter");
} else {
	if (!/^name: suiming$/mu.test(frontmatter)) errors.push("shared Skill must be named suiming");
	if (!/^description: .+$/mu.test(frontmatter)) errors.push("shared Skill must have a non-empty description");
}

/** 命令目录是唯一真源：Skill 必须提到每一条本地命令的 `suim --json <phrase>` 写法；Cloud 命令随 Cloud 冻结。 */
function cliPhrase(command) {
	const [group, name] = command.split(".");
	if (name === undefined) return group;
	if (group === "project") return name;
	if (command === "read.search") return "search";
	return `${group} ${name}`;
}
const hostCommands = SUIM_CLI_COMMANDS.filter((command) => !command.startsWith("cloud."));
const requiredContractFragments = [
	...hostCommands.map((command) => `suim --json ${cliPhrase(command)}`),
	"suim.cli.v1",
	".suiming/**",
	"rg",
];

for (const fragment of requiredContractFragments) {
	if (!skill.includes(fragment)) errors.push(`shared Skill is missing contract fragment: ${fragment}`);
}

/** 每个 host README 必须写明 `suim update --agent <host>` 安装命令、Skill 落地路径、真源文件与安装后的 smoke check。 */
const hosts = [
	{
		name: "Codex",
		id: "codex",
		readme: "integrations/codex/README.md",
		installPath: ".agents/skills/suiming/SKILL.md",
	},
	{
		name: "Claude Code",
		id: "claude-code",
		readme: "integrations/claude-code/README.md",
		installPath: ".claude/skills/suiming/SKILL.md",
	},
	{
		name: "Grok Build",
		id: "grok",
		readme: "integrations/grok/README.md",
		installPath: ".grok/skills/suiming/SKILL.md",
	},
];

for (const host of hosts) {
	const source = readFileSync(resolve(root, host.readme), "utf8");
	if (!source.includes(`suim update --agent ${host.id}`)) {
		errors.push(`${host.name} README is missing the install command suim update --agent ${host.id}`);
	}
	if (!source.includes(host.installPath)) errors.push(`${host.name} README is missing ${host.installPath}`);
	if (!source.includes("integrations/shared/suiming/SKILL.md")) {
		errors.push(`${host.name} README must install the canonical shared Skill`);
	}
	if (!source.includes("suim --json open") || !source.includes("suim --json status")) {
		errors.push(`${host.name} README is missing the installation smoke check`);
	}
}

// 当前入口不能再把已删除的命令交给作者或 host；历史记录不在此检查范围。
for (const path of [
	"README.md",
	"integrations/README.md",
	"integrations/shared/suiming/SKILL.md",
	...hosts.map((host) => host.readme),
]) {
	const source = readFileSync(resolve(root, path), "utf8");
	for (const pattern of [/suim(?: --json)? run\b/u, /suim(?: --json)? host install\b/u]) {
		if (pattern.test(source)) errors.push(`${path} contains a removed CLI command: ${pattern.source}`);
	}
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Host integration contracts are valid for Codex, Claude Code, and Grok Build.");
}
