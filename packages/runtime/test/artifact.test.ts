import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	ArtifactError,
	applyChangeOperations,
	artifactIdentityKey,
	type ChangeSet,
	candidateFromStoryFiles,
	exportOpenPackage,
	InMemoryArtifactStore,
	importOpenPackage,
	ingestSource,
	inspectStoryDesignCandidate,
	inspectStorySourcesCandidate,
	materializeOpenStoryDirectorySnapshot,
	type OpenPackageFile,
	OpenStoryDirectoryCache,
	readOpenStoryDirectory,
	storyPackageCodec,
	targetArtifactIdentity,
	unrecognizedPaths,
	validateStoryProjectCandidate,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
	return left !== undefined && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function file(path: string, content: string, mediaType = "text/markdown; charset=utf-8"): OpenPackageFile {
	return { path, mediaType, bytes: encoder.encode(content) };
}

function binaryFile(path: string, bytes: readonly number[], mediaType: string): OpenPackageFile {
	return { path, mediaType, bytes: new Uint8Array(bytes) };
}

function designPackage(): OpenPackageFile[] {
	return [
		file(
			"outline/story/index.yaml",
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001, beat-0002]\n",
			"application/yaml; charset=utf-8",
		),
		file(
			"outline/story/vol-0001/beat-0001.md",
			"---\nrefs:\n  character: [黄盖]\n  place: [赤壁]\n  resource: [火船]\ncontracts:\n  open: [诈降]\nchanges:\n  world:\n    黄盖.location: 赤壁\n---\n黄盖在赤壁挨打诈降。\n",
		),
		file(
			"outline/story/vol-0001/beat-0002.md",
			"---\nrefs:\n  character: [黄盖]\n  resource: [火船]\n  beat: [beat-0001]\ncontracts:\n  resolve: [诈降]\nchanges:\n  world:\n    火船.consumed: true\n---\n火船冲进曹营，烧得一艘不剩。\n",
		),
		file("world/characters/黄盖.md", "---\nname: 黄盖\n---\n宁可自己受刑，也不让计谋露出破绽。\n"),
		file("world/places/赤壁.md", "长江南岸，孙刘联军扎营之处。\n"),
		file("world/resources/火船.md", "---\ninitial:\n  holder: 黄盖\n---\n黄盖备下的二十艘火船。\n"),
		file(
			"outline/contracts/诈降.md",
			"---\nsubjects:\n  character: [黄盖]\n  resource: [火船]\ndeadline: beat-0002\n---\n诈降必须兑现成一把火，火船随之烧尽。\n",
		),
		file(
			"intent/计谋的代价.md",
			"---\nstyle_refs: [style_contemporary_restraint]\n---\n计谋要让读者看见代价，不能靠巧合取胜。\n",
		),
		binaryFile(
			"reference/materials/旧案/卷宗.pdf",
			[0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
			"application/pdf",
		),
		file("reference/research/制度/档案封存.md", "旧朝档案按案件与移交批次双重编号。\n"),
		file("reference/style/style_contemporary_restraint.md", "短句，少解释；先让人物行动，再让读者看见代价。\n"),
	];
}

function sourcePackage(sourceId: string): OpenPackageFile[] {
	const root = `source/${sourceId}`;
	return [
		file(
			`${root}/source.yaml`,
			`schema_version: 1\nname: ${sourceId}.txt\nencoding: utf-8\n`,
			"application/yaml; charset=utf-8",
		),
		file(`${root}/original.bin`, "黄盖备下火船，准备诈降。", "application/octet-stream"),
		file(`${root}/material.txt`, "黄盖备下火船，准备诈降。\n", "text/plain; charset=utf-8"),
		file(
			`${root}/outline/story/index.yaml`,
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 来源\n    beat_ids: [beat-0001]\n",
			"application/yaml; charset=utf-8",
		),
		file(
			`${root}/outline/story/vol-0001/beat-0001.md`,
			"---\nrefs:\n  character: [黄盖]\ncontracts:\n  open: [火船去向]\n---\n黄盖备下火船，材料没有交代它最终去了哪里。\n",
		),
		file(`${root}/world/characters/黄盖.md`, "上阵前先算清退路。\n"),
		file(
			`${root}/outline/contracts/火船去向.md`,
			"---\nsubjects:\n  character: [黄盖]\ndeadline: book_end\n---\n材料已经建立火船去向的期待，但当前边界尚未回答。\n",
		),
	];
}

