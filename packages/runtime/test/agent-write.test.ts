import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { fauxProvider } from "@earendil-works/pi-ai";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { readProjectStatus } from "../src/harness/project-status.js";
import { compileWriteContext, composeReviewFile, SuimingHarness, textCurrencies } from "../src/index.js";
import { call, fauxGateway, type Responses, reply, say, withSampleProject as withProject } from "./harness-fixtures.js";
import { sampleWorkFiles } from "./sample-work.js";

function gateway(responses: Responses) {
	return fauxGateway("suiming-write-faux", responses, {
		main: "agent-model",
		reviewer: "agent-model",
		writer: "writer-model",
	});
}

const beatOneText =
	"军杖落到第三十下，黄盖咬住了衣角。他知道曹操的人就在辕门外看着，也知道这顿打少一下都不像真的。\n\n他没有喊。";
const beatTwoText = "约定那夜，二十艘船一齐点火，借着风冲进曹营。没有人拦得住。";

test("Agent 自己写正文并提交，不需要隔离 Writer；正文时效从提交历史派生", async () => {
	await withProject(async (project, checkoutPath) => {
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("write_context", { storyBeatId: "beat-0001" }),
					call("write", { path: "text/beat-0001.md", content: beatOneText }),
					call("commit", { summary: "采用首场正文" }),
					reply("首场写好并提交了"),
				]),
			}),
			"写 beat-0001 的正文",
		);
		assert.equal(outcome.failure, undefined);
		assert.equal(await readFile(join(checkoutPath, "text/beat-0001.md"), "utf8"), beatOneText);
		assert.deepEqual(project.loadExecutionState().tasks, []);
		const reader = project.historyReader();
		const head = project.project().headRevisionId;
		assert.deepEqual(
			(await textCurrencies(reader, head, await reader.snapshot(head))).map((item) => [
				item.storyBeatId,
				item.state,
			]),
			[
				["beat-0001", "current"],
				["beat-0002", "missing"],
			],
		);
	});
});

test("委派的 writer 只能改自己的 Beat；越界写是回到它手里的工具错误；后续 Beat 的 Context 包含前文", async () => {
	await withProject(async (project, checkoutPath) => {
		const writerPrompts: string[] = [];
		for (const [beat, content] of [
			["beat-0001", beatOneText],
			["beat-0002", beatTwoText],
		] as const) {
			const responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [
				call("delegate", { goal: `写 ${beat} 的正文`, profile: "writer", storyBeatId: beat }),
				async (context) => {
					writerPrompts.push(
						context.messages
							.map((message) => (typeof message.content === "string" ? message.content : ""))
							.join("\n"),
					);
					return call("write", { path: "intent/不允许.md", content: "越界" });
				},
				(context) => {
					assert.ok(JSON.stringify(context.messages.at(-1)).includes("may not modify"));
					return call("write", { path: `text/${beat}.md`, content });
				},
				call("submit_task", { summary: "已写入" }),
				call("commit", { summary: "采用正文" }),
				reply("已提交"),
			];
			const outcome = await say(
				new SuimingHarness({ project, models: gateway(responses) }),
				`委派 writer 写 ${beat}`,
			);
			assert.equal(outcome.failure, undefined);
		}
		assert.ok((writerPrompts[1] ?? "").includes(beatOneText), "第二个 Beat 的 Write Context 带前文");
		const candidate = await project.historyReader().snapshot(await project.refreshHead());
		assert.ok(compileWriteContext(candidate, "beat-0002").text.includes(beatOneText));
		assert.equal(await readFile(join(checkoutPath, "text/beat-0002.md"), "utf8"), beatTwoText);
		assert.deepEqual(
			project.loadExecutionState().tasks.map((task) => [task.kind, task.status]),
			[
				["subagent", "completed"],
				["subagent", "completed"],
			],
		);
	});
});

test("未提交的模型候选不会因为停止输出而进入 Canon；候选留在 checkout 等下一轮", async () => {
	await withProject(async (project, checkoutPath) => {
		const head = project.project().headRevisionId;
		const outcome = await say(
			new SuimingHarness({
				project,
				models: gateway([call("write", { path: "text/beat-0001.md", content: beatOneText }), reply("先写到这")]),
			}),
			"写 beat-0001",
		);
		assert.equal(outcome.session.status, "idle");
		assert.equal(project.project().headRevisionId, head);
		assert.equal(await readFile(join(checkoutPath, "text/beat-0001.md"), "utf8"), beatOneText);
		assert.equal((await project.status()).state, "dirty", "候选就是 project.diff 看得见的那一份");
	});
});

