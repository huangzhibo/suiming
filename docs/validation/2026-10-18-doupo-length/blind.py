"""从改前、改后两次留出里挑几节，做成给作者的盲读包（路线图第 6 节第 5 项）。

用法（在仓库根目录）：
  python3 -I docs/validation/2026-10-18-doupo-length/blind.py <改前留出目录> <改后留出目录> <评委互比目录> <盲读包目录> [--count 8]

<评委互比目录> 是 judge.py --versus 对这两次留出的输出（如 <输出目录>/<配置名>/<改前名>--<改后名>）。按评委 4 轮的结论挑节：
两边各取判得最确定（4:0）的，再补不确定的（3:1、2:2），一共 --count 节。每节两版匿名成甲、乙，顺序按节号定的随机；
前文给评委看到的同一段原作结尾。来源与评委结论封在 sealed/，作者写完 answer.md 之前不看。

盲读包是《斗破苍穹》的续写，不进仓库。
"""

import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PRIOR_CHARACTERS = 1500


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


judge = load("judge", REPO / "docs/validation/2026-10-17-judge-position/judge.py")


def strip_headings(text: str) -> str:
    return "\n".join(line for line in text.split("\n") if not line.lstrip().startswith("#")).strip() + "\n"


def beat_order(work: Path) -> list[str]:
    index = (work / "outline/story/index.yaml").read_text(encoding="utf8")
    return [beat for line in re.findall(r"beat_ids:\s*\[([^\]]*)\]", index) for beat in re.findall(r"beat-\d+", line)]


def main() -> None:
    args = sys.argv[1:]
    count = 8
    if "--count" in args:
        at = args.index("--count")
        count = int(args[at + 1])
        del args[at : at + 2]
    if len(args) != 4:
        raise SystemExit(__doc__)
    before, after, versus, pack = (Path(arg).expanduser().resolve() for arg in args)
    if pack.exists():
        raise SystemExit(f"{pack} 已存在")
    store = judge.Store(versus / "ref")
    rounds: dict[str, list[str]] = {}
    for log in sorted(versus.glob("rank-beat-*.json")):
        envelope = json.loads(log.read_text(encoding="utf8") or "{}")
        if not envelope.get("ok"):
            continue
        rounds[log.stem.removeprefix("rank-")] = [
            min(store.object(object_id)["result"]["ranking"], key=lambda item: item["rank"])["label"]
            for object_id in envelope["data"]["roundResultObjectIds"]
        ]
    wins = {beat: sum(label == before.name for label in winners) for beat, winners in rounds.items()}
    full = {beat: len(winners) for beat, winners in rounds.items()}
    sure_before = [beat for beat in sorted(wins) if wins[beat] == full[beat]]
    sure_after = [beat for beat in sorted(wins) if wins[beat] == 0]
    unsure = sorted((beat for beat in wins if 0 < wins[beat] < full[beat]), key=lambda beat: (abs(2 * wins[beat] - full[beat]), beat))
    picked: list[str] = []
    each = count // 3
    for group in (sure_before[:each], sure_after[:each], unsure):
        for beat in group:
            if len(picked) < count and beat not in picked:
                picked.append(beat)
    for beat in sure_before + sure_after:
        if len(picked) < count and beat not in picked:
            picked.append(beat)
    picked.sort()

    order = beat_order(before / "ref")
    key_lines = ["# 盲读包的来源（作者写完 answer.md 再看）", "", "| 节 | 甲 | 乙 | 评委 4 轮（改前胜几轮） |", "| --- | --- | --- | --- |"]
    answer = ["# 盲读回答", "", "每节写选哪一版（甲 / 乙 / 差不多）和一句理由。理由比选择重要。", ""]
    for beat in picked:
        folder = pack / beat
        folder.mkdir(parents=True)
        texts = {
            "改前": (before / "logs" / "rank" / beat / "agent.md").read_text(encoding="utf8"),
            "改后": (after / "logs" / "rank" / beat / "agent.md").read_text(encoding="utf8"),
        }
        flip = int(hashlib.sha256(beat.encode()).hexdigest(), 16) % 2 == 1
        first, second = ("改后", "改前") if flip else ("改前", "改后")
        (folder / "甲.md").write_text(strip_headings(texts[first]), encoding="utf8")
        (folder / "乙.md").write_text(strip_headings(texts[second]), encoding="utf8")
        previous = order[order.index(beat) - 1]
        prior = (before / "ref" / "text" / f"{previous}.md").read_text(encoding="utf8")
        (folder / "前文.md").write_text("……" + strip_headings(prior)[-PRIOR_CHARACTERS:], encoding="utf8")
        key_lines.append(f"| {beat} | {first} | {second} | {wins[beat]} / {full[beat]} |")
        answer += [f"## {beat}", "", "选：", "", "理由：", ""]
    (pack / "sealed").mkdir()
    (pack / "sealed" / "key.md").write_text("\n".join(key_lines) + "\n", encoding="utf8")
    (pack / "answer.md").write_text("\n".join(answer), encoding="utf8")
    (pack / "README.md").write_text(
        "\n".join([
            "# 盲读：斗破第二卷留出的两种写法",
            "",
            f"共 {len(picked)} 节。每节目录里 `甲.md`、`乙.md` 是同一节（同一份情节设计）的两种续写，出自同一个 Agent 的两次运行，"
            "章标题已去掉，顺序随机。`前文.md` 是原作里紧挨着这一节之前的一段，评委看到的也是这一段；"
            "两版在各自的运行里接的是自己写的上一节，开头和前文的衔接对不上时不用扣分。",
            "",
            "题目和评委一样：哪一版读起来更像这部书接着往下写、更让你想接着读。分不出来就写「差不多」。",
            "",
            "读完在 `answer.md` 里填，写完再打开 `sealed/key.md` 看来源与评委的结论。",
            "",
        ]),
        encoding="utf8",
    )
    print(f"盲读包写进 {pack}：{', '.join(picked)}")


if __name__ == "__main__":
    main()
