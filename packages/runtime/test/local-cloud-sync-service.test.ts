import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CloudSyncError,
	classifyOpenStoryDirectoryFile,
	LocalCloudSyncService,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	openStoryContentFingerprint,
	storyPackageCodec,
	validateStoryProjectCandidate,
} from "../src/index.js";
import { InMemoryCloudProjectStore } from "./in-memory-cloud.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const endpoint = "https://cloud.example.invalid/api";
const actorId = "author-1";

async function fixtureFiles() {
	return sampleWorkFiles();
}

async function createLocal(root: string, projectId: string): Promise<LocalProjectService> {
	const checkoutPath = join(root, projectId);
	await materializeOpenStoryDirectorySnapshot(checkoutPath, await fixtureFiles());
	return LocalProjectService.init({ checkoutPath, projectId });
}

async function createCloud(cloud: InMemoryCloudProjectStore, projectId: string) {
	const files = await fixtureFiles();
	return cloud.createProject(
		{
			projectId,
			actorId,
			idempotencyKey: `${projectId}:create`,
			artifacts: files
				.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story")
				.map((file) => ({
					identity: storyPackageCodec.identityForPath(file.path),
					path: file.path,
					mediaType: file.mediaType,
					bytes: new Uint8Array(file.bytes),
				})),
		},
		validateStoryProjectCandidate,
	);
}

async function commitCloudArtifact(
	cloud: InMemoryCloudProjectStore,
	projectId: string,
	kind: string,
	localId: string,
	before: string,
	after: string,
	idempotencyKey: string,
) {
	const head = await cloud.project({ projectId, actorId });
	const snapshot = await cloud.readRevision({ projectId, actorId, revisionId: head.headRevisionId });
	const artifact = snapshot.candidate.artifacts.find(
		(candidate) => candidate.identity.kind === kind && candidate.identity.localId === localId,
	);
	assert.ok(artifact);
	const text = decoder.decode(artifact.bytes);
	assert.ok(text.includes(before));
	return cloud.commit(
		{
			projectId,
			actorId,
			idempotencyKey,
			changeSet: {
				baseRevisionId: snapshot.revision.id,
				operations: [
					{
						operation: "replace",
						identity: artifact.identity,
						path: artifact.path,
						mediaType: artifact.mediaType,
						bytes: encoder.encode(text.replace(before, after)),
					},
				],
			},
		},
		validateStoryProjectCandidate,
	);
}

async function editAndCommitLocal(
	local: LocalProjectService,
	path: string,
	before: string,
	after: string,
): Promise<void> {
	const absolutePath = join(local.paths.checkoutPath, path);
	const text = await readFile(absolutePath, "utf8");
	assert.ok(text.includes(before));
	await writeFile(absolutePath, text.replace(before, after));
	assert.equal((await local.commitCheckout()).created, true);
}

