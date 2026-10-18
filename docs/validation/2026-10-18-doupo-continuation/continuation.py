"""斗破接着往下写第 121–140 章：Agent 按作品意图自己设计并写这一段，原作第 121–140 章作参照（路线图第 6 节第 6 项）。

用法（在仓库根目录）：
  DOUPO_CHAPTERS=<按章拆分的原文目录> python3 -I docs/validation/2026-10-18-doupo-continuation/continuation.py \
      <120 章抽取作品> <那次 Agent 的回复.md> <输出目录>

与留出评测的区别：前 120 章的正文全是原作，第 121 章以后没有 Design，Agent 自己定情节；作品意图不改，用的就是作者
原来写的续写要求（每节一万字左右、分三到四章、章号从第一百二十一章接着往下编）。原作不是唯一正确的写法，这一项看的是
Agent 定的情节会不会让设定与人物走样，评委只量「离这部书有多远」。

输出目录不在仓库里（《斗破苍穹》原文，不进 MIT 仓库）：
- work/       评测作品：前 120 章放原作正文，`source/` 去掉
- reference/  原作第 121–140 章，`chapter-0121.md` 起，与正文同一套清洗
- logs/       每一步的原始 JSON 输出与 stderr；`original-beats.json` 是搭好时已有的节
- results.json、results.md

能续跑：已经有输出的步骤跳过；没写到第 140 章就替作者说「继续」，最多两次，说过几次照实记下。
搭作品用 2026-10-03 的 build_eval_work.py（续写模式），执行、dist 指纹与评委配置复用 2026-10-17 的 holdout.py：
跑之前先构建，跑的过程中不要重建 dist。
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HOLDOUT = REPO / "docs/validation/2026-10-17-doupo-holdout-pipeline/holdout.py"
FIRST, LAST = 121, 140
HEADING = re.compile(r"^##\s*第\s*(\d+)\s*章[^\n]*$", re.M)
MESSAGE = (
    f"接着第 {FIRST - 1} 章往下写第 {FIRST} 到第 {LAST} 章，写到第 {LAST} 章为止：先把这一段的情节设计写进 Design，"
    "再按设计写正文，语气、节奏和人物说话方式与前文一致。写完独立审稿，按意见修，检查并提交。"
)


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


holdout = load("holdout", HOLDOUT)


def strip_headings(text: str) -> str:
    """评委比较前去掉章标题（章号与标题会泄露哪份是原作）。"""
    return "\n".join(line for line in text.split("\n") if not line.lstrip().startswith("#")).strip() + "\n"


class Continuation(holdout.Pipeline):
    # ① 搭作品：前 120 章全放原作，参照第 121–140 章
    def build_work(self, extraction: Path, reply: Path) -> None:
        if not self.work.exists():
            if "DOUPO_CHAPTERS" not in os.environ:
                raise SystemExit("设 DOUPO_CHAPTERS 指向按章拆分的原文目录")
            subprocess.run(
                [sys.executable, "-I", str(holdout.BUILDER), str(extraction), str(reply), str(self.work),
                 str(self.reference), "--reference-chapters", f"{FIRST}-{LAST}"],
                check=True,
            )
            self.logs.mkdir(parents=True, exist_ok=True)
            (self.logs / "original-beats.json").write_text(
                json.dumps(sorted(path.stem for path in (self.work / "text").glob("beat-*.md"))), encoding="utf8"
            )
            if not self.suim(self.work, ["init"], "init-work").get("ok"):
                raise SystemExit(f"suim init 失败：{self.work}")
        self.logs.mkdir(parents=True, exist_ok=True)

    def original_beats(self) -> set[str]:
        return set(json.loads((self.logs / "original-beats.json").read_text(encoding="utf8")))

    def new_beats(self) -> dict[str, str]:
        """Canon 里新加的节与它们的正文。"""
        listed = self.git(self.work, "ls-tree", "--name-only", "refs/suiming/canon", "text/").stdout.split()
        stems = [Path(path).stem for path in listed if path.endswith(".md")]
        return {
            stem: self.git(self.work, "show", f"refs/suiming/canon:text/{stem}.md").stdout
            for stem in stems
            if stem not in self.original_beats()
        }

    def chapters(self) -> dict[int, str]:
        """新写的正文按章题切开：章号 → 这一章的正文（含章题）。没有章题的节接在它前面那一章后面，按节号顺序。"""
        out: dict[int, str] = {}
        current: int | None = None
        for _, text in sorted(self.new_beats().items()):
            marks = list(HEADING.finditer(text))
            if marks and marks[0].start() > 0 and current is not None:
                out[current] += "\n\n" + text[: marks[0].start()]
            elif not marks and current is not None:
                out[current] += "\n\n" + text
            for index, mark in enumerate(marks):
                end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
                current = int(mark.group(1))
                out[current] = out.get(current, "") + text[mark.start() : end]
        return out

    def done(self) -> bool:
        return all(number in self.chapters() for number in range(FIRST, LAST + 1))

    # ② 设计并续写、审稿、提交：一句作者消息，没写到第 140 章就说「继续」
    def write_all(self) -> list[dict]:
        if not self.done() and self.build_identity()["dist"] != self.fingerprint:
            raise SystemExit("前面的 turn 用的是另一份 dist，接着写会把两次构建混进一份结果；换一个输出目录重跑")
        turns = [json.loads(path.read_text(encoding="utf8") or "{}") for path in sorted(self.logs.glob("turn-*.json"))]
        while not self.done() and len(turns) <= holdout.MAX_CONTINUES:
            session = next((turn.get("data", {}).get("session", {}).get("id") for turn in reversed(turns) if turn.get("ok")), None)
            args = ["session", "send", MESSAGE] if session is None else ["session", "send", "--session", session, "继续"]
            turn = self.suim(self.work, args, f"turn-{len(turns) + 1}")
            (self.logs / f"turn-{len(turns) + 1}.json").write_text(json.dumps(turn, ensure_ascii=False), encoding="utf8")
            turns.append(turn)
            if not turn.get("ok") and session is None:
                break
        return turns

    # ③ 指标与评委
    def score_all(self) -> tuple[dict, dict]:
        compare = holdout.load_module("compare", holdout.COMPARE)
        chapters = self.chapters()
        metrics = {
            number: compare.measure(chapters[number], (self.reference / f"chapter-{number:04d}.md").read_text(encoding="utf8"))
            for number in range(FIRST, LAST + 1)
            if number in chapters
        }
        # 评委按节比：Agent 这一节对原作同号的那几章。第一节的前文是原作第 120 章，之后各节的前文是 Agent 自己的上一节，
        # 对 Agent 略有利（2026-10-03 留出时记过同样的偏差）。
        ranks: dict[str, dict] = {}
        for beat, text in sorted(self.new_beats().items()):
            numbers = [int(mark.group(1)) for mark in HEADING.finditer(text) if FIRST <= int(mark.group(1)) <= LAST]
            if not numbers:
                continue
            log = self.logs / f"rank-{beat}.json"
            if not log.exists():
                folder = self.logs / "rank" / beat
                folder.mkdir(parents=True, exist_ok=True)
                original = "\n\n".join(
                    (self.reference / f"chapter-{number:04d}.md").read_text(encoding="utf8") for number in numbers
                )
                (folder / "agent.md").write_text(strip_headings(text), encoding="utf8")
                (folder / "original.md").write_text(strip_headings(original), encoding="utf8")
                self.suim(
                    self.work,
                    ["rank", beat, "--candidate", str(folder / "agent.md"), str(folder / "original.md"),
                     "--rubric", "reader", "--rounds", str(holdout.RANK_ROUNDS)],
                    f"rank-{beat}",
                    holdout.JUDGE_ENV,
                )
            ranks[beat] = json.loads(log.read_text(encoding="utf8") or "{}") | {"chapters": numbers}
        return metrics, ranks

    def summarize_all(self, turns: list[dict], metrics: dict, ranks: dict) -> None:
        check = self.suim(self.work, ["check"], "check")
        status = self.suim(self.work, ["status"], "status").get("data", {})
        genesis = self.git(self.work, "rev-list", "--max-parents=0", "refs/suiming/canon").stdout.split()[0]
        changes = [
            line.split("\t", 1)
            for line in self.git(self.work, "diff", "--name-status", genesis, "refs/suiming/canon").stdout.splitlines()
        ]
        # 前 120 章已有的作品文件被改了哪些：续写可能合理地更新人物与世界，但要点名，读结果时心里有数
        touched = [path for kind, path in changes if kind != "A" and not path.startswith("review/")]
        written = {number: re.match(r"(\d+) / (\d+)", value["字数（候选 / 原作）"]).groups() for number, value in metrics.items()}
        agent_total = sum(int(agent) for agent, _ in written.values())
        original_total = sum(int(original) for _, original in written.values())
        tally: dict[str, int] = {}
        for value in ranks.values():
            if not value.get("ok"):
                tally["评委没交出结果"] = tally.get("评委没交出结果", 0) + 1
                continue
            ranking = {item["label"]: item for item in value["data"]["ranking"]}
            won = sum(rank == 1 for rank in ranking["agent"]["ranks"])
            rounds = value["data"]["rounds"]
            key = "Agent 全胜" if won == rounds else "原作全胜" if won == 0 else "持平" if 2 * won == rounds else "Agent 占多" if 2 * won > rounds else "原作占多"
            tally[key] = tally.get(key, 0) + 1
        results = {
            "repo": self.build_identity()["commit"],
            "dist": self.build_identity()["dist"],
            "turns": [
                {
                    "ok": turn.get("ok"),
                    "seconds": turn.get("_seconds"),
                    "status": turn.get("data", {}).get("session", {}).get("status") if turn.get("ok") else turn.get("error"),
                    "usage": turn.get("data", {}).get("session", {}).get("usage") if turn.get("ok") else None,
                }
                for turn in turns
            ],
            "newBeats": sorted(self.new_beats()),
            "chapters": sorted(self.chapters()),
            "check": check.get("data") if check.get("ok") else check.get("error"),
            "uncommittedChanges": status.get("candidate", {}).get("uncommittedChanges"),
            "staleReviews": status.get("stale", {}).get("reviews", {}).get("ids", []),
            "touchedExisting": touched,
            "metrics": {str(number): value for number, value in metrics.items()},
            "ranks": {
                beat: {"chapters": value["chapters"]}
                | (
                    {item["label"]: item["ranks"] for item in value["data"]["ranking"]} | {"judge": value["data"]["judge"]}
                    if value.get("ok")
                    else {"error": value.get("error")}
                )
                for beat, value in ranks.items()
            },
        }
        (self.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf8")
        missing = [number for number in range(FIRST, LAST + 1) if number not in metrics]
        lines = [
            f"# 第 {FIRST}–{LAST} 章续写结果（构建 {results['repo']} · dist {results['dist']}）",
            "",
            f"- 新加 {len(results['newBeats'])} 节，写到的章：{results['chapters'][:1]}…{results['chapters'][-1:]}"
            + (f"；缺第 {'、'.join(map(str, missing))} 章" if missing else "；第 121–140 章齐"),
            f"- turn {len(turns)} 次（其中「继续」{max(len(turns) - 1, 0)} 次）：" + "；".join(
                f"{'ok' if turn['ok'] else 'fail'} {turn['seconds']}s {turn['status']} 调用 {(turn['usage'] or {}).get('calls')} "
                f"估算 ${(turn['usage'] or {}).get('costUsd', 0):.2f}"
                for turn in results["turns"]
            ),
            f"- check：{'passed' if (results['check'] or {}).get('passed') else results['check']}；未提交改动 "
            f"{results['uncommittedChanges']}；过时审稿 {len(results['staleReviews'])} 份",
            "- 改了前 120 章已有的作品文件：" + ("、".join(touched) if touched else "无"),
            f"- 篇幅：第 {FIRST}–{LAST} 章里写到的 {len(metrics)} 章合计 {agent_total} 字，原作同号章 {original_total} 字"
            + (f"（{agent_total / original_total:.2f} 倍）" if original_total else ""),
            f"- 读者口径评委（{holdout.JUDGE_ENV['SUIMING_JUDGE_MODEL_ID']}，{holdout.RANK_ROUNDS} 轮，按节对原作同号章）："
            + "，".join(f"{key} {count} 节" for key, count in tally.items()),
        ]
        (self.out / "results.md").write_text("\n".join(lines) + "\n", encoding="utf8")
        print("\n".join(lines))


def main() -> None:
    args = sys.argv[1:]
    if len(args) != 3:
        raise SystemExit(__doc__)
    extraction, reply, out = (Path(arg).expanduser().resolve() for arg in args)
    run = Continuation(out)
    run.build_work(extraction, reply)
    turns = run.write_all()
    metrics, ranks = run.score_all()
    run.summarize_all(turns, metrics, ranks)


if __name__ == "__main__":
    main()
