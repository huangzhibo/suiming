import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	composeReviewFile,
	JsonFileCredentialStore,
	LocalModelSettings,
	LocalProjectService,
	LocalWorkspace,
	loadModelRoutingConfig,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

async function fixture(body: (project: LocalProjectService, root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "suiming-workspace-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "workspace" });
	try {
		await body(project, root);
	} finally {
		project.close();
		await rm(root, { recursive: true, force: true });
	}
}

const lease = { ownerId: "owner", hostname: "test", pid: 123, acquiredAt: new Date().toISOString() };

function fauxGateway(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = []) {
	const provider = fauxProvider({ provider: "workspace-faux" });
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	const gateway = new ModelGateway(models, {
		profiles: {
			main: { provider: provider.provider.id, model: provider.getModel().id },
			reviewer: { provider: provider.provider.id, model: provider.getModel().id },
		},
	});
	return { provider, gateway };
}

async function untilIdle(workspace: LocalWorkspace): Promise<void> {
	for (let n = 0; n < 500; n++) {
		if (workspace.activeSessionIds().length === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("turn 没有结束");
}

test("执行查询独立于作品文件有效性，并保留上一轮失败的结构化原因", async () =>
	fixture(async (project, root) => {
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("不应加载模型");
		});
		const state = project.createExecutionState();
		state.createSession({ commandId: "s", id: "s", projectId: project.projectId });
		state.startTurn({ commandId: "start", sessionId: "s", lease });
		state.endTurn({
			commandId: "end",
			sessionId: "s",
			failure: { code: "model_call_failed", message: "Request timed out", retryable: false },
		});
		await writeFile(join(root, "outline/story/index.yaml"), "invalid: [");
		const listed = await workspace.invoke("session.list", {});
		assert.equal(listed.sessions[0]?.status, "idle");
		assert.equal(listed.sessions[0]?.lastFailure?.code, "model_call_failed");
		assert.equal(listed.sessions[0]?.turn, 1);
		assert.equal(listed.projectId, project.projectId);
	}));

test("工作台查询无需模型；读写只有 workspace.file.* 一组：编辑 CAS 保留外部修改，按版本读单个文件", async () =>
	fixture(async (project, root) => {
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("查询不应初始化模型");
		});
		// 2026-10-02 之前另有 workspace.read / save 只管作品文件，与 workspace.file.* 大面积重叠，冲突提示都说得不一样。
		const empty = await workspace.invoke("workspace.file.read", { path: "text/beat-0002.md" });
		assert.deepEqual(
			{
				content: empty.content,
				sha256: empty.sha256,
				writable: empty.writable,
				classification: empty.classification,
			},
			{ content: "", sha256: null, writable: true, classification: "story" },
			"尚未写作的正文是可开始写作的空内容，不是读取失败",
		);
		await assert.rejects(workspace.invoke("workspace.file.read", { path: "notes/missing.txt" }), {
			code: "file_not_found",
		});
		await workspace.invoke("workspace.file.save", {
			path: "text/beat-0002.md",
			expectedSHA: null,
			content: "黄盖当众焚毁火船。\n",
		});
		assert.match(await readFile(join(root, "text/beat-0002.md"), "utf8"), /焚毁/, "保存可以新建作品文件");
		const file = await workspace.invoke("workspace.file.read", { path: "intent/计谋的代价.md" });
		await writeFile(join(root, file.path), "作者在外部明确了诈降的代价。\n");
		await assert.rejects(
			workspace.invoke("workspace.file.save", { path: file.path, expectedSHA: file.sha256, content: "过时 buffer" }),
			{ code: "checkout_edit_conflict", message: /请比较差异后再保存/ },
		);
		assert.match(await readFile(join(root, file.path), "utf8"), /外部/);
		const baseline = await workspace.invoke("workspace.file.read", { path: file.path });
		await workspace.invoke("workspace.file.save", {
			path: file.path,
			expectedSHA: baseline.sha256,
			content: "主角主动受刑，付出不可逆的代价。\n",
		});
		assert.equal((await workspace.invoke("workspace.show", {})).dirty, true);
		// 比较页只拿清单，选中哪个文件再按路径读两侧：一次大改不再把全部正文经 IPC 搬一遍（2026-10-02）。
		const pending = await workspace.invoke("project.diff", {});
		assert.equal(pending.length, 2);
		for (const entry of pending) assert.deepEqual(Object.keys(entry).sort(), ["kind", "path"]);
		const result = await workspace.invoke("project.commit", {});
		assert.equal(result.created, true);
		assert.equal((await workspace.invoke("workspace.show", {})).dirty, false);
		const committed = await workspace.invoke("revision.diff", { revisionId: result.revision.id });
		assert.deepEqual(committed, pending, "提交前看到的清单就是这个版本的改动");
		const parentId = result.revision.parentId ?? assert.fail("缺少父版本");
		const sides = await Promise.all(
			[parentId, result.revision.id].map((revisionId) =>
				workspace.invoke("workspace.file.read", { path: file.path, revisionId }),
			),
		);
		assert.doesNotMatch(sides[0]?.content ?? "", /不可逆/);
		assert.match(sides[1]?.content ?? "", /不可逆/);
		await rm(join(root, file.path));
		await writeFile(join(root, "world/places/新地点.md"), "新写的地点。\n");
		assert.deepEqual(await workspace.invoke("project.diff", {}), [
			{ path: file.path, kind: "deleted" },
			{ path: "world/places/新地点.md", kind: "added" },
		]);
		await writeFile(join(root, file.path), sides[1]?.content ?? "");
		await rm(join(root, "world/places/新地点.md"));
		await assert.rejects(workspace.invoke("workspace.file.read", { path: "../auth.json" }));
		// 按版本读单个文件：只读那一个 blob，原来要导出整个版本再从里面找。
		const first = (await project.history())[0]?.id ?? assert.fail("缺少初始版本");
		const old = await workspace.invoke("workspace.file.read", { path: "intent/计谋的代价.md", revisionId: first });
		assert.doesNotMatch(old.content, /不可逆/);
		assert.equal(old.writable, false, "历史版本只读");
		const now = await workspace.invoke("workspace.file.read", {
			path: "intent/计谋的代价.md",
			revisionId: result.revision.id,
		});
		assert.match(now.content, /不可逆/);
		assert.equal(
			now.sha256,
			(await workspace.invoke("workspace.file.read", { path: "intent/计谋的代价.md" })).sha256,
		);
		const missing = await workspace.invoke("workspace.file.read", { path: "text/beat-0002.md", revisionId: first });
		assert.deepEqual({ content: missing.content, sha256: missing.sha256 }, { content: "", sha256: null });
		// 恢复历史版本不倒拨 head：目标内容成为当前 head 的新子版本。
		const restored = await workspace.invoke("project.rollback", { revisionId: first });
		assert.equal(restored.created, true);
		assert.equal((await project.history()).at(-1)?.id, restored.revision.id);
		assert.equal((await project.history()).length, 3);
		assert.doesNotMatch(
			(await workspace.invoke("workspace.file.read", { path: "intent/计谋的代价.md" })).content,
			/不可逆/,
		);
		assert.equal((await workspace.invoke("project.rollback", { revisionId: restored.revision.id })).created, false);
	}));

