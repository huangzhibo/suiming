"""在已有的留出稿子上换评委配置重跑读者口径评委，量位置偏差。不写新稿。

用法（在仓库根目录）：
  python3 -I docs/validation/2026-10-17-judge-position/judge.py <输出目录> <配置名> <留出输出目录>... \
      [--env KEY=VALUE ...] [--rounds 2] [--limit N] [--versus]
  python3 -I docs/validation/2026-10-17-judge-position/judge.py <输出目录> --compare <配置名> <配置名>...

<留出输出目录> 是 holdout.py 的输出目录：评委的候选取自它的 logs/rank/<beat>/{agent,original}.md，前文取自它的 ref/。
--versus 时留出目录两两配对，每节拿两次运行的 Agent 稿互比（改前改后对照就是这种情形），前文取每对第一个的 ref/。
每个配置把 ref/ 复制一份到 <输出目录>/<配置名>/<留出名>/ref 再跑，原来的评测记录不动；几次留出并行，各自 24 节依次跑。
--env 覆盖 .env 里的同名变量，比如开思考：
  --env 'SUIMING_JUDGE_MODEL_OPTIONS={"maxTokens":32768,"reasoningEffort":"high"}'

--limit N 只跑每次留出的前 N 节，用来先试配置通不通。能续跑：已经交出结果的节跳过。跑完打印并写下 summary.json：
- 先出场胜率：每轮名次第一的候选在本轮是不是先出场的那一版（2 个候选时 50% 是没有位置偏差）
- 两种顺序一致：一节里各轮第一名都是同一版的节数（2 轮时就是正反两种顺序结论相同）
- 评委的模型与思考档位取自每个评委子任务的模型记录，不信配置
--compare 比较同一批稿子在几次运行之间的结论：两轮都选同一版算明确，两次都明确时相同还是相反。
suim 用本仓的 apps/cli/dist/bin.js；跑的过程中不要重建 dist。
"""

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "apps/cli/dist/bin.js"


def environment(overrides: dict[str, str]) -> dict[str, str]:
    """与 holdout.py 相同：本仓 .env，shell 里已有的同名变量优先；--env 最优先。"""
    env = dict(os.environ)
    dotenv = REPO / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf8").splitlines():
            match = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
            if match:
                env.setdefault(match.group(1), re.sub(r"^([\"'])(.*)\1$", r"\2", match.group(2)))
    env.update(overrides)
    return env


def dist_fingerprint() -> str:
    digest = hashlib.sha256()
    for root in ("packages/story/dist", "packages/sdk/dist", "packages/runtime/dist", "apps/cli/dist"):
        for path in sorted((REPO / root).rglob("*")):
            if path.is_file():
                info = path.stat()
                digest.update(f"{path}\0{info.st_size}\0{info.st_mtime_ns}\n".encode())
    return digest.hexdigest()[:16]


class Store:
    """评委每轮的结果是执行对象（rank-round-result），模型记录在 tasks 里；只读。"""

    def __init__(self, ref: Path) -> None:
        self.root = ref / ".suiming"
        self.db = sqlite3.connect(f"file:{self.root / 'local.sqlite'}?mode=ro", uri=True)

    def object(self, object_id: str) -> dict:
        inline, digest = self.db.execute(
            "select inline_bytes, object_hash from execution_objects where id = ?", (object_id,)
        ).fetchone()
        if inline is None:
            digest = digest.removeprefix("sha256:")
            inline = (self.root / "objects" / digest[:2] / digest[2:]).read_bytes()
        return json.loads(inline)

    def judges(self, session_id: str) -> set[str]:
        models = set()
        for (data,) in self.db.execute("select data_json from tasks where session_id = ?", (session_id,)):
            model = json.loads(data).get("model") or {}
            models.add(f"{model.get('provider')}/{model.get('model')} thinking={model.get('thinking', '?')}")
        return models


