"""斗破留出评测的全流程：搭作品 → Agent 续写、审稿、提交 → 确定性指标 → 读者口径评委，一条命令跑完。

用法（在仓库根目录）：
  python3 -I docs/validation/2026-10-17-doupo-holdout-pipeline/holdout.py <抽取作品> <Agent 回复.md> <输出目录> \
      --holdout-from 107 [--goal]

`--goal`：作者消息改用 `suim session goal set` 发（ADR-0038），turn 结束后由 Runtime 自动续跑，直到 Agent 标完成
或需要作者拍板；停在用量检查点时照旧替作者说「继续」。

输出目录不在仓库里（作品是《斗破苍穹》的原文，不进 MIT 仓库）：
- work/       评测作品：留出的节没有正文，Agent 在这里写
- ref/        参照作品：留出的节放回原作，评委从这里取前文（Agent 那一版若接在自己的上一节后面，评委看到的前文就偏向它）
- reference/  留出各节的原作原文
- logs/       每一步的原始 JSON 输出与 stderr
- results.json、results.md

能续跑：已经有输出的步骤跳过；turn 没写完就发「继续」，最多两次，发过几次照实记下。
这一轮只验证流程能无人工干预地跑完，不调写法：评委与指标照常出，但不据此改任何东西。

搭作品用 2026-10-03 的 build_eval_work.py；指标用 2026-10-02 的 compare.py。suim 用本仓的
apps/cli/dist/bin.js，跑之前先构建；跑的过程中不要重建 dist（每一步核对一次指纹，变了就停）。
"""

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "apps/cli/dist/bin.js"
BUILDER = REPO / "docs/validation/2026-10-03-doupo-agent-gpt/build_eval_work.py"
COMPARE = REPO / "docs/validation/2026-10-02-doupo-holdout/compare.py"
MAX_CONTINUES = 2

# 评测搭法对意图的两处改动（2026-10-03 留出时手改过同样两处）：留出点之后的正文不是原作；
# 续写篇幅那句去掉——篇幅交给 Agent 按前文判断，留着它会让 24 节各写一万字。
# 分章那句原来是「章题沿用前文的格式，章号接着前文往下编」，四次留出 Agent 都每节开一章（原作 24 节只有 14 节开章），
# 章内续接的节膨胀到 2.4 倍；这部书一章常跨几节，2026-10-18 改成照前文分章（路线图第 6 节第 4a 项）。
STYLE_INTENT = "intent/story-text-style.md"
STYLE_EDITS = [
    (r"前[一二三四五六七八九十百零]+章的正文就是原作章节，续写正文延续原作的笔法：", "第 {n} 章之前的正文就是原作章节，之后的正文延续原作的笔法："),
    (r"续写每个 StoryBeat 写一万字左右[^\n]*",
     "分章照前文：一章常常跨两三节，开新章的那一节才写章题，格式沿用前文的「## 第N章 标题」，章号接着前文往下编；"
     "接着上一节同一章往下写的节不加章题。"),
]


# 评委是评测协议的一部分，不跟本机 .env 的 judge 设置走（2026-10-17 评委位置偏差实验，docs/validation/2026-10-17-judge-position）：
# 不开思考时先出场的候选赢 79%，结论多半由顺序决定；deepseek-flash 开思考后正反顺序各跑两轮，四轮全一致的结论可复现。
JUDGE_ENV = {
    "SUIMING_JUDGE_MODEL_PROVIDER": "deepseek",
    "SUIMING_JUDGE_MODEL_ID": "deepseek-flash",
    "SUIMING_JUDGE_MODEL_OPTIONS": '{"maxTokens":32768,"reasoningEffort":"high"}',
}
RANK_ROUNDS = 4


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment() -> dict[str, str]:
    """本仓 .env 里的模型与观测配置（judge profile 在这里）；shell 里已有的同名变量优先。"""
    env = dict(os.environ)
    dotenv = REPO / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf8").splitlines():
            match = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
            if match:
                # 与 node --env-file 一样去掉成对的引号（LANGFUSE_BASE_URL="http://…" 带着引号会让 OTLP 导出器拒绝启动）
                value = re.sub(r"^([\"'])(.*)\1$", r"\2", match.group(2))
                env.setdefault(match.group(1), value)
    return env


def dist_fingerprint() -> str:
    digest = hashlib.sha256()
    for root in ("packages/story/dist", "packages/sdk/dist", "packages/runtime/dist", "apps/cli/dist"):
        for path in sorted((REPO / root).rglob("*")):
            if path.is_file():
                info = path.stat()
                digest.update(f"{path}\0{info.st_size}\0{info.st_mtime_ns}\n".encode())
    return digest.hexdigest()[:16]


