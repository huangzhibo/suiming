"""留出评测的确定性指标：Agent 写的正文与原作对应章节逐项对照，不需要人读。

用法：python3 compare.py <作品目录> <原作参照目录> beat-0025 [beat-0026 ...]

作品目录里读 text/<beat>.md（Agent 写的），参照目录里读 <beat>.md（原作那一节，转换规则见
2026-10-02-doupo-host 的验收记录）。只读不写。指标的用意：

- 篇幅：去掉标题与空白后的字数，看是否写短、注水。
- 与原作重合：候选里有多少 13 字片段原样出现在原作里、最长的一段原样重合有多长。
  模型可能背过原作，重合高说明是在背书，不是在写；正常改写应接近 0。
- 对话占比、段落数与平均段长：网文的节奏大头在这几项，与原作差得远就是语气没接上。
"""

import re
import sys
from pathlib import Path

N = 13


def body(text: str) -> str:
    """正文字符：去掉 Markdown 标题行与全部空白。"""
    lines = [line for line in text.split("\n") if not line.lstrip().startswith("#")]
    return re.sub(r"\s+", "", "".join(lines))


def paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and not p.lstrip().startswith("#")]


def grams(s: str) -> set[str]:
    return {s[i : i + N] for i in range(len(s) - N + 1)}


def longest_shared(a: str, b_grams: set[str]) -> int:
    """最长的原样重合（字）：以连续命中的 N 字片段链近似。"""
    best = run = 0
    for i in range(len(a) - N + 1):
        if a[i : i + N] in b_grams:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best + N - 1 if best else 0


def dialogue_ratio(s: str) -> float:
    quoted = sum(len(m) for m in re.findall(r"“([^”]*)”", s))
    return quoted / len(s) if s else 0.0


def measure(candidate: str, original: str) -> dict[str, str]:
    c, o = body(candidate), body(original)
    o_grams = grams(o)
    c_grams = [c[i : i + N] for i in range(len(c) - N + 1)]
    overlap = sum(1 for g in c_grams if g in o_grams) / len(c_grams) if c_grams else 0.0
    cp, op = paragraphs(candidate), paragraphs(original)
    avg = lambda ps: sum(len(body(p)) for p in ps) / len(ps) if ps else 0.0  # noqa: E731
    return {
        "字数（候选 / 原作）": f"{len(c)} / {len(o)}（{len(c) / len(o):.2f}）" if o else str(len(c)),
        "13 字片段重合": f"{overlap:.1%}",
        "最长原样重合": f"{longest_shared(c, o_grams)} 字",
        "对话占比": f"{dialogue_ratio(c):.0%} / {dialogue_ratio(o):.0%}",
        "段落数": f"{len(cp)} / {len(op)}",
        "平均段长": f"{avg(cp):.0f} / {avg(op):.0f} 字",
    }


def main() -> None:
    work, reference, beats = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    rows = {beat: measure((work / "text" / f"{beat}.md").read_text(), (reference / f"{beat}.md").read_text()) for beat in beats}
    keys = list(next(iter(rows.values())).keys())
    print("| 指标 | " + " | ".join(beats) + " |")
    print("| --- |" + " --- |" * len(beats))
    for key in keys:
        print(f"| {key} | " + " | ".join(rows[beat][key] for beat in beats) + " |")


if __name__ == "__main__":
    main()
