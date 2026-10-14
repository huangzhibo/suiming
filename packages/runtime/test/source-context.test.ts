import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactCandidate } from "../src/artifact/types.js";
import { renderSourceRange } from "../src/harness/source-context.js";

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
