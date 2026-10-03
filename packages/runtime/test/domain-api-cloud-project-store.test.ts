import assert from "node:assert/strict";
import test from "node:test";
import { sha256Buffer } from "@suiming/story";
import {
	artifactIdentityKey,
	CloudProjectService,
	CloudStoreError,
	candidateFromOpenStoryFiles,
	DomainApiCloudProjectStore,
	type DomainApiProjectClient,
	InMemoryCloudProjectStore,
	validateStoryProjectCandidate,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const actorId = "author-1";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function fixtureFiles() {
	return sampleWorkFiles();
}

function referenceClient(store: InMemoryCloudProjectStore): DomainApiProjectClient {
	const service = new CloudProjectService(store);
	const revisionData = async (projectId: string, revisionId: string) => {
		const value = await service.revision({ projectId, actorId, revisionId });
		return {
			projectId,
			revision: value.snapshot.revision,
			manifest: {
				schemaVersion: 1 as const,
				contentFingerprint: value.contentFingerprint,
				files: value.files.map((file) => ({
					path: file.path,
					mediaType: file.mediaType,
					contentSha256: sha256Buffer(file.bytes),
					byteLength: file.bytes.byteLength,
				})),
			},
		};
	};
	return {
		async importProject(input) {
			const value = await service.importSnapshot({ ...input, actorId });
			const project = await service.project({ projectId: input.projectId, actorId });
			return { project: { ...project.project, role: project.role }, revision: value.snapshot.revision };
		},
		async readProject(projectId) {
			const value = await service.project({ projectId, actorId });
			return { ...value.project, role: value.role };
		},
		async setProjectMember(input) {
			return store.setMember({ ...input, actorId });
		},
		async history(projectId) {
			const [project, revisions] = await Promise.all([
				store.project({ projectId, actorId }),
				service.history({ projectId, actorId }),
			]);
			return { projectId, headRevisionId: project.headRevisionId, revisions };
		},
		async commitRevision(input) {
			const value = await service.commitSnapshot({ ...input, actorId });
			return revisionData(input.projectId, value.snapshot.revision.id);
		},
		readRevision: revisionData,
		async exportRevision(projectId, revisionId) {
			return (await service.revision({ projectId, actorId, revisionId })).files;
		},
		async readArtifactVersion(projectId, artifactVersionId) {
			return store.readVersion({ projectId, actorId, artifactVersionId });
		},
	};
}

test("DomainApiCloudProjectStore preserves CloudProjectStore semantics over public SDK methods", async () => {
	const backing = new InMemoryCloudProjectStore();
	const remote = new DomainApiCloudProjectStore({ client: referenceClient(backing), actorId });
	const files = await fixtureFiles();
	const candidate = candidateFromOpenStoryFiles(files, "import");
	const genesis = await remote.createProject(
		{
			projectId: "project-1",
			actorId,
			idempotencyKey: "import-1",
			artifacts: candidate.artifacts,
		},
		validateStoryProjectCandidate,
	);
	const snapshot = await remote.readRevision({ projectId: "project-1", actorId, revisionId: genesis.id });
	// 导出的文件与版本清单必须是同一份内容：条数相同，identity 一一对上。候选自己带字节，不再抄一份 version id。
	assert.equal(snapshot.candidate.artifacts.length, genesis.artifacts.length);
	assert.deepEqual(
		snapshot.candidate.artifacts.map((artifact) => artifactIdentityKey(artifact.identity)).sort(),
		snapshot.revision.artifacts.map((artifact) => artifactIdentityKey(artifact.identity)).sort(),
	);

	const character = snapshot.candidate.artifacts.find(
		(artifact) => artifact.identity.kind === "character" && artifact.identity.localId === "黄盖",
	);
	assert.ok(character);
	const text = decoder.decode(character.bytes);
	const committed = await remote.commit(
		{
			projectId: "project-1",
			actorId,
			idempotencyKey: "commit-1",
			changeSet: {
				baseRevisionId: genesis.id,
				operations: [
					{
						operation: "replace",
						identity: character.identity,
						path: character.path,
						mediaType: character.mediaType,
						bytes: encoder.encode(text.replace("先保留筹码", "先核验证据")),
					},
				],
			},
		},
		validateStoryProjectCandidate,
	);
	assert.equal(committed.parentId, genesis.id);
	assert.deepEqual(
		(await remote.history({ projectId: "project-1", actorId })).map((revision) => revision.id),
		[genesis.id, committed.id],
	);
	const committedCharacter = committed.artifacts.find(
		(artifact) => artifact.identity.kind === "character" && artifact.identity.localId === "黄盖",
	);
	assert.ok(committedCharacter);
	const version = await remote.readVersion({
		projectId: "project-1",
		actorId,
		artifactVersionId: committedCharacter.artifactVersionId,
	});
	assert.match(decoder.decode(version.bytes), /先核验证据/u);
	assert.equal(
		await remote.setMember({
			projectId: "project-1",
			actorId,
			idempotencyKey: "member-1",
			memberActorId: "reader-1",
			role: "viewer",
		}),
		"viewer",
	);
	await assert.rejects(
		remote.project({ projectId: "project-1", actorId: "another-actor" }),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_actor_mismatch",
	);
});
