import assert from "node:assert/strict";
import test from "node:test";
import {
	CloudProjectService,
	CloudStoreError,
	InMemoryCloudProjectStore,
	openStoryContentFingerprint,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const actorId = "author-1";

async function fixtureFiles() {
	return sampleWorkFiles();
}

function replaceInFile(files: Awaited<ReturnType<typeof fixtureFiles>>, path: string, before: string, after: string) {
	return files.map((file) => {
		if (file.path !== path) return { ...file, bytes: new Uint8Array(file.bytes) };
		const text = decoder.decode(file.bytes);
		assert.ok(text.includes(before));
		return { ...file, bytes: encoder.encode(text.replace(before, after)) };
	});
}

test("Cloud Project application service validates import and exposes authorized revision views", async () => {
	const store = new InMemoryCloudProjectStore({ now: () => new Date("2026-09-03T01:00:00.000Z") });
	const service = new CloudProjectService(store);
	const files = await fixtureFiles();
	const imported = await service.importSnapshot({
		projectId: "cloud-project-1",
		actorId,
		idempotencyKey: "import-1",
		files,
	});
	assert.equal(imported.contentFingerprint, openStoryContentFingerprint(files));
	assert.deepEqual(
		imported.files.map((file) => file.path),
		files.map((file) => file.path),
	);
	assert.equal((await service.project({ projectId: "cloud-project-1", actorId })).role, "owner");
	assert.deepEqual(
		(await service.history({ projectId: "cloud-project-1", actorId })).map((revision) => revision.id),
		[imported.snapshot.revision.id],
	);
	const first = files[0];
	assert.ok(first);

	await assert.rejects(
		service.importSnapshot({
			projectId: "malicious-project",
			actorId,
			idempotencyKey: "import-malicious",
			files: [{ ...first, path: "../outside.md" }, ...files.slice(1)],
		}),
		/Invalid open-package path/u,
	);
});

test("snapshot commit derives ChangeSet inside Runtime and keeps idempotent retries stable", async () => {
	const store = new InMemoryCloudProjectStore();
	const service = new CloudProjectService(store);
	const files = await fixtureFiles();
	const imported = await service.importSnapshot({
		projectId: "cloud-project-1",
		actorId,
		idempotencyKey: "import-1",
		files,
	});
	const changed = replaceInFile(files, "world/characters/黄盖.md", "他宁可自己受刑", "他宁可自己当众受刑");
	const input = {
		projectId: "cloud-project-1",
		actorId,
		idempotencyKey: "commit-1",
		baseRevisionId: imported.snapshot.revision.id,
		files: changed,
	};
	const committed = await service.commitSnapshot(input);
	const retried = await service.commitSnapshot(input);
	assert.equal(retried.snapshot.revision.id, committed.snapshot.revision.id);
	assert.equal(committed.snapshot.revision.parentId, imported.snapshot.revision.id);
	const diff = await service.diff({
		projectId: "cloud-project-1",
		actorId,
		baseRevisionId: imported.snapshot.revision.id,
		revisionId: committed.snapshot.revision.id,
	});
	assert.deepEqual(
		diff.changes.map((change) => [change.kind, change.change]),
		[["story", "modified"]],
	);
	assert.match(diff.changes[0]?.key ?? "", /character/u);

	await assert.rejects(
		service.commitSnapshot({ ...input, idempotencyKey: "commit-2", files }),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_no_changes",
	);
});

test("Cloud application service cannot bypass project membership", async () => {
	const store = new InMemoryCloudProjectStore();
	const service = new CloudProjectService(store);
	const files = await fixtureFiles();
	const imported = await service.importSnapshot({
		projectId: "cloud-project-1",
		actorId,
		idempotencyKey: "import-1",
		files,
	});
	await store.setMember({
		projectId: "cloud-project-1",
		actorId,
		idempotencyKey: "member-1",
		memberActorId: "reader-1",
		role: "viewer",
	});
	assert.equal((await service.project({ projectId: "cloud-project-1", actorId: "reader-1" })).role, "viewer");
	const changed = replaceInFile(files, "world/characters/黄盖.md", "宁可自己受刑", "宁可自己先受刑");
	await assert.rejects(
		service.commitSnapshot({
			projectId: "cloud-project-1",
			actorId: "reader-1",
			idempotencyKey: "commit-reader",
			baseRevisionId: imported.snapshot.revision.id,
			files: changed,
		}),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_access_denied",
	);
});
