import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { type ReviewFile, type ReviewScope, renderReviewFile } from "@suiming/story";
import {
	type ArtifactCandidate,
	ArtifactError,
	composeReviewFile,
	designClosurePaths,
	inspectRelease,
	type OpenPackageFile,
	type ProjectRevision,
	publishRelease,
	type RevisionHistoryReader,
	releaseReadiness,
	reviewCurrency,
	reviewSubjectPaths,
	storyPackageCodec,
	subjectDigests,
	textCurrencies,
	textCurrency,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();

/**
 * 派生层只依赖 `RevisionHistoryReader`：这里用一串快照冒充历史，摘要就是内容 sha。
 * git 实现的同名契约由 canon-store-contract 与 local-project-service 的测试覆盖。
 */
class FakeHistory implements RevisionHistoryReader {
	readonly #revisions: { revision: ProjectRevision; files: OpenPackageFile[] }[] = [];
	commit(files: OpenPackageFile[]): string {
		const id = `r${this.#revisions.length + 1}`;
		const parentId = this.#revisions.at(-1)?.revision.id ?? null;
		this.#revisions.push({ revision: { id, parentId }, files });
		return id;
	}
	candidateFiles(revisionId: string): OpenPackageFile[] {
		const entry = this.#revisions.find((item) => item.revision.id === revisionId);
		if (entry === undefined) throw new ArtifactError("revision_not_found", revisionId);
		return entry.files;
	}
	candidate(revisionId: string): ArtifactCandidate {
		return candidateOf(this.candidateFiles(revisionId), revisionId);
	}
	async history(): Promise<ProjectRevision[]> {
		return this.#revisions.map((item) => item.revision);
	}
	async fileDigests(revisionId: string): Promise<ReadonlyMap<string, string>> {
		const entry = this.#revisions.find((item) => item.revision.id === revisionId);
		if (entry === undefined) throw new ArtifactError("revision_not_found", revisionId);
		return new Map(entry.files.map((file) => [file.path, createHash("sha256").update(file.bytes).digest("hex")]));
	}
	async snapshot(revisionId: string): Promise<ArtifactCandidate> {
		return this.candidate(revisionId);
	}
}

function candidateOf(files: readonly OpenPackageFile[], baseRevisionId: string): ArtifactCandidate {
	return {
		baseRevisionId,
		artifacts: files.map((file) => ({
			identity: storyPackageCodec.identityForPath(file.path),
			path: file.path,
			mediaType: file.mediaType,
			bytes: file.bytes,
		})),
	};
}

const markdown = (path: string, text: string): OpenPackageFile => ({
	path,
	mediaType: "text/markdown; charset=utf-8",
	bytes: encoder.encode(text),
});
const replace = (files: OpenPackageFile[], path: string, text: string) =>
	files.map((file) => (file.path === path ? markdown(path, text) : file));
const texts = () => [
	markdown("text/beat-0001.md", "黄盖当众挨了军杖。\n\n他一声没吭。"),
	markdown("text/beat-0002.md", "约定那夜，二十艘火船一齐点火，冲进了曹营。"),
];

test("正文时效从历史派生：写成时的 Design 闭包没变就是 current，闭包里任一文件变了就是 design-changed，重写正文后重新起算", async () => {
	const history = new FakeHistory();
	const design = sampleWorkFiles();
	const r1 = history.commit(design);
	assert.deepEqual(
		(await textCurrencies(history, r1, history.candidate(r1))).map((item) => [item.storyBeatId, item.state]),
		[
			["beat-0001", "missing"],
			["beat-0002", "missing"],
		],
	);
	// 样例作品很小，两个 Beat 的闭包都是整套 Design。
	assert.ok(designClosurePaths(history.candidate(r1), "beat-0001").includes("world/characters/黄盖.md"));

	const withText = [...design, ...texts()];
	assert.deepEqual(
		(await textCurrencies(history, r1, candidateOf(withText, r1))).map((item) => item.state),
		["uncommitted", "uncommitted"],
		"候选里有正文、head 里没有：还没提交",
	);
	const r2 = history.commit(withText);
	assert.deepEqual(await textCurrencies(history, r2, history.candidate(r2)), [
		{ storyBeatId: "beat-0001", state: "current", writtenAt: r2, changed: [] },
		{ storyBeatId: "beat-0002", state: "current", writtenAt: r2, changed: [] },
	]);

	const r3 = history.commit(
		replace(withText, "world/characters/黄盖.md", "---\nname: 黄盖\n---\n宁可自己受刑，也不让计谋露出破绽。\n"),
	);
	const changed = await textCurrencies(history, r3, history.candidate(r3));
	assert.deepEqual(
		changed.map((item) => [item.state, item.writtenAt, item.changed]),
		[
			["design-changed", r2, ["world/characters/黄盖.md"]],
			["design-changed", r2, ["world/characters/黄盖.md"]],
		],
	);

	// r4：黄盖改回 r2 的样子，同时重写 beat-0001 的正文。
	const r4 = history.commit(replace(withText, "text/beat-0001.md", "军杖落到第三十下。"));
	assert.deepEqual(
		(await textCurrencies(history, r4, history.candidate(r4))).map((item) => [item.state, item.writtenAt]),
		[
			["current", r4],
			["current", r2],
		],
		"时效比较的是写成时与 head 的闭包内容，中间来回改过不算",
	);
	assert.equal((await textCurrency(history, r4, history.candidate(r4), "beat-0002")).changed.length, 0);
	await assert.rejects(textCurrencies(history, "r9", history.candidate(r4)), { code: "revision_not_found" });
});

test("story index 只按这个 Beat 的那一段算进闭包：末尾加卷不让前面的正文变黄，改卷名、动了前后邻居才算", async () => {
	const history = new FakeHistory();
	const withText = [...sampleWorkFiles(), ...texts()];
	const r1 = history.commit(withText);
	assert.deepEqual(
		(await textCurrencies(history, r1, history.candidate(r1))).map((item) => item.state),
		["current", "current"],
	);
	const index = (volumes: string) => markdown("outline/story/index.yaml", `schema_version: 2\nvolumes:\n${volumes}`);
	const first = "  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001, beat-0002]\n";
	// r2：全书末尾追加一卷一个 Beat（连载式写法每加一节都会改 index.yaml）
	const appended = [
		...withText.filter((file) => file.path !== "outline/story/index.yaml"),
		index(`${first}  - id: vol-0002\n    title: 续篇\n    beat_ids: [beat-0003]\n`),
		markdown("outline/story/vol-0002/beat-0003.md", "---\nrefs:\n  character: [黄盖]\n---\n黄盖离开都城。\n"),
	];
	const r2 = history.commit(appended);
	assert.deepEqual(
		(await textCurrencies(history, r2, history.candidate(r2))).map((item) => [item.storyBeatId, item.state]),
		[
			["beat-0001", "current"],
			["beat-0002", "design-changed"],
			["beat-0003", "missing"],
		],
		"只有原来的最后一篇多了一个「下一个」",
	);
	// r3：改第一卷的卷名，这一卷的正文都算 Design 变了
	const r3 = history.commit(
		appended.map((file) =>
			file.path === "outline/story/index.yaml"
				? index(
						`${first.replace("赤壁之战", "破局")}  - id: vol-0002\n    title: 续篇\n    beat_ids: [beat-0003]\n`,
					)
				: file,
		),
	);
	const renamed = await textCurrencies(history, r3, history.candidate(r3));
	assert.deepEqual(
		renamed
			.slice(0, 2)
			.map((item) => [item.storyBeatId, item.state, item.changed.includes("outline/story/index.yaml")]),
		[
			["beat-0001", "design-changed", true],
			["beat-0002", "design-changed", true],
		],
	);
});

test("正文的 Design 闭包只取 Writer 读到的那部分：同卷别的 Beat、没碰到的 Contract 与 Intent 改了不算，它引用的与它碰到的改了才算", async () => {
	const history = new FakeHistory();
	const index = markdown(
		"outline/story/index.yaml",
		"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001, beat-0002, beat-0003]\n",
	);
	const beat3 = (body: string) =>
		markdown(
			"outline/story/vol-0001/beat-0003.md",
			`---\nrefs:\n  character: [曹操]\ncontracts:\n  open: [华容道]\n---\n${body}\n`,
		);
	const contract = (body: string) =>
		markdown("outline/contracts/华容道.md", `---\nsubjects:\n  character: [曹操]\n---\n${body}\n`);
	const intent = (body: string) =>
		markdown("intent/败走.md", `---\ntarget: { from_beat_id: beat-0003, to_beat_id: beat-0003 }\n---\n${body}\n`);
	const files = [
		...sampleWorkFiles().filter((file) => file.path !== "outline/story/index.yaml"),
		index,
		beat3("曹操烧了船，从华容小道逃走。"),
		contract("曹操欠下的这条命，要等关羽来还。"),
		intent("败走要写出曹操的狼狈，也写出他不肯认输。"),
		markdown("world/characters/曹操.md", "---\nname: 曹操\n---\n统率北军南下的丞相。\n"),
		markdown("text/beat-0001.md", "黄盖当众挨了军杖。\n\n他一声没吭。"),
	];
	const r1 = history.commit(files);
	const closure = designClosurePaths(history.candidate(r1), "beat-0001");
	for (const path of [
		"outline/story/vol-0001/beat-0001.md",
		"world/characters/黄盖.md",
		"world/places/赤壁.md",
		"world/resources/火船.md",
		"outline/contracts/诈降.md",
		"intent/计谋的代价.md",
		"outline/story/index.yaml",
	])
		assert.ok(closure.includes(path), `闭包应包含 ${path}`);
	for (const path of [
		"outline/story/vol-0001/beat-0002.md",
		"outline/story/vol-0001/beat-0003.md",
		"outline/contracts/华容道.md",
		"intent/败走.md",
		"world/characters/曹操.md",
	])
		assert.ok(!closure.includes(path), `闭包不应包含 ${path}`);

	// r2：同卷的第三节、它开的 Contract、只覆盖它的 Intent、它引用的人物全改了，第一节的正文不受影响。
	const r2 = history.commit(
		files
			.filter((file) => !["outline/story/vol-0001/beat-0003.md", "outline/contracts/华容道.md"].includes(file.path))
			.filter((file) => !["intent/败走.md", "world/characters/曹操.md"].includes(file.path))
			.concat(
				beat3("曹操在乌林大败，带着残兵从华容小道逃走。"),
				contract("曹操在华容道上欠下关羽一条命。"),
				intent("败走写他的狼狈。"),
				markdown("world/characters/曹操.md", "---\nname: 曹操\n---\n挟天子以令诸侯的丞相。\n"),
			),
	);
	assert.deepEqual(await textCurrency(history, r2, history.candidate(r2), "beat-0001"), {
		storyBeatId: "beat-0001",
		state: "current",
		writtenAt: r1,
		changed: [],
	});

	// r3：第一节引用的地点与它开的 Contract 改了，才算 Design 变了。
	const r3 = history.commit(
		replace(
			replace(history.candidateFiles(r2), "world/places/赤壁.md", "长江南岸的赤壁，孙刘联军隔江扎营。\n"),
			"outline/contracts/诈降.md",
			"---\nsubjects:\n  character: [黄盖]\n  resource: [火船]\ndeadline: beat-0002\n---\n黄盖的投降是假的。\n",
		),
	);
	const changed = await textCurrency(history, r3, history.candidate(r3), "beat-0001");
	assert.equal(changed.state, "design-changed");
	assert.deepEqual(changed.changed, ["outline/contracts/诈降.md", "world/places/赤壁.md"]);
});

test("审稿时效比的是审的时候主体文件的摘要，不是审稿进版本的时间", async () => {
	const history = new FakeHistory();
	const design = sampleWorkFiles();
	history.commit(design);
	const withText = [...design, ...texts()];
	const r2 = history.commit(withText);
	const draft = { verdict: "pass" as const, summary: "成立", findings: [], uncovered: [], uncertainties: [] };
	// 用真实的 composeReviewFile 造审稿：subjects 由它按主体路径算，测的是产品路径不是手搭的字面量。
	const compose = (candidate: ArtifactCandidate, layer: "text" | "design", scope: ReviewScope, revision: string) =>
		composeReviewFile(candidate, { layer, scope, revision, draft }).file;
	const book = { kind: "book" as const };
	const at2 = history.candidate(r2);
	const bookText = compose(at2, "text", book, r2);
	const beatOne = compose(at2, "text", { kind: "beats", storyBeatIds: ["beat-0001"] }, r2);
	const designReview = compose(at2, "design", book, r2);
	const at = (file: ReviewFile, path = "review/x.md") => ({ path, file });

	assert.deepEqual(await reviewCurrency(history, r2, at2, at(bookText)), {
		state: "current",
		changed: [],
		revision: r2,
	});

	const r3 = history.commit(replace(withText, "text/beat-0002.md", "火船点着了。江面上许久没有人声。"));
	const at3 = history.candidate(r3);
	assert.deepEqual(await reviewCurrency(history, r3, at3, at(bookText)), {
		state: "stale",
		changed: ["text/beat-0002.md"],
		revision: r2,
	});
	assert.deepEqual(await reviewCurrency(history, r3, at3, at(beatOne)), {
		state: "current",
		changed: [],
		revision: r2,
	});
	assert.deepEqual(await reviewCurrency(history, r3, at3, at(designReview)), {
		state: "current",
		changed: [],
		revision: r2,
	});

	const r4 = history.commit(replace(withText, "intent/计谋的代价.md", "真相必须有代价。\n"));
	const at4 = history.candidate(r4);
	assert.deepEqual(await reviewCurrency(history, r4, at4, at(designReview)), {
		state: "stale",
		changed: ["intent/计谋的代价.md"],
		revision: r2,
	});
	assert.equal(
		(await reviewCurrency(history, r4, at4, at(beatOne))).state,
		"stale",
		"Intent 在 Beat 的 Design 闭包里",
	);

	// 2026-09-16 第一次真实对话撞上的那条：Agent 审完按意见改正文，两者一起提交。
	// 按版本比时区间为空、必然判 current；按摘要比才判得出来。
	const beforeFix = history.candidate(r4);
	const sameCommitReview = compose(beforeFix, "text", { kind: "beats", storyBeatIds: ["beat-0001"] }, "candidate");
	const fixed = [
		...replace(history.candidateFiles(r4), "text/beat-0001.md", "军杖落下，黄盖咬住衣角，一声没吭。"),
		markdown("review/same.md", renderReviewFile(sameCommitReview)),
	];
	const r5 = history.commit(fixed);
	assert.deepEqual(
		await reviewCurrency(history, r5, history.candidate(r5), at(sameCommitReview, "review/same.md")),
		{ state: "stale", changed: ["text/beat-0001.md"], revision: r5 },
		"审稿与按它改过的正文落在同一个 revision，仍要判 stale",
	);

	// 审稿时还不存在、后来成了主体的文件，也让全书正文审稿过时。
	const onlyOne = [...design, markdown("text/beat-0001.md", "黄盖当众挨了军杖。")];
	const r6 = history.commit(onlyOne);
	const partial = compose(history.candidate(r6), "text", book, r6);
	assert.deepEqual(partial.subjects.has("text/beat-0002.md"), false, "审的时候 beat-0002 还没有正文");
	const r7 = history.commit([...onlyOne, markdown("text/beat-0002.md", "火船点着了。")]);
	assert.deepEqual(await reviewCurrency(history, r7, history.candidate(r7), at(partial)), {
		state: "stale",
		changed: ["text/beat-0002.md"],
		revision: r6,
	});
});

test("Release 从完整且 current 的正文派生，Review 意见不拥有发布裁决权；正文一变 Release 就 stale", async () => {
	const history = new FakeHistory();
	const design = sampleWorkFiles();
	const r1 = history.commit(design);
	const incomplete = await releaseReadiness(history, r1, history.candidate(r1));
	assert.equal(incomplete.publishable, false);
	assert.ok(incomplete.blockers.length > 0);

	const withText = [...design, ...texts()];
	const r2 = history.commit(withText);
	const readiness = await releaseReadiness(history, r2, history.candidate(r2));
	assert.equal(readiness.publishable, false, "还没有 current 的全书正文审稿");
	assert.deepEqual(readiness.blockers, ["没有 current 的全书正文审稿"]);
	assert.ok(readiness.texts.every((item) => item.state === "current"));

	const review = {
		layer: "text" as const,
		scope: { kind: "book" as const },
		revision: r2,
		draft: {
			verdict: "revise" as const,
			summary: "结尾反馈仍可加强。",
			findings: [
				{
					severity: "minor" as const,
					anchor: { kind: "artifact" as const, path: "text/beat-0002.md" },
					issue: "焚信后的旁观者反馈偏少。",
					evidence: "二十艘火船一齐点火，冲进了曹营。",
					repairLayer: "text" as const,
				},
			],
			uncovered: [],
			uncertainties: [],
		},
	};
	const reviewedAt = history.candidate(r2);
	const reviewed = [
		...withText,
		markdown(
			"review/text-book.md",
			renderReviewFile({
				...review,
				subjects: subjectDigests(reviewedAt, reviewSubjectPaths(reviewedAt, "text", review.scope)),
			}),
		),
	];
	const r3 = history.commit(reviewed);
	const ready = await releaseReadiness(history, r3, history.candidate(r3));
	assert.equal(ready.publishable, true);
	assert.deepEqual(ready.review, { id: "text-book", verdict: "revise" });

	const published = await publishRelease(history, {
		candidate: history.candidate(r3),
		headRevisionId: r3,
		storyTextReview: "text-book",
		minCodePoints: 12,
		targetCodePoints: 18,
		maxCodePoints: 24,
	});
	assert.equal(published.reviewVerdict, "revise", "verdict 原样带出，不决定发布权限");
	assert.equal(published.manifest.revision, r3);
	assert.equal(published.manifest.storyTextReview, "text-book");
	const releaseFiles: OpenPackageFile[] = published.operations.flatMap((operation) =>
		operation.operation === "delete"
			? []
			: [
					{
						path: operation.path,
						mediaType: operation.mediaType,
						bytes: operation.bytes,
					},
				],
	);
	assert.ok(releaseFiles.some((file) => file.path === "release/manifest.yaml"));
	const r4 = history.commit([...reviewed, ...releaseFiles]);
	assert.deepEqual(await inspectRelease(history, r4, history.candidate(r4)), {
		state: "current",
		chapterCount: published.manifest.chapters.length,
		reviewVerdict: "revise",
	});

	await assert.rejects(
		publishRelease(history, { candidate: history.candidate(r4), headRevisionId: r4, storyTextReview: "nope" }),
		{ code: "invalid_release_review" },
	);

	const r5 = history.commit(
		replace(
			[...reviewed, ...releaseFiles],
			"text/beat-0002.md",
			"火船点着了，江面上许久没有人声，才有人喊出他的名字。",
		),
	);
	const stale = await inspectRelease(history, r5, history.candidate(r5));
	assert.equal(stale.state, "stale");
	await assert.rejects(
		publishRelease(history, { candidate: history.candidate(r5), headRevisionId: r5, storyTextReview: "text-book" }),
		{ code: "review_not_current" },
	);
	const republished = await publishRelease(history, { candidate: history.candidate(r5), headRevisionId: r5 });
	assert.equal(republished.manifest.revision, r5);
	assert.equal(republished.manifest.storyTextReview, undefined);
});