test("状态与产品事件原子确认：事件 INSERT 失败时 turn 不会先收口", async () =>
	fixture(async (project) => {
		const execution = project.createExecutionState();
		execution.createSession({ commandId: "s", id: "s", projectId: project.projectId });
		execution.startTurn({ commandId: "start", sessionId: "s", lease });
		const database = new DatabaseSync(project.paths.databasePath);
		database.exec(
			"CREATE TRIGGER fail_terminal BEFORE INSERT ON session_events WHEN json_extract(NEW.event_json, '$.event.type') = 'RUN_FINISHED' BEGIN SELECT RAISE(ABORT, 'event storage failed'); END",
		);
		assert.throws(() => execution.endTurn({ commandId: "end", sessionId: "s" }), /event storage failed/);
		assert.equal(project.loadExecutionState().sessions[0]?.status, "running");
		assert.equal(
			project.readSessionEvents("s").some((record) => record.event.type === "RUN_FINISHED"),
			false,
		);
		database.exec("DROP TRIGGER fail_terminal");
		database.close();
		project.createExecutionState().endTurn({ commandId: "end", sessionId: "s" });
		assert.equal(project.loadExecutionState().sessions[0]?.status, "idle");
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("attach 不应启动模型");
		});
		const snapshot = await workspace.invoke("session.attach", { sessionId: "s" });
		assert.ok(snapshot.snapshot?.some((event) => event.type === "RUN_FINISHED"));
		assert.equal(snapshot.events.length, 0);
		assert.deepEqual(
			(await workspace.invoke("session.attach", { sessionId: "s", afterSequence: snapshot.cursor })).events,
			[],
		);
	}));

