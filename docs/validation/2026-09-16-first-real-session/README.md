# 2026-09-16：重构后的第一次真实对话（基线）

这是 Session / evidence 派生 / 去 worktree / 版本身份瘦身四轮重构之后，第一次用真实模型在真实作品上跑完整创作闭环。**此后一切对照以它为基线**——重构前的基线是有意放弃的。

## 现场

| | |
|---|---|
| 作品 | `~/stories/eval-022-suiming` 的副本 `~/stories/eval-022-baseline-2026-09-16`（121 文件 / 69 Beat / 6 篇正文，原作品未被触碰） |
| 模型 | 全角色 deepseek-v4-flash，`reasoningEffort: high`（Writer low） |
| 任务 | 写 `beat-0069`《无功者》的正文——index 顺序里紧接已写完的 beat-0005，是下一篇该写的 |
| 命令 | `suim session send --events`，两个 turn |

作者判断的部分**没有代做**：人名撞车与 Design 措辞两处问题由 Agent 提出、留给作者定，本记录不替他回答。所以这份基线覆盖的是「系统与模型做到了什么」，不含「作者否决」那一维。

## 发生了什么

**turn 1（206 秒，7 次调用，$0.019）**

```
write_context(beat-0069) → story_guide → read×4（Beat 设计、前一节设计、前一节正文；
探 text/beat-0069.md 得 file_not_found）→ write → edit×5 → check(PASSED) → commit
```

产出 28720 字正文，提交为 r2。`commit` 结果如实列出 `committed: ["text/beat-0069.md"]`——去 worktree 那轮加的可见性机制在真实作品上成立。回复里 Agent 主动报了一个它在读前文时发现的**既有缺陷**：beat-0003 的杀仓佐者与 beat-0004 的涿县应募者都叫「赵大」，两节在 index 顺序里紧挨着（第一卷第 4、5 节；本记录原写作 beat-0004 / beat-0005，是把阅读顺序当成了文件编号，2026-10-01 对照作品更正）。它没有自己改，而是问作者。

**turn 2（188 秒，24 次调用，$0.044）**

```
delegate review（子任务 1 个）
  Reviewer: frame → check → search×4（逐条核对引文逐字出自被审文件）→ submit_review
父 Agent: read_result → read(审稿文件) → read(正文 4 段) → search×2 → edit×8 → check → commit
```

Reviewer 判 `revise`，4 条 finding：同一日内「午后会面」与「晌午缚人」时刻打架；Design 给关羽的「阻止杀人却不代赔罪」没落到页面；一处主体与处所指代混乱的病句；一条 note 说正文对张飞动怒理由的改写比 Design 更贴人物，建议反过来改 Design。父 Agent 复核后认可并改掉三条，另修三处自检出的小漏，提交为 r3。

## 成立的事

- **一次对话走完 Design → Writer → Checker → Review → 修订 → 提交**，没有固定配方，没有预算，模型自己决定读什么、写几次、要不要委派。
- **子任务持久交接成立**：Reviewer 的结果存成执行对象，父 Agent 用 `read_result` 回读，不转录 JSON。
- **引文校验成立**：Reviewer 用 4 次 `search` 逐条确认 evidence 逐字出自被审文件，这是 Slice G 加的闸。
- **审稿是普通作品文件**：`review/text-20260915-173703-47ef.md` 随 `commit` 进版本，`suim review list` 从 git 历史派生出时效。
- **Review 有真实鉴别力**：三条 finding 都是真问题，不是套话；note 那条还反过来质疑了 Design。
- 成本量级：一篇 2.9 万字正文 + 一次独立审稿 + 一轮修订 = **$0.064，6.6 分钟，31 次模型调用**。

## 缺陷

### 1. 审稿在同一次提交里失效，而系统报它 current（本轮最重要的发现）

`review list` 报这份审稿 `current: true, changed: []`。但它引的原文已经不在正文里了：

| 审稿 evidence 引文 | 现在 |
|---|---|
| `放在怀里那卷文书上的手停了一下` | 已不在正文 |
| `第二日午后，他带陈丰` | 已不在正文 |
| `你先别动` | 仍在 |

原因是机制性的，不是模型的错。`reviewCurrency` 对 `revision: candidate` 的审稿，把它解析成**审稿文件自己首次出现的版本**（`writtenAtMap`），再比较那个版本到 head 之间主体路径有没有变。而 Agent 的自然循环是「审 → 按意见改 → 一次提交」，于是审稿文件与改过的正文落在**同一个 revision**，比较区间为空，永远 `current`。

