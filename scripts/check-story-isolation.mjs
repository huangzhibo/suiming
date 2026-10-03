import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "packages/story/src");
const forbidden = [
	/\bfrom\s+["']node:(?:fs|sqlite|child_process|net|http|https)["']/,
	/\bfrom\s+["'](?:fastify|pi-ai|@ag-ui\/|pg|kysely|commander)/,
];

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

const violations = files(sourceRoot).flatMap((path) => {
	const source = readFileSync(path, "utf8");
	return forbidden.some((pattern) => pattern.test(source)) ? [relative(root, path)] : [];
});

if (violations.length > 0) {
	console.error(`packages/story must remain pure; forbidden imports in:\n${violations.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("Story package isolation is valid.");
}