test("本地执行库只认 v6：旧版本打开时说清怎么办且不动库；把库挪走再 init，接上 git 里原来的版本链", async () => {
	// 2026-10-02 删掉 v1→v6 的迁移链（删前确认在用作品都已是 v6）。旧执行数据本来就不迁，作品版本在 git 里。
	const root = await mkdtemp(join(tmpdir(), "suiming-old-store-"));
	try {
		await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
		const project = await LocalProjectService.init({ checkoutPath: root, projectId: "old-store" });
		await writeFile(join(root, "world/places/赤壁.md"), "第二版的赤壁。\n");
		await project.commitCheckout();
		const head = project.project().headRevisionId;
		const databasePath = project.paths.databasePath;
		project.close();

		const tables = (database: DatabaseSync) =>
			database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
		const database = new DatabaseSync(databasePath);
		database.exec("DROP TABLE session_inbox; UPDATE schema_meta SET version = 4");
		const before = tables(database);
		database.close();
		await assert.rejects(LocalProjectService.open(root), (error: unknown) => {
			assert.equal((error as { code?: string }).code, "unsupported_local_store_schema");
			assert.match((error as Error).message, /v4.*v6.*local\.sqlite.*init/su);
			return true;
		});
		const untouched = new DatabaseSync(databasePath, { readOnly: true });
		assert.deepEqual(tables(untouched), before, "旧库不建表、不改版本");
		untouched.close();

		for (const name of await readdir(join(root, ".suiming")))
			if (name.startsWith("local.sqlite")) await rename(join(root, ".suiming", name), join(root, `${name}.old`));
		const reopened = await LocalProjectService.init({ checkoutPath: root });
		try {
			assert.equal(reopened.project().headRevisionId, head);
			assert.equal((await reopened.history()).length, 2, "版本链原样接上");
		} finally {
			reopened.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("idle 的 session：interrupt 原样返回；delete 带走子任务与执行记录", async () =>
	fixture(async (project) => {
		const execution = project.createExecutionState();
		execution.createSession({ commandId: "s", id: "s", projectId: project.projectId });
		execution.startTurn({ commandId: "start", sessionId: "s", lease });
		execution.addTask({ commandId: "t", id: "t", sessionId: "s", kind: "main", key: "a" });
		execution.endTurn({ commandId: "end", sessionId: "s" });
		assert.equal(execution.task("t").status, "interrupted");
		const workspace = new LocalWorkspace(project, async () => fauxGateway().gateway);
		assert.equal((await workspace.invoke("session.interrupt", { sessionId: "s" })).status, "idle");
		assert.equal((await project.history()).length, 1);
		assert.deepEqual(
			(await workspace.invoke("session.tasks", { sessionId: "s" })).map((task) => task.status),
			["interrupted"],
		);
		await workspace.invoke("session.delete", { sessionId: "s" });
		assert.deepEqual(project.loadExecutionState().sessions, []);
		assert.deepEqual(project.loadExecutionState().tasks, []);
		await assert.rejects(workspace.invoke("session.tasks", { sessionId: "s" }), { code: "session_not_found" });
	}));

test("命令重发校验输入：并发 send 只有一个 controller，跑完后的重发返回原回执不再开 turn", async () =>
	fixture(async (project) => {
		const { provider, gateway } = fauxGateway([
			fauxAssistantMessage("分析完成"),
			fauxAssistantMessage("第二句的回答"),
		]);
		let initializations = 0;
		const workspace = new LocalWorkspace(project, async () => {
			initializations++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return gateway;
		});
		const input = { commandId: "send", text: "确认现有设计" };
		const first = workspace.invoke("session.send", input);
		const duplicate = workspace.invoke("session.send", input);
		await assert.rejects(workspace.invoke("session.send", { ...input, text: "不同目标" }), {
			code: "command_conflict",
		});
		const sent = await first;
		assert.deepEqual(await duplicate, sent);
		assert.equal(initializations, 1);
		await untilIdle(workspace);
		assert.equal(provider.state.callCount, 1);
		assert.deepEqual(await workspace.invoke("session.inbox", { sessionId: sent.sessionId }), [
			{ sequence: 1, text: "确认现有设计", delivered: true },
		]);
		assert.deepEqual(await workspace.invoke("session.send", input), sent);
		await untilIdle(workspace);
		assert.equal(provider.state.callCount, 1, "重发只返回回执，不再调用模型");
		await assert.rejects(workspace.invoke("session.send", { ...input, text: "改了" }), { code: "command_conflict" });

		const second = await workspace.invoke("session.send", {
			commandId: "send-2",
			text: "再来一句",
			sessionId: sent.sessionId,
		});
		assert.deepEqual(second, { sessionId: sent.sessionId, sequence: 2 });
		await untilIdle(workspace);
		assert.equal(provider.state.callCount, 2);
		assert.deepEqual(
			(await workspace.invoke("session.inbox", { sessionId: sent.sessionId })).map((item) => item.delivered),
			[true, true],
		);
		assert.equal((await workspace.invoke("session.list", {})).sessions[0]?.turn, 2, "重发不开空 turn");
		await assert.rejects(workspace.invoke("session.inbox", { sessionId: "missing" }), { code: "session_not_found" });
		await assert.rejects(workspace.invoke("session.attach", { sessionId: "missing" }), { code: "session_not_found" });
	}));

test("目录投影透传 frontmatter 与卷顺序，正文时效与审稿从历史派生；坏编码不拖垮整份列表", async () =>
	fixture(async (project, root) => {
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("查询不应初始化模型");
		});
		const shown = await workspace.invoke("workspace.show", {});
		assert.deepEqual(shown.volumes, [{ id: "vol-0001", title: "赤壁之战", beatIds: ["beat-0001", "beat-0002"] }]);
		assert.equal(shown.storyIndexError, undefined);
		assert.equal(shown.openEnded, undefined, "没声明未完待续就不带这个字段");
		const indexPath = join(root, "outline/story/index.yaml");
		const indexText = await readFile(indexPath, "utf8");
		await writeFile(indexPath, indexText.replace("schema_version: 2\n", "schema_version: 2\nopen_ended: true\n"));
		assert.equal((await workspace.invoke("workspace.show", {})).openEnded, true, "index 的声明透传给界面");
		await writeFile(indexPath, indexText);
		assert.deepEqual(
			shown.storyText.map((item) => [item.storyBeatId, item.state]),
			[
				["beat-0001", "missing"],
				["beat-0002", "missing"],
			],
		);
		const beat = shown.files.find((file) => file.path === "outline/story/vol-0001/beat-0001.md");
		assert.ok(beat, "beat-0001 应在目录投影中");
		assert.deepEqual((beat.frontmatter.refs as { character: string[] }).character, ["黄盖"]);
		assert.ok((shown.files.find((file) => file.path === "outline/story/index.yaml")?.codePoints ?? 0) > 0);

		// 写好正文提交：时效 current 且记下写成的版本；再改第二节的设计提交，第二节的正文就 design-changed，
		// 第一节不引用第二节，它的正文仍是 current（2026-10-04 之前闭包取整卷，两篇一起变黄）。
		await mkdir(join(root, "text"), { recursive: true });
		await writeFile(join(root, "text/beat-0001.md"), "黄盖走入赤壁，在木匣中找到火船。\n");
		await writeFile(join(root, "text/beat-0002.md"), "约定那夜，二十艘火船一齐点火，直冲曹营。\n");
		await workspace.invoke("project.commit", {});
		const written = await workspace.invoke("workspace.show", {});
		assert.deepEqual(written.storyText, [
			{ storyBeatId: "beat-0001", state: "current", writtenAt: written.revisionId, changed: [] },
			{ storyBeatId: "beat-0002", state: "current", writtenAt: written.revisionId, changed: [] },
		]);
		await writeFile(
			join(root, "outline/story/vol-0001/beat-0002.md"),
			(await readFile(join(root, "outline/story/vol-0001/beat-0002.md"), "utf8")).replace("同时点火", "先后点火"),
		);
		await workspace.invoke("project.commit", {});
		const changed = await workspace.invoke("workspace.show", {});
		assert.deepEqual(
			changed.storyText.map((item) => [item.state, item.changed]),
			[
				["current", []],
				["design-changed", ["outline/story/vol-0001/beat-0002.md"]],
			],
		);

		// 审稿是 review/<id>.md：列出它审的版本与当前时效；被审 Beat 之后被移出 index.yaml 时仍列出，只是少一条路径。
		const reader = project.historyReader();
		const head = project.project().headRevisionId;
		const composed = composeReviewFile(await reader.snapshot(head), {
			layer: "design",
			scope: { kind: "book" },
			revision: head,
			draft: { verdict: "pass", summary: "设计成立", findings: [], uncovered: [], uncertainties: [] },
		});
		await mkdir(join(root, "review"), { recursive: true });
		await writeFile(join(root, composed.path), composed.content);
		await workspace.invoke("project.commit", {});
		const before = await workspace.invoke("workspace.reviews", {});
		const listed = before.find((item) => item.id === composed.id);
		assert.ok(listed);
		assert.equal(listed.revision, head);
		assert.equal(listed.current, true);
		assert.equal(listed.path, composed.path);
		assert.ok(listed.paths.includes("outline/story/vol-0001/beat-0002.md"));

		await writeFile(
			join(root, "outline/story/index.yaml"),
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001]\n",
		);
		await rm(join(root, "outline/story/vol-0001/beat-0002.md"));
		await rm(join(root, "text/beat-0002.md"));
		await writeFile(
			join(root, "outline/story/vol-0001/beat-0001.md"),
			"---\nrefs:\n  character: [黄盖]\n  place: [赤壁]\n  resource: [火船]\n---\n黄盖挨打诈降，火船烧尽。\n",
		);
		await rm(join(root, "outline/contracts/诈降.md"));
		await workspace.invoke("project.commit", {});
		const after = await workspace.invoke("workspace.reviews", {});
		const stale = after.find((item) => item.id === composed.id);
		assert.ok(stale, "被审 Beat 删除后审稿仍应列出");
		assert.equal(stale.paths.includes("outline/story/vol-0001/beat-0002.md"), false);
		assert.equal(stale.current, false);
		assert.ok(stale.changed.includes("outline/story/vol-0001/beat-0002.md"));

		// index.yaml 不是 UTF-8 时目录列表仍返回，只是标出原因。
		await writeFile(join(root, "outline/story/index.yaml"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
		const broken = await workspace.invoke("workspace.show", {});
		assert.deepEqual(broken.volumes, []);
		assert.match(broken.storyIndexError ?? "", /UTF-8/);
		assert.ok(broken.files.some((file) => file.path === "outline/story/vol-0001/beat-0001.md"));
	}));

test("send 前预检模型与凭据：缺凭据的 profile 在建 session 前按名字报出，不留下空 session", async () =>
	fixture(async (project) => {
		const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
		const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
		const { createBuiltinModelGateway } = await import("../src/model/model-gateway.js");
		const catalog = builtinModels();
		const deepseek = catalog.getProvider("deepseek")?.getModels()[0] ?? assert.fail("缺少 deepseek 模型");
		const codex = catalog.getProvider("openai-codex")?.getModels()[0] ?? assert.fail("缺少 codex 模型");
		const workspace = new LocalWorkspace(project, async () =>
			createBuiltinModelGateway(
				{
					profiles: {
						main: { provider: codex.provider, model: codex.id },
						reviewer: { provider: deepseek.provider, model: deepseek.id },
						writer: { provider: codex.provider, model: codex.id },
					},
				},
				{
					credentials: new InMemoryCredentialStore(),
					authContext: {
						env: async (name) => (name === "DEEPSEEK_API_KEY" ? "env-key" : undefined),
						fileExists: async () => false,
					},
				},
			),
		);
		await assert.rejects(
			workspace.invoke("session.send", { commandId: "preflight", text: "写第一场" }),
			(error: unknown) => {
				assert.equal((error as { code?: string }).code, "model_credentials_missing");
				assert.match((error as Error).message, /openai-codex/);

				return true;
			},
		);
		assert.equal(project.loadExecutionState().sessions.length, 0);
		assert.equal(workspace.activeSessionIds().length, 0);
	}));

test("目录投影的未提交标记逐文件准确：改一个文件只标它；删掉已提交的文件，作品算有改动", async () =>
	fixture(async (project, root) => {
		// 已提交版本的对照改用按版本缓存的 git blob id（不再每 100ms 把整份版本从 git 读出来），口径要对得上。
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("查询不应初始化模型");
		});
		const clean = await workspace.invoke("workspace.show", {});
		assert.equal(clean.dirty, false);
		assert.deepEqual(
			clean.files.filter((file) => file.dirty),
			[],
		);

		const placePath = join(root, "world/places/赤壁.md");
		await writeFile(placePath, `${await readFile(placePath, "utf8")}改过一句。\n`);
		const edited = await workspace.invoke("workspace.show", {});
		assert.equal(edited.dirty, true);
		assert.deepEqual(
			edited.files.filter((file) => file.dirty).map((file) => file.path),
			["world/places/赤壁.md"],
		);

		await workspace.invoke("project.commit", {});
		await rm(join(root, "world/places/赤壁.md"));
		const deleted = await workspace.invoke("workspace.show", {});
		assert.equal(deleted.dirty, true, "删掉已提交的文件也是未提交的修改");
		assert.deepEqual(
			deleted.files.filter((file) => file.dirty),
			[],
		);
	}));

test("目录投影按文件状态复用解析结果：同长度改写、mtime 拨回原值也看得到", async () =>
	fixture(async (project, root) => {
		// show 每 100ms 刷一次，2026-10-02 起按文件状态复用字节与解析结果；状态里少一项就会把改动吞掉。
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("查询不应初始化模型");
		});
		const placePath = join(root, "world/places/赤壁.md");
		const old = new Date(Date.now() - 60_000);
		const titled = (title: string) => `---\ntitle: ${title}\n---\n长江南岸，孙刘联军扎营之处。\n`;
		await writeFile(placePath, titled("皇家档案"));
		await utimes(placePath, old, old);
		const place = async () =>
			(await workspace.invoke("workspace.show", {})).files.find((file) => file.path === "world/places/赤壁.md");
		assert.equal((await place())?.title, "皇家档案");
		assert.equal((await place())?.title, "皇家档案");

		await writeFile(placePath, titled("皇家库房"));
		await utimes(placePath, old, old);
		assert.equal((await place())?.title, "皇家库房");
		assert.equal((await place())?.dirty, true);
	}));

