import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// .claude 下是桌面应用放的后台任务 worktree，是另一份仓库副本，不归这里检查（biome 同样跳过它）。
const ignoredDirectories = new Set([".git", "node_modules", ".claude"]);

function collectMarkdown(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (ignoredDirectories.has(entry.name)) return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectMarkdown(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});
}

const errors = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of collectMarkdown(root)) {
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(linkPattern)) {
		const target = match[1].trim();
		if (/^(?:https?:|mailto:|#)/.test(target)) continue;
		const path = resolve(dirname(file), decodeURI(target.split("#", 1)[0]));
		if (!existsSync(path) || (!statSync(path).isFile() && !statSync(path).isDirectory())) {
			errors.push(`${file.slice(root.length + 1)}: broken link ${target}`);
		}
	}
}

// Codex 默认只读 AGENTS.md 的前 32 KiB（project_doc_max_bytes），多出的部分静默截掉；
// 只在某个目录用得上的约定放进那个目录的 AGENTS.md。
const codexProjectDocMaxBytes = 32 * 1024;
const rootAgentsBytes = statSync(join(root, "AGENTS.md")).size;
if (rootAgentsBytes > codexProjectDocMaxBytes) {
	errors.push(
		`AGENTS.md: ${rootAgentsBytes} bytes, Codex reads only the first ${codexProjectDocMaxBytes}; move directory-specific notes into that directory's AGENTS.md`,
	);
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Documentation links are valid.");
}