function bytesByPath(files: readonly OpenPackageFile[]): Map<string, string> {
	return new Map(files.map((item) => [item.path, decoder.decode(item.bytes)]));
}

type DirectoryFixtureKind = "repository-native" | "export-directory" | "cloud-checkout";

async function createDirectoryFixture(kind: DirectoryFixtureKind): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `suiming-${kind}-`));
	for (const item of designPackage()) {
		const absolutePath = join(root, item.path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, item.bytes);
	}
	if (kind === "repository-native") {
		await mkdir(join(root, ".git"), { recursive: true });
		await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		await mkdir(join(root, ".codex", "skills", "suiming"), { recursive: true });
		await writeFile(join(root, ".codex", "skills", "suiming", "SKILL.md"), "# Suiming\n");
		await writeFile(join(root, "AGENTS.md"), "# Repository instructions\n");
		await writeFile(join(root, "intent", ".draft.swp"), "temporary");
	}
	if (kind === "cloud-checkout") {
		await mkdir(join(root, ".suiming"), { recursive: true });
		await writeFile(join(root, ".suiming", "remote.json"), '{"projectId":"cloud-project"}\n');
	}
	return root;
}

test("开放作品包导入导出保持未修改 artifact 的路径、media type 与字节", () => {
	const store = new InMemoryArtifactStore();
	const input = designPackage();
	const revision = importOpenPackage(store, "project-1", input, storyPackageCodec, validateStoryProjectCandidate);
	const { check } = inspectStoryDesignCandidate(store.snapshot(revision.id));
	assert.deepEqual(check.diagnostics, []);
	assert.equal(check.passed, true);

	const output = exportOpenPackage(store, "project-1", revision.id);
	assert.deepEqual(bytesByPath(output), bytesByPath(input));
	assert.deepEqual(
		new Map(output.map((item) => [item.path, item.mediaType])),
		new Map(input.map((item) => [item.path, item.mediaType])),
	);
});

