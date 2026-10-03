import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelease, parseReleaseManifest, parseYaml, renderReleaseManifest, verifyRelease } from "../src/index.js";

const revision = "a".repeat(40);
const storyTextReview = "text-20260913-120000-ab12";
const storyText = [
	{ storyBeatId: "beat-0001", text: "萧炎抬起头。\n\n大厅安静下来。" },
	{ storyBeatId: "beat-0002", text: "他没有退。🔥众人终于听见了回答。" },
];

test("Release 只做无损发布切分，并保留 StoryText 到章节的精确映射", () => {
	const release = deriveRelease({
		revision,
		storyTextReview,
		storyText,
		minCodePoints: 8,
		targetCodePoints: 12,
		maxCodePoints: 18,
	});
	assert.equal(release.chapters.map((chapter) => chapter.text).join(""), storyText.map((item) => item.text).join(""));
	assert.equal(release.manifest.revision, revision);
	assert.equal(release.manifest.storyTextReview, storyTextReview);
	assert.equal(
		release.manifest.chapters.some((chapter) => chapter.spans.length > 1),
		true,
	);
	assert.equal(verifyRelease(release.manifest, release.chapters, storyText).passed, true);

	const parsed = parseReleaseManifest(parseYaml(renderReleaseManifest(release.manifest), "release/manifest.yaml"));
	assert.deepEqual(parsed, release.manifest);
});

test("Release 校验能发现章节内容或 StoryText 被改写", () => {
	const release = deriveRelease({
		revision,
		storyText,
		minCodePoints: 8,
		targetCodePoints: 12,
		maxCodePoints: 18,
	});
	const chapters = release.chapters.map((chapter, index) =>
		index === 0 ? { ...chapter, text: `${chapter.text}多` } : chapter,
	);
	assert.equal(verifyRelease(release.manifest, chapters, storyText).passed, false);
	assert.equal(
		verifyRelease(release.manifest, release.chapters, [storyText[0] as (typeof storyText)[number]]).passed,
		false,
	);
});
