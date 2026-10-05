import assert from "node:assert/strict";
import test from "node:test";
import {
	type CheckDiagnostic,
	type CheckResult,
	candidateBasis,
	checkNotice,
	diagnosticPosition,
	groupDiagnostics,
	runCheck,
} from "../src/check-result.js";
import { CommandError } from "../src/command-error.js";
import type { WorkspaceData } from "../src/model.js";

function workspace(files: { path: string; dirty?: boolean; codePoints?: number }[], revisionId = "r1"): WorkspaceData {
	return {
		revisionId,
		files: files.map((file) => ({ dirty: false, codePoints: 10, ...file })),
	} as unknown as WorkspaceData;
}
function result(overrides: Partial<CheckResult> = {}): CheckResult {
	return {
		passed: true,
		changedFiles: 0,
		designPassed: true,
		statePassed: true,
		storyTextPassed: true,
		storyTextFailures: [],
		sourceCount: 0,
		diagnostics: [],
		...overrides,
	};
}
const error = (path: string | undefined, detail: string): CheckDiagnostic => ({
	severity: "error",
	...(path === undefined ? {} : { path }),
	detail,
	message: `${path ?? ""}：${detail}`,
});
const warning = (path: string, detail: string): CheckDiagnostic => ({
	severity: "warning",
	path,
	detail,
	message: `${path}：警告：${detail}`,
});

test("候选指纹：提交、增删文件与未提交文件的改动都会让它变化，已提交文件的顺序不影响", () => {
	const base = candidateBasis(workspace([{ path: "a.md" }, { path: "b.md" }]));
	assert.equal(candidateBasis(workspace([{ path: "b.md" }, { path: "a.md" }])), base);
	assert.notEqual(candidateBasis(workspace([{ path: "a.md" }, { path: "b.md" }], "r2")), base, "提交了新版本");
	assert.notEqual(candidateBasis(workspace([{ path: "a.md" }])), base, "删了文件");
	const edited = candidateBasis(workspace([{ path: "a.md", dirty: true, codePoints: 10 }, { path: "b.md" }]));
	assert.notEqual(edited, base, "改了一个文件");
	assert.notEqual(
		candidateBasis(workspace([{ path: "a.md", dirty: true, codePoints: 12 }, { path: "b.md" }])),
		edited,
		"未提交的文件又改了一次",
	);
});

test("诊断按文件归类：有错误的文件在前、组内错误在前，没有路径的放最后", () => {
	const groups = groupDiagnostics([
		warning("outline/story/vol-0001/beat-0001.md", "提到了黄盖"),
		error(undefined, "全书级问题"),
		warning("outline/story/vol-0001/beat-0002.md", "提到了火船"),
		error("outline/story/vol-0001/beat-0002.md", "引用不存在"),
		error("outline/contracts/诈降.md", "到期未兑现"),
	]);
	assert.deepEqual(
		groups.map((group) => [group.path, group.errors, group.warnings, group.items.map((item) => item.detail)]),
		[
			["outline/contracts/诈降.md", 1, 0, ["到期未兑现"]],
			["outline/story/vol-0001/beat-0002.md", 1, 1, ["引用不存在", "提到了火船"]],
			["outline/story/vol-0001/beat-0001.md", 0, 1, ["提到了黄盖"]],
			[undefined, 1, 0, ["全书级问题"]],
		],
	);
});

test("文件内位置：行列与 JSON pointer 都可能缺", () => {
	const base = error("a.md", "x");
	assert.equal(diagnosticPosition(base), "");
	assert.equal(diagnosticPosition({ ...base, pointer: "/frontmatter/refs" }), "/frontmatter/refs");
	assert.equal(diagnosticPosition({ ...base, line: 3, column: 5 }), "3:5");
	assert.equal(diagnosticPosition({ ...base, line: 3, pointer: "/x" }), "3 /x");
});

test("绑定期失败是检查的答案：带诊断的命令错误收进结果，没有诊断的照常抛出", async () => {
	const data = workspace([{ path: "a.md", dirty: true }]);
	const bound = await runCheck(data, async () => result(), 42);
	assert.deepEqual(
		{ at: bound.at, revisionId: bound.revisionId, dirtyFiles: bound.dirtyFiles, passed: bound.result?.passed },
		{ at: 42, revisionId: "r1", dirtyFiles: 1, passed: true },
	);
	assert.equal(bound.basis, candidateBasis(data));
	const diagnostics = [error("outline/story/vol-0001/beat-0001.md", "找不到引用 character:不存在")];
	const unbound = await runCheck(data, async () => {
		throw new CommandError({ code: "missing_context_reference", message: "共 1 处问题", diagnostics });
	});
	assert.deepEqual(unbound.failure, { message: "共 1 处问题", diagnostics });
	await assert.rejects(
		runCheck(data, async () => {
			throw new CommandError({ code: "project_locked", message: "作品被另一进程占用" });
		}),
		/作品被另一进程占用/,
	);
});

test("检查提示：通过且无诊断不给详情，有警告、未通过或绑定失败给详情；missing_text 不算正文问题", () => {
	const snapshot = { at: 0, revisionId: "r1", dirtyFiles: 0, basis: "" };
	const missing = [{ storyBeatId: "beat-0002", code: "missing_text", message: "还没有正文" }];
	assert.deepEqual(
		checkNotice({
			...snapshot,
			result: result({ changedFiles: 2, storyTextPassed: false, storyTextFailures: missing }),
		}),
		{ text: "检查通过；2 个文件未提交。", tone: "ok", details: false },
	);
	assert.deepEqual(checkNotice({ ...snapshot, result: result({ diagnostics: [warning("a.md", "提到了黄盖")] }) }), {
		text: "检查通过；1 条警告。",
		tone: "ok",
		details: true,
	});
	assert.deepEqual(
		checkNotice({
			...snapshot,
			result: result({
				passed: false,
				designPassed: false,
				storyTextPassed: false,
				storyTextFailures: [...missing, { storyBeatId: "beat-0001", code: "empty_text", message: "正文为空" }],
				diagnostics: [error("c.md", "到期未兑现"), warning("a.md", "提到了黄盖")],
			}),
		}),
		{ text: "检查未通过：设计 / 正文；1 处错误、1 条警告；1 篇正文有问题。", tone: "warn", details: true },
	);
	assert.deepEqual(
		checkNotice({
			...snapshot,
			failure: { message: "共 2 处问题", diagnostics: [error("a.md", "x"), error("b.md", "y")] },
		}),
		{ text: "作品文件有结构问题，检查没有跑完：共 2 处。", tone: "warn", details: true },
	);
});
