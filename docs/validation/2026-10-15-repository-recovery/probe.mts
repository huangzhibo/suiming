/** 冷备份恢复验收：只复制已 idle 的隔离作品；不调用模型，不把副本或执行数据写进仓库。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { LocalProjectService, readProjectStatus, LocalWorkspace } from "@suiming/runtime";
import { CheckpointArchive } from "../../../packages/runtime/dist/harness/checkpoint-archive.js";

const source = process.env.SUIMING_VALIDATION_SOURCE;
const root = process.env.SUIMING_VALIDATION_ROOT;
assert.ok(source && root, "指定已停止写入的隔离作品与不存在的仓库外目标目录");
for (const parent of [source, process.cwd()]) {
	const rel = relative(resolve(parent), resolve(root));
	assert.ok(rel.startsWith(`..`) || isAbsolute(rel), "目标不能在作品或代码仓库内");
}
await mkdir(root);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const cli = (dir: string, ...args: string[]) =>
	JSON.parse(
		execFileSync(process.execPath, [resolve("apps/cli/dist/bin.js"), "--project", dir, "--json", ...args], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		}),
	);
async function files(dir: string, prefix = ""): Promise<[string, string][]> {
	const out: [string, string][] = [];
	for (const entry of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = join(prefix, entry.name);
		assert.ok(!entry.isSymbolicLink(), `本验收只接收自含目录，不解引用外部链接：${path}`);
		if (entry.isDirectory()) out.push(...(await files(dir, path)));
		else out.push([path, digest(await readFile(join(dir, path)))]);
	}
	return out;
}
async function inspect(dir: string) {
	const p = await LocalProjectService.open(dir);
	try {
		const entities = p.loadExecutionEntities();
		assert.ok(
			entities.sessions.every((s) => s.status === "idle"),
			"有运行中的对话，不能把目录复制当作热备份",
		);
		const history = await p.history();
		const snapshots = await Promise.all(
			history.map(async (r) => ({
				id: r.id,
				files: (await p.exportRevision(r.id)).map((f) => [f.path, digest(f.bytes)]),
			})),
		);
		const checkpoints = [];
		for (const e of [...entities.sessions, ...entities.tasks]) {
			if (!e.checkpointRef) continue;
			const decoded = await new CheckpointArchive(p).read((await p.readExecutionObject(e.checkpointRef.id)).bytes);
			checkpoints.push({ id: e.id, hash: digest(JSON.stringify(decoded)) });
			if ("result" in e && e.result) await p.readExecutionObject(e.result.id);
		}
		const w = new LocalWorkspace(p, async () => {
			throw new Error("恢复检查不能启动模型");
		});
		const events = [];
		for (const s of entities.sessions) {
			const rows = p.readSessionEvents(s.id);
			const attached = await w.invoke("session.attach", { sessionId: s.id });
			events.push({
				id: s.id,
				count: rows.length,
				hash: digest(JSON.stringify(rows)),
				attached: digest(JSON.stringify(attached)),
			});
		}
		return {
			projectId: p.projectId,
			history,
			snapshots,
			entities,
			checkpoints,
			events,
			candidate: (await p.checkoutCandidate()).artifacts.map((a) => [a.path, digest(a.bytes)]),
			status: await readProjectStatus(p, await p.checkoutCandidate()),
		};
	} finally {
		p.close();
	}
}
const before = await inspect(source);
const backup = join(root, "backup");
await cp(source, backup, { recursive: true, errorOnExist: true, force: false });
const originalFiles = await files(source);
assert.deepEqual(await files(backup), originalFiles, "完整备份每份文件的字节一致");
const staging = join(root, "staging");
await cp(backup, staging, { recursive: true, errorOnExist: true, force: false });
const restored = join(root, "restored");
await rename(staging, restored);
assert.deepEqual(await files(restored), originalFiles);
const after = await inspect(restored);
assert.deepEqual(after, before, "换目录后 Canon、作品、执行实体、事件、checkpoint 与 attach 全部保持");
const historyCli = cli(restored, "history");
assert.equal(historyCli.ok, true);
assert.equal(historyCli.data.revisions.length, before.history.length);

// 默认 clone 不传自定义 ref。显式取回后再打开；不根据 HEAD 猜 Canon。
const cloned = join(root, "ordinary-clone");
git(root, "clone", "--no-local", backup, cloned);
assert.equal(git(cloned, "for-each-ref", "--format=%(refname)", "refs/suiming/canon"), "");
git(cloned, "fetch", "origin", "refs/suiming/canon:refs/suiming/canon");
git(cloned, "restore", "--source=refs/suiming/canon", "--worktree", "--", ".");
(await LocalProjectService.init({ checkoutPath: cloned })).close();
const cloneState = await inspect(cloned);
assert.deepEqual(cloneState.history, before.history);
assert.deepEqual(cloneState.snapshots, before.snapshots);
assert.equal(cloneState.entities.sessions.length, 0, "只取 git 不携带对话");

const bundle = join(root, "canon.bundle");
git(backup, "bundle", "create", bundle, "refs/suiming/canon");
git(backup, "bundle", "verify", bundle);
const bundled = join(root, "from-bundle");
await mkdir(bundled);
git(bundled, "init", "--quiet");
git(bundled, "fetch", bundle, "refs/suiming/canon:refs/suiming/canon");
git(bundled, "restore", "--source=refs/suiming/canon", "--worktree", "--", ".");
(await LocalProjectService.init({ checkoutPath: bundled })).close();
const bundledState = await inspect(bundled);
assert.deepEqual(bundledState.history, before.history);
assert.deepEqual(bundledState.snapshots, before.snapshots);
assert.equal(bundledState.entities.sessions.length, 0);

const snapshot = join(root, "snapshot-only");
assert.equal(cli(restored, "export", snapshot).ok, true);
(await LocalProjectService.init({ checkoutPath: snapshot })).close();
const snapshotState = await inspect(snapshot);
assert.equal(snapshotState.history.length, 1, "快照重新建仓只有一个版本");
assert.equal(snapshotState.entities.sessions.length, 0);
assert.deepEqual(snapshotState.snapshots[0]?.files, before.snapshots.at(-1)?.files);
assert.deepEqual(await files(backup), originalFiles, "恢复和继续检查不改备份");
const summary = {
	revisions: before.history.length,
	files: originalFiles.length,
	sessions: before.entities.sessions.length,
	tasks: before.entities.tasks.length,
	calls: before.entities.sessions.reduce((n, s) => n + s.usage.calls, 0),
	events: before.events.reduce((n, s) => n + s.count, 0),
	checkpoints: before.checkpoints.length,
	fullRestore: true,
	explicitClone: true,
	bundle: true,
	snapshotIsNotBackup: true,
};
await writeFile(join(root, "result.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
