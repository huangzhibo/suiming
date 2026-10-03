import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { STORY_CONSTITUTION } from "../src/index.js";

test("故事创作宪法模块与 strategies/story-constitution.md 同源，版本是内容的 sha256", async () => {
	const source = await readFile(join(import.meta.dirname, "../../../strategies/story-constitution.md"), "utf8");
	const normalized = source.replace(/\r\n/gu, "\n").trimEnd().concat("\n");
	assert.equal(STORY_CONSTITUTION.markdown, normalized, "生成物过期：运行 npm run generate:constitution");
	assert.equal(STORY_CONSTITUTION.version, `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`);
	assert.ok(Object.isFrozen(STORY_CONSTITUTION));
	for (const heading of [
		"### 1. 体验优先",
		"### 2. 不能为了情节牺牲人物",
		"### 3. 期待应当得到兑现",
		"### 4. 意义来自故事本身",
		"### 5. 从整体安排情绪与节奏",
		"## 解释边界",
	]) {
		assert.ok(STORY_CONSTITUTION.markdown.includes(heading), heading);
	}
});