test("repository-native、export directory 与 Cloud checkout 共用目录 codec", async () => {
	const expected = designPackage();
	for (const kind of ["repository-native", "export-directory", "cloud-checkout"] as const) {
		const root = await createDirectoryFixture(kind);
		try {
			const scanned = await readOpenStoryDirectory(root);
			assert.deepEqual(
				scanned.files.map((item) => item.path),
				expected.map((item) => item.path).sort(),
			);
			assert.deepEqual(bytesByPath(scanned.files), bytesByPath(expected));
			assert.deepEqual(
				new Map(scanned.files.map((item) => [item.path, item.mediaType])),
				new Map(expected.map((item) => [item.path, item.mediaType])),
			);

			const store = new InMemoryArtifactStore();
			const revision = importOpenPackage(
				store,
				`project-${kind}`,
				scanned.files,
				storyPackageCodec,
				validateStoryProjectCandidate,
			);
			const exported = exportOpenPackage(store, `project-${kind}`, revision.id);
			assert.deepEqual(bytesByPath(exported), bytesByPath(expected));

			if (kind === "repository-native") {
				assert.deepEqual(
					new Map(scanned.ignored.map((entry) => [entry.path, entry.kind])),
					new Map([
						[".codex", "repository-auxiliary"],
						[".git", "private"],
						["AGENTS.md", "repository-auxiliary"],
						["intent/.draft.swp", "temporary"],
					]),
				);
			}
			if (kind === "cloud-checkout") {
				assert.deepEqual(scanned.ignored, [{ path: ".suiming", kind: "private" }]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("目录 snapshot materializer 只写入空目录并可无损读回", async () => {
	const parent = await mkdtemp(join(tmpdir(), "suiming-materialize-"));
	const destination = join(parent, "story");
	try {
		const expected = designPackage();
		await materializeOpenStoryDirectorySnapshot(destination, expected);
		const scanned = await readOpenStoryDirectory(destination);
		assert.deepEqual(bytesByPath(scanned.files), bytesByPath(expected));
		assert.deepEqual(
			new Map(scanned.files.map((item) => [item.path, item.mediaType])),
			new Map(expected.map((item) => [item.path, item.mediaType])),
		);
		await assert.rejects(
			() => materializeOpenStoryDirectorySnapshot(destination, expected),
			(error: unknown) => error instanceof ArtifactError && error.code === "story_directory_not_empty",
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("视图用的目录缓存：文件状态不变就复用同一份字节，状态一变或刚写过就重读", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-directory-cache-"));
	try {
		await materializeOpenStoryDirectorySnapshot(root, designPackage());
		const old = new Date(Date.now() - 60_000);
		for (const item of designPackage()) await utimes(join(root, item.path), old, old);
		const cache = new OpenStoryDirectoryCache();
		const first = await readOpenStoryDirectory(root, cache);
		const second = await readOpenStoryDirectory(root, cache);
		assert.ok(
			first.files.every((item, index) => item.bytes === second.files[index]?.bytes),
			"状态没变，复用同一份字节",
		);
		assert.deepEqual(bytesByPath(second.files), bytesByPath(designPackage()));

		// 同样长度的新内容、mtime 也拨回原值：只剩 ctime 变了，照样要重读。
		const target = first.files[0] as OpenPackageFile;
		const original = await readFile(join(root, target.path));
		const changed = Buffer.from(original);
		changed[changed.length - 1] = (changed.at(-1) as number) ^ 1;
		await writeFile(join(root, target.path), changed);
		await utimes(join(root, target.path), old, old);
		const third = await readOpenStoryDirectory(root, cache);
		assert.deepEqual(third.files[0]?.bytes, new Uint8Array(changed));

		// 刚写过的文件不复用：粗粒度时间戳的文件系统上，同一刻内的两次写入状态完全相同。
		await writeFile(join(root, target.path), original);
		const fresh = await readOpenStoryDirectory(root, cache);
		const again = await readOpenStoryDirectory(root, cache);
		assert.notEqual(fresh.files[0]?.bytes, again.files[0]?.bytes);
		assert.deepEqual(again.files[0]?.bytes, new Uint8Array(original));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("目录 codec 拒绝未知保留路径、路径穿越与保留路径中的 symlink", async () => {
	const store = new InMemoryArtifactStore();
	assert.throws(
		() =>
			importOpenPackage(
				store,
				"unsafe-project",
				[file("../intent/escape.md", "escape\n")],
				storyPackageCodec,
				validateStoryProjectCandidate,
			),
		(error: unknown) => error instanceof ArtifactError && error.code === "invalid_logical_path",
	);

	const unknownRoot = await createDirectoryFixture("export-directory");
	try {
		await writeFile(join(unknownRoot, "outline", "notes.txt"), "must not be ignored\n");
		// 扫描不因它失败（一个放错的文件不能让整部作品读不出来），但它也不能被静默跳过：Checker 点名拒绝。
		const scanned = await readOpenStoryDirectory(unknownRoot);
		assert.deepEqual(
			scanned.ignored.filter((entry) => entry.kind === "unrecognized"),
			[{ path: "outline/notes.txt", kind: "unrecognized" }],
		);
		assert.throws(
			() =>
				validateStoryProjectCandidate(
					candidateFromStoryFiles("base", scanned.files, unrecognizedPaths(scanned.ignored)),
				),
			(error: unknown) =>
				error instanceof ArtifactError &&
				error.code === "unsupported_story_package_path" &&
				error.message.includes("outline/notes.txt"),
		);
	} finally {
		await rm(unknownRoot, { recursive: true, force: true });
	}

	const symlinkRoot = await createDirectoryFixture("export-directory");
	const outsideRoot = await mkdtemp(join(tmpdir(), "suiming-outside-"));
	try {
		const outsideFile = join(outsideRoot, "outside.txt");
		await writeFile(outsideFile, "outside\n");
		await symlink(outsideFile, join(symlinkRoot, "reference", "materials", "outside.txt"));
		await assert.rejects(
			() => readOpenStoryDirectory(symlinkRoot),
			(error: unknown) => error instanceof ArtifactError && error.code === "unsafe_story_directory_symlink",
		);
	} finally {
		await rm(symlinkRoot, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
});

test("ChangeSet 的应用是纯函数：不触碰 store，只有 commit 推进 ProjectRevision", () => {
	const store = new InMemoryArtifactStore();
	const base = importOpenPackage(
		store,
		"project-1",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	const currentIntent = designPackage().find((item) => item.path === "intent/计谋的代价.md");
	assert.ok(currentIntent);
	const changeSet: ChangeSet = {
		baseRevisionId: base.id,
		operations: [
			{
				operation: "replace",
				identity: targetArtifactIdentity("intent", "计谋的代价"),
				path: "intent/计谋的代价.md",
				mediaType: currentIntent.mediaType,
				bytes: encoder.encode(`${decoder.decode(currentIntent.bytes).trimEnd()}\n胜利还必须让读者获得清晰反馈。\n`),
			},
		],
	};
	const applied = applyChangeOperations(store.snapshot(base.id).artifacts, changeSet.operations);
	assert.equal(store.headRevisionId("project-1"), base.id, "应用候选不推进 head");
	const intent = applied.find((artifact) => artifact.identity.localId === "计谋的代价");
	assert.ok(intent !== undefined, "被 replace 的 artifact 仍在候选里");
	assert.equal(
		decoder.decode(intent.bytes).endsWith("胜利还必须让读者获得清晰反馈。\n"),
		true,
		"被 replace 的换了内容",
	);
	const untouched = new Map(
		store.snapshot(base.id).artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact.bytes]),
	);
	assert.ok(
		applied
			.filter((artifact) => artifact.identity.localId !== "计谋的代价")
			.every((artifact) => bytesEqual(untouched.get(artifactIdentityKey(artifact.identity)), artifact.bytes)),
		"其余 artifact 逐字节不变",
	);
	assert.throws(
		() =>
			applyChangeOperations(applied, [{ operation: "delete", identity: targetArtifactIdentity("intent", "没有") }]),
		(error: unknown) => error instanceof ArtifactError && error.code === "artifact_not_found",
	);

	const committed = store.commit("project-1", changeSet, validateStoryProjectCandidate);
	assert.equal(committed.parentId, base.id);
	assert.notEqual(committed.id, base.id);
	assert.equal(store.headRevisionId("project-1"), committed.id);
	// version id 是内容寻址的：同样内容在任何 store 里都是同一个 id。
	const other = new InMemoryArtifactStore();
	const otherBase = importOpenPackage(
		other,
		"project-x",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	assert.deepEqual(
		store.readRevisionArtifacts(base.id).map((artifact) => artifact.artifactVersionId),
		other.readRevisionArtifacts(otherBase.id).map((artifact) => artifact.artifactVersionId),
	);
	assert.equal(
		bytesByPath(exportOpenPackage(store, "project-1", base.id)).get("intent/计谋的代价.md"),
		decoder.decode(currentIntent.bytes),
	);
});

test("StoryBeat 换卷是两步：改 index 加移动文件；只改一半由 Checker 拒绝", () => {
	const store = new InMemoryArtifactStore();
	const base = importOpenPackage(
		store,
		"project-1",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	const beat = store.snapshot(base.id).artifacts.find((artifact) => artifact.identity.localId === "beat-0002");
	assert.ok(beat);
	assert.equal(beat.path, "outline/story/vol-0001/beat-0002.md");
	const movedIndex = {
		operation: "replace" as const,
		identity: targetArtifactIdentity("story-index", "main"),
		path: "outline/story/index.yaml",
		mediaType: "application/yaml; charset=utf-8",
		bytes: encoder.encode(
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001]\n  - id: vol-0002\n    title: 代价\n    beat_ids: [beat-0002]\n",
		),
	};

	// 只改 index、文件还留在 vol-0001：目录与 index 对不上，Checker 双向报出来并给出两条出路。
	assert.throws(
		() =>
			store.commit(
				"project-1",
				{ baseRevisionId: base.id, operations: [movedIndex] },
				validateStoryProjectCandidate,
			),
		(error: unknown) => {
			const diagnostics =
				(error as { diagnostics?: readonly { message: string; hint?: string }[] }).diagnostics ?? [];
			const rendered = diagnostics.map((item) => `${item.message} ${item.hint ?? ""}`);
			return (
				// 文件在 vol-0001，index 没这么说
				rendered.some((line) => /没有列在/u.test(line) && /vol-0001/u.test(line)) &&
				// index 说 vol-0002 有 beat-0002，那里却没有文件
				rendered.some((line) => /文件不存在/u.test(line) && /vol-0002\/beat-0002/u.test(line))
			);
		},
	);

	// 改 index 加移动文件才是换卷。路径变了、内容一个字没改，也是一次 replace。
	const revision = store.commit(
		"project-1",
		{
			baseRevisionId: base.id,
			operations: [
				movedIndex,
				{
					operation: "replace",
					identity: targetArtifactIdentity("story-beat", "beat-0002"),
					path: "outline/story/vol-0002/beat-0002.md",
					mediaType: beat.mediaType,
					bytes: beat.bytes,
				},
			],
		},
		validateStoryProjectCandidate,
	);
	const paths = exportOpenPackage(store, "project-1", revision.id).map((item) => item.path);
	assert.equal(paths.includes("outline/story/vol-0002/beat-0002.md"), true);
	assert.equal(paths.includes("outline/story/vol-0001/beat-0002.md"), false);
});

test("identity 改名表现为 delete 加 create；未同步确定性引用时不能提交", () => {
	const store = new InMemoryArtifactStore();
	const base = importOpenPackage(
		store,
		"project-1",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	const character = designPackage().find((item) => item.path === "world/characters/黄盖.md");
	assert.ok(character);
	const renamed: ChangeSet = {
		baseRevisionId: base.id,
		operations: [
			{ operation: "delete", identity: targetArtifactIdentity("character", "黄盖") },
			{
				operation: "create",
				identity: targetArtifactIdentity("character", "李校尉"),
				path: "world/characters/李校尉.md",
				mediaType: character.mediaType,
				bytes: character.bytes,
			},
		],
	};
	assert.throws(() => store.commit("project-1", renamed, validateStoryProjectCandidate));
	assert.equal(store.headRevisionId("project-1"), base.id);
});

test("ProjectRevision 拒绝没有对应 StoryBeat 的 StoryText", () => {
	const files = designPackage();
	files.push(file("text/beat-9999.md", "没有对应细纲的正文。\n"));
	const store = new InMemoryArtifactStore();
	assert.throws(
		() => importOpenPackage(store, "project-1", files, storyPackageCodec, validateStoryProjectCandidate),
		(error: unknown) => error instanceof ArtifactError && error.code === "orphan_story_text",
	);
});

test("Target 与多个 Source 使用独立 namespace，同名 StoryBeat 和 Character 不冲突", () => {
	const files = [...designPackage(), ...sourcePackage("原作一"), ...sourcePackage("原作二")];
	const store = new InMemoryArtifactStore();
	const revision = importOpenPackage(store, "project-1", files, storyPackageCodec, validateStoryProjectCandidate);
	const characters = store
		.snapshot(revision.id)
		.artifacts.filter((artifact) => artifact.identity.kind === "character" && artifact.identity.localId === "黄盖");
	assert.equal(characters.length, 3);
	assert.deepEqual(
		characters.map((artifact) => artifact.identity.namespace),
		[{ kind: "source", sourceId: "原作一" }, { kind: "source", sourceId: "原作二" }, { kind: "target" }],
	);
	const sources = inspectStorySourcesCandidate(store.snapshot(revision.id));
	assert.deepEqual(
		sources.map((source) => [source.sourceId, source.state, source.check?.contracts.openContractIds]),
		[
			["原作一", "extracted", ["火船去向"]],
			["原作二", "extracted", ["火船去向"]],
		],
	);
	assert.deepEqual(bytesByPath(exportOpenPackage(store, "project-1", revision.id)), bytesByPath(files));
});

test("Source 可以先只导入原始材料，再在后续 revision 建立 extraction", () => {
	const files = [
		...designPackage(),
		file(
			"source/待抽取/source.yaml",
			"schema_version: 1\nname: 待抽取.txt\nencoding: utf-8\n",
			"application/yaml; charset=utf-8",
		),
		file("source/待抽取/original.bin", "尚未抽取的材料。", "application/octet-stream"),
		file("source/待抽取/material.txt", "尚未抽取的材料。\n", "text/plain; charset=utf-8"),
	];
	const store = new InMemoryArtifactStore();
	const revision = importOpenPackage(store, "project-1", files, storyPackageCodec, validateStoryProjectCandidate);
	const source = inspectStorySourcesCandidate(store.snapshot(revision.id))[0];
	assert.equal(source?.state, "ingested");
	assert.equal(source?.check, undefined);
});

test("Source ingest 保留原始字节、生成 UTF-8 material，并拒绝覆盖已有 Source", () => {
	const store = new InMemoryArtifactStore();
	const base = importOpenPackage(
		store,
		"project-1",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	const original = encoder.encode("访谈记录：黄盖先核对火船。\n");
	const ingested = ingestSource({
		artifactStore: store,
		projectId: "project-1",
		projectRevisionId: base.id,
		sourceId: "访谈",
		name: "访谈.txt",
		original,
		encoding: "utf-8",
	});
	assert.equal(ingested.source.state, "ingested");
	assert.equal(ingested.source.materialCodePoints, [...decoder.decode(original)].length);
	const candidate = store.snapshotForProject("project-1", ingested.revision.id);
	assert.deepEqual(
		candidate.artifacts.find(
			(artifact) =>
				artifact.identity.namespace.kind === "source" &&
				artifact.identity.namespace.sourceId === "访谈" &&
				artifact.identity.kind === "source-input",
		)?.bytes,
		original,
	);
	assert.equal(
		decoder.decode(
			candidate.artifacts.find(
				(artifact) =>
					artifact.identity.namespace.kind === "source" &&
					artifact.identity.namespace.sourceId === "访谈" &&
					artifact.identity.kind === "source-material",
			)?.bytes,
		),
		"访谈记录：黄盖先核对火船。\n",
	);
	assert.throws(
		() =>
			ingestSource({
				artifactStore: store,
				projectId: "project-1",
				projectRevisionId: ingested.revision.id,
				sourceId: "访谈",
				name: "覆盖.txt",
				original: encoder.encode("不能覆盖。"),
			}),
		(error: unknown) => error instanceof ArtifactError && error.code === "source_already_exists",
	);
	assert.throws(
		() =>
			ingestSource({
				artifactStore: store,
				projectId: "project-1",
				projectRevisionId: ingested.revision.id,
				sourceId: "坏编码",
				name: "broken.txt",
				original: new Uint8Array([0xff, 0xfe, 0xff]),
				encoding: "utf-8",
			}),
		(error: unknown) => error instanceof ArtifactError && error.code === "invalid_source_encoding",
	);
	assert.equal(store.headRevisionId("project-1"), ingested.revision.id);
});

test("ProjectRevision 不能跨项目读取或提交", () => {
	const store = new InMemoryArtifactStore();
	const first = importOpenPackage(
		store,
		"project-1",
		designPackage(),
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
	importOpenPackage(store, "project-2", designPackage(), storyPackageCodec, validateStoryProjectCandidate);
	assert.throws(
		() => store.snapshotForProject("project-2", first.id),
		(error: unknown) => error instanceof ArtifactError && error.code === "revision_project_mismatch",
	);
	assert.throws(
		() => store.commit("project-2", { baseRevisionId: first.id, operations: [] }, validateStoryProjectCandidate),
		(error: unknown) => error instanceof ArtifactError && error.code === "revision_conflict",
	);
});