def jobs(holdouts: list[Path], versus: bool) -> list[tuple[str, Path, dict[str, list[tuple[str, Path]]]]]:
    """每个任务：(目标名, 取前文的留出目录, 每节的候选 [(label, 文件)])。

    默认每次留出各自一个任务，候选是它的 Agent 稿对原作；--versus 时留出目录两两配对，候选是两次的 Agent 稿。
    """
    def drafts(holdout: Path) -> dict[str, Path]:
        return {folder.name: folder for folder in sorted((holdout / "logs" / "rank").iterdir())}

    if not versus:
        return [
            (h.name, h, {beat: [("agent", f / "agent.md"), ("original", f / "original.md")] for beat, f in drafts(h).items()})
            for h in holdouts
        ]
    if len(holdouts) % 2 != 0:
        raise SystemExit("--versus 要成对给留出目录")
    pairs = []
    for a, b in zip(holdouts[::2], holdouts[1::2]):
        left, right = drafts(a), drafts(b)
        pairs.append((
            f"{a.name}--{b.name}",
            a,
            {beat: [(a.name, left[beat] / "agent.md"), (b.name, right[beat] / "agent.md")] for beat in left if beat in right},
        ))
    return pairs


def run_job(name: str, holdout: Path, beats: dict[str, list[tuple[str, Path]]], target: Path, env: dict[str, str],
            rounds: int, fingerprint: str, limit: int) -> None:
    ref = target / "ref"
    if not ref.exists():
        target.mkdir(parents=True, exist_ok=True)
        # APFS 上是写时复制，十几 MB 的参照作品不占多余空间
        subprocess.run(["cp", "-cR", str(holdout / "ref"), str(ref)], check=True)
    for beat, candidates in list(beats.items())[:limit]:
        log = target / f"rank-{beat}.json"
        if log.exists() and json.loads(log.read_text(encoding="utf8") or "{}").get("ok"):
            continue
        if dist_fingerprint() != fingerprint:
            raise SystemExit("dist 在运行中变了，之后的结果与前面不可比，停止。")
        # suim rank 用文件名当 label，候选按 label 复制一份
        folder = target / "candidates" / beat
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        for label, source in candidates:
            (folder / f"{label}.md").write_bytes(source.read_bytes())
            files.append(str(folder / f"{label}.md"))
        started = time.time()
        done = subprocess.run(
            ["node", str(CLI), "--json", "rank", beat, "--candidate", *files, "--rubric", "reader", "--rounds", str(rounds)],
            cwd=ref, env=env, capture_output=True, text=True, check=False,
        )
        log.write_text(done.stdout, encoding="utf8")
        if done.stderr.strip():
            (target / f"rank-{beat}.err").write_text(done.stderr, encoding="utf8")
        try:
            status = "ok" if json.loads(done.stdout).get("ok") else "fail"
        except json.JSONDecodeError:
            status = f"非 JSON 输出（exit {done.returncode}）"
        print(f"{name} {beat} {status} {time.time() - started:.0f}s", flush=True)


def summarize(target: Path) -> dict:
    store = Store(target / "ref")
    rounds = first = beats = consistent = cost = 0
    wins: dict[str, int] = {}
    failed: list[str] = []
    judges: set[str] = set()
    for log in sorted(target.glob("rank-*.json")):
        beat = log.stem.removeprefix("rank-")
        envelope = json.loads(log.read_text(encoding="utf8") or "{}")
        if not envelope.get("ok"):
            failed.append(beat)
            continue
        data = envelope["data"]
        judges |= store.judges(data["sessionId"])
        winners = []
        for object_id in data["roundResultObjectIds"]:
            record = store.object(object_id)
            result = record["result"]
            top = min(result["ranking"], key=lambda item: item["rank"])["label"]
            winners.append(top)
            rounds += 1
            first += result["order"][0] == top
            wins[top] = wins.get(top, 0) + 1
            cost += record["usage"]["costUsd"]
        beats += 1
        consistent += len(set(winners)) == 1
    return {
        "beats": beats, "failed": failed, "rounds": rounds, "firstWins": first, "consistentBeats": consistent,
        "wins": wins, "costUsd": round(cost, 2), "judges": sorted(judges),
    }