CLAUDE.md 与 derived-evidence-design.md 把这条写成「代价」，并要求 Skill 约束「review 后有修改就再审」。**第一次真实运行就撞上了，而且比记录的更糟**：不是「可能漏判」，是**必然漏判**——只要 Agent 按意见改了再提交，就一定这样。而且 `verdict` 停在 `revise`，作者从 `review list` 看到的是「revise 且 current」，分不清「还没改」和「已经改完了」。

根因是把「审的是哪一版」编码成了**时间**（文件何时进版本），而它其实是**内容**（审的时候那些文件长什么样）。

**同日已修**（`1333afc`）：`review/<id>.md` 的 frontmatter 加必填的 `subjects`（路径 → `sha256:<hex>`），`submit_review` 写审稿时记下主体文件当时的摘要，`reviewCurrency` 比摘要不比时间；`CANDIDATE_REVISION` 降为展示标签。判定还变简单了——不再走祖先链、不再读历史快照。

**在同一个真实场景上验过**：清掉旧格式的审稿文件后，让同一个 session 再做一次「审 → 按意见改 → 一次提交」（37 次调用、$0.061），现在 `review list` 报：

```
verdict   revise
current   False
changed   ['outline/story/vol-0001/beat-0069.md', 'text/beat-0069.md']
```

改前的同一场景报 `current: true, changed: []`。审稿文件里的 `subjects` 是 beat-0069 的完整 Design 闭包，24 个路径——代价是每份审稿多 24 行，换来判定精确。

### 2. 事件流里 96% 是状态快照

turn 1 的 190 行事件里，`suiming.session` 状态快照占 160 行以上，每次 version 自增发一条全量 usage；真正有信息的 `ACTIVITY_SNAPSHOT` 只有 14 条。做长对话的界面与回放时这是实打实的带宽与存储成本，也让人读 NDJSON 时看不见东西。没有测量它对桌面 IPC 的实际影响，先记下来。

### 3. `ignored` 里有 `evidence`

eval-022 里还留着 Slice G 之前的 `evidence/` 目录，现在只是一个被忽略的仓库辅助目录。不是 bug（目录扫描的行为如实），但真实作品里留着一个已经没有语义的目录，作者迁移时会困惑。

### 4. 模型探了一次不存在的文件

`read text/beat-0069.md` → `file_not_found`。无害（它在确认这一节是否已有正文），记录用于对照后续是否变成习惯。

### 5. `submit_review` 被拒过一次

验证轮里 `submit_review` 第一次报 `invalid_tool_arguments: must have required properties uncovered`，模型补齐后重试成功。工具契约拒绝 malformed output、失败回到模型手里——这条路本身是对的；记下来是因为如果 `uncovered` 经常被漏，说明它该有默认值而不是必填。

## 留给作者的两件事

Agent 提出、本记录不代答。**2026-10-01 已裁定**：测试作品的故事内容由负责人定，不再等作者；两件都在原作品 `eval-022-suiming` 上提交为 r2——应募者改名孙七，beat-0069 的 Design 采纳 Reviewer，改成张飞不计较「贩履屠狗」、被「死者不必上簿」刺到。

1. **人名撞车**：beat-0003（杀仓佐者，出现 16 次）与 beat-0004（涿县应募者，2 次）都有「赵大」，两节相邻。改哪一个？
2. **Design 与正文的措辞差**：Design 写张飞「差点为一句轻慢杀人」，正文让他明确不计较「贩履屠狗」、只被「死者不必上簿」刺到。Reviewer 认为正文更贴人物，建议改 Design。

## 原始材料

仓库里只留数字与结论：`measurements.json`（事件数、墙钟、用量、动作计数）。

**作品内容不进产品仓**（与既往验收记录一致，那些也只引标识和短句）。完整材料在作品副本里：

- `~/stories/eval-022-baseline-2026-09-16/.validation/session-events*.ndjson`：两个 turn 的完整 SessionEvent 流。
- `~/stories/eval-022-baseline-2026-09-16/text/beat-0069.md`：产出的正文。
- `~/stories/eval-022-baseline-2026-09-16/review/text-20260915-173703-47ef.md`：审稿文件——它本来就是作品文件，在版本里。
- canon 三个版本：创世 → r2（正文）→ r3（审稿 + 修订）。原作品 `~/stories/eval-022-suiming` 未被触碰。
