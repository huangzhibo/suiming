import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	compileHostContext,
	composeHostReview,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	parseHostContextTask,
	parseStoryImpactSubject,
	reviewCurrency,
	reviewsIn,
	sourceCoverage,
	storyImpact,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

async function withProject<T>(body: (project: LocalProjectService, checkoutPath: string) => Promise<T>): Promise<T> {
	const checkoutPath = await mkdtemp(join(tmpdir(), "suiming-host-context-"));
	await materializeOpenStoryDirectorySnapshot(checkoutPath, sampleWorkFiles());
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "host-context" });
		return await body(project, checkoutPath);
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
}

const code = (error: unknown): string | undefined => (error as { code?: string }).code;

test("design impact 按主体召回候选：Beat 的下游依赖、人物涉及的全部 Beat、Contract 的 open / resolve 与 deadline、Intent 的范围", async () => {
	await withProject(async (project) => {
		const candidate = await project.checkoutCandidate();
		const beat = storyImpact(candidate, parseStoryImpactSubject("beat:beat-0001"));
		assert.deepEqual(beat.storyBeatIds, ["beat-0001"]);
		assert.deepEqual(beat.dependentStoryBeatIds, ["beat-0002"], "beat-0002 经 refs.beat 依赖 beat-0001");
		assert.deepEqual(beat.characterIds, ["黄盖"]);
		assert.deepEqual(beat.placeIds, ["赤壁"]);
		assert.deepEqual(beat.resourceIds, ["火船"]);
		assert.deepEqual(beat.contractIds, ["诈降"]);
		assert.deepEqual(beat.intentIds, ["计谋的代价"]);
		for (const path of [
			"outline/story/vol-0001/beat-0001.md",
			"outline/story/vol-0001/beat-0002.md",
			"world/characters/黄盖.md",
			"outline/contracts/诈降.md",
			"intent/计谋的代价.md",
		]) {
			assert.ok(beat.paths.includes(path), `${path} 应在候选路径里`);
		}
		assert.deepEqual(storyImpact(candidate, { kind: "character", id: "黄盖" }).storyBeatIds, [
			"beat-0001",
			"beat-0002",
		]);
		assert.deepEqual(storyImpact(candidate, { kind: "contract", id: "诈降" }).storyBeatIds, [
			"beat-0001",
			"beat-0002",
		]);
		assert.deepEqual(storyImpact(candidate, { kind: "resource", id: "火船" }).storyBeatIds, [
			"beat-0001",
			"beat-0002",
		]);
		const place = storyImpact(candidate, { kind: "place", id: "赤壁" });
		assert.deepEqual(place.storyBeatIds, ["beat-0001"]);
		assert.deepEqual(place.dependentStoryBeatIds, ["beat-0002"]);
		assert.deepEqual(storyImpact(candidate, { kind: "intent", id: "计谋的代价" }).storyBeatIds, [
			"beat-0001",
			"beat-0002",
		]);
		assert.throws(
			() => storyImpact(candidate, { kind: "place", id: "不存在" }),
			(error: unknown) => code(error) === "place_not_found",
		);
		assert.throws(
			() => parseStoryImpactSubject("beat-0001"),
			(error: unknown) => code(error) === "invalid_impact_subject",
		);
	});
});

