import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ArtifactCandidate } from "../src/artifact/types.js";
import { renderSourceNotes } from "../src/harness/material.js";
import { renderSourceRange } from "../src/harness/source-context.js";

test("不同 Source 同名笔记：覆盖对账与正文读取都使用完整路径", () => {
	const candidate: ArtifactCandidate = { baseRevisionId: "base", artifacts: [] };
	for (const sourceId of ["前作", "续作"]) {
		const material = `${sourceId}的原文。`;
		const sha = createHash("sha256").update(material).digest("hex");
		for (const [kind, localId, path, text] of [
			["source-material", "main", "material.txt", material],
			[
				"source-note",
				"1",
				"notes/1.md",
				`---\nspan: [0, ${[...material].length}]\nmaterial_sha256: ${sha}\n---\n只属于${sourceId}的事实。`,
			],
		] as const) {
			candidate.artifacts.push({
				identity: { namespace: { kind: "source", sourceId }, kind, localId },
				path: `source/${sourceId}/${path}`,
				mediaType: "text/plain",
				bytes: new TextEncoder().encode(text),
			});
		}
	}
	const rendered = renderSourceNotes(candidate, "续作");
	assert.match(rendered, /source\/续作\/notes\/1.md/u);
	assert.match(rendered, /只属于续作的事实/u);
	assert.doesNotMatch(rendered, /只属于前作的事实/u);
});

test("231 节补全预载随当前号段增长，不随全书增长；过大的本段文件给读取路径", () => {
	const candidate: ArtifactCandidate = {
		baseRevisionId: "base",
		artifacts: Array.from({ length: 231 }, (_, index) => {
			const localId = `beat-${String(index + 1).padStart(4, "0")}`;
			return {
				identity: { namespace: { kind: "source" as const, sourceId: "小说" }, kind: "story-beat", localId },
				path: `source/小说/outline/story/vol-0001/${localId}.md`,
				mediaType: "text/markdown",
				bytes: new TextEncoder().encode(`第${index + 1}节独有依据：${"因果与知情".repeat(1000)}`),
			};
		}),
	};
	const projected = renderSourceRange(candidate, "小说", { from: 1, to: 8 });
	assert.ok(Buffer.byteLength(projected) < 52 * 1024);
	assert.match(projected, /第1节独有依据/u);
	assert.match(projected, /按需读取：.*beat-0008/u);
	assert.doesNotMatch(projected, /第9节独有依据|beat-0231/u);
	assert.equal(
		projected,
		renderSourceRange({ ...candidate, artifacts: candidate.artifacts.slice(0, 8) }, "小说", { from: 1, to: 8 }),
	);
});
