import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "packages/story/src");

/**
 * packages/story 只放纯领域逻辑：不碰文件系统、数据库、子进程、网络、服务端框架、CLI、UI 与模型 provider。
 * 白名单而不是黑名单（2026-10-04 改）：黑名单漏了 node:os / dns / worker_threads、undici、isomorphic-git、
 * 反向依赖 @suiming/* 这类，新出现的依赖默认就该被拦下来、由人判断要不要放行。
 */
const allowedPackages = ["typebox", "yaml"];
const allowedBuiltins = new Set(["node:crypto"]);

function allowed(specifier) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	if (allowedBuiltins.has(specifier)) return true;
	return allowedPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** 不经 import 也能产生副作用的全局：网络、进程环境、时钟与随机数让同样的输入得出不同的检查结果。 */
const forbiddenGlobals = [
	[/\bfetch\s*\(/u, "fetch"],
	[/\bprocess\.(env|argv|cwd|exit)\b/u, "process"],
	[/\bDate\.now\s*\(/u, "Date.now"],
	[/\bnew\s+Date\s*\(\s*\)/u, "new Date()"],
	[/\bMath\.random\s*\(/u, "Math.random"],
	[/\brequire\s*\(/u, "require"],
];

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? files(path)
			: entry.isFile() && /\.(ts|tsx|mts|js|mjs)$/u.test(entry.name)
				? [path]
				: [];
	});
}

const violations = files(sourceRoot).flatMap((path) => {
	const source = readFileSync(path, "utf8");
	const imports = [...source.matchAll(importPattern)].map((match) => match[1]).filter((spec) => !allowed(spec));
	const globals = forbiddenGlobals.filter(([pattern]) => pattern.test(source)).map(([, name]) => name);
	const hits = [...new Set([...imports, ...globals])];
	return hits.length > 0 ? [`${relative(root, path)}: ${hits.join(", ")}`] : [];
});

if (violations.length > 0) {
	console.error(
		`packages/story must remain pure (allowed: relative imports, ${allowedPackages.join(", ")}, ${[...allowedBuiltins].join(", ")}); found:\n${violations.join("\n")}`,
	);
	process.exitCode = 1;
} else {
	console.log("Story package isolation is valid.");
}