test("context compile 给 host 的输入按路径列出作品文件；review record 写成 review/<id>.md，正文一变它就不再 current", async () => {
	await withProject(async (project, checkoutPath) => {
		await mkdir(join(checkoutPath, "text"), { recursive: true });
		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖走入赤壁，在木匣中找到火船。\n");
		await writeFile(join(checkoutPath, "text", "beat-0002.md"), "约定那夜，二十艘火船一齐点火，直冲曹营。\n");
		await project.commitCheckout();

		const write = await compileHostContext(project, "write:beat-0002");
		assert.equal(write.task, "write:beat-0002");
		assert.equal(write.revisionId, project.project().headRevisionId);
		assert.equal(write.write?.targetPath, "text/beat-0002.md");
		assert.equal(write.write?.previousStoryBeatId, "beat-0001");
		assert.equal(write.write?.hasCurrentText, true);
		assert.ok(write.systemPrompt.includes("StoryText Writer"));
		// host 子 agent 没有引擎工具：契约里不能出现 write / check / submit_story_text，改为文件写入与 text check。
		assert.equal(write.systemPrompt.includes("submit_story_text"), false);
		assert.ok(write.systemPrompt.includes("suim --json text check"));
		assert.ok(write.systemPrompt.includes("旁白不替人物作证"), "读者优先规则进入 host 版 Writer 契约");
		assert.ok(
			write.artifacts.some((artifact) => artifact.path === "text/beat-0001.md"),
			"previous 正文列在输入引用里",
		);

		const design = await compileHostContext(project, "design");
		assert.ok(design.text.includes('"outline/story/index.yaml"'));

		const review = await compileHostContext(project, "review:text:beat-0001");
		assert.equal(review.systemPrompt.includes("submit_review"), false);
		assert.ok(review.systemPrompt.includes("ReviewDraft JSON"));
		assert.ok(review.systemPrompt.includes("repairLayer 只能为 design 或 text"), "判断规则原样保留");
		assert.ok(review.systemPrompt.includes("severity 按读者体验定"), "severity 规则进入 host 版 Reviewer 契约");
		// 没有这句，Reviewer 会拿写作方法的默认取舍把样章里作品自己的写法判成缺陷（10-03 斗破评委就这样扣原作的分）
		assert.ok(
			review.systemPrompt.includes("不拿上面的标准把作品自己的写法判成缺陷"),
			"作品依据优先进入 Reviewer 契约",
		);
		assert.deepEqual(review.review, { layer: "text", storyBeatIds: ["beat-0001"] });
		assert.ok(review.text.includes("# 当前 Design") && review.text.includes('"text/beat-0001.md"'));

		const draft = {
			verdict: "revise",
			summary: "找到火船的过程被一句带过。",
			findings: [
				{
					severity: "minor",
					anchor: { kind: "artifact", path: "text/beat-0001.md" },
					issue: "挨打写得太顺，读者感受不到这顿打的分量。",
					evidence: "黄盖走入赤壁，在木匣中找到火船。",
					repairLayer: "text",
				},
			],
			uncovered: [],
			uncertainties: [],
		};
		const input = {
			draft,
			layer: "text" as const,
			scope: { kind: "selection" as const, storyBeatIds: ["beat-0001"] },
		};
		const composed = await composeHostReview(project, input);
		assert.match(composed.path, /^review\/text-\d{8}-\d{6}-[0-9a-f]{4}\.md$/u);
		assert.equal(composed.file.revision, project.project().headRevisionId, "审的是当前 head");
		assert.equal(composed.file.draft.verdict, "revise", "verdict 如实保留");
		assert.deepEqual(composed.file.scope, { kind: "beats", storyBeatIds: ["beat-0001"] });

		// 引文必须逐字出自被审文件；锚不到的路径与转述都被拒绝。
		await assert.rejects(
			composeHostReview(project, {
				...input,
				draft: { ...draft, findings: [{ ...draft.findings[0], evidence: "全文只有一句陈述。" }] },
			}),
			(error: unknown) => code(error) === "review_quote_not_found",
		);
		await assert.rejects(
			composeHostReview(project, {
				...input,
				draft: {
					...draft,
					findings: [{ ...draft.findings[0], anchor: { kind: "artifact", path: "text/beat-0009.md" } }],
				},
			}),
			(error: unknown) => code(error) === "review_anchor_not_found",
		);
		await assert.rejects(
			composeHostReview(project, { ...input, scope: { kind: "selection", storyBeatIds: ["beat-0009"] } }),
			(error: unknown) => code(error) === "story_beat_not_found",
		);

		// 写进作品目录、随 commit 进版本，然后从历史派生它是否还 current。
		await mkdir(join(checkoutPath, "review"), { recursive: true });
		await writeFile(join(checkoutPath, composed.path), composed.content);
		await project.commitCheckout();
		const reader = project.historyReader();
		let head = project.project().headRevisionId;
		let reviews = reviewsIn(await reader.snapshot(head));
		assert.deepEqual(
			reviews.map((item) => item.id),
			[composed.id],
		);
		assert.deepEqual(await reviewCurrency(reader, head, await reader.snapshot(head), reviews[0] as never), {
			state: "current",
			changed: [],
			revision: composed.file.revision,
		});

		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖当众挨了军杖。\n");
		await project.commitCheckout();
		head = project.project().headRevisionId;
		reviews = reviewsIn(await reader.snapshot(head));
		assert.deepEqual(await reviewCurrency(reader, head, await reader.snapshot(head), reviews[0] as never), {
			state: "stale",
			changed: ["text/beat-0001.md"],
			revision: composed.file.revision,
		});
		assert.throws(
			() => parseHostContextTask("nonsense"),
			(error: unknown) => code(error) === "invalid_context_task",
		);
	});
});