test("委派出去的 writer 拿到 Writer 契约，不是通用 subagent 措辞", async () => {
	await withProject(async (project) => {
		const workerSystemPrompts: string[] = [];
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { goal: "写 beat-0001 的正文", profile: "writer", storyBeatId: "beat-0001" }),
					async (context) => {
						// pi-ai 0.99 起系统提示折进 transcript 开头的 system message。
						const system = context.messages[0];
						workerSystemPrompts.push(system?.role === "system" ? getSystemMessageText(system) : "");
						return call("submit_task", { summary: "已写入" });
					},
					reply("完成"),
				]),
			}),
			"写第一个 Beat",
		);
		const worker = workerSystemPrompts[0] ?? "";
		// 角色定义跟着 profile 走：写作工艺（旁白不替人物作证、同一笔账只成立一次）必须到达真正
		// 写字的那个 agent，不能只留在 host 路径上。
		assert.match(worker, /旁白不替人物作证/u);
		assert.doesNotMatch(worker, /只完成给定目标与范围/u);
	});
});

test("Agent 自己写 Beat 时，write_context 同时交付写作方法", async () => {
	await withProject(async (project) => {
		const toolResults: string[] = [];
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("write_context", { storyBeatId: "beat-0001" }),
					async (context) => {
						toolResults.push(JSON.stringify(context.messages.at(-1)));
						return call("write", { path: "text/beat-0001.md", content: beatOneText });
					},
					reply("写好了"),
				]),
			}),
			"写 beat-0001",
		);
		// 桌面「写这个 Beat」就是 Agent 自己写字，没有隔离 Writer。
		// 写作方法必须跟着 Context 一起到，否则最常走的那条路径反而拿不到写作工艺。
		const result = toolResults[0] ?? "";
		assert.match(result, /旁白不替人物作证/u);
		assert.match(result, /target_story_design/u);
		// 2026-10-03 前 12 章续写：平均段长 31 字（原作 51 字），10-02 的 DeepSeek 留出评测也是这样；风格意图写着「短段落」
		assert.match(result, /它怎么分段就怎么分段/u);
		// 2026-10-03 读者口径的评委对照原作 48 轮 38 轮判原作胜：Agent 那份「更克制、更干净」，却「像同人文而非续写」——
		// 方法里的取舍压过了风格意图要的原作笔法（大段设定交代、反复强调、外露的心理独白）
		// 真实创作里前文质量参差、甚至没有前文：文风先看作者选定的样章（reference/style），前文首先负责接续
		assert.match(result, /文风的依据先看 intent_and_style 里作者选定的 style 样章，没有样章才看 prior_story_text/u);
		assert.match(result, /前文质量可能参差，它首先负责接续/u);
		assert.match(result, /不拿它们把作品自己的写法改得更克制、更干净/u);
		// 同一次正文审稿的 major：brief 里的一串「不写……」被写成旁白里「没有叫摊主、没有掏钱」这类否定式作证
		assert.match(result, /排除项.*是边界，不是要写进正文的内容/u);
	});
});

test("根 Agent 的提示与工具说明：写正文先取依据、Source 抽取的计划、独立的几段一起派出", async () => {
	// 三处原来各跑一个 turn 只为抓同一份系统提示（2026-10-04 合并）；每条断言守的那次失败写在旁边。
	// 2026-10-02 斗破留出评测（DeepSeek）：根 Agent 没委派 Writer、也没调 write_context，三节都凭 Frame 自己写，
	// 再用 118 次 edit 逐句凑篇幅；beat-0025 只有原作的 0.59。AGENT_PROMPT 里对写正文一句话都没有，
	// brief 与校准只在 host 的 Skill 里。
	await withProject(async (project) => {
		let system = "";
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					(context) => {
						system = JSON.stringify(context.messages[0]);
						return reply("好");
					},
				]),
			}),
			"写下一节",
		);
		assert.match(system, /写一节正文或成段重写前先用 write_context 取这一节的写作依据，或委派 writer/u);
		// 2026-10-05 走查：作者选中一段要求压短，Agent 也先取了整节 7,748 字的写作依据
		assert.match(system, /选中一两段要求就地改时，读这一节正文与情节设计就够/u);
		// 同一次走查：模型把 Beat 设计里的叙述也叫「正文」，在产品里正文专指 StoryText
		assert.match(system, /「正文」只指 text\/ 下的成稿/u);
		assert.match(system, /写一个 Beat 的正文或成段重写前先取/u, "write_context 的说明");
		assert.match(system, /writer 的 goal 就是 authorial brief/u, "delegate 的说明");
		assert.match(system, /建议篇幅与依据/u);
		assert.match(system, /不复述事件顺序/u);
		assert.match(system, /第一节写完先读一遍正文/u);
		assert.match(system, /不逐句 edit 凑篇幅/u);
		assert.match(system, /不要再列成一串「不写……」/u, "brief 写发生什么，不列禁令");
		// 10-03 重抽：能并行之后根 Agent 仍先派一个 source-reader 试水，等它读完（11 分半）才一次派出其余五个，
		// 读原文的时间翻了一倍。Codex 与 Claude Code 都在提示里明说「能并行就一起派」，只写「会同时执行」模型不会主动这么做。
		assert.match(system, /同一次回复里一起派出/u);
		assert.match(system, /不要先派一段试水/u);
		assert.match(system, /分段抽取.*整合.*补全.*统一修.*review 一轮/u);
		// 10-03 前 12 章第三圈：一段装得下，根 Agent 派了一个不带范围的抽取，没人写笔记，只好自己把原文读一遍补覆盖
		assert.match(system, /只有一段也这样派：笔记由它写/u);
		// 10-03 前 24 章：根 Agent 只派了第一段，goal 里要它「说明本段引向下一段的状态」，打算串行交接
		assert.match(system, /segments 的每一段各委派一个/u);
		assert.match(system, /不要让前一段给后一段交代状态/u);
	});
});

