"""把一份忠实抽取作品搭成续写评测作品：前面各节的正文放原作，原作后文放在作品外当参照。

用法：
  python3 build_eval_work.py <抽取作品> <Agent 回复.md> <评测作品> <参照目录> [--reference-chapters 121-140]
  python3 build_eval_work.py <抽取作品> <Agent 回复.md> <评测作品> <参照目录> --holdout-from 13

- 抽取作品取已提交版本（`refs/suiming/canon`），不碰 checkout 里未提交的东西。
- Agent 回复里有「Target Beat 与原作章节对应」的表与「章内分界：下一节的原文开头句」。每节从它的起点切到下一节的
  起点；起点在章首就从章标记切，落在章内就从给出的那句话切。表的顺序必须与 index 里的 Beat 顺序逐个对上。
- 清洗规则同 2026-10-02 host 记录：剔作者按语、推书行、网站水印与重复的第 72 章，断在句中的换行接回，其余一字不动；
  章标题写成「## 第N章 标题」，与正文风格意图给续写定的格式一致。对照评分前要去掉标题（会泄露身份），compare.py 已经这么做。
- 评测作品去掉 `source/` 与 Source 审稿，免得 Agent 读到答案。参照章节从作者本地的按章原文取，同一套清洗。
- `--holdout-from N`（留出评测）：起始章 ≥ N 的节不放正文，这一节的原作原文写进参照目录的 `<beat>.md`。Agent 按同一份
  抽自原作的 Design 写这几节，与原作逐节对照才公平；Agent 自己定情节的续写与原作比，评委拿着 Agent 的 Design 打分，
  原作会因「不兑现本节 Design」被扣分（2026-10-03 前 12 章续写 6 轮全判 Agent 胜，就是这个偏差）。

只写评测作品与参照目录，不改抽取作品。评测作品写完后要在里面执行一次 `suim init`。
"""

import re
import subprocess
import sys
from pathlib import Path

ORIGINAL_CHAPTERS = Path.home() / "ai/04.web_novel/斗破苍穹/正文"
DUPLICATE_CHAPTERS = {72}  # 第 72 章是第 71 章的整章重复（2026-10-03 逐字核对）

HEADER = re.compile(r"^===== 第(\d{4})章[^\n]*=====$", re.M)