test("什么算 Design 只有一处：Reference 不是 Design；审正文时带 Intent 选中的风格证据，与 Writer 拿到的一致", async () => {
	await withProject(async (project, checkoutPath) => {
		// 2026-10-02 之前 Reviewer 自己定一份 Design（含整个 reference/），host 的 context compile design 用另一份。
		// Story Language：reference 是资料与研究，不是作品事实；只有被选进 Design 的结论才约束后续任务。
		await mkdir(join(checkoutPath, "reference", "research"), { recursive: true });
		await writeFile(join(checkoutPath, "reference", "research", "旧案.md"), "旧案卷宗的整理笔记。\n");
		await mkdir(join(checkoutPath, "text"), { recursive: true });
		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖走入赤壁，在木匣中找到火船。\n");
		await project.commitCheckout();
		const marked = (text: string) =>
			[...text.matchAll(/--- BEGIN ARTIFACT "([^"]+)" ---/gu)].map((match) => match[1] as string);

		const design = await compileHostContext(project, "design");
		const designReview = await compileHostContext(project, "review:design");
		assert.deepEqual(marked(designReview.text), marked(design.text), "Design 审稿看到的就是 Design");
		assert.equal(
			marked(design.text).some((path) => path.startsWith("reference/")),
			false,
		);
		assert.deepEqual(designReview.artifacts.map((artifact) => artifact.path).sort(), marked(design.text).sort());

		const textReview = await compileHostContext(project, "review:text:beat-0001");
		const shown = marked(textReview.text);
		assert.ok(shown.includes("reference/style/style_contemporary_restraint.md"), "Intent 选中的风格证据");
		assert.equal(shown.includes("reference/research/旧案.md"), false, "没被选中的研究资料不进输入");
		const write = await compileHostContext(project, "write:beat-0001");
		assert.ok(
			write.artifacts.some((artifact) => artifact.path === "reference/style/style_contemporary_restraint.md"),
		);
	});
});

