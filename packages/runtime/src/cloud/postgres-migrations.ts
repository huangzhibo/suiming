export interface CloudPostgresMigration {
	id: string;
	statements: readonly string[];
}

const INITIAL_CLOUD_STORE_STATEMENTS = [
	`CREATE SCHEMA IF NOT EXISTS suiming`,
	`CREATE TABLE suiming.projects (
		id text PRIMARY KEY,
		head_revision_id text NOT NULL,
		created_by text NOT NULL,
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL
	)`,
	`CREATE TABLE suiming.project_members (
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		actor_id text NOT NULL,
		role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, actor_id)
	)`,
	`CREATE INDEX project_members_actor ON suiming.project_members(actor_id, project_id)`,
	`CREATE TABLE suiming.artifact_versions (
		id text PRIMARY KEY,
		media_type text NOT NULL,
		content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
		byte_length bigint NOT NULL CHECK (byte_length >= 0),
		inline_bytes bytea,
		object_key text,
		CHECK (num_nonnulls(inline_bytes, object_key) = 1),
		UNIQUE (media_type, content_hash)
	)`,
	`CREATE TABLE suiming.change_sets (
		id text PRIMARY KEY,
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		base_revision_id text NOT NULL,
		operations_json jsonb NOT NULL CHECK (jsonb_typeof(operations_json) = 'array'),
		created_by text NOT NULL,
		created_at timestamptz NOT NULL,
		UNIQUE (project_id, id)
	)`,
	`CREATE TABLE suiming.project_revisions (
		id text PRIMARY KEY,
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		parent_id text,
		change_set_id text,
		created_by text NOT NULL,
		created_at timestamptz NOT NULL,
		UNIQUE (project_id, id),
		FOREIGN KEY (project_id, parent_id)
			REFERENCES suiming.project_revisions(project_id, id)
			DEFERRABLE INITIALLY DEFERRED,
		FOREIGN KEY (project_id, change_set_id)
			REFERENCES suiming.change_sets(project_id, id)
			DEFERRABLE INITIALLY DEFERRED,
		CHECK (
			(parent_id IS NULL AND change_set_id IS NULL)
			OR (parent_id IS NOT NULL AND change_set_id IS NOT NULL)
		)
	)`,
	`ALTER TABLE suiming.projects
		ADD CONSTRAINT projects_head_revision
		FOREIGN KEY (id, head_revision_id)
		REFERENCES suiming.project_revisions(project_id, id)
		DEFERRABLE INITIALLY DEFERRED`,
	`ALTER TABLE suiming.change_sets
		ADD CONSTRAINT change_sets_base_revision
		FOREIGN KEY (project_id, base_revision_id)
		REFERENCES suiming.project_revisions(project_id, id)
		DEFERRABLE INITIALLY DEFERRED`,
	`CREATE INDEX project_revisions_history
		ON suiming.project_revisions(project_id, created_at, id)`,
	`CREATE TABLE suiming.revision_artifacts (
		project_id text NOT NULL,
		revision_id text NOT NULL,
		namespace_kind text NOT NULL CHECK (namespace_kind IN ('target', 'source')),
		source_id text NOT NULL,
		artifact_kind text NOT NULL,
		local_id text NOT NULL,
		artifact_version_id text NOT NULL REFERENCES suiming.artifact_versions(id),
		PRIMARY KEY (project_id, revision_id, namespace_kind, source_id, artifact_kind, local_id),
		FOREIGN KEY (project_id, revision_id)
			REFERENCES suiming.project_revisions(project_id, id) ON DELETE CASCADE,
		CHECK (
			(namespace_kind = 'target' AND source_id = '')
			OR (namespace_kind = 'source' AND source_id <> '')
		)
	)`,
	`CREATE INDEX revision_artifacts_version
		ON suiming.revision_artifacts(artifact_version_id)`,
	`CREATE TABLE suiming.revision_evidence_files (
		project_id text NOT NULL,
		revision_id text NOT NULL,
		path text NOT NULL,
		artifact_version_id text NOT NULL REFERENCES suiming.artifact_versions(id),
		PRIMARY KEY (project_id, revision_id, path),
		FOREIGN KEY (project_id, revision_id)
			REFERENCES suiming.project_revisions(project_id, id) ON DELETE CASCADE
	)`,
	`CREATE INDEX revision_evidence_files_version
		ON suiming.revision_evidence_files(artifact_version_id)`,
	`CREATE TABLE suiming.conversations (
		id text PRIMARY KEY,
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		status text NOT NULL CHECK (status IN ('open', 'closed')),
		data_json jsonb NOT NULL CHECK (jsonb_typeof(data_json) = 'object'),
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL,
		UNIQUE (project_id, id)
	)`,
	`CREATE TABLE suiming.runs (
		id text PRIMARY KEY,
		project_id text NOT NULL,
		conversation_id text NOT NULL,
		status text NOT NULL CHECK (
			status IN ('pending', 'running', 'interrupting', 'completed', 'failed', 'interrupted')
		),
		data_json jsonb NOT NULL CHECK (jsonb_typeof(data_json) = 'object'),
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL,
		UNIQUE (project_id, id),
		FOREIGN KEY (project_id, conversation_id)
			REFERENCES suiming.conversations(project_id, id) ON DELETE CASCADE
	)`,
	`CREATE INDEX runs_project_status
		ON suiming.runs(project_id, status, updated_at, id)`,
	`CREATE TABLE suiming.tasks (
		id text PRIMARY KEY,
		project_id text NOT NULL,
		run_id text NOT NULL,
		kind text NOT NULL,
		status text NOT NULL CHECK (
			status IN ('pending', 'running', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled')
		),
		data_json jsonb NOT NULL CHECK (jsonb_typeof(data_json) = 'object'),
		lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL,
		UNIQUE (project_id, id),
		UNIQUE (project_id, run_id, id),
		UNIQUE (project_id, id, lease_generation),
		FOREIGN KEY (project_id, run_id)
			REFERENCES suiming.runs(project_id, id) ON DELETE CASCADE
	)`,
	`CREATE INDEX tasks_ready_queue
		ON suiming.tasks(project_id, created_at, id)
		WHERE status = 'pending'`,
	`CREATE TABLE suiming.task_dependencies (
		project_id text NOT NULL,
		run_id text NOT NULL,
		task_id text NOT NULL,
		depends_on_task_id text NOT NULL,
		PRIMARY KEY (project_id, task_id, depends_on_task_id),
		FOREIGN KEY (project_id, run_id, task_id)
			REFERENCES suiming.tasks(project_id, run_id, id) ON DELETE CASCADE,
		FOREIGN KEY (project_id, run_id, depends_on_task_id)
			REFERENCES suiming.tasks(project_id, run_id, id) ON DELETE CASCADE,
		CHECK (task_id <> depends_on_task_id)
	)`,
	`CREATE INDEX task_dependencies_upstream
		ON suiming.task_dependencies(project_id, depends_on_task_id)`,
	`CREATE TABLE suiming.attempts (
		id text PRIMARY KEY,
		project_id text NOT NULL,
		task_id text NOT NULL,
		status text NOT NULL CHECK (status IN ('running', 'interrupting', 'completed', 'failed', 'interrupted')),
		data_json jsonb NOT NULL CHECK (jsonb_typeof(data_json) = 'object'),
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL,
		UNIQUE (project_id, id),
		FOREIGN KEY (project_id, task_id)
			REFERENCES suiming.tasks(project_id, id) ON DELETE CASCADE
	)`,
	`CREATE INDEX attempts_task_status
		ON suiming.attempts(project_id, task_id, status, created_at, id)`,
	`CREATE TABLE suiming.execution_command_receipts (
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		command_id text NOT NULL,
		fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
		result_json jsonb NOT NULL,
		created_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, command_id)
	)`,
	`CREATE TABLE suiming.execution_objects (
		id text PRIMARY KEY,
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		artifact_version_id text NOT NULL REFERENCES suiming.artifact_versions(id),
		created_at timestamptz NOT NULL,
		UNIQUE (project_id, id)
	)`,
	`CREATE INDEX execution_objects_version
		ON suiming.execution_objects(artifact_version_id)`,
	`CREATE TABLE suiming.idempotency_receipts (
		project_id text NOT NULL REFERENCES suiming.projects(id) ON DELETE CASCADE,
		actor_id text NOT NULL,
		operation text NOT NULL,
		idempotency_key text NOT NULL,
		fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
		result_json jsonb NOT NULL,
		created_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, actor_id, operation, idempotency_key)
	)`,
	`CREATE TABLE suiming.task_leases (
		project_id text NOT NULL,
		task_id text NOT NULL,
		worker_id text NOT NULL,
		token text NOT NULL,
		generation bigint NOT NULL CHECK (generation > 0),
		acquired_at timestamptz NOT NULL,
		heartbeat_at timestamptz NOT NULL,
		expires_at timestamptz NOT NULL,
		PRIMARY KEY (project_id, task_id),
		UNIQUE (token),
		FOREIGN KEY (project_id, task_id, generation)
			REFERENCES suiming.tasks(project_id, id, lease_generation) ON DELETE CASCADE,
		CHECK (heartbeat_at >= acquired_at),
		CHECK (expires_at > heartbeat_at)
	)`,
	`CREATE INDEX task_leases_expiry
		ON suiming.task_leases(expires_at, project_id, task_id)`,
] as const;

