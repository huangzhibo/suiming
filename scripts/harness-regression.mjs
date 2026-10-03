// 真实模型回归（2026-10-01 Harness 审查 3.3）：改 prompt、工具描述或 loop 之前与之后各跑一遍。
// 每个任务在样例作品的一份新副本上，像 host 一样从外面驱动 `suim session send`，只用确定性信号判分：
// turn 结束对账（suiming.turn）、版本历史、Checker、文件、审稿引文能否在正文里找到。
// 模型输出不确定，所以这是报通过率的脚本，不是红绿测试；不写 trace、不碰真实作品。
// `suim --json` 的 ok 只表示命令跑完，Checker 过没过看 data.passed。
//
//   npm run regression:harness -- [--trials 3] [--only discuss,review] [--out result.json]
//
// 跑的过程中不要重建 dist：每个任务起一个新的 suim 进程，读的是当时的 dist。脚本开头记下 commit 与
// dist 指纹，每跑完一个任务核对一次，变了就停——不同构建混在一份结果里比不出任何东西。
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { parseReviewFile } from "@suiming/story";
import { anchorParagraphs } from "../apps/web/src/anchors.ts";
import { sampleWorkFiles } from "../packages/runtime/test/sample-work.ts";

const run = promisify(execFile);
const CLI = resolve("apps/cli/dist/bin.js");

const PROSE = `李牧推开皇档的门，霉味先于灯光涌出来。他知道匣子在哪一层，也知道拿走密信之后，自己就再没有可以讨价还价的东西。

守档的老吏咳了一声，没有回头。李牧把手按在匣盖上，停了很久。

他还是伸手取了。蜡封在指腹下碎开的时候，他想起父亲说过的话：真相要有人付账。`;

async function suim(dir, args) {
	try {
		const { stdout } = await run(process.execPath, [CLI, "--project", dir, "--json", ...args], {
			env: process.env,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { ok: true, ...JSON.parse(stdout) };
	} catch (error) {
		const stdout = error.stdout ? String(error.stdout) : "";
		try {
			return { ok: false, ...JSON.parse(stdout) };
		} catch {
			return { ok: false, error: { message: String(error.stderr ?? error.message) } };
		}
	}
}

/** 构建产物的指纹：文件路径、大小与修改时间。 */
async function distFingerprint() {
	const hash = createHash("sha256");
	const walk = async (dir) => {
		for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const info = await stat(path);
				hash.update(`${path}\0${info.size}\0${info.mtimeMs}\n`);
			}
		}
	};
	for (const dir of ["packages/story/dist", "packages/sdk/dist", "packages/runtime/dist", "apps/cli/dist"])
		await walk(resolve(dir));
	return hash.digest("hex").slice(0, 16);
}

/**
 * `suim init / update --agent` 写进作品仓的 host 接入文件。真实作品都装着（eval-022 根目录有 .agents、.codex、.grok、
 * AGENTS.md），样例副本也装上；它们是写给 Codex / Claude Code / Grok 的，这里记下 Agent 碰没碰。
 */
const HOST_FILE = /^(?:\.agents|\.claude|\.codex|\.grok)(?:\/|$)|^(?:AGENTS|CLAUDE)\.md$/u;

const total = (changed) => Object.values(changed).reduce((sum, item) => sum + item.count, 0);
const expect = (name, pass) => ({ name, pass: Boolean(pass) });

/**
 * 审稿引文能不能锚回正文段落。引文是否出自锚定文件，submit_review 已经确定性地校验（review-authoring 的
 * quoteMissing），这里不重复；量的是工作台要做的那一步：锚在正文上的 finding，引文能不能落到某一段
 * （与 apps/web/src/anchors.ts 同一条规则）。锚在 Design 等其它文件上的 finding 只锚文件，不计入。
 */
async function reviewAnchors(dir) {
	const files = (await readdir(join(dir, "review")).catch(() => [])).filter((name) => name.endsWith(".md"));
	const text = await readFile(join(dir, "text/beat-0001.md"), "utf8");
	let findings = 0;
	let textFindings = 0;
	let anchored = 0;
	const misses = [];
	for (const name of files) {
		const review = parseReviewFile(await readFile(join(dir, "review", name), "utf8"), `review/${name}`);
		for (const finding of review.draft.findings) {
			findings += 1;
			if (finding.anchor.kind !== "artifact" || finding.anchor.path !== "text/beat-0001.md") continue;
			textFindings += 1;
			if (anchorParagraphs(finding.evidence, text).length > 0) anchored += 1;
			else misses.push(finding.evidence.slice(0, 80));
		}
	}
	return { reviews: files.length, findings, textFindings, anchored, misses };
}