test("context compile 的 Design 视图：人物视角带家族、硬状态与出场 Beat，at 把证据边界收到该 Beat 开始前；家族与卷视图各自成段", async () => {
	await withProject(async (project) => {
		const whole = await compileHostContext(project, "design:character:黄盖");
		assert.equal(whole.task, "design:character:黄盖");
		assert.deepEqual(whole.design, { kind: "character", id: "黄盖", storyBeatIds: ["beat-0001", "beat-0002"] });
		assert.ok(whole.text.startsWith("# 人物视角：黄盖（character:黄盖）"));
		assert.ok(whole.text.includes("（没有家族声明）"));
		assert.ok(whole.text.includes("- character:黄盖.location = place:赤壁"), "全书末的硬状态");
		assert.equal(whole.text.includes("- 持有 resource:火船"), false, "火船在 beat-0002 已 consumed，不再持有");
		assert.ok(whole.text.includes('--- BEGIN ARTIFACT "outline/story/vol-0001/beat-0002.md" ---'));
		assert.ok(whole.artifacts.some((artifact) => artifact.path === "world/characters/黄盖.md"));
		// 阅读契约：作者层信息不等于人物已知，带时点的视图不得用之后的事（原来是一份写 brief 的契约，要 host 没有的 frame 与 submit_brief）。
		assert.ok(whole.systemPrompt.includes("带时点的人物视图只含那个 Beat 开始之前的依据"));
		assert.equal(whole.systemPrompt.includes("submit_brief"), false);

		const at = await compileHostContext(project, "design:character:黄盖:at:beat-0002");
		assert.deepEqual(at.design, {
			kind: "character",
			id: "黄盖",
			atStoryBeatId: "beat-0002",
			storyBeatIds: ["beat-0001"],
		});
		assert.ok(at.text.includes("时点：beat-0002 开始前"));
		assert.ok(at.text.includes("- 持有 resource:火船"), "时点前火船还在黄盖手里");
		assert.equal(at.text.includes('--- BEGIN ARTIFACT "outline/story/vol-0001/beat-0002.md" ---'), false);
		assert.ok(at.text.includes("- outline/story/vol-0001/beat-0002.md"), "晚于时点的 Beat 只进目录");
		assert.ok(at.text.includes("晚于时点，不作为证据"));
		assert.equal(
			at.artifacts.some((artifact) => artifact.path === "outline/story/vol-0001/beat-0002.md"),
			false,
			"晚于时点的 Beat 不进输入引用",
		);
		assert.ok(at.artifacts.some((artifact) => artifact.path === "outline/story/vol-0001/beat-0001.md"));

		const family = await compileHostContext(project, "design:family:黄盖");
		assert.deepEqual(family.design, { kind: "family", id: "黄盖", storyBeatIds: ["beat-0001", "beat-0002"] });
		assert.ok(family.text.startsWith("# 家族视角：黄盖（character:黄盖），成员 黄盖"));
		assert.ok(family.text.includes('--- BEGIN ARTIFACT "world/characters/黄盖.md" ---'));

		const volume = await compileHostContext(project, "design:volume:vol-0001");
		assert.deepEqual(volume.design, { kind: "volume", id: "vol-0001", storyBeatIds: ["beat-0001", "beat-0002"] });
		assert.ok(volume.text.includes("- beat-0001"));
		assert.ok(volume.text.includes("open 诈降"));
		assert.ok(volume.text.includes("resolve 诈降"));
		assert.ok(volume.text.includes('--- BEGIN ARTIFACT "outline/story/vol-0001/beat-0002.md" ---'));

		await assert.rejects(
			compileHostContext(project, "design:character:无此人"),
			(error) => code(error) === "character_not_found",
		);
		await assert.rejects(
			compileHostContext(project, "design:character:黄盖:at:beat-0099"),
			(error) => code(error) === "story_beat_not_found",
		);
		await assert.rejects(
			compileHostContext(project, "design:volume:vol-0009"),
			(error) => code(error) === "story_volume_not_found",
		);
		await assert.rejects(
			compileHostContext(project, "design:character"),
			(error) => code(error) === "invalid_context_task",
		);
	});
});