class Pipeline:
    def __init__(self, out: Path, goal: bool = False):
        self.out = out
        self.goal = goal
        self.work = out / "work"
        self.ref = out / "ref"
        self.reference = out / "reference"
        self.logs = out / "logs"
        self.env = environment()
        self.fingerprint = dist_fingerprint()
        self.commit = self.git(REPO, "rev-parse", "--short", "HEAD").stdout.strip()

    def guard(self) -> None:
        if dist_fingerprint() != self.fingerprint:
            raise SystemExit("dist 在运行中变了，之后的结果与前面不可比，停止。")

    def suim(self, cwd: Path, args: list[str], log: str, env: dict[str, str] | None = None) -> dict:
        """跑一次 suim --json，原样存下 stdout / stderr；返回解析后的信封。env 覆盖本机 .env 的同名变量。"""
        self.guard()
        started = time.time()
        done = subprocess.run(
            ["node", str(CLI), "--json", *args], cwd=cwd, env=self.env | (env or {}), capture_output=True, text=True,
            check=False,
        )
        (self.logs / f"{log}.json").write_text(done.stdout, encoding="utf8")
        if done.stderr:
            (self.logs / f"{log}.err").write_text(done.stderr, encoding="utf8")
        try:
            envelope = json.loads(done.stdout)
        except json.JSONDecodeError:
            envelope = {"ok": False, "error": {"message": f"非 JSON 输出（exit {done.returncode}）"}}
        envelope["_seconds"] = round(time.time() - started, 1)
        envelope["_exit"] = done.returncode
        return envelope

    def git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)

    # ① 搭作品
    def build(self, extraction: Path, reply: Path, holdout_from: int) -> list[str]:
        if not self.work.exists():
            subprocess.run(
                [sys.executable, "-I", str(BUILDER), str(extraction), str(reply), str(self.work), str(self.reference),
                 "--holdout-from", str(holdout_from)],
                check=True,
            )
            style = self.work / STYLE_INTENT
            text = style.read_text(encoding="utf8")
            for pattern, replacement in STYLE_EDITS:
                text, count = re.subn(pattern, replacement.format(n=holdout_from), text)
                if count != 1:
                    raise SystemExit(f"风格意图里没找到要改的那句（{pattern[:20]}…），这份抽取作品的意图写法不同，先看一眼再改脚本")
            style.write_text(text, encoding="utf8")
            shutil.copytree(self.work, self.ref)
            for path in sorted(self.reference.glob("beat-*.md")):
                shutil.copy(path, self.ref / "text" / path.name)
            self.logs.mkdir(parents=True, exist_ok=True)
            for name, path in (("init-work", self.work), ("init-ref", self.ref)):
                result = self.suim(path, ["init"], name)
                if not result.get("ok"):
                    raise SystemExit(f"suim init 失败：{path}")
        self.logs.mkdir(parents=True, exist_ok=True)
        return sorted(path.stem for path in self.reference.glob("beat-*.md"))

    def committed(self, beats: list[str]) -> list[str]:
        return [beat for beat in beats if self.git(self.work, "cat-file", "-e", f"refs/suiming/canon:text/{beat}.md").returncode == 0]

    # ② 续写、审稿、提交：一句作者消息，没写完就说「继续」
    def build_identity(self) -> dict:
        """写正文那次的构建：第一轮开始前记下，之后续跑出汇总也报它，而不是续跑时的 dist。"""
        path = self.logs / "build.json"
        if not path.exists():
            path.write_text(json.dumps({"commit": self.commit, "dist": self.fingerprint}), encoding="utf8")
        return json.loads(path.read_text(encoding="utf8"))

    def write(self, beats: list[str]) -> list[dict]:
        if len(self.committed(beats)) < len(beats) and self.build_identity()["dist"] != self.fingerprint:
            raise SystemExit("前面的 turn 用的是另一份 dist，接着写会把两次构建混进一份结果；换一个输出目录重跑")
        turns: list[dict] = []
        for path in sorted(self.logs.glob("turn-*.json")):
            turns.append(json.loads(path.read_text(encoding="utf8") or "{}"))
        message = (
            f"按设计写 {beats[0]} 到 {beats[-1]} 共 {len(beats)} 节的正文，接着前面的原作往下写，"
            "语气、节奏和人物说话方式与前文一致。写完独立审稿，按意见修，检查并提交。"
        )
        while len(self.committed(beats)) < len(beats) and len(turns) <= MAX_CONTINUES:
            session = next((turn.get("data", {}).get("session", {}).get("id") for turn in reversed(turns) if turn.get("ok")), None)
            first = ["session", "goal", "set", message] if self.goal else ["session", "send", message]
            args = first if session is None else ["session", "send", "--session", session, "继续"]
            turn = self.suim(self.work, args, f"turn-{len(turns) + 1}")
            # 存档里补上耗时与退出码，续跑时读得回来
            (self.logs / f"turn-{len(turns) + 1}.json").write_text(json.dumps(turn, ensure_ascii=False), encoding="utf8")
            turns.append(turn)
            if not turn.get("ok") and session is None:
                break
        return turns

    # ③ 指标与评委
    def score(self, beats: list[str]) -> tuple[dict, dict]:
        compare = load_module("compare", COMPARE)
        metrics: dict[str, dict] = {}
        ranks: dict[str, dict] = {}
        for beat in self.committed(beats):
            candidate = self.git(self.work, "show", f"refs/suiming/canon:text/{beat}.md").stdout
            original = (self.reference / f"{beat}.md").read_text(encoding="utf8")
            metrics[beat] = compare.measure(candidate, original)
            log = self.logs / f"rank-{beat}.json"
            if not log.exists():
                folder = self.logs / "rank" / beat
                folder.mkdir(parents=True, exist_ok=True)
                # 去掉章标题（章号与标题会泄露哪份是原作）和原作章末残留的按语括号
                strip = lambda text: re.sub(r"[（(]\s*$", "", "\n".join(  # noqa: E731
                    line for line in text.split("\n") if not line.lstrip().startswith("#")
                ).strip()) + "\n"
                (folder / "agent.md").write_text(strip(candidate), encoding="utf8")
                (folder / "original.md").write_text(strip(original), encoding="utf8")
                self.suim(
                    self.ref,
                    ["rank", beat, "--candidate", str(folder / "agent.md"), str(folder / "original.md"),
                     "--rubric", "reader", "--rounds", str(RANK_ROUNDS)],
                    f"rank-{beat}",
                    JUDGE_ENV,
                )
            ranks[beat] = json.loads(log.read_text(encoding="utf8") or "{}")
        return metrics, ranks

    def length_line(self, metrics: dict) -> str:
        """篇幅按原作开不开新章、第一节与其后分开算（路线图第 6 节第 4 项）：第一节接的是原作前文，其后接 Agent 自己的上一节。"""
        heading = re.compile(r"^#+\s*第.+章", re.M)
        rows = []
        for beat, value in sorted(metrics.items()):
            agent, original = map(int, re.match(r"(\d+) / (\d+)", value["字数（候选 / 原作）"]).groups())
            opens = bool(heading.search((self.reference / f"{beat}.md").read_text(encoding="utf8")))
            titled = bool(heading.search(self.git(self.work, "show", f"refs/suiming/canon:text/{beat}.md").stdout))
            rows.append((beat, agent, original, opens, titled))

        def ratio(selected: list[tuple]) -> str:
            total = sum(row[2] for row in selected)
            return f"{sum(row[1] for row in selected) / total:.2f}" if total else "—"

        first, rest = rows[:1], rows[1:]
        return (
            f"- 篇幅：合计 {ratio(rows)} 倍；原作开新章的 {sum(r[3] for r in rows)} 节 {ratio([r for r in rows if r[3]])} 倍，"
            f"章内续接的 {sum(not r[3] for r in rows)} 节 {ratio([r for r in rows if not r[3]])} 倍；"
            f"第一节 {ratio(first)} 倍，其后 {ratio(rest)} 倍；Agent 稿带章题 {sum(r[4] for r in rows)} / {len(rows)} 节"
        )

    def summarize(self, beats: list[str], turns: list[dict], metrics: dict, ranks: dict) -> None:
        check = self.suim(self.work, ["check"], "check")
        revisions = self.git(self.work, "rev-list", "--count", "refs/suiming/canon").stdout.strip()
        changed = self.git(self.work, "diff", "--name-only", "refs/suiming/canon~" + str(max(int(revisions or 1) - 1, 0)),
                           "refs/suiming/canon").stdout.split()
        # 作品仓的 main 分支没有提交，git status 会把整个目录算成未跟踪；候选与过时审稿以 suim status 为准
        status = self.suim(self.work, ["status"], "status").get("data", {})
        committed = self.committed(beats)
        results = {
            # 写正文那次的提交与 dist 指纹；dist 才是构建的身份（中间只有文档提交时两者不一一对应）
            "repo": self.build_identity()["commit"],
            "dist": self.build_identity()["dist"],
            "heldOut": beats,
            "goal": self.goal,
            "committed": committed,
            "canonRevisions": int(revisions or 0),
            "changedSinceGenesis": changed,
            "uncommittedChanges": status.get("candidate", {}).get("uncommittedChanges"),
            "staleReviews": status.get("stale", {}).get("reviews", {}).get("ids", []),
            "turns": [
                {
                    "ok": turn.get("ok"),
                    "seconds": turn.get("_seconds"),
                    "status": turn.get("data", {}).get("session", {}).get("status"),
                    "goal": turn.get("data", {}).get("session", {}).get("goal"),
                    "turns": turn.get("data", {}).get("session", {}).get("turn"),
                    "usage": turn.get("data", {}).get("session", {}).get("usage"),
                    "lastFailure": turn.get("data", {}).get("session", {}).get("lastFailure"),
                    "error": turn.get("error"),
                    "reply": turn.get("data", {}).get("reply", "")[:2000],
                }
                for turn in turns
            ],
            "check": check.get("data") if check.get("ok") else check.get("error"),
            "metrics": metrics,
            "ranks": {
                beat: (
                    {item["label"]: item["averageRank"] for item in rank["data"]["ranking"]}
                    | {"rounds": rank["data"]["rounds"], "judge": rank["data"]["judge"]["model"]}
                    if rank.get("ok")
                    else {"error": rank.get("error")}
                )
                for beat, rank in ranks.items()
            },
        }
        (self.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf8")
        # 每节按 Agent 赢了几轮分档：两个候选时平均名次 1 是轮轮都赢，2 是一轮没赢。
        # 只有各轮全一致才算明确，其余是倾向或持平；评委没交出结果的节单列，不算持平
        failed = [beat for beat, value in results["ranks"].items() if "error" in value]
        tally: dict[str, int] = {}
        for value in results["ranks"].values():
            if "error" in value:
                continue
            rounds = value["rounds"]
            won = round((2 - value["agent"]) * rounds)
            key = "Agent 全胜" if won == rounds else "原作全胜" if won == 0 else "持平" if 2 * won == rounds else "Agent 占多" if 2 * won > rounds else "原作占多"
            tally[key] = tally.get(key, 0) + 1
        lines = [
            f"# 留出全流程结果（构建 {results['repo']} · dist {results['dist']}）",
            "",
            f"- 留出 {len(beats)} 节，提交了 {len(committed)} 节；Canon 共 {results['canonRevisions']} 个版本；"
            f"未提交改动 {results['uncommittedChanges']}；审稿 {sum(1 for path in changed if path.startswith('review/'))} 份，"
            f"其中过时 {len(results['staleReviews'])} 份",
            f"- turn {len(turns)} 次（其中「继续」{max(len(turns) - 1, 0)} 次）：" + "；".join(
                f"{'ok' if turn['ok'] else 'fail'} {turn['seconds']}s {turn['status']} 调用 {(turn['usage'] or {}).get('calls')} 估算 ${(turn['usage'] or {}).get('costUsd', 0):.2f}"
                for turn in results["turns"]
            ),
            f"- check：{'passed' if (results['check'] or {}).get('passed') else results['check']}",
            *(
                [
                    "- 目标："
                    + (
                        f"{goal['status']}，自动续跑 {goal['autoTurns']} 轮；{goal.get('reason', '')}"
                        if (goal := (results["turns"][-1] if results["turns"] else {}).get("goal"))
                        else "没有"
                    )
                ]
                if self.goal
                else []
            ),
            # 留出评测的前提是两边按同一份 Design 写；Agent 改了 Design 或别的作品文件，在这里点名，评分时心里有数
            "- 正文与审稿之外的改动：" + ("、".join(other) if (other := [
                path for path in changed if not path.startswith(("text/", "review/"))
            ]) else "无"),
            self.length_line(metrics),
            f"- 读者口径评委（{JUDGE_ENV['SUIMING_JUDGE_MODEL_ID']}，{RANK_ROUNDS} 轮）："
            + "，".join(f"{key} {tally.get(key, 0)} 节" for key in ("Agent 全胜", "Agent 占多", "持平", "原作占多", "原作全胜"))
            + (f"，评委没交出结果 {len(failed)} 节（{'、'.join(failed)}）" if failed else ""),
        ]
        (self.out / "results.md").write_text("\n".join(lines) + "\n", encoding="utf8")
        print("\n".join(lines))


def main() -> None:
    args = sys.argv[1:]
    if "--holdout-from" not in args:
        raise SystemExit(__doc__)
    goal = "--goal" in args
    if goal:
        args.remove("--goal")
    at = args.index("--holdout-from")
    holdout_from = int(args[at + 1])
    del args[at : at + 2]
    extraction, reply, out = (Path(arg).expanduser().resolve() for arg in args)
    pipeline = Pipeline(out, goal)
    beats = pipeline.build(extraction, reply, holdout_from)
    turns = pipeline.write(beats)
    metrics, ranks = pipeline.score(beats)
    pipeline.summarize(beats, turns, metrics, ranks)


if __name__ == "__main__":
    main()
