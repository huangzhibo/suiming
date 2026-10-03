import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceNote, SuimError } from "../src/index.js";

const sha = "b".repeat(64);

test("Source 笔记是普通 Markdown：frontmatter 记码点区间与材料 sha，正文是 handoff", () => {
	const markdown = `---\nspan:\n  - 0\n  - 120\nmaterial_sha256: ${sha}\n---\n黄盖找到火船，先不公开。\n`;
	assert.deepEqual(parseSourceNote(markdown, "source/访谈/notes/1.md"), {
		span: { start: 0, end: 120 },
		materialSha256: sha,
		handoff: "黄盖找到火船，先不公开。",
	});
});

test("区间必须 start < end，handoff 不能为空，sha 必须是 64 位十六进制", () => {
	const code = (error: unknown) => (error instanceof SuimError ? error.code : undefined);
	assert.throws(
		() => parseSourceNote(`---\nspan: [10, 10]\nmaterial_sha256: ${sha}\n---\n笔记\n`, "source/访谈/notes/1.md"),
		(error) => code(error) === "invalid_source_note",
	);
	assert.throws(
		() => parseSourceNote(`---\nspan: [0, 10]\nmaterial_sha256: ${sha}\n---\n`, "source/访谈/notes/1.md"),
		(error) => code(error) === "invalid_source_note",
	);
	assert.throws(
		() => parseSourceNote("---\nspan: [0, 10]\nmaterial_sha256: nope\n---\n笔记\n", "source/访谈/notes/1.md"),
		(error) => code(error) === "invalid_source_note",
	);
});
