import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { errorCategory, retryableErrorCode } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const SOURCE_ROOTS = ["packages", "apps"].map((directory) => join(root, directory));
/** 只在 internal 才合理的错误码：损坏、完整性、测试桩与"不应发生"。 */
const INTERNAL_ALLOWLIST =
	/_corrupt$|_integrity_error$|_store_error$|^(local_project_closed|unknown|boom|test_checker_rejected|internal_error|invalid_cli_response)$/u;

function* sourceFiles(directory: string): Generator<string> {
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "dist" || entry === "test") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) yield* sourceFiles(path);
		else if (path.endsWith(".ts")) yield path;
	}
}

function errorCodesInRepository(): string[] {
	const codes = new Set<string>();
	for (const sourceRoot of SOURCE_ROOTS) {
		for (const file of sourceFiles(sourceRoot)) {
			for (const match of readFileSync(file, "utf8").matchAll(/new [A-Za-z]+Error\(\s*"([a-z_]+)"/gu)) {
				codes.add(match[1] as string);
			}
		}
	}
	return [...codes].sort();
}

test("仓库里每个错误码都能从命名约定派生出类别；只有损坏与不应发生的错误落到 internal", () => {
	const codes = errorCodesInRepository();
	assert.ok(codes.length > 100, `expected the scan to find the runtime error codes, found ${codes.length}`);
	const unclassified = codes.filter((code) => errorCategory(code) === "internal" && !INTERNAL_ALLOWLIST.test(code));
	assert.deepEqual(unclassified, [], "这些错误码没有类别：改名遵守约定，或在 OVERRIDES 里显式归类");
});

test("错误类别的代表样本", () => {
	assert.equal(errorCategory("design_check_failed"), "validation");
	assert.equal(errorCategory("invalid_model_output"), "validation");
	assert.equal(errorCategory("dirty_checkout"), "conflict");
	assert.equal(errorCategory("revision_conflict"), "conflict");
	assert.equal(errorCategory("session_running"), "conflict");
	assert.equal(errorCategory("review_report_stale"), "conflict");
	assert.equal(errorCategory("project_locked"), "conflict");
	assert.equal(errorCategory("model_credentials_missing"), "configuration");
	assert.equal(errorCategory("invalid_model_options"), "validation");
	assert.equal(errorCategory("review_report_not_found"), "not_found");
	assert.equal(errorCategory("local_project_not_initialized"), "not_found");
	assert.equal(errorCategory("run_interrupted"), "interrupted");
	assert.equal(errorCategory("turn_usage_checkpoint"), "interrupted");
	assert.equal(errorCategory("local_store_corrupt"), "internal");
	assert.equal(errorCategory("something_nobody_declared"), "internal");
});

test("能不能原样重试只有一处判定：作品被短暂占用、模型调用失败；其余要先改输入或环境", () => {
	// 2026-10-02 之前子任务失败与 CLI 的 JSON 信封各判一遍，CLI 漏了 model_call_failed。
	assert.equal(retryableErrorCode("project_locked"), true);
	assert.equal(retryableErrorCode("model_call_failed"), true);
	for (const code of ["design_check_failed", "model_credentials_missing", "revision_conflict", "turn_failed"])
		assert.equal(retryableErrorCode(code), false, code);
});
