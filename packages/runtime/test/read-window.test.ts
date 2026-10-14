import assert from "node:assert/strict";
import test from "node:test";
import { readWindow } from "../src/harness/read-window.js";

test("长行按 UTF-8 字节限制分片，码点续读无重叠无遗漏", () => {
	const original = "正文😀é".repeat(12000);
	let offset = 1;
	let column = 1;
	let collected = "";
	for (let count = 0; count < 30; count++) {
		const result = readWindow(original, { offset, column, limit: 1 });
		assert.ok(Buffer.byteLength(result.text) <= 50 * 1024);
		collected += result.text.replace(/^1(?:\[\d+\])?: /u, "");
		if (!result.next) break;
		({ offset, column } = result.next);
	}
	assert.equal(collected, original);
});

test("行数与字节同时受限，末尾空行可读，非法列不静默跳过", () => {
	assert.deepEqual(readWindow("甲\n乙\n", { limit: 1 }).next, { offset: 2, column: 1 });
	assert.equal(readWindow("甲\n乙\n", { offset: 3 }).text, "3: ");
	assert.throws(() => readWindow("甲", { column: 3 }), /invalid_read_range/u);
});
