import assert from "node:assert/strict";
import test from "node:test";
import { compileWriteContext } from "../src/harness/index.js";
import {
	artifactIdentityKey,
	candidateFromStoryFiles,
	checkFindings,
	designClosurePaths,
	inspectStoryDesignCandidate,
	inspectStoryProjectCandidate,
	type OpenPackageFile,
	readOpenStoryDirectory,
} from "../src/index.js";

/**
 * C 题库（docs/c-question-bank.md）的长程题，做在仓库里的示例三国上：231 节、9 卷、跨卷的长线都是真的，
 * 2 节的样例撑不起「隔了几十节还守得住」。每题在内存候选上做一处最小改动，断言 Checker 恰好多出预期的那一条诊断
 * （示例本身就带着合法的提醒，比如死者在回忆里被提起，所以只比改动前后多出来的）。2026-10-04 起取代题库里
 * 依赖仓库外 eval-022 的那部分。示例随 Story Language 重写时锚点会失效：锚点不在就直接报错，不让题静默变空。
 */
const scan = await readOpenStoryDirectory(new URL("../../../examples/sanguo", import.meta.url).pathname);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function findings(files: readonly OpenPackageFile[]): string[] {
	try {
		const result = checkFindings(inspectStoryProjectCandidate(candidateFromStoryFiles("sanguo", files)));
		return [
			...result.errors.map((item) => `error ${item.path} ${item.message}`),
			...result.warnings.map((item) => `warning ${item.path} ${item.message}`),
		];
	} catch (error) {
		// 绑定期就过不去的问题（期待顺序、依赖方向）整份抛出，诊断带在错误上。
		const diagnostics = (error as { diagnostics?: { path?: string; message: string }[] }).diagnostics;
		if (diagnostics === undefined) throw error;
		return diagnostics.map((item) => `error ${item.path} ${item.message}`);
	}
}

const baseline = new Set(findings(scan.files));

/** 把 path 里的 from 换成 to，返回 Checker 比改动前多出来的诊断。 */
function introduced(path: string, from: string, to: string): string[] {
	const files = scan.files.map((file) => {
		if (file.path !== path) return file;
		const text = decoder.decode(file.bytes);
		if (!text.includes(from)) throw new Error(`示例里 ${path} 已经没有这处锚点，题目要跟着改：${from}`);
		return { ...file, bytes: encoder.encode(text.replace(from, to)) };
	});
	return findings(files).filter((line) => !baseline.has(line));
}

const B0001 = "outline/story/vol-0001/beat-0001.md";
const B0331 = "outline/story/vol-0007/beat-0331.md";
const B0440 = "outline/story/vol-0009/beat-0440.md";

test("示例三国本身过 Checker：没有错误", () => {
	assert.deepEqual(
		[...baseline].filter((line) => line.startsWith("error")),
		[],
	);
});

test("C1 死亡：蔡和在第 437 节被斩，第 440 节华容道又把他写进来，提醒作者确认只是回忆", () => {
	assert.deepEqual(introduced(B0440, "  character: [曹操,", "  character: [蔡和, 曹操,"), [
		`warning ${B0440} character:蔡和 已在 beat-0437 死亡，却在 beat-0440 又被引用`,
	]);
});

test("C9 / C12 资源终止：黄盖的火船在第 437 节烧尽，三节之后又被曹操拿着", () => {
	assert.deepEqual(
		introduced(
			B0440,
			"contracts:\n  resolve: [关羽余恩报曹]",
			"changes:\n  world:\n    黄盖火船.holder: 曹操\ncontracts:\n  resolve: [关羽余恩报曹]",
		),
		[`error ${B0440} consumed or destroyed resource cannot regain a holder or location`],
	);
});

test("C2 / C10 秘密：曹操刺董之谋第 22 节才埋下，第 1 节就对读者揭开", () => {
	assert.deepEqual(
		introduced(
			B0001,
			"  character: [张角, 张宝, 张梁, 何进, 卢植, 皇甫嵩, 朱隽, 蔡邕, 张让]\n",
			"  character: [张角, 张宝, 张梁, 何进, 卢植, 皇甫嵩, 朱隽, 蔡邕, 张让]\nchanges:\n  reader:\n    曹操刺董之谋.revealed: true\n",
		),
		[`error ${B0001} secret:曹操刺董之谋 在任何 StoryBeat 于 refs.secret 声明它之前就被揭示了`],
	);
});

test("C5 期待到期：伏龙凤雏之谜期限是第 331 节，把那里的兑现删掉就到期未兑现", () => {
	assert.deepEqual(introduced(B0331, "contracts:\n  resolve: [伏龙凤雏之谜]\n", ""), [
		"error outline/contracts/伏龙凤雏之谜.md StoryContract 伏龙凤雏之谜：到期限 beat-0331 还没有兑现",
	]);
});

test("C11 期待顺序：伏龙凤雏之谜在第 331 节兑现，第 440 节再推进它", () => {
	assert.deepEqual(introduced(B0440, "advance: [华容军令状]", "advance: [华容军令状, 伏龙凤雏之谜]"), [
		`error ${B0440} advance 必须在 Contract 的 resolve 之前`,
	]);
});

test("C4 依赖方向：第 331 节的 refs.beat 指向一百多节之后的第 440 节", () => {
	assert.deepEqual(introduced(B0331, "  beat: [beat-0327, beat-0330]", "  beat: [beat-0327, beat-0330, beat-0440]"), [
		`error ${B0331} StoryBeat 只能依赖故事顺序里更早的 Beat`,
	]);
});

test("长篇上 Writer 读到的 Design 就是正文时效比较的闭包：有只在硬状态里出现的参与者的每一节，加每 25 节抽一节", () => {
	// write-context.test 在 2 节样例上守同一件事；这里是长篇上的版本，world/core 与只在硬状态变化里出现的
	// 参与者都真实存在。两边都从 beatDesign 取，相等由构造保证；231 节全扫要二十多秒（每次都重绑整份 Design），
	// 所以扫会出问题的那些节，再均匀抽一些。
	const candidate = candidateFromStoryFiles("sanguo", scan.files);
	const pathOf = new Map(
		candidate.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact.path]),
	);
	const beats = inspectStoryDesignCandidate(candidate).design.story.beats.filter(
		(beat, index) => beat.stateRefs.some((ref) => !beat.refs.includes(ref)) || index % 25 === 0,
	);
	assert.ok(beats.some((beat) => beat.stateRefs.some((ref) => !beat.refs.includes(ref))));
	for (const beat of beats) {
		const read = compileWriteContext(candidate, beat.id)
			.artifacts.filter((identity) => !["story-text", "style-evidence"].includes(identity.kind))
			.map((identity) => pathOf.get(artifactIdentityKey(identity)))
			.sort();
		const closure = designClosurePaths(candidate, beat.id).filter((path) => path !== "outline/story/index.yaml");
		assert.deepEqual(read, closure, beat.id);
	}
});
