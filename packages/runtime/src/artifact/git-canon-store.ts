import fs, { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Buffer, sha256Hex } from "@suiming/story";
import git from "isomorphic-git";
import type { CanonStore } from "./canon-store.js";
import { applyChangeOperations } from "./change-operations.js";
import { ArtifactError } from "./errors.js";
import { artifactIdentityKey } from "./identity.js";
import type { OpenPackageFile } from "./open-package.js";
import { classifyOpenStoryDirectoryFile, mediaTypeForPath } from "./open-story-directory.js";
import { storyPackageCodec } from "./story-package-codec.js";
import type {
	ArtifactCandidate,
	ArtifactCandidateValidator,
	CandidateArtifact,
	ChangeSet,
	ProjectRevision,
} from "./types.js";

/**
 * Canon 指向的 ref。作品目录是普通 git 仓库，谁都可以 `git commit`——那是候选；只有经 Checker 的
 * promote 会移动这条 ref，所以「只有已提交的版本化 Story Artifact 是作品权威」（不变量 3）仍然
 * 是结构性的，不是靠约定。作者当然能 `git update-ref` 手动搬，那与今天直接改 `.suiming` 里的
 * SQLite 同级。
 */
export const CANON_REF = "refs/suiming/canon";

/** 提交回执写进 commit message 的 trailer：作品目录自带幂等证据，不依赖另一个数据库。 */
const COMMAND_TRAILER = "Suiming-Command-Id";
const FINGERPRINT_TRAILER = "Suiming-Fingerprint";

/** 回执只在最近这些提交里找。进程崩溃后要核对的是刚发生的那一次，不是全部历史。 */
const RECEIPT_SCAN_DEPTH = 64;

const author = { name: "Suiming", email: "suiming@localhost" };

interface CommitReceipt {
	commandId: string;
	fingerprint: string;
}

function trailers(message: string): CommitReceipt | undefined {
	const commandId = /^Suiming-Command-Id:\s*(.+)$/mu.exec(message)?.[1]?.trim();
	const fingerprint = /^Suiming-Fingerprint:\s*(.+)$/mu.exec(message)?.[1]?.trim();
	return commandId === undefined || fingerprint === undefined ? undefined : { commandId, fingerprint };
}

/**
 * 提交指纹：同一 commandId 重放时用它确认「是同一次提交」而不是「同一个命令 id 被复用」。
 * 只取内容，不取时间——否则重放永远对不上。
 */
function commitFingerprint(changeSet: ChangeSet): string {
	const parts = [
		changeSet.baseRevisionId,
		...changeSet.operations.map((operation) =>
			operation.operation === "delete"
				? `delete\u0000${artifactIdentityKey(operation.identity)}`
				: `${operation.operation}\u0000${artifactIdentityKey(operation.identity)}\u0000${sha256Buffer(operation.bytes)}`,
		),
	];
	return `sha256:${sha256Hex(parts.join("\u0001"))}`;
}

export interface GitCanonStoreOptions {
	/** 作品目录，即 git 工作树的根。 */
	dir: string;
	now?: () => Date;
}

/**
 * git 支持的 Canon 存储（[ADR-0010](../../../../docs/adr/0010-git-as-canon-storage-engine.md)）。
 *
 * 实现 `CanonStore` 契约。revision id 就是 commit sha；快照就是 tree；history 就是 canon ref 的祖先链。
 */
export class GitCanonStore implements CanonStore {
	readonly #dir: string;
	readonly #now: () => Date;

	constructor(options: GitCanonStoreOptions) {
		this.#dir = options.dir;
		this.#now = options.now ?? (() => new Date());
	}

