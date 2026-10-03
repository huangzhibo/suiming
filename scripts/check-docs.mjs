import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules"]);

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

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Documentation links are valid.");
}
