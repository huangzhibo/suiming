import assert from "node:assert/strict";
import test from "node:test";
import {
	ArtifactError,
	type CandidateArtifact,
	CLOUD_POSTGRES_MIGRATIONS,
	type CloudObjectStore,
	type CloudPostgresMigration,
	CloudStoreError,
	type CommitCloudProjectInput,
	classifyOpenStoryDirectoryFile,
	InMemoryCloudObjectStore,
	storyPackageCodec,
	targetArtifactIdentity,
	validateStoryProjectCandidate,
} from "@suiming/runtime";
import { sql } from "kysely";
import { sampleWorkFiles } from "../../runtime/test/sample-work.js";
import {
	CloudPostgresError,
	cloudPostgresConfigFromEnvironment,
	cloudPostgresMigrationChecksum,
	createCloudPostgresDatabase,
	migrateCloudPostgres,
	PostgresCloudProjectStore,
} from "../src/index.js";

const connectionString = process.env.SUIMING_TEST_POSTGRES_URL;

test("PostgreSQL process config requires a URL and parses bounded pool settings", () => {
	assert.deepEqual(
		cloudPostgresConfigFromEnvironment(
			{
				SUIMING_POSTGRES_URL: " postgresql://localhost/suiming ",
				SUIMING_POSTGRES_MAX_CONNECTIONS: "12",
			},
			"suiming-api",
		),
		{
			connectionString: "postgresql://localhost/suiming",
			maxConnections: 12,
			applicationName: "suiming-api",
		},
	);
	assert.throws(
		() => cloudPostgresConfigFromEnvironment({}),
		(error: unknown) => error instanceof CloudPostgresError && error.code === "missing_cloud_postgres_config",
	);
	assert.throws(
		() =>
			cloudPostgresConfigFromEnvironment({
				SUIMING_POSTGRES_URL: "postgresql://localhost/suiming",
				SUIMING_POSTGRES_MAX_CONNECTIONS: "0",
			}),
		(error: unknown) => error instanceof CloudPostgresError && error.code === "invalid_cloud_postgres_config",
	);
});

async function storyFixture(): Promise<CandidateArtifact[]> {
	return sampleWorkFiles()
		.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story")
		.map((file) => ({
			identity: storyPackageCodec.identityForPath(file.path),
			path: file.path,
			mediaType: file.mediaType,
			bytes: new Uint8Array(file.bytes),
		}));
}