	/** 建仓并把当前工作树的作品文件提交为创世版本。已经是 Canon 仓库时原样返回。 */
	async init(files: readonly OpenPackageFile[]): Promise<ProjectRevision> {
		await git.init({ fs, dir: this.#dir, defaultBranch: "canon" });
		await this.#writeMergePolicy();
		const existing = await this.#resolveCanon();
		if (existing !== undefined) return this.#revision(existing);
		const oid = await this.#writeCommit(undefined, files, "创世版本", undefined);
		return this.#revision(oid);
	}

	/**
	 * 合并策略（收敛方案 3.5）：作者在自己的仓里 `git merge` 两条线时，git 默认会把同一文件不同位置的
	 * 改动内容级合并。对结构化文件没问题——顺序坏了 Checker 会报；对正文是风险：合出来的那一版谁都
	 * 没写过，而 Checker 验不了散文的连贯。`merge=binary` 让 `text/**` 两侧都改时如实冲突。
	 *
	 * 它是仓库辅助文件，不进 artifact snapshot（scan 把顶层非保留项归为 repository-auxiliary）。
	 * 已经存在就不动——作者自己调过的策略不该被覆盖。
	 */
	async #writeMergePolicy(): Promise<void> {
		const path = join(this.#dir, ".gitattributes");
		if (existsSync(path)) return;
		await writeFile(
			path,
			[
				"# 正文两侧都改时必须冲突：自动合并会产出谁都没写过的版本，Checker 也验不出来。",
				"text/** merge=binary",
				"# 结构化文件走 git 默认的内容级合并：合坏了 Checker 会在 promote 时报出来。",
				"",
			].join("\n"),
			{ flag: "wx" },
		);
	}

	async project(projectId: string): Promise<{ id: string; headRevisionId: string }> {
		return { id: projectId, headRevisionId: await this.headRevisionId(projectId) };
	}

	async headRevisionId(_projectId: string): Promise<string> {
		const oid = await this.#resolveCanon();
		if (oid === undefined) throw new ArtifactError("project_not_found", `${this.#dir} 还不是 Canon 仓库`);
		return oid;
	}

	async history(projectId: string): Promise<ProjectRevision[]> {
		const oids = await this.#ancestors(projectId);
		const revisions: ProjectRevision[] = [];
		for (const oid of oids) revisions.push(await this.#revision(oid));
		return revisions;
	}

	async readProjectRevision(_projectId: string, revisionId: string): Promise<ProjectRevision> {
		return this.#revision(revisionId);
	}

	async snapshotForProject(_projectId: string, revisionId: string): Promise<ArtifactCandidate> {
		return this.snapshot(revisionId);
	}

	/** 路径 → blob oid。走一遍 tree 不读内容，几百个 commit 的历史也就毫秒级；派生状态只比较摘要。 */
	async fileDigests(_projectId: string, revisionId: string): Promise<ReadonlyMap<string, string>> {
		const digests = new Map<string, string>();
		await git.walk({
			fs,
			dir: this.#dir,
			trees: [git.TREE({ ref: revisionId })],
			map: async (path, [entry]) => {
				if (path === "." || entry === null || entry === undefined) return;
				if ((await entry.type()) !== "blob") return;
				try {
					if (classifyOpenStoryDirectoryFile(path) !== "story") return;
				} catch {
					return;
				}
				digests.set(path, await entry.oid());
			},
		});
		return digests;
	}

	/**
	 * 某个版本里的一个 Story 文件；版本里没有它时 undefined。只读这一个 blob，不展开整棵 tree——桌面打开
	 * 审稿页、比较历史稿时原来要导出整个版本再从里面找一个文件。
	 */
	async readFile(revisionId: string, path: string): Promise<Uint8Array | undefined> {
		if (classifyOpenStoryDirectoryFile(path) !== "story") return undefined;
		try {
			const { blob } = await git.readBlob({ fs, dir: this.#dir, oid: revisionId, filepath: path });
			return blob;
		} catch (error) {
			if ((error as { code?: string }).code !== "NotFoundError") throw error;
			// 版本本身不存在与版本里没有这个文件要分开：前者是调用方给错了 id。
			try {
				await this.#revision(revisionId);
			} catch {
				throw new ArtifactError("revision_not_found", `找不到版本 ${revisionId}`);
			}
			return undefined;
		}
	}

	async readCommitReceipt(projectId: string, commandId: string): Promise<ProjectRevision | undefined> {
		return this.receipt(projectId, commandId);
	}

	/** 某个版本的全部 Story artifact。仓库辅助文件不在内。 */
	async snapshot(revisionId: string): Promise<ArtifactCandidate> {
		const files = await this.#readTree(revisionId);
		const artifacts: CandidateArtifact[] = files.map((file) => ({
			identity: storyPackageCodec.identityForPath(file.path),
			path: file.path,
			mediaType: file.mediaType,
			bytes: file.bytes,
		}));
		return { baseRevisionId: revisionId, artifacts };
	}

	/**
	 * 推进 Canon（promote）：校验后写 tree、写 commit、移 canon ref。候选 commit 可以早就在仓库里，这一步不看
	 * 它们，只认传进来的 ChangeSet——Canon 的内容由 Runtime 决定，不由作者的 git 历史决定。
	 */
	async commit(
		projectId: string,
		changeSet: ChangeSet,
		validate: ArtifactCandidateValidator,
		command?: { commandId: string },
	): Promise<ProjectRevision> {
		const fingerprint = commitFingerprint(changeSet);
		if (command !== undefined) {
			const previous = await this.receipt(projectId, command.commandId, fingerprint);
			if (previous !== undefined) return previous;
		}
		const head = await this.headRevisionId(projectId);
		if (changeSet.baseRevisionId !== head) {
			throw new ArtifactError(
				"change_set_stale",
				`ChangeSet 基线 ${changeSet.baseRevisionId} 不是当前 Canon ${head}`,
			);
		}
		const base = await this.snapshot(head);
		const artifacts = applyChangeOperations(base.artifacts, changeSet.operations);
		const candidate: ArtifactCandidate = { baseRevisionId: head, artifacts };
		validate(candidate);

		const story: OpenPackageFile[] = artifacts.map((artifact) => ({
			path: artifact.path,
			mediaType: artifact.mediaType,
			bytes: artifact.bytes,
		}));
		const message =
			command === undefined
				? "提交"
				: `提交\n\n${COMMAND_TRAILER}: ${command.commandId}\n${FINGERPRINT_TRAILER}: ${fingerprint}`;
		const oid = await this.#writeCommit(head, story, message, undefined);
		return this.#revision(oid);
	}

	/** 崩溃后核对：提交可能已落盘但回执没发出。只扫最近的提交。 */
	async receipt(projectId: string, commandId: string, fingerprint?: string): Promise<ProjectRevision | undefined> {
		for (const oid of (await this.#ancestors(projectId)).slice(-RECEIPT_SCAN_DEPTH).reverse()) {
			const { commit } = await git.readCommit({ fs, dir: this.#dir, oid });
			const found = trailers(commit.message);
			if (found?.commandId !== commandId) continue;
			if (fingerprint !== undefined && found.fingerprint !== fingerprint) return undefined;
			return this.#revision(oid);
		}
		return undefined;
	}

	// --- 内部 ---

	async #resolveCanon(): Promise<string | undefined> {
		try {
			const oid = await git.resolveRef({ fs, dir: this.#dir, ref: CANON_REF });
			return oid;
		} catch {
			return undefined;
		}
	}

	async #ancestors(projectId: string): Promise<string[]> {
		const head = await this.headRevisionId(projectId);
		const log = await git.log({ fs, dir: this.#dir, ref: head });
		return log.map((entry) => entry.oid).reverse();
	}

	/** 只读 commit 头。版本内容就是它的 tree，要内容用 `snapshot()`，不要在这里预先展开。 */
	async #revision(oid: string): Promise<ProjectRevision> {
		const { commit } = await git.readCommit({ fs, dir: this.#dir, oid });
		return { id: oid, parentId: commit.parent[0] ?? null };
	}

	async #readTree(oid: string): Promise<OpenPackageFile[]> {
		const files: OpenPackageFile[] = [];
		await git.walk({
			fs,
			dir: this.#dir,
			trees: [git.TREE({ ref: oid })],
			map: async (path, [entry]) => {
				if (path === "." || entry === null || entry === undefined) return;
				if ((await entry.type()) !== "blob") return;
				try {
					if (classifyOpenStoryDirectoryFile(path) !== "story") return;
				} catch {
					return; // 仓库辅助文件不进 artifact snapshot
				}
				const bytes = await entry.content();
				if (bytes === undefined) return;
				files.push({ path, mediaType: mediaTypeForPath(path), bytes: new Uint8Array(bytes) });
			},
		});
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		return files;
	}

	async #writeCommit(
		parent: string | undefined,
		files: readonly OpenPackageFile[],
		message: string,
		_unused: undefined,
	): Promise<string> {
		// 先把内容写成 blob 与 tree，再写 commit，最后移 ref：任何一步失败都不会留下一个
		// 指向半个版本的 Canon。
		const tree = await this.#writeTree(files);
		const timestamp = Math.floor(this.#now().getTime() / 1000);
		const oid = await git.writeCommit({
			fs,
			dir: this.#dir,
			commit: {
				message: message.endsWith("\n") ? message : `${message}\n`,
				tree,
				parent: parent === undefined ? [] : [parent],
				author: { ...author, timestamp, timezoneOffset: 0 },
				committer: { ...author, timestamp, timezoneOffset: 0 },
			},
		});
		await git.writeRef({ fs, dir: this.#dir, ref: CANON_REF, value: oid, force: true });
		return oid;
	}

	async #writeTree(files: readonly OpenPackageFile[]): Promise<string> {
		interface Node {
			children: Map<string, Node>;
			blobs: Map<string, string>;
		}
		const root: Node = { children: new Map(), blobs: new Map() };
		for (const file of files) {
			const segments = file.path.split("/");
			const name = segments.pop() as string;
			let node = root;
			for (const segment of segments) {
				let next = node.children.get(segment);
				if (next === undefined) {
					next = { children: new Map(), blobs: new Map() };
					node.children.set(segment, next);
				}
				node = next;
			}
			node.blobs.set(
				name,
				await git.writeBlob({ fs, dir: this.#dir, blob: Buffer.from(file.bytes) as unknown as Uint8Array }),
			);
		}
		const write = async (node: Node): Promise<string> => {
			const entries = [
				...[...node.blobs].map(([name, oid]) => ({ mode: "100644", path: name, oid, type: "blob" as const })),
				...(await Promise.all(
					[...node.children].map(async ([name, child]) => ({
						mode: "040000",
						path: name,
						oid: await write(child),
						type: "tree" as const,
					})),
				)),
			].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
			return git.writeTree({ fs, dir: this.#dir, tree: entries });
		};
		return write(root);
	}
}