test("写正文时结果附段落数与平均段长；作品没有样章时与故事顺序上的前一节对比", async () => {
	// 段落偏碎两次都是事后量出来的（续写平均段长 31–34 字，原作 51 字）；写的时候就给出数，Writer 与根 Agent 才能校准。
	await withProject(async (project, checkoutPath) => {
		// 样例作品带着一份样章；拿掉它，看没有样章时的对照
		await rm(join(checkoutPath, "reference/style/style_contemporary_restraint.md"));
		const intentPath = join(checkoutPath, "intent/计谋的代价.md");
		await writeFile(
			intentPath,
			(await readFile(intentPath, "utf8")).replace(
				"style_refs: [style_contemporary_restraint]",
				"applies_to: design",
			),
		);
		const results: string[] = [];
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("write", {
						path: "text/beat-0001.md",
						content: "第一段写得长一些，有好几个分句，人物在动。\n\n第二段也不短，接着往下走。\n",
					}),
					call("write", { path: "text/beat-0002.md", content: "## 第2章\n\n短。\n\n又短。\n\n还是短。\n" }),
					(context) => {
						const last = context.messages.at(-1);
						const part = Array.isArray(last?.content)
							? last.content.find((item) => item.type === "text")
							: undefined;
						results.push(part?.type === "text" ? part.text : "");
						return reply("写好了");
					},
				]),
			}),
			"写两节",
		);
		assert.match(results[0] ?? "", /段落 3，平均段长 3 字（前一节 17 字）/u, `标题不算段落：${results[0]}`);
	});
});

test("委派的 writer 读不到 Source：原作既不在读范围里，也没有读原文的工具", async () => {
	// 留出评测里原作就是参照答案；Skill 的 Writer 契约也说不给它 Source。read_source / search_source 从候选里
	// 直接读材料，不经过读范围，所以只收读范围挡不住。
	await withProject(async (project) => {
		const seen: string[] = [];
		let system = "";
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("delegate", { goal: "写 beat-0001 的正文", profile: "writer", storyBeatId: "beat-0001" }),
					(context) => {
						system = JSON.stringify(context.messages[0]);
						return call("list", { path: "source" });
					},
					(context) => {
						seen.push(JSON.stringify(context.messages.at(-1)));
						return call("read", { path: "outline/story/index.yaml" });
					},
					(context) => {
						seen.push(JSON.stringify(context.messages.at(-1)));
						return call("submit_task", { summary: "先停" });
					},
					reply("好"),
				]),
			}),
			"委派 writer 写第一节",
		);
		assert.match(seen[0] ?? "", /permission_denied/u);
		assert.match(seen[1] ?? "", /beat-0001/u, "Target 照常可读");
		assert.doesNotMatch(system, /"read_source"|"search_source"|"source_coverage"/u);
	});
});