test("cloud checkout 建立独立 Local Project、共同内容证据与可删除 binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cloud-checkout-"));
	const cloud = new InMemoryCloudProjectStore();
	let local: LocalProjectService | undefined;
	try {
		const cloudRevision = await createCloud(cloud, "cloud-project-1");
		const checkedOut = await LocalCloudSyncService.checkout({
			cloud,
			endpoint,
			actorId,
			cloudProjectId: "cloud-project-1",
			cloudRevisionId: cloudRevision.id,
			destinationPath: join(root, "checkout"),
			localProjectId: "local-project-1",
		});
		local = checkedOut.local;
		assert.notEqual(checkedOut.binding.lastSyncedLocalRevisionId, cloudRevision.id);
		assert.equal(
			checkedOut.binding.lastSyncedContentFingerprint,
			openStoryContentFingerprint(await local.exportRevision()),
		);
		const sync = new LocalCloudSyncService({ local, cloud, endpoint, actorId });
		assert.equal((await sync.status()).state, "in_sync");
		assert.equal(sync.unlink().cloudProjectId, "cloud-project-1");
		assert.equal(local.remoteBinding(), undefined);
		assert.equal((await cloud.project({ projectId: "cloud-project-1", actorId })).headRevisionId, cloudRevision.id);
	} finally {
		local?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("cloud import 与单侧 push / pull 只移动已提交 revision", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cloud-fast-forward-"));
	const cloud = new InMemoryCloudProjectStore();
	let local: LocalProjectService | undefined;
	try {
		local = await createLocal(root, "local-project-1");
		const sync = new LocalCloudSyncService({ local, cloud, endpoint, actorId });
		await sync.import({ cloudProjectId: "cloud-project-1", idempotencyKey: "import-1" });
		assert.equal((await sync.status()).state, "in_sync");

		await editAndCommitLocal(local, "world/characters/黄盖.md", "他宁可自己受刑", "他宁可自己当众受刑");
		assert.equal((await sync.status()).state, "local_ahead");
		const pushed = await sync.push({ idempotencyKey: "push-1" });
		assert.equal(pushed.cloudRevisionCreated, true);
		assert.equal(pushed.localRevisionCreated, false);
		assert.equal(pushed.after.state, "in_sync");

		await commitCloudArtifact(
			cloud,
			"cloud-project-1",
			"story-beat",
			"beat-0002",
			"各船同时点火",
			"各船立刻同时点火",
			"cloud-edit-1",
		);
		assert.equal((await sync.status()).state, "cloud_ahead");
		const pulled = await sync.pull();
		assert.equal(pulled.localRevisionCreated, true);
		assert.equal(pulled.cloudRevisionCreated, false);
		assert.equal(pulled.after.state, "in_sync");
		assert.match(
			await readFile(join(local.paths.checkoutPath, "outline/story/vol-0001/beat-0002.md"), "utf8"),
			/各船立刻同时点火/u,
		);
		const dirtyPath = join(local.paths.checkoutPath, "world/places/赤壁.md");
		await writeFile(dirtyPath, `${await readFile(dirtyPath, "utf8")}未提交。\n`);
		assert.equal((await sync.status()).dirtyCheckout, true);
		await assert.rejects(
			() => sync.push({ idempotencyKey: "push-dirty" }),
			(error: unknown) => error instanceof CloudSyncError && error.code === "cloud_sync_dirty_checkout",
		);
		await assert.rejects(
			() => sync.pull(),
			(error: unknown) => error instanceof CloudSyncError && error.code === "cloud_sync_dirty_checkout",
		);
	} finally {
		local?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("pull 合并非交叉分叉后保留 Local ahead，随后 push 收敛到同一快照", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cloud-diverged-"));
	const cloud = new InMemoryCloudProjectStore();
	let local: LocalProjectService | undefined;
	try {
		local = await createLocal(root, "local-project-1");
		const sync = new LocalCloudSyncService({ local, cloud, endpoint, actorId });
		await sync.import({ cloudProjectId: "cloud-project-1", idempotencyKey: "import-1" });
		await editAndCommitLocal(local, "world/characters/黄盖.md", "也不让这条计露出破绽", "也绝不让这条计露出破绽");
		await commitCloudArtifact(
			cloud,
			"cloud-project-1",
			"story-beat",
			"beat-0002",
			"各船同时点火",
			"各船立刻同时点火",
			"cloud-edit-1",
		);
		assert.equal((await sync.status()).state, "diverged_mergeable");
		const pulled = await sync.pull();
		assert.equal(pulled.after.state, "local_ahead");
		assert.match(
			await readFile(join(local.paths.checkoutPath, "world/characters/黄盖.md"), "utf8"),
			/也绝不让这条计露出破绽/u,
		);
		assert.match(
			await readFile(join(local.paths.checkoutPath, "outline/story/vol-0001/beat-0002.md"), "utf8"),
			/各船立刻同时点火/u,
		);
		const pushed = await sync.push({ idempotencyKey: "push-merge-1" });
		assert.equal(pushed.after.state, "in_sync");
		const binding = local.remoteBinding();
		assert.ok(binding);
		const cloudHead = await cloud.readRevision({
			projectId: "cloud-project-1",
			actorId,
			revisionId: binding.lastSyncedCloudRevisionId,
		});
		assert.equal(
			binding.lastSyncedContentFingerprint,
			openStoryContentFingerprint([
				...cloudHead.candidate.artifacts.map((artifact) => ({
					path: artifact.path,
					mediaType: artifact.mediaType,
					bytes: artifact.bytes,
				})),
			]),
		);
	} finally {
		local?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("同 artifact 双改产生显式 conflict", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cloud-conflict-"));
	const cloud = new InMemoryCloudProjectStore();
	let local: LocalProjectService | undefined;
	try {
		local = await createLocal(root, "local-project-1");
		const sync = new LocalCloudSyncService({ local, cloud, endpoint, actorId });
		await sync.import({ cloudProjectId: "cloud-project-1", idempotencyKey: "import-1" });
		await editAndCommitLocal(local, "outline/story/vol-0001/beat-0002.md", "各船同时点火", "各船先后点火");
		await commitCloudArtifact(
			cloud,
			"cloud-project-1",
			"story-beat",
			"beat-0002",
			"各船同时点火",
			"各船一齐点火",
			"cloud-edit-1",
		);
		const conflict = await sync.status();
		assert.equal(conflict.state, "conflict");
		assert.deepEqual(
			conflict.conflicts.map((item) => item.description),
			["target/story-beat:beat-0002"],
		);
		await assert.rejects(
			() => sync.push({ idempotencyKey: "push-conflict" }),
			(error: unknown) => error instanceof CloudSyncError && error.code === "cloud_sync_conflict",
		);
		await assert.rejects(
			() => sync.pull(),
			(error: unknown) => error instanceof CloudSyncError && error.code === "cloud_sync_conflict",
		);
	} finally {
		local?.close();
		await rm(root, { recursive: true, force: true });
	}
});