test("host 自己读材料：source:read 分段 Context 带上一段笔记的位置，笔记写成 source/<id>/notes/<n>.md；覆盖全文后合并 Context 与 review:source 才可编译", async () => {
	await withProject(async (project, checkoutPath) => {
		const material =
			"第一段。黄盖在赤壁的木匣里找到火船，决定先不公开。\n第二段。他把火船藏在袖中，去见旧友。\n第三段。旧友劝他烧掉火船，他没有答应。\n";
		const total = [...material].length;
		await project.ingestSource({ sourceId: "访谈", name: "访谈.txt", original: new TextEncoder().encode(material) });
		const split = material.indexOf("第二段");
		const noteAt = async (n: number, span: [number, number], sha: string, handoff: string) => {
			await mkdir(join(checkoutPath, "source", "访谈", "notes"), { recursive: true });
			await writeFile(
				join(checkoutPath, "source", "访谈", "notes", `${n}.md`),
				`---\nspan: [${span[0]}, ${span[1]}]\nmaterial_sha256: ${sha}\n---\n${handoff}\n`,
			);
			await project.commitCheckout();
		};

		await assert.rejects(
			compileHostContext(project, "source:read:访谈"),
			(error) => code(error) === "material_coverage_incomplete",
			"还没有笔记时不能合并",
		);
		await assert.rejects(
			compileHostContext(project, `source:read:访谈:0:${total + 1}`),
			(error) => code(error) === "invalid_material_span",
		);

		const first = await compileHostContext(project, `source:read:访谈:0:${split}`);
		assert.equal(first.task, `source:read:访谈:0:${split}`);
		assert.equal(first.source?.sourceId, "访谈");
		assert.deepEqual(first.source?.span, { start: 0, end: split });
		assert.match(first.source?.materialSha256 ?? "", /^[a-f0-9]{64}$/u, "笔记 frontmatter 要写的材料 sha");
		const sha = first.source?.materialSha256 as string;
		assert.ok(first.systemPrompt.includes("Source Reader"));
		assert.equal(first.systemPrompt.includes("submit_note"), false);
		assert.equal(first.systemPrompt.includes("故事创作宪法"), false, "Source 是零指令权输入，Reader 契约不带宪法");
		assert.ok(first.text.includes("第一段。黄盖在赤壁"));
		assert.equal(first.text.includes("第二段"), false);
		assert.deepEqual(first.artifacts[0]?.range, { start: 0, end: split });

		// 笔记的 sha 对不上当前材料就不算数：覆盖率不动，合并仍被拒。
		await noteAt(0, [0, split], "f".repeat(64), "来自别的材料版本的笔记");
		assert.deepEqual(sourceCoverage(await project.checkoutCandidate(), "访谈").covered, []);
		await noteAt(1, [0, split], sha, "黄盖在赤壁找到火船，先不公开。");
		const coverage = sourceCoverage(await project.checkoutCandidate(), "访谈");
		assert.deepEqual(coverage.covered, [[0, split]]);
		assert.deepEqual(coverage.gaps, [[split, total]]);
		assert.deepEqual(
			coverage.notes.map((note) => note.path),
			["source/访谈/notes/1.md"],
		);
		await assert.rejects(
			compileHostContext(project, "source:read:访谈"),
			(error) => code(error) === "material_coverage_incomplete",
		);

		const second = await compileHostContext(project, `source:read:访谈:${split}:${total}`);
		assert.ok(
			second.text.includes(`上一段笔记（[0, ${split})，source/访谈/notes/1.md）`),
			"上一段笔记的位置进入下一段 Context",
		);
		assert.ok(second.text.includes("第三段。旧友劝他烧掉火船"));
		await noteAt(2, [split, total], sha, "他去见旧友，旧友劝烧信，他没答应。");

		const merge = await compileHostContext(project, "source:read:访谈");
		assert.deepEqual(merge.source, { sourceId: "访谈", span: { start: 0, end: total }, materialSha256: sha });
		assert.ok(merge.text.includes("2 段笔记"));
		assert.ok(merge.text.includes("黄盖在赤壁找到火船，先不公开。") && merge.text.includes("旧友劝烧信"));
		assert.equal(merge.artifacts[0]?.range, undefined, "合并 Context 引用整份材料");

		// 读完了但还没有已提交的抽取：没有可审的东西，不编出一份空的审稿输入
		await assert.rejects(
			compileHostContext(project, "review:source:访谈"),
			(error) => code(error) === "source_not_extracted",
		);
		await mkdir(join(checkoutPath, "source", "访谈", "outline", "story", "vol-0001"), { recursive: true });
		await writeFile(
			join(checkoutPath, "source", "访谈", "outline", "story", "index.yaml"),
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 访谈\n    beat_ids: [beat-0001]\n",
		);
		await writeFile(
			join(checkoutPath, "source", "访谈", "outline", "story", "vol-0001", "beat-0001.md"),
			"---\ntitle: 火船\n---\n黄盖在赤壁找到火船，没有公开，也没有听旧友的劝烧掉它。\n",
		);
		await project.commitCheckout();
		const review = await compileHostContext(project, "review:source:访谈");
		assert.deepEqual(review.review, { layer: "source", sourceId: "访谈" });
		assert.ok(review.text.includes("黄盖在赤壁找到火船，先不公开。"), "Source Review 拿到 host 写的笔记");
		assert.ok(review.text.includes("也没有听旧友的劝烧掉它"), "也拿到已提交的抽取");
	});
});