def verdicts(target: Path) -> dict[str, str]:
    """每节的结论：各轮第一名都是同一版就是那一版的 label，否则 split；没交出结果是 fail。"""
    store = Store(target / "ref")
    out = {}
    for log in sorted(target.glob("rank-*.json")):
        envelope = json.loads(log.read_text(encoding="utf8") or "{}")
        beat = log.stem.removeprefix("rank-")
        if not envelope.get("ok"):
            out[beat] = "fail"
            continue
        winners = {
            min(store.object(object_id)["result"]["ranking"], key=lambda item: item["rank"])["label"]
            for object_id in envelope["data"]["roundResultObjectIds"]
        }
        out[beat] = winners.pop() if len(winners) == 1 else "split"
    return out


def compare(out: Path, variants: list[str]) -> None:
    """同一批稿子在几次运行之间的结论是否可复现：两次都有明确结论时相同还是相反。"""
    runs = {
        variant: {
            (target.name, beat): verdict
            for target in sorted((out / variant).iterdir()) if target.is_dir()
            for beat, verdict in verdicts(target).items()
        }
        for variant in variants
    }
    decided = lambda value: value not in ("split", "fail")  # noqa: E731
    for variant, run in runs.items():
        values = list(run.values())
        print(f"{variant}：明确 {sum(map(decided, values))}，split {values.count('split')}，fail {values.count('fail')}，共 {len(values)}")
    for i, a in enumerate(variants):
        for b in variants[i + 1:]:
            keys = [key for key in runs[a] if key in runs[b]]
            both = [key for key in keys if decided(runs[a][key]) and decided(runs[b][key])]
            same = sum(runs[a][key] == runs[b][key] for key in both)
            mixed = sum(decided(runs[a][key]) != decided(runs[b][key]) for key in keys)
            print(f"{a} × {b}：两次都明确 {len(both)}，其中相同 {same}、相反 {len(both) - same}；一次明确一次不明确 {mixed}")


def main() -> None:
    args = sys.argv[1:]
    overrides: dict[str, str] = {}
    rounds = 2
    limit = 10_000
    versus = False
    positional: list[str] = []
    while args:
        arg = args.pop(0)
        if arg == "--env":
            key, _, value = args.pop(0).partition("=")
            overrides[key] = value
        elif arg == "--rounds":
            rounds = int(args.pop(0))
        elif arg == "--limit":
            limit = int(args.pop(0))
        elif arg == "--versus":
            versus = True
        else:
            positional.append(arg)
    if "--compare" in positional:
        index = positional.index("--compare")
        compare(Path(positional[0]).expanduser(), positional[index + 1:])
        return
    if len(positional) < 3:
        raise SystemExit(__doc__)
    out, variant, holdouts = Path(positional[0]).expanduser(), positional[1], [Path(p).expanduser() for p in positional[2:]]
    env = environment(overrides)
    fingerprint = dist_fingerprint()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    root = out / variant
    root.mkdir(parents=True, exist_ok=True)
    (root / "config.json").write_text(
        json.dumps({"commit": commit, "dist": fingerprint, "rounds": rounds, "versus": versus, "env": overrides}, ensure_ascii=False, indent=2),
        encoding="utf8",
    )
    work = jobs(holdouts, versus)
    with ThreadPoolExecutor(max_workers=len(work)) as pool:
        futures = [
            pool.submit(run_job, name, holdout, beats, root / name, env, rounds, fingerprint, limit)
            for name, holdout, beats in work
        ]
        for future in futures:
            future.result()
    summary = {name: summarize(root / name) for name, _, _ in work}
    total = {key: sum(item[key] for item in summary.values()) for key in
             ("beats", "rounds", "firstWins", "consistentBeats", "costUsd")}
    total["failed"] = sum(len(item["failed"]) for item in summary.values())
    summary["合计"] = total
    (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8")
    for name, item in summary.items():
        failed = item["failed"] if isinstance(item["failed"], int) else len(item["failed"])
        print(
            f"{name}: 先出场胜 {item['firstWins']} / {item['rounds']}（{item['firstWins'] / max(item['rounds'], 1):.0%}），"
            f"两种顺序一致 {item['consistentBeats']} / {item['beats']}，"
            + "".join(f"{label} 胜 {count} 轮，" for label, count in item.get("wins", {}).items())
            + f"失败 {failed} 节，"
            f"${item['costUsd']:.2f}" + (f"，{'；'.join(item['judges'])}" if item.get("judges") else "")
        )


if __name__ == "__main__":
    main()
