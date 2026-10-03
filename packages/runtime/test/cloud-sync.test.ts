import assert from "node:assert/strict";
import test from "node:test";
import {
	compareOpenStoryFiles,
	mergeOpenStoryFiles,
	type OpenPackageFile,
	openStoryContentFingerprint,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function fixture(): Promise<OpenPackageFile[]> {
	return sampleWorkFiles();
}

function replace(files: readonly OpenPackageFile[], path: string, before: string, after: string): OpenPackageFile[] {
	let found = false;
	const result = files.map((file) => {
		if (file.path !== path) return { ...file, bytes: new Uint8Array(file.bytes) };
		found = true;
		const text = decoder.decode(file.bytes);
		assert.ok(text.includes(before), `${path} must contain replacement source`);
		return { ...file, bytes: encoder.encode(text.replace(before, after)) };
	});
	assert.equal(found, true, `Missing fixture path: ${path}`);
	return result;
}

test("Open Story 三方合并接受互不交叉的 Local / Cloud artifact 修改", async () => {
	const base = await fixture();
	const local = replace(base, "world/characters/李牧.md", "他习惯先保留筹码", "他习惯先核验证据再保留筹码");
	const cloud = replace(base, "outline/story/vol-0001/beat-0002.md", "亲手焚毁密信", "主动亲手焚毁密信");
	const merged = mergeOpenStoryFiles(base, local, cloud);
	assert.equal(merged.state, "merged");
	assert.deepEqual(
		merged.localChanges.map((change) => change.after?.path ?? change.before?.path),
		["world/characters/李牧.md"],
	);
	assert.deepEqual(
		merged.cloudChanges.map((change) => change.after?.path ?? change.before?.path),
		["outline/story/vol-0001/beat-0002.md"],
	);
	assert.equal(compareOpenStoryFiles(base, merged.state === "merged" ? merged.files : []).length, 2);
	assert.notEqual(openStoryContentFingerprint(base), openStoryContentFingerprint(merged.files));
	assert.equal(openStoryContentFingerprint(merged.files), openStoryContentFingerprint([...merged.files].reverse()));
});

test("Open Story 三方合并按 artifact identity 处理 StoryBeat 换卷：一侧移动文件，另一侧改别处，合并后文件在新卷", async () => {
	const base = await fixture();
	const moved = replace(
		base.map((file) =>
			file.path === "outline/story/vol-0001/beat-0002.md"
				? { ...file, path: "outline/story/vol-0002/beat-0002.md", bytes: new Uint8Array(file.bytes) }
				: { ...file, bytes: new Uint8Array(file.bytes) },
		),
		"outline/story/index.yaml",
		"  - id: vol-0001\n    title: 入局\n    beat_ids: [beat-0001, beat-0002]",
		"  - id: vol-0001\n    title: 入局\n    beat_ids: [beat-0001]\n  - id: vol-0002\n    title: 真相\n    beat_ids: [beat-0002]",
	);
	const cloud = replace(base, "world/characters/李牧.md", "公开密信", "公开唯一密信");
	const merged = mergeOpenStoryFiles(base, moved, cloud);
	assert.equal(merged.state, "merged");
	assert.equal(
		merged.state === "merged" && merged.files.some((file) => file.path === "outline/story/vol-0002/beat-0002.md"),
		true,
	);
	assert.equal(
		merged.state === "merged" && merged.files.some((file) => file.path === "outline/story/vol-0001/beat-0002.md"),
		false,
	);
});

test("Open Story 三方合并拒绝同一 artifact 双改，合起来不合法的快照按语义冲突拒绝", async () => {
	const base = await fixture();
	const local = replace(base, "outline/story/vol-0001/beat-0002.md", "亲手焚毁密信", "主动焚毁密信");
	const cloud = replace(base, "outline/story/vol-0001/beat-0002.md", "亲手焚毁密信", "当众焚毁密信");
	const conflicted = mergeOpenStoryFiles(base, local, cloud);
	assert.equal(conflicted.state, "conflict");
	assert.deepEqual(
		conflicted.state === "conflict" ? conflicted.conflicts.map((conflict) => conflict.description) : [],
		["target/story-beat:beat-0002"],
	);

	// 一侧把 Beat 挪到 index 没说的卷目录里：这份快照本身就不合法，合并前就被 Checker 挡住。
	// 拦它的曾经是 path_projection_mismatch（拿 index 反推路径再和自己比），现在是 story-outline
	// 里那条双向规则，诊断带得出「加进卷里或删掉文件」。
	const moved = base.map((file) =>
		file.path === "outline/story/vol-0001/beat-0002.md"
			? { ...file, path: "outline/story/vol-other/beat-0002.md", bytes: new Uint8Array(file.bytes) }
			: { ...file, bytes: new Uint8Array(file.bytes) },
	);
	assert.throws(
		() => mergeOpenStoryFiles(base, moved, base),
		(error: unknown) => {
			const diagnostics =
				(error as { diagnostics?: readonly { message: string; hint?: string }[] }).diagnostics ?? [];
			return (
				(error as { code?: string }).code === "invalid_story_outline" &&
				diagnostics.some((item) => /把 beat-0002 加进卷 vol-other/u.test(item.hint ?? ""))
			);
		},
	);
});
