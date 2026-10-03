import assert from "node:assert/strict";
import test from "node:test";
import type { CanonStore } from "../src/artifact/canon-store.js";
import { ArtifactError } from "../src/artifact/errors.js";
import { targetArtifactIdentity } from "../src/artifact/identity.js";
import { validateStoryProjectCandidate } from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CanonStoreFixture {
	store: CanonStore;
	projectId: string;
	/** 关闭并清理这次 fixture 用的一切；实现各自决定怎么收。 */
	close(): Promise<void> | void;
}

/**
 * Canon 存储的契约。断言写的是领域语义，不涉及任何存储细节：每条要么来自不变量（3：只有已提交版本
 * 是权威；10：重连不重执行，所以提交必须按 commandId 幂等），要么来自已经踩过的坑。
 *
 * 当前只有 git 一个实现（[ADR-0010]）。契约仍与实现分开放，因为它在迁移中真的起过作用——先让旧的
 * SQLite 实现跑通，才证明这套断言描述的是语义而不是某个实现的行为；Cloud 将来接自己的实现也跑这一套。
 */
export function describeCanonStore(name: string, create: () => Promise<CanonStoreFixture>): void {
	const withStore = async (body: (fixture: CanonStoreFixture) => Promise<void>) => {
		const fixture = await create();
		try {
			await body(fixture);
		} finally {
			await fixture.close();
		}
	};

	test(`${name}：head 从创世版本开始，history 自创世起按时序`, () =>
		withStore(async ({ store, projectId }) => {
			const head = await store.headRevisionId(projectId);
			assert.equal((await store.project(projectId)).headRevisionId, head);
			const history = await store.history(projectId);
			assert.ok(history.length >= 1, "至少有创世版本");
			assert.equal(history.at(-1)?.id, head, "history 末尾就是 head");
			assert.equal(history[0]?.parentId, null, "创世版本没有父");
			assert.equal((await store.readProjectRevision(projectId, head)).id, head);
		}));

	test(`${name}：提交推进 head，父指向提交前的 head`, () =>
		withStore(async ({ store, projectId }) => {
			const before = await store.headRevisionId(projectId);
			const candidate = await store.snapshotForProject(projectId, before);
			const intent = candidate.artifacts.find((artifact) => artifact.identity.kind === "intent");
			assert.ok(intent, "样例作品应有 intent");
			const changeSet = {
				baseRevisionId: before,
				operations: [
					{
						operation: "replace" as const,
						identity: targetArtifactIdentity("intent", intent.identity.localId),
						path: intent.path,
						mediaType: intent.mediaType,
						bytes: encoder.encode(`${decoder.decode(intent.bytes).trimEnd()}\n契约测试追加的一行。\n`),
					},
				],
			};
			const committed = await store.commit(projectId, changeSet, validateStoryProjectCandidate);
			assert.equal(committed.parentId, before);
			assert.notEqual(committed.id, before);
			assert.equal(await store.headRevisionId(projectId), committed.id);

			// 已提交版本是权威：读回来的内容必须与提交的一致（不变量 3）。
			const after = await store.snapshotForProject(projectId, committed.id);
			const readBack = after.artifacts.find((artifact) => artifact.identity.localId === intent.identity.localId);
			assert.ok(readBack);
			assert.match(decoder.decode(readBack.bytes), /契约测试追加的一行。/u);

			// 旧版本不因新提交而改变。
			const old = await store.snapshotForProject(projectId, before);
			const oldIntent = old.artifacts.find((artifact) => artifact.identity.localId === intent.identity.localId);
			assert.ok(oldIntent);
			assert.doesNotMatch(decoder.decode(oldIntent.bytes), /契约测试追加的一行。/u);
		}));

	test(`${name}：同一 commandId 重放返回同一版本，不重复推进`, () =>
		withStore(async ({ store, projectId }) => {
			const before = await store.headRevisionId(projectId);
			const candidate = await store.snapshotForProject(projectId, before);
			const intent = candidate.artifacts.find((artifact) => artifact.identity.kind === "intent");
			assert.ok(intent);
			const changeSet = {
				baseRevisionId: before,
				operations: [
					{
						operation: "replace" as const,
						identity: targetArtifactIdentity("intent", intent.identity.localId),
						path: intent.path,
						mediaType: intent.mediaType,
						bytes: encoder.encode(`${decoder.decode(intent.bytes).trimEnd()}\n幂等检查。\n`),
					},
				],
			};
			const command = { commandId: "contract-commit-1" };
			const first = await store.commit(projectId, changeSet, validateStoryProjectCandidate, command);
			const second = await store.commit(projectId, changeSet, validateStoryProjectCandidate, command);
			assert.equal(second.id, first.id, "重放必须返回同一个版本");
			assert.equal(await store.headRevisionId(projectId), first.id, "重放不得再推进 head");
			assert.equal(
				(await store.history(projectId)).filter((revision) => revision.id === first.id).length,
				1,
				"history 里不得出现两条",
			);

			// 进程退出时提交已落盘但回执没发出：靠 commandId 核对得回来。
			assert.equal((await store.readCommitReceipt(projectId, command.commandId))?.id, first.id);
			assert.equal(await store.readCommitReceipt(projectId, "从未发生的命令"), undefined);
		}));

	test(`${name}：基线陈旧的 ChangeSet 不得覆盖别人的提交`, () =>
		withStore(async ({ store, projectId }) => {
			const before = await store.headRevisionId(projectId);
			const candidate = await store.snapshotForProject(projectId, before);
			const intent = candidate.artifacts.find((artifact) => artifact.identity.kind === "intent");
			assert.ok(intent);
			const changeSet = (suffix: string) => ({
				baseRevisionId: before,
				operations: [
					{
						operation: "replace" as const,
						identity: targetArtifactIdentity("intent", intent.identity.localId),
						path: intent.path,
						mediaType: intent.mediaType,
						bytes: encoder.encode(`${decoder.decode(intent.bytes).trimEnd()}\n${suffix}\n`),
					},
				],
			});
			const committed = await store.commit(projectId, changeSet("先到的提交。"), validateStoryProjectCandidate);
			// 第二份候选还拿着 before 作基线：直接落下去就会把上一次提交静默盖掉。
			await assert.rejects(
				async () => store.commit(projectId, changeSet("后到的旧候选。"), validateStoryProjectCandidate),
				(error: unknown) => error instanceof ArtifactError && error.code === "change_set_stale",
			);
			assert.equal(await store.headRevisionId(projectId), committed.id);
		}));

	test(`${name}：校验失败不产生版本`, () =>
		withStore(async ({ store, projectId }) => {
			const before = await store.headRevisionId(projectId);
			const changeSet = {
				baseRevisionId: before,
				operations: [
					{
						operation: "create" as const,
						identity: targetArtifactIdentity("intent", "契约测试非法意图"),
						path: "intent/契约测试非法意图.md",
						mediaType: "text/markdown",
						bytes: encoder.encode("这份内容会被校验拒绝。\n"),
					},
				],
			};
			await assert.rejects(
				async () =>
					store.commit(projectId, changeSet, () => {
						throw new Error("校验拒绝");
					}),
				/校验拒绝/u,
			);
			assert.equal(await store.headRevisionId(projectId), before, "校验失败不得推进 head");
		}));

	test(`${name}：fileDigests 给每个版本下每个作品文件一个可比较的摘要，只有改过的文件摘要才变`, () =>
		withStore(async ({ store, projectId }) => {
			const before = await store.headRevisionId(projectId);
			const candidate = await store.snapshotForProject(projectId, before);
			const intent = candidate.artifacts.find((artifact) => artifact.identity.kind === "intent");
			assert.ok(intent);
			const committed = await store.commit(
				projectId,
				{
					baseRevisionId: before,
					operations: [
						{
							operation: "replace" as const,
							identity: targetArtifactIdentity("intent", intent.identity.localId),
							path: intent.path,
							mediaType: intent.mediaType,
							bytes: encoder.encode(`${decoder.decode(intent.bytes).trimEnd()}\n改过一次。\n`),
						},
					],
				},
				validateStoryProjectCandidate,
			);
			const [previous, current] = await Promise.all([
				store.fileDigests(projectId, before),
				store.fileDigests(projectId, committed.id),
			]);
			assert.deepEqual([...previous.keys()].sort(), [...current.keys()].sort(), "路径集合不变");
			assert.equal(previous.size, candidate.artifacts.length, "每个作品文件一条摘要");
			const changed = [...current.keys()].filter((path) => previous.get(path) !== current.get(path));
			assert.deepEqual(changed, ["intent/揭开真相.md"]);
			assert.deepEqual(await store.fileDigests(projectId, committed.id), current, "同一版本摘要稳定");
		}));
}