test("作品状态点名过时的正文与审稿：Agent 的 project_status 与 suim status 是同一份", async () => {
	// Skill 说 `suim --json status` 会标出「Design 已变」的正文，实际 status 只有计数；Agent 的 project_status
	// 也一样，正文写成之后改了 Design、审稿之后改了主体，Agent 与 host 都只能去桌面上看。
	await withProject(async (project, checkoutPath) => {
		await mkdir(join(checkoutPath, "text"), { recursive: true });
		await writeFile(join(checkoutPath, "text/beat-0001.md"), beatOneText);
		const written = await project.checkoutCandidate();
		const review = composeReviewFile(written, {
			layer: "design",
			scope: { kind: "book" },
			revision: "candidate",
			draft: { verdict: "pass", summary: "成立。", findings: [], uncovered: [], uncertainties: [] },
		});
		await mkdir(join(checkoutPath, "review"), { recursive: true });
		await writeFile(join(checkoutPath, review.path), review.content);
		await project.commitCheckout();
		const fresh = await readProjectStatus(project, await project.checkoutCandidate());
		assert.deepEqual(fresh.stale, { texts: { count: 0, ids: [] }, reviews: { count: 0, ids: [] } });

		const beat = join(checkoutPath, "outline/story/vol-0001/beat-0001.md");
		await writeFile(beat, (await readFile(beat, "utf8")).replace("早已备好的火船", "早已备好的二十艘火船"));
		await project.commitCheckout();
		const after = await readProjectStatus(project, await project.checkoutCandidate());
		assert.deepEqual(after.stale, {
			texts: { count: 1, ids: ["beat-0001"] },
			reviews: { count: 1, ids: [review.id] },
		});
	});
});

test("Write Context 与 frame 的硬状态带作用域：读者知道与人物知道分得开", async () => {
	// 2026-10-02 审查：两处打印都只有 `subject.property = value`，读者与黄盖同时得知一个秘密时打出两行一模一样的
	// `secret:苦肉计.revealed = true`，Writer 分不出谁知道，可能让人物用上只有读者知道的事。
	const { candidateFromStoryFiles } = await import("../src/index.js");
	const { frameTool } = await import("../src/harness/tools.js");
	const encoder = new TextEncoder();
	const beat = "outline/story/vol-0001/beat-0001.md";
	const files = sampleWorkFiles().filter((file) => file.path !== beat);
	files.push({
		path: beat,
		mediaType: "text/markdown; charset=utf-8",
		bytes: encoder.encode(`---
refs:
  character: [黄盖]
  place: [赤壁]
  resource: [火船]
  secret: [苦肉计]
contracts:
  open: [诈降]
changes:
  world:
    黄盖.location: 赤壁
  reader:
    苦肉计.revealed: true
  character:
    黄盖:
      苦肉计.revealed: true
---
黄盖在赤壁大营挨了军杖，也明白了这是一场苦肉计。
`),
	});
	const candidate = candidateFromStoryFiles("r1", files);
	const state = compileWriteContext(candidate, "beat-0002").text.split("## hard_state")[1] ?? "";
	assert.match(state, /读者：secret:苦肉计\.revealed = true/u);
	assert.match(state, /人物 黄盖：secret:苦肉计\.revealed = true/u);
	assert.match(state, /客观：character:黄盖\.location = "place:赤壁"/u);
	const frame = frameTool(async () => candidate);
	const result = (await frame.prepare?.({ storyBeatId: "beat-0002" })) as { content: { text: string }[] };
	assert.match(result.content[0]?.text ?? "", /人物 黄盖：secret:苦肉计\.revealed = true/u);
});

test("作品有样章时，写正文的段长对照样章而不是前一节：前文质量参差时它才是文风的依据", async () => {
	// 真实创作里前文可能是写得不满意的章节，甚至没有前文；作者选定的 reference/style 样章才是「这部书该这么写」。
	await withProject(async (project, checkoutPath) => {
		await mkdir(join(checkoutPath, "reference/style"), { recursive: true });
		await writeFile(
			join(checkoutPath, "reference/style/style_long_paragraphs.md"),
			"这一段写得很长，人物一边走一边想着心事，旁人的议论从四面八方传过来，他只当没听见。\n\n第二段同样不短，把场面交代清楚了才收住。\n",
		);
		await writeFile(
			join(checkoutPath, "intent/样章.md"),
			"---\napplies_to: text\nstyle_refs: [style_long_paragraphs]\n---\n正文照样章的写法：长段落，心事写在动作里。\n",
		);
		const results: string[] = [];
		await say(
			new SuimingHarness({
				project,
				models: gateway([
					call("write", { path: "text/beat-0001.md", content: "短。\n\n又短。\n" }),
					(context) => {
						const last = context.messages.at(-1);
						const part = Array.isArray(last?.content)
							? last.content.find((item) => item.type === "text")
							: undefined;
						results.push(part?.type === "text" ? part.text : "");
						return reply("写好了");
					},
				]),
			}),
			"写第一节",
		);
		assert.match(results[0] ?? "", /段落 2，平均段长 3 字（样章 \d+ 字）/u, results[0]);
	});
});