/**
 * beat-0002 不再兑现「真相的代价」（期限就是 beat-0002）：设计层错误不拦提交，所以能作为起点提交；
 * check 对它说 ISSUES。2026-10-02 之前 Agent 的 check 对这份候选说 PASSED。
 */
async function unpaidContract(dir, service, id) {
	const path = join(dir, "outline/story/vol-0001/beat-0002.md");
	const before = await readFile(path, "utf8");
	const after = before.replace("contracts:\n  resolve: [真相的代价]\n", "");
	if (after === before) throw new Error("样例的 beat-0002 已不再兑现「真相的代价」，出题要跟着改");
	await writeFile(path, after);
	await service.commitCheckout({ commandId: `regression:${id}:setup` });
}

const TASKS = [
	{
		id: "discuss",
		prompt: "讨论一下李牧公开密信要付出什么代价，先不要修改作品。",
		grade: (r) => [
			expect("没有改动作品", total(r.summary.changed) === 0),
			expect("没有提交", r.summary.revisions === 0),
			expect("有回答", r.reply.length > 0),
		],
	},
	{
		id: "write-back",
		prompt: "记住一个以后都成立的设定：李牧从不说谎，哪怕对敌人也一样。",
		grade: (r) => [
			expect("写回了意图或 Design", r.summary.changed.intent.count + r.summary.changed.design.count > 0),
		],
	},
	{
		id: "design-edit",
		// 样例的 beat-0002 已经是「当众焚毁密信」，要求一个它确实没有的改动，否则「不用改」才是对的回答。
		prompt: "在 beat-0002 里加上守档的老吏想拦住李牧、被他推开的情节。改完检查并提交。",
		grade: (r) => [
			expect("改了 Design", r.summary.changed.design.count > 0),
			expect("提交了版本", r.summary.revisions > 0),
			expect("当前版本过 Checker", r.check.data?.passed === true),
			expect("没有遗留未提交", r.summary.uncommitted === 0),
		],
	},
	{
		id: "write-text",
		prompt: "写 beat-0001 的正文，写完检查并提交。",
		textCheck: true,
		grade: (r) => [
			expect("写了正文", r.summary.changed.text.count > 0),
			expect("提交了版本", r.summary.revisions > 0),
			expect("正文过检查", r.textCheck?.data?.passed === true),
		],
	},
	{
		id: "delegate-writer",
		prompt: "委派一个 writer 子任务写 beat-0001 的正文，写好后检查并提交。",
		textCheck: true,
		grade: (r) => [
			expect(
				"委派了子任务并完成",
				r.tasks.some((task) => task.kind === "subagent" && task.status === "completed"),
			),
			expect("写了正文", r.summary.changed.text.count > 0),
			expect("提交了版本", r.summary.revisions > 0),
			expect("正文过检查", r.textCheck?.data?.passed === true),
		],
	},
	{
		id: "check-issues",
		setup: (dir, service) => unpaidContract(dir, service, "check-issues"),
		prompt: "检查一下作品现在有没有问题，先不要修改。",
		grade: (r) => [
			expect("没有改动作品", total(r.summary.changed) === 0),
			expect("回复点名没兑现的期待", r.reply.includes("真相的代价")),
		],
	},
	{
		// 书里别处有设计问题时，Writer 的 write(check: true) 拿到 ISSUES：不能因此卡住或去改设计，
		// 根 Agent 阶段提交时要告诉作者那个问题还在。
		id: "delegate-writer-issues",
		setup: (dir, service) => unpaidContract(dir, service, "delegate-writer-issues"),
		prompt: "委派一个 writer 子任务写 beat-0001 的正文，写好后检查并提交。",
		textCheck: true,
		grade: (r) => [
			expect(
				"委派了子任务并完成",
				r.tasks.some((task) => task.kind === "subagent" && task.status === "completed"),
			),
			expect("写了正文", r.summary.changed.text.count > 0),
			expect("提交了版本", r.summary.revisions > 0),
			expect("正文过检查", r.textCheck?.data?.passed === true),
			expect("回复提到还没兑现的期待", r.reply.includes("真相的代价")),
		],
	},
	{
		id: "review",
		async setup(dir, service) {
			await mkdir(join(dir, "text"), { recursive: true });
			await writeFile(join(dir, "text/beat-0001.md"), `${PROSE}\n`);
			await service.commitCheckout({ commandId: "regression:review:setup" });
		},
		prompt: "独立审一下 beat-0001 的正文。",
		grade: (r) => [
			expect("留下了审稿", r.summary.changed.review.count > 0),
			expect("正文上的 finding 都能锚到段落", r.anchors.anchored === r.anchors.textFindings),
		],
	},
];