test("目录投影带正文的第一个一级标题：没有 title / name 的文件靠它显示中文名", async () =>
	fixture(async (project, root) => {
		// 2026-10-01 斗破运行：Contract 的中文名只写在正文 # 标题里，邻域图显示成 contract-yunlan-yingyue。
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("查询不应初始化模型");
		});
		await writeFile(join(root, "world/overview.md"), "# 世界总纲\n\n汉末天下的规则。\n");
		const contractPath = join(root, "outline/contracts/诈降.md");
		await writeFile(
			contractPath,
			(await readFile(contractPath, "utf8")).replace(
				"---\n黄盖的投降是假的",
				"---\n# 一把火的约定\n\n黄盖的投降是假的",
			),
		);
		const shown = await workspace.invoke("workspace.show", {});
		const byPath = (path: string) => shown.files.find((file) => file.path === path);
		assert.equal(byPath("world/overview.md")?.heading, "世界总纲");
		assert.equal(byPath("outline/contracts/诈降.md")?.heading, "一把火的约定");
		assert.equal(byPath("world/places/赤壁.md")?.heading, undefined, "没有一级标题就不带这个字段");
	}));

test("文件目录独立于作品投影，辅助文件保存不进入作品 diff，非法文件仍可修复", async () =>
	fixture(async (project, root) => {
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("不能调用模型");
		});
		await writeFile(join(root, "AGENTS.md"), "作者笔记\n");
		const original = await workspace.invoke("workspace.file.read", { path: "AGENTS.md" });
		assert.equal(original.classification, "auxiliary");
		await workspace.invoke("workspace.file.save", {
			path: original.path,
			expectedSHA: original.sha256,
			content: "新的作者笔记\n",
		});
		assert.deepEqual(await workspace.invoke("project.diff", {}), []);
		assert.equal((await workspace.invoke("project.commit", {})).created, false);
		await assert.rejects(
			workspace.invoke("workspace.file.save", {
				path: original.path,
				expectedSHA: original.sha256,
				content: "旧草稿",
			}),
			{ code: "checkout_edit_conflict" },
		);
		await mkdir(join(root, "text"), { recursive: true });
		await writeFile(join(root, "text/unrecognized.txt"), "需要修复的保留路径\n");
		// 主视图照常读得出来：一个放错的文件不能让整部作品打不开（2026-10-01 斗破那一轮就是这样连 session 都读不出）。
		// 它不当作品文件出现在主视图里；文件树把它标成 invalid 供修复，提交由 Checker 点名拒绝。
		const shown = await workspace.invoke("workspace.show", {});
		assert.ok(!shown.files.some((file) => file.path === "text/unrecognized.txt"));
		const listing = await workspace.invoke("workspace.files", {});
		assert.equal(listing.entries.find((entry) => entry.path === "text/unrecognized.txt")?.classification, "invalid");
		assert.ok(listing.entries.find((entry) => entry.path === "AGENTS.md"));
		assert.ok(!listing.entries.some((entry) => entry.path.startsWith(".suiming")));
		const invalid = await workspace.invoke("workspace.file.read", { path: "text/unrecognized.txt" });
		assert.ok(invalid.diagnostic);
		await workspace.invoke("workspace.file.save", {
			path: invalid.path,
			expectedSHA: invalid.sha256,
			content: "修复中的内容",
		});
		await assert.rejects(workspace.invoke("project.commit", {}), { code: "unsupported_story_package_path" });
	}));