test("PostgreSQL migrator 原子应用 catalog，以 advisory lock 收敛并发，并拒绝 checksum drift", {
	skip: connectionString === undefined ? "set SUIMING_TEST_POSTGRES_URL to run PostgreSQL integration" : false,
}, async (context) => {
	const database = createCloudPostgresDatabase({
		connectionString: connectionString as string,
		applicationName: "suiming-migrator-test-primary",
	});
	const concurrent = createCloudPostgresDatabase({
		connectionString: connectionString as string,
		applicationName: "suiming-migrator-test-concurrent",
	});
	context.after(async () => {
		await Promise.all([database.destroy(), concurrent.destroy()]);
	});
	await sql.raw("DROP SCHEMA IF EXISTS suiming CASCADE").execute(database);

	const broken: readonly CloudPostgresMigration[] = [
		{ id: "test_001_partial", statements: ["CREATE TABLE suiming.partial_migration (id text PRIMARY KEY)"] },
		{ id: "test_002_broken", statements: ["THIS IS NOT VALID SQL"] },
	];
	await assert.rejects(migrateCloudPostgres(database, broken));
	const rolledBack = await sql<{ table_name: string | null }>`
			SELECT to_regclass('suiming.partial_migration')::text AS table_name
		`.execute(database);
	assert.equal(rolledBack.rows[0]?.table_name, null);

	const raced = await Promise.all([migrateCloudPostgres(database), migrateCloudPostgres(concurrent)]);
	assert.deepEqual(
		raced.map((result) => result.applied.length).sort((left, right) => left - right),
		[0, CLOUD_POSTGRES_MIGRATIONS.length],
	);
	assert.deepEqual(
		raced.flatMap((result) => result.applied).sort(),
		CLOUD_POSTGRES_MIGRATIONS.map((migration) => migration.id).sort(),
	);

	const tables = await sql<{ table_name: string }>`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'suiming'
			ORDER BY table_name
		`.execute(database);
	// 这条断言曾经点名 tasks / task_leases / run_events，而 004_drop_execution 早把它们删了
	// （2026-09-13，Cloud 只剩 Canon 与同步）。没有 PostgreSQL 时整个文件 skip，所以一直没人发现。
	assert.deepEqual(
		tables.rows.map((row) => row.table_name),
		[
			"artifact_versions",
			"change_sets",
			"idempotency_receipts",
			"project_members",
			"project_revisions",
			"projects",
			"revision_artifacts",
			"schema_migrations",
		],
	);
	// 路径与 identity 一起存：按 identity 存的 store 读回候选时要拿得出路径（006）。
	const artifactColumns = await sql<{ column_name: string }>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'suiming' AND table_name = 'revision_artifacts' AND column_name = 'path'
		`.execute(database);
	assert.equal(artifactColumns.rows.length, 1);

	const idempotent = await migrateCloudPostgres(database);
	assert.deepEqual(idempotent.applied, []);
	assert.deepEqual(
		idempotent.alreadyApplied,
		CLOUD_POSTGRES_MIGRATIONS.map((migration) => migration.id),
	);

	const first = CLOUD_POSTGRES_MIGRATIONS[0];
	assert.ok(first);
	const changed: readonly CloudPostgresMigration[] = [
		{ ...first, statements: [...first.statements, "SELECT 1"] },
		...CLOUD_POSTGRES_MIGRATIONS.slice(1),
	];
	assert.notEqual(
		cloudPostgresMigrationChecksum(changed[0] as CloudPostgresMigration),
		cloudPostgresMigrationChecksum(first),
	);
	await assert.rejects(
		migrateCloudPostgres(database, changed),
		(error: unknown) => error instanceof CloudPostgresError && error.code === "postgres_migration_checksum_mismatch",
	);
});

test("PostgreSQL CloudProjectStore 保持权限、幂等、线性 revision 与对象完整性", {
	skip: connectionString === undefined ? "set SUIMING_TEST_POSTGRES_URL to run PostgreSQL integration" : false,
}, async (context) => {
	const database = createCloudPostgresDatabase({
		connectionString: connectionString as string,
		applicationName: "suiming-project-store-test-primary",
	});
	const concurrentDatabase = createCloudPostgresDatabase({
		connectionString: connectionString as string,
		applicationName: "suiming-project-store-test-concurrent",
	});
	context.after(async () => {
		await Promise.all([database.destroy(), concurrentDatabase.destroy()]);
	});
	await sql.raw("DROP SCHEMA IF EXISTS suiming CASCADE").execute(database);
	await migrateCloudPostgres(database);

	const artifacts = await storyFixture();
	const failingObjects: CloudObjectStore = {
		async put() {
			throw new Error("object write failed");
		},
		async read() {
			throw new Error("unused");
		},
		async delete() {},
	};
	const failingStore = new PostgresCloudProjectStore({
		database,
		objects: failingObjects,
		inlineTextThresholdBytes: 0,
	});
	await assert.rejects(
		() =>
			failingStore.createProject(
				{
					projectId: "project-object-failure",
					actorId: "owner-failure",
					idempotencyKey: "create-failure",
					artifacts,
				},
				validateStoryProjectCandidate,
			),
		/object write failed/,
	);
	const failedRows = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM suiming.projects WHERE id = 'project-object-failure'
	`.execute(database);
	assert.equal(failedRows.rows[0]?.count, "0");

	const objects = new InMemoryCloudObjectStore();
	const now = () => new Date("2026-09-03T04:00:00.000Z");
	const store = new PostgresCloudProjectStore({
		database,
		objects,
		inlineTextThresholdBytes: 0,
		now,
	});
	const concurrentStore = new PostgresCloudProjectStore({
		database: concurrentDatabase,
		objects,
		inlineTextThresholdBytes: 0,
		now,
	});
	const createInput = {
		projectId: "project-postgres",
		actorId: "owner-1",
		idempotencyKey: "create-1",
		artifacts,
	};
	const genesis = await store.createProject(createInput, validateStoryProjectCandidate);
	assert.match(genesis.id, /^pr_[0-9a-f-]{36}$/u);
	assert.equal((await store.createProject(createInput, validateStoryProjectCandidate)).id, genesis.id);
	await assert.rejects(
		() =>
			store.createProject(
				{ ...createInput, artifacts: createInput.artifacts.slice(0, -1) },
				validateStoryProjectCandidate,
			),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_idempotency_conflict",
	);
	assert.deepEqual(await store.project({ projectId: createInput.projectId, actorId: "owner-1" }), {
		id: createInput.projectId,
		headRevisionId: genesis.id,
		createdBy: "owner-1",
		createdAt: "2026-09-03T04:00:00.000Z",
		updatedAt: "2026-09-03T04:00:00.000Z",
	});
	assert.equal(await store.role({ projectId: createInput.projectId, actorId: "owner-1" }), "owner");

	await store.setMember({
		projectId: createInput.projectId,
		actorId: "owner-1",
		idempotencyKey: "member-viewer",
		memberActorId: "author-1",
		role: "viewer",
	});
	const initialSnapshot = await store.readRevision({
		projectId: createInput.projectId,
		actorId: "author-1",
		revisionId: genesis.id,
	});
	assert.equal(initialSnapshot.candidate.artifacts.length, artifacts.length);
	assert.deepEqual(
		await concurrentStore.readCandidate({ projectId: createInput.projectId, revisionId: genesis.id }),
		initialSnapshot.candidate,
	);

	const beat = artifacts.find(
		(artifact) => artifact.identity.kind === "story-beat" && artifact.identity.localId === "beat-0002",
	);
	assert.ok(beat);
	const replacementBytes = new TextEncoder().encode(
		new TextDecoder().decode(beat.bytes).replace("亲手焚毁密信", "主动亲手焚毁密信"),
	);
	const commitInput = {
		projectId: createInput.projectId,
		actorId: "author-1",
		idempotencyKey: "commit-1",
		changeSet: {
			baseRevisionId: genesis.id,
			operations: [
				{
					operation: "replace" as const,
					identity: targetArtifactIdentity("story-beat", "beat-0002"),
					path: beat.path,
					mediaType: beat.mediaType,
					bytes: replacementBytes,
				},
			],
		},
	};
	await assert.rejects(
		() => store.commit(commitInput, validateStoryProjectCandidate),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_access_denied",
	);
	await store.setMember({
		projectId: createInput.projectId,
		actorId: "owner-1",
		idempotencyKey: "member-editor",
		memberActorId: "author-1",
		role: "editor",
	});
	const committed = await store.commit(commitInput, validateStoryProjectCandidate);
	assert.equal(committed.parentId, genesis.id);
	assert.equal((await store.commit(commitInput, validateStoryProjectCandidate)).id, committed.id);
	assert.equal((await concurrentStore.history({ projectId: createInput.projectId, actorId: "author-1" })).length, 2);

	const storedChangeSet = await sql<{ operations_json: unknown }>`
		SELECT operations_json FROM suiming.change_sets WHERE project_id = ${createInput.projectId}
	`.execute(database);
	assert.match(JSON.stringify(storedChangeSet.rows[0]?.operations_json), /"artifactVersionId":"av_[0-9a-f]{64}"/u);
	assert.doesNotMatch(JSON.stringify(storedChangeSet.rows[0]?.operations_json), /bytesBase64/u);

	const idempotentBytes = new TextEncoder().encode(
		new TextDecoder().decode(replacementBytes).replace("主动亲手", "更加主动亲手"),
	);
	const commitOperation = commitInput.changeSet.operations[0];
	assert.ok(commitOperation);
	const idempotentInput = {
		...commitInput,
		idempotencyKey: "commit-concurrent-idempotent",
		changeSet: {
			...commitInput.changeSet,
			baseRevisionId: committed.id,
			operations: [{ ...commitOperation, bytes: idempotentBytes }],
		},
	} satisfies CommitCloudProjectInput;
	const duplicateRace = await Promise.all([
		store.commit(idempotentInput, validateStoryProjectCandidate),
		concurrentStore.commit(idempotentInput, validateStoryProjectCandidate),
	]);
	assert.equal(duplicateRace[0].id, duplicateRace[1].id);

	const concurrentBytes = new TextEncoder().encode(
		new TextDecoder().decode(idempotentBytes).replace("更加主动亲手", "坚决主动亲手"),
	);
	const concurrentInput = {
		...commitInput,
		changeSet: {
			...commitInput.changeSet,
			baseRevisionId: duplicateRace[0].id,
			operations: [{ ...commitOperation, bytes: concurrentBytes }],
		},
	} satisfies CommitCloudProjectInput;
	const raced = await Promise.allSettled([
		store.commit({ ...concurrentInput, idempotencyKey: "commit-race-a" }, validateStoryProjectCandidate),
		concurrentStore.commit({ ...concurrentInput, idempotencyKey: "commit-race-b" }, validateStoryProjectCandidate),
	]);
	assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
	const raceFailure = raced.find((result) => result.status === "rejected");
	assert.equal(
		raceFailure?.status === "rejected" && raceFailure.reason instanceof ArtifactError
			? raceFailure.reason.code
			: undefined,
		"revision_conflict",
	);

	const current = await store.project({ projectId: createInput.projectId, actorId: "author-1" });
	const currentSnapshot = await store.readRevision({
		projectId: createInput.projectId,
		actorId: "author-1",
		revisionId: current.headRevisionId,
	});
	const currentBeat = currentSnapshot.candidate.artifacts.find(
		(artifact) => artifact.identity.kind === "story-beat" && artifact.identity.localId === "beat-0002",
	);
	assert.ok(currentBeat);
	const retryInput = {
		projectId: createInput.projectId,
		actorId: "author-1",
		idempotencyKey: "commit-checker-retry",
		changeSet: {
			baseRevisionId: current.headRevisionId,
			operations: [
				{
					operation: "replace" as const,
					identity: currentBeat.identity,
					path: currentBeat.path,
					mediaType: currentBeat.mediaType,
					bytes: new TextEncoder().encode(
						new TextDecoder().decode(currentBeat.bytes).replace("焚毁密信", "果断焚毁密信"),
					),
				},
			],
		},
	};
	await assert.rejects(
		() =>
			store.commit(retryInput, () => {
				throw new ArtifactError("test_checker_rejected", "Checker rejected candidate");
			}),
		(error: unknown) => error instanceof ArtifactError && error.code === "test_checker_rejected",
	);
	assert.equal(
		(await store.project({ projectId: createInput.projectId, actorId: "author-1" })).headRevisionId,
		current.headRevisionId,
	);
	const retried = await store.commit(retryInput, validateStoryProjectCandidate);
	assert.equal(retried.parentId, current.headRevisionId);

	await assert.rejects(
		() =>
			store.setMember({
				projectId: createInput.projectId,
				actorId: "owner-1",
				idempotencyKey: "remove-last-owner",
				memberActorId: "owner-1",
				role: "editor",
			}),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_last_owner",
	);

	const finalSnapshot = await concurrentStore.readRevision({
		projectId: createInput.projectId,
		actorId: "owner-1",
		revisionId: retried.id,
	});
	const changedVersionId = finalSnapshot.revision.artifacts.find(
		(artifact) => artifact.identity.kind === "story-beat" && artifact.identity.localId === "beat-0002",
	)?.artifactVersionId;
	assert.ok(changedVersionId);
	const retryOperation = retryInput.changeSet.operations[0];
	assert.ok(retryOperation);
	assert.deepEqual(
		await concurrentStore.readVersion({
			projectId: createInput.projectId,
			actorId: "owner-1",
			artifactVersionId: changedVersionId,
		}),
		{
			id: changedVersionId,
			mediaType: currentBeat.mediaType,
			bytes: retryOperation.bytes,
		},
	);
	await store.createProject(
		{
			projectId: "project-isolated",
			actorId: "owner-isolated",
			idempotencyKey: "create-isolated",
			artifacts,
		},
		validateStoryProjectCandidate,
	);
	await assert.rejects(
		() =>
			store.readVersion({
				projectId: "project-isolated",
				actorId: "owner-isolated",
				artifactVersionId: changedVersionId,
			}),
		(error: unknown) => error instanceof ArtifactError && error.code === "artifact_version_project_mismatch",
	);
	const externalVersions = await sql<{ count: string }>`
		SELECT count(*)::text AS count
		FROM suiming.artifact_versions
		WHERE inline_bytes IS NULL AND object_key ~ '^objects/sha256/[0-9a-f]{2}/[0-9a-f]{64}$'
	`.execute(database);
	assert.ok(Number(externalVersions.rows[0]?.count) > 0);
	assert.equal(
		(await concurrentStore.history({ projectId: createInput.projectId, actorId: "owner-1" })).at(-1)?.id,
		retried.id,
	);
});
