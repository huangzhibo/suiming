import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "packages/story/src");

/** packages/story 只放纯领域逻辑：不碰文件系统、数据库、子进程、网络、服务端框架、CLI 与模型 provider。 */
const forbiddenBuiltins = new Set(["fs", "fs/promises", "sqlite", "child_process", "net", "http", "https"]);
const forbiddenPackages = ["fastify", "pg", "kysely", "commander", "@ag-ui/"];

/**
 * 按包名比对，不按前缀字符串：pi-ai 发布在 scope 下（`@earendil-works/pi-ai`，旧名 `@mariozechner/pi-ai`），
 * 原先的正则只认 `from "pi-ai`，对真实包名一直是失效的（2026-10-04 文档核对时发现）。
 */
function forbidden(specifier) {
	const builtin = specifier.replace(/^node:/, "");
	if (forbiddenBuiltins.has(builtin)) return true;
	if (specifier === "pi-ai" || specifier.endsWith("/pi-ai") || specifier.includes("/pi-ai/")) return true;
	return forbiddenPackages.some((name) =>
		name.endsWith("/") ? specifier.startsWith(name) : specifier === name || specifier.startsWith(`${name}/`),
	);
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

const violations = files(sourceRoot).flatMap((path) => {
	const source = readFileSync(path, "utf8");
	const hits = [...source.matchAll(importPattern)].map((match) => match[1]).filter(forbidden);
	return hits.length > 0 ? [`${relative(root, path)}: ${[...new Set(hits)].join(", ")}`] : [];
});

if (violations.length > 0) {
	console.error(`packages/story must remain pure; forbidden imports in:\n${violations.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("Story package isolation is valid.");
}
