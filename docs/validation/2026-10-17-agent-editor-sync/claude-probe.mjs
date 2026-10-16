// 只执行官方发行包中两段保存函数，VS Code 文档接口与等待结果由探针注入。
// 不安装扩展、不运行 CLI、不读取凭据。参数是本机已解包的 extension.js。
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
const source = await readFile(process.argv[2], "utf8");
const method = source.slice(
	source.indexOf("async saveFileIfNeeded($,J)"),
	source.indexOf("getAdditionalMcpServers(){", source.indexOf("async saveFileIfNeeded($,J)")),
);
const save = source.slice(source.indexOf("async function mo1("), source.indexOf("async function uo1("));
assert.ok(method && save, "只适用于已核对的 2.1.301；升级后需重新定位函数");
const root = await mkdtemp(join(tmpdir(), "suiming-claude-probe-"));
try {
	const visited = [],
		saved = [];
	let enabled = true,
		outcome = "answered",
		dirty = true,
		result = true;
	const docs = new Map([
		["a.md", "A 草稿"],
		["b.md", "B 草稿"],
	]);
	for (const path of docs.keys()) await writeFile(join(root, path), "原文");
	const context = {
		performance,
		c4: () => enabled,
		H$: () => false,
		W7: () => false,
		fb: (path) => ({ fsPath: path }),
		yo1: 1000,
		go1: 1000,
		I61: () => 0,
		N1: {
			workspace: {
				openTextDocument: async ({ fsPath }) => {
					visited.push(fsPath);
					return {
						get isDirty() {
							return dirty;
						},
						async save() {
							saved.push(fsPath);
							if (result) await writeFile(join(root, fsPath), docs.get(fsPath));
							return result;
						},
					};
				},
			},
		},
		uo1: async ({ request }) =>
			outcome === "answered"
				? { kind: outcome, value: await request() }
				: { kind: outcome, error: new Error("injected") },
	};
	const fn = runInNewContext(`${save}; ({${method}}).saveFileIfNeeded`, context);
	const host = { output: { debug() {}, info() {}, warn() {} } };
	const call = (tool, path = "a.md") =>
		fn.call(
			host,
			{ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path } },
			new AbortController().signal,
		);
	for (const tool of ["Read", "Edit", "Write"]) await call(tool);
	assert.deepEqual(saved, ["a.md", "a.md", "a.md"]);
	assert.equal(await readFile(join(root, "b.md"), "utf8"), "原文");
	for (const tool of ["Glob", "Grep", "Bash", "MultiEdit"]) await call(tool, "b.md");
	assert.equal(visited.length, 3);
	dirty = false;
	await call("Read");
	assert.equal(saved.length, 3);
	enabled = false;
	await call("Read");
	assert.equal(visited.length, 4);
	enabled = true;
	dirty = true;
	result = false;
	assert.equal((await call("Write")).continue, true);
	for (outcome of ["failed", "timed-out", "cancelled"]) assert.equal((await call("Write")).continue, true);
	console.log(
		JSON.stringify(
			{
				version: "2.1.301",
				targetOnly: true,
				readEditWrite: true,
				otherToolsSkipped: true,
				cleanSkipped: true,
				disabledSkipped: true,
				failedSaveContinues: true,
				unavailableContinues: true,
				scope: "发行包函数 + 模拟文档接口；不等于实际 IDE 并发验收",
			},
			null,
			2,
		),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