async function runTask(task, root, trial) {
	const dir = join(root, `${task.id}-${trial}`);
	await mkdir(dir, { recursive: true });
	await materializeOpenStoryDirectorySnapshot(dir, sampleWorkFiles());
	const service = await LocalProjectService.init({ checkoutPath: dir });
	try {
		await task.setup?.(dir, service);
	} finally {
		service.close();
	}
	const installed = await suim(dir, ["update", "--agent", "codex", "--agent", "claude-code", "--agent", "grok"]);
	if (!installed.ok) throw new Error(`装 host 接入文件失败：${installed.error?.message}`);
	const started = Date.now();
	const sent = await suim(dir, ["session", "send", task.prompt]);
	const durationMs = Date.now() - started;
	const session = sent.data?.session;
	if (!sent.ok || session === undefined)
		return { id: task.id, trial, passed: false, durationMs, error: sent.error?.message ?? "session send 失败" };
	const events = (await suim(dir, ["session", "events", session.id])).data?.events ?? [];
	const summary = events
		.map((record) => record.event)
		.findLast((event) => event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.turn")?.content;
	const tasks = (await suim(dir, ["session", "show", session.id])).data?.tasks ?? [];
	const actions = events
		.map((record) => record.event)
		.filter((event) => event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.action")
		.map((event) => event.content);
	// 子任务各读了几次文件：Writer 的 prompt 说它只靠 Write Context，这个数看它实际怎么做。
	const subagentReads = actions.filter((action) => action.label === "read" && action.taskId !== session.id).length;
	const hostFileActions = actions
		.filter((action) => HOST_FILE.test(action.target ?? ""))
		.map((action) => `${action.label} ${action.target}${action.isError ? "（被拒）" : ""}`);
	if (summary === undefined) return { id: task.id, trial, passed: false, durationMs, error: "没有 turn 结束对账事件" };
	const result = {
		reply: sent.data.reply ?? "",
		summary,
		check: await suim(dir, ["check"]),
		textCheck: task.textCheck ? await suim(dir, ["text", "check", "beat-0001"]) : undefined,
		tasks,
		anchors: task.id === "review" ? await reviewAnchors(dir) : undefined,
	};
	const checks = task.grade(result);
	return {
		id: task.id,
		trial,
		passed: checks.every((check) => check.pass),
		checks,
		durationMs,
		status: session.status,
		// 原文要留下：副本跑完就删，事后只剩一个错误码分不清是服务商的问题还是我们的。
		...(session.lastFailure ? { lastFailure: `${session.lastFailure.code}：${session.lastFailure.message}` } : {}),
		calls: session.usage?.calls ?? 0,
		costUsd: session.usage?.costUsd ?? 0,
		summary,
		subagents: tasks.length,
		subagentReads,
		hostFileActions,
		...(result.anchors ? { anchors: result.anchors } : {}),
		reply: result.reply,
	};
}

const option = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
};
const trials = Number(option("trials") ?? 1);
const only = option("only")?.split(",");
const tasks = TASKS.filter((task) => only === undefined || only.includes(task.id));
const build = {
	commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
	dirty: execFileSync("git", ["status", "--porcelain", "--", "packages", "apps"], { encoding: "utf8" }).trim() !== "",
	dist: await distFingerprint(),
};
console.log(`构建 ${build.commit}${build.dirty ? "（packages / apps 有未提交修改）" : ""} · dist ${build.dist}\n`);
const out = option("out");
const root = await mkdtemp(join(tmpdir(), "suiming-regression-"));
const results = [];
try {
	campaign: for (const task of tasks)
		for (let trial = 1; trial <= trials; trial += 1) {
			const result = await runTask(task, root, trial);
			if ((await distFingerprint()) !== build.dist) {
				console.log("✖ dist 在运行中变了，这一项与之后的结果都不可比，停止。");
				process.exitCode = 1;
				break campaign;
			}
			results.push(result);
			if (out) await writeFile(out, `${JSON.stringify({ build, results }, null, 2)}\n`);
			const failed = (result.checks ?? []).filter((check) => !check.pass).map((check) => check.name);
			console.log(
				`${result.passed ? "✔" : "✖"} ${task.id} #${trial}  ${(result.durationMs / 1000).toFixed(0)}s  $${(result.costUsd ?? 0).toFixed(4)}${result.error ? `  ${result.error}` : ""}${failed.length ? `  未通过：${failed.join("、")}` : ""}${result.lastFailure ? `  lastFailure=${result.lastFailure}` : ""}${result.hostFileActions?.length ? `  碰了 host 文件：${result.hostFileActions.join("、")}` : ""}`,
			);
		}
} finally {
	await rm(root, { recursive: true, force: true });
}
const passed = results.filter((result) => result.passed).length;
const cost = results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
console.log(`\n通过 ${passed} / ${results.length}，合计 $${cost.toFixed(4)}`);
