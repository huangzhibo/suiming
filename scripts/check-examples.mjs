import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	candidateFromOpenStoryFiles,
	checkFindings,
	inspectStoryProjectCandidate,
	readOpenStoryDirectory,
} from "@suiming/runtime";
import { formatDiagnostic } from "@suiming/story";

/**
 * examples/ 下每部示例作品都要过 Checker，与 `suim check` 同一个判定（checkFindings）。Story Language 改了而
 * 示例没跟上，这里先报出来；示例是给第一次打开的人看的，不能是一部打不开或检查不通过的作品。
 * 只看已有正文的问题，不要求全书写完（missing_text 不算）。
 */
const root = resolve(import.meta.dirname, "../examples");
const works = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
const failures = [];
for (const work of works) {
	const path = join(root, work.name);
	try {
		const scan = await readOpenStoryDirectory(path);
		const findings = checkFindings(inspectStoryProjectCandidate(candidateFromOpenStoryFiles(scan.files, "example")));
		for (const diagnostic of findings.errors) failures.push(`examples/${work.name}: ${formatDiagnostic(diagnostic)}`);
		for (const failure of findings.textFailures) failures.push(`examples/${work.name}: ${failure.message}`);
	} catch (error) {
		failures.push(`examples/${work.name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Examples pass the Checker: ${works.map((work) => work.name).join(", ")}.`);
}