def clean(text: str) -> str:
    """章标记、作者按语、推书行、水印去掉，章标题写成 Markdown 标题；断在句中的换行接回；段与段之间空一行。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 盗版站水印：插在句中、自成一行或几行，2026-10-03 在前 140 章里见到的几种
    text = re.sub(r"—\n*全文字版\n*首发\n*—", "", text)
    for mark in (r"手机轻松阅读：ｗàｐ\.1⑹κ\.ｃn", r"1⑹ｋｗαр\.⑴⑹整理", r"整理发布于ωωω．ㄧб", r"全文字版", r"首发"):
        text = re.sub(mark, "", text)
    lines = []
    for line in text.split("\n"):
        line = re.sub(r"\s{2,}：\s*$", "", line).rstrip()
        stripped = line.strip()
        if HEADER.match(stripped):
            continue
        if re.fullmatch(r"第\d+章.*", stripped):
            lines.append(f"## {stripped}")
            continue
        if stripped.startswith("推荐一本好看的新作"):
            continue
        if re.fullmatch(r"[（(].*[）)]", stripped):
            continue
        if stripped in ("", "：", "—"):
            continue
        lines.append(stripped)
    paragraphs: list[str] = []
    for line in lines:
        if paragraphs and re.search(r"[，、]$", paragraphs[-1]) and not line.startswith(("“", "## ")):
            paragraphs[-1] += line
        else:
            paragraphs.append(line)
    return "\n\n".join(paragraphs) + "\n"


def parse_reply(reply: str, titles: list[str]) -> tuple[list[tuple[str, int]], dict[str, str]]:
    """表里每行：(标题, 起始章)；章内分界 → 下一节开头的那句原文，按《标题》对上。

    Agent 每次的表格式不一样（有时多一列「第几节」，章内分界有时用 ①② 标号、有时写「第2章 → 第3节《标题》」），
    这里只认两样东西：哪一格是 index 里的 Beat 标题、哪一格写着「第N章」；开头句按引号上方那行里的《标题》对应。
    """
    known = set(titles)
    rows: list[tuple[str, int]] = []
    for line in reply.split("\n"):
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip().strip("*《》") for cell in line.strip().strip("|").split("|")]
        title = next((cell for cell in cells if cell in known), None)
        # 「第3—4章」这种范围只在末尾写一次「章」；「第18节」那一列不是章号
        chapter = next((match for cell in cells if (match := re.search(r"第(\d+)(?:[—–\-~至到]\d+)?章", cell))), None)
        if title is None or chapter is None:
            continue
        rows.append((title, int(chapter.group(1))))
    openings = {
        match.group(1): match.group(2).strip()
        for match in re.finditer(r"《([^》]+)》[^\n]*\n\s*>\s*(.+)", reply)
    }
    return rows, openings


def committed_files(work: Path, out: Path) -> None:
    out.mkdir(parents=True)
    archive = subprocess.run(["git", "archive", "refs/suiming/canon"], cwd=work, capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(out)], input=archive.stdout, check=True)


def beat_order(out: Path) -> list[tuple[str, str]]:
    """index 里的 Beat 顺序与各自的标题。"""
    index = (out / "outline/story/index.yaml").read_text(encoding="utf8")
    order = [beat for ids in re.findall(r"beat_ids:\s*\[([^\]]*)\]", index) for beat in re.split(r"\s*,\s*", ids.strip()) if beat]
    titles = {}
    for path in (out / "outline/story").glob("vol-*/beat-*.md"):
        title = re.search(r"^title:\s*(.+)$", path.read_text(encoding="utf8"), re.M)
        titles[path.stem] = title.group(1).strip().strip("'\"") if title else ""
    return [(beat, titles.get(beat, "")) for beat in order]


def reference(chapters: range, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for number in chapters:
        found = sorted(ORIGINAL_CHAPTERS.glob(f"第{number:04d}章*.txt"))
        if not found:
            raise SystemExit(f"本地原文缺第 {number} 章")
        (target / f"chapter-{number:04d}.md").write_text(clean(found[0].read_text(encoding="utf8")), encoding="utf8")


def main() -> None:
    args = sys.argv[1:]
    chapters = range(121, 141)
    holdout_from: int | None = None
    if "--holdout-from" in args:
        at = args.index("--holdout-from")
        holdout_from = int(args[at + 1])
        del args[at : at + 2]
    if "--reference-chapters" in args:
        at = args.index("--reference-chapters")
        first, last = (int(value) for value in args[at + 1].split("-"))
        chapters = range(first, last + 1)
        del args[at : at + 2]
    work, reply_path, out, reference_dir = (Path(arg).expanduser() for arg in args)
    if out.exists():
        raise SystemExit(f"{out} 已存在")
    committed_files(work, out)
    sources = sorted((out / "source").iterdir())
    if len(sources) != 1:
        raise SystemExit("抽取作品里应当恰好有一份 Source")
    material = (sources[0] / "material.txt").read_text(encoding="utf8")
    order = beat_order(out)
    rows, openings = parse_reply(reply_path.read_text(encoding="utf8"), [title for _, title in order])
    if [title for _, title in order] != [title for title, _ in rows]:
        mismatch = next(
            (i for i, (left, right) in enumerate(zip(order, rows)) if left[1] != right[0]), min(len(order), len(rows))
        )
        raise SystemExit(f"对应表与 index 顺序在第 {mismatch + 1} 节对不上（index {len(order)} 节，表 {len(rows)} 行）")
    heads = {int(match.group(1)): match.start() for match in HEADER.finditer(material)}
    starts = []
    for title, chapter in rows:
        sentence = openings.get(title)
        if sentence is None:
            starts.append(heads[chapter])
            continue
        at = material.find(sentence, heads[chapter])
        if at < 0:
            raise SystemExit(f"《{title}》的开头句在第 {chapter} 章之后找不到：{sentence[:30]}")
        starts.append(at)
    if starts != sorted(starts):
        raise SystemExit("各节起点不是递增的")
    duplicate = [
        (heads[number], min([position for position in heads.values() if position > heads[number]] + [len(material)]))
        for number in DUPLICATE_CHAPTERS
        if number in heads
    ]
    (out / "text").mkdir(exist_ok=True)
    reference_dir.mkdir(parents=True, exist_ok=True)
    held: list[str] = []
    for index, ((beat, _), start) in enumerate(zip(order, starts)):
        end = starts[index + 1] if index + 1 < len(starts) else len(material)
        segment = "".join(
            character
            for offset, character in enumerate(material[start:end], start)
            if not any(left <= offset < right for left, right in duplicate)
        )
        text = clean(segment)
        if not text.strip():
            raise SystemExit(f"{beat} 切出来是空的：对应表的起点或开头句没对上")
        # 留出评测：从第 N 章起的节不放正文，这一节的原作原文就是它的参照答案（与 Agent 按同一份 Design 写）
        if holdout_from is not None and rows[index][1] >= holdout_from:
            (reference_dir / f"{beat}.md").write_text(text, encoding="utf8")
            held.append(beat)
            continue
        (out / "text" / f"{beat}.md").write_text(text, encoding="utf8")
    subprocess.run(["rm", "-r", str(out / "source")], check=True)
    for review in (out / "review").glob("source-*.md") if (out / "review").exists() else []:
        review.unlink()
    if holdout_from is None:
        reference(chapters, reference_dir)
        print(f"{len(order)} 节正文写进 {out / 'text'}；参照第 {chapters.start}–{chapters.stop - 1} 章写进 {reference_dir}")
    else:
        print(f"{len(order) - len(held)} 节正文写进 {out / 'text'}；留出 {', '.join(held)}，各自的原作原文写进 {reference_dir}")


if __name__ == "__main__":
    main()