export const CLOUD_POSTGRES_MIGRATIONS: readonly CloudPostgresMigration[] = Object.freeze([
	Object.freeze({
		id: "001_initial_cloud_store",
		statements: INITIAL_CLOUD_STORE_STATEMENTS,
	}),
	Object.freeze({
		id: "002_run_events",
		statements: [
			`ALTER TABLE suiming.runs
				ADD COLUMN last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0)`,
			`CREATE TABLE suiming.run_events (
				project_id text NOT NULL,
				run_id text NOT NULL,
				sequence bigint NOT NULL CHECK (sequence > 0),
				event_key text NOT NULL,
				protocol_version text NOT NULL CHECK (protocol_version = 'suiming.run-event.v1'),
				event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
				fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
				created_at timestamptz NOT NULL,
				PRIMARY KEY (project_id, run_id, sequence),
				UNIQUE (project_id, run_id, event_key),
				FOREIGN KEY (project_id, run_id)
					REFERENCES suiming.runs(project_id, id) ON DELETE CASCADE
			)`,
			`CREATE INDEX run_events_replay
				ON suiming.run_events(project_id, run_id, sequence)`,
		],
	}),
	Object.freeze({
		id: "003_cancelled_status",
		statements: [
			// cancelRun 会把 Run 与它的活动 Attempt 一起写成 cancelled，但 001 的 CHECK 只给 tasks 留了这个值，
			// Cloud adapter 一取消就撞 CHECK 违例。约束名由 001 的 CHECK 自动生成（表名_列名_check）。
			`ALTER TABLE suiming.runs DROP CONSTRAINT runs_status_check`,
			`ALTER TABLE suiming.runs ADD CONSTRAINT runs_status_check CHECK (
				status IN ('pending', 'running', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled')
			)`,
			`ALTER TABLE suiming.attempts DROP CONSTRAINT attempts_status_check`,
			`ALTER TABLE suiming.attempts ADD CONSTRAINT attempts_status_check CHECK (
				status IN ('running', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled')
			)`,
		],
	}),
	Object.freeze({
		id: "004_drop_execution",
		statements: [
			// Cloud 执行 adapter 删除（2026-09-13）：Cloud 只保留 Canon 与同步。Worker 领到 Task 只会以
			// cloud_task_executor_not_found 确定性失败，为它把 schema 改成 session 是没有用户的成本。
			`DROP TABLE IF EXISTS suiming.run_events`,
			`DROP TABLE IF EXISTS suiming.task_leases`,
			`DROP TABLE IF EXISTS suiming.attempts`,
			`DROP TABLE IF EXISTS suiming.task_dependencies`,
			`DROP TABLE IF EXISTS suiming.tasks`,
			`DROP TABLE IF EXISTS suiming.runs`,
			`DROP TABLE IF EXISTS suiming.conversations`,
			`DROP TABLE IF EXISTS suiming.execution_command_receipts`,
			`DROP TABLE IF EXISTS suiming.execution_objects`,
		],
	}),
	Object.freeze({
		id: "005_drop_evidence",
		statements: [
			// evidence 层改为从版本历史派生（2026-09-13）：审稿与 Source 笔记是普通 artifact，随 revision_artifacts 走。
			`DROP TABLE IF EXISTS suiming.revision_evidence_files`,
		],
	}),
	Object.freeze({
		id: "006_artifact_path",
		statements: [
			// 路径与 identity 一样是事实，不再由 outline/story/index.yaml 反推（2026-09-14）。git 的 tree
			// 天然存路径，按 identity 存的 store 要自己存一份，否则读回来的候选没有路径可交给 Checker。
			// 开发期没有需要保留的 Cloud 数据，旧行留空路径即可——下一次提交会整表重写。
			`ALTER TABLE suiming.revision_artifacts ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT ''`,
			`ALTER TABLE suiming.revision_artifacts ALTER COLUMN path DROP DEFAULT`,
		],
	}),
]);