test("文件入口拒绝越界、符号链接与二进制写入", async () =>
	fixture(async (project, root) => {
		const { symlink } = await import("node:fs/promises");
		const workspace = new LocalWorkspace(project, async () => {
			throw new Error("不能调用模型");
		});
		for (const path of ["../secret", "/etc/hosts", ".suiming/project.json", ".git/config"])
			await assert.rejects(workspace.invoke("workspace.file.read", { path }));
		await symlink(tmpdir(), join(root, "outside"));
		await assert.rejects(workspace.invoke("workspace.file.read", { path: "outside/secret" }));
		await assert.rejects(workspace.invoke("workspace.file.open", { path: "outside", action: "reveal" }));
		await writeFile(join(root, "binary.md"), Buffer.from([0, 255, 1]));
		const binary = await workspace.invoke("workspace.file.read", { path: "binary.md" });
		assert.equal(binary.textual, false);
		assert.equal(binary.content, "");
		await assert.rejects(
			workspace.invoke("workspace.file.save", {
				path: binary.path,
				expectedSHA: binary.sha256,
				content: "不能损坏二进制",
			}),
			{ code: "file_write_forbidden" },
		);
	}));

test("运行中停用提供商拒绝新的 send，保留当前回复与凭据，重新启用后恢复选择", async () =>
	fixture(async (project) => {
		const configRoot = await mkdtemp(join(tmpdir(), "suiming-provider-toggle-"));
		const configPath = join(configRoot, "config.toml");
		const credentials = new JsonFileCredentialStore({ path: join(configRoot, "auth.json") });
		const provider = fauxProvider({ provider: "toggle-test" });
		const models = createModels({ credentials });
		models.setProvider(provider.provider);
		const settings = new LocalModelSettings({ configPath, credentials, models });
		await settings.save({ profile: "main", provider: provider.provider.id, model: provider.getModel().id });
		const workspace = new LocalWorkspace(
			project,
			async () => new ModelGateway(models, (await loadModelRoutingConfig({ configPath, environment: {} })).config),
			settings,
		);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		provider.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("原回复完成");
			},
			fauxAssistantMessage("重新启用后完成"),
		]);
		const waitIdle = async (id: string) => {
			for (let n = 0; n < 500; n++) {
				const listed = (await workspace.invoke("session.list", {})).sessions.find((session) => session.id === id);
				if (listed?.status === "idle" && !workspace.activeSessionIds().includes(id)) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.fail("turn 未结束");
		};
		try {
			const first = await workspace.invoke("session.send", { commandId: "toggle-first", text: "只讨论，不修改" });
			await started.promise;
			await workspace.invoke("models.provider.setEnabled", { provider: provider.provider.id, enabled: false });
			await assert.rejects(workspace.invoke("session.send", { commandId: "toggle-blocked", text: "不应启动" }), {
				code: "model_provider_disabled",
			});
			assert.equal((await workspace.invoke("session.list", {})).sessions.length, 1);
			release.resolve();
			await waitIdle(first.sessionId);
			await workspace.invoke("models.provider.setEnabled", { provider: provider.provider.id, enabled: true });
			const second = await workspace.invoke("session.send", { commandId: "toggle-second", text: "继续讨论" });
			await waitIdle(second.sessionId);
			assert.equal(provider.state.callCount, 2);
		} finally {
			release.resolve();
			await workspace.shutdown();
			await rm(configRoot, { recursive: true, force: true });
		}
	}));
