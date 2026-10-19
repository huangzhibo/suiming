# 旧仓四个 Skill 的规则去向（2026-10-19）

作者问：旧仓 suiming-story 的 `/suim-source` 等 Skill 经过试用、比较完善，现在合成一个 Agent，还能准确完成任务吗？

旧仓按阶段分成四个 Skill：`suim-source`（149 行）、`suim-design`（99 行）、`suim-write`（133 行）、`suim-review`（138 行）。本仓 2026-09-03 重建时没有搬它们：host 接入改写成一个 `suiming` Skill（`integrations/shared/suiming/SKILL.md`）加 4 个 Codex 子 agent，managed Agent 的方法写进 `packages/runtime/src/harness/writing-methods.ts` 与各角色提示。合成一个的理由当时没有写下。

做法：四个子代理各审一个旧 Skill。逐条列出方法与质量规则，再对照新系统标成四类：保留、改写、有意删除、丢失。「丢失」先 grep 确认确实没有对应。丢失或变弱的条目，再到 `docs/validation/**` 与[当前状态](../../current-status.md)的已知缺陷里找新系统是否真出过对应的问题。结论里的关键说法已逐条核对原文。

## 总体

- **host 侧几乎完整**：Codex / Claude Code 用的 `suiming` Skill 保留了旧 design、write、review 的大部分方法与清单。
- **managed 侧（桌面 Agent）不对称**：
  - 写作与抽取的方法并进了 `STORY_TEXT_METHOD` 与 `SOURCE_*_METHOD`，抽取多处比旧版更强。隔离靠读写范围从结构上保证，分段在代码里切，「带着后文补全」每次都做。
  - **设计方法整份没进来**。根 Agent 与委派做设计的子任务只拿到通用提示加宪法。
  - 审稿的几份逐项清单压成了一句话。
- **有意删除的不算损失**：MaterialEvidence、`source record`、seal、ReviewReport 绑定、`.suim/contexts` 交付、按批串行改全段并行、2–3 万码点改窗口两成、多观察视图收成三层，理由见 [Harness 设计](../../harness-design.md)第 16 节与[派生状态设计](../../derived-evidence-design.md)。

## 丢失或变弱、且真实运行里出过问题的

| 旧规则 | 新系统 | 出过的问题 |
| --- | --- | --- |
| **Source**：人物基底只放进入故事前已成立的事实，后来的变化只写 StoryBeat，不由结局反推 | Story Language 写清了，但抽取方法只说「人物基底按全书证据」，自检没有按人物核对 | 10-03 GPT 抽斗破，人物档预载了后文事件；10-15 三国，蔡阳基底提前装入复仇动机，抽取、补全与自检都没拦住（[记录](../2026-10-15-large-source/README.md)） |
| **Source**：preflight 核对进入与退出状态、位置；按关注点回查人物、Contract、World | 压成一句自检，缺「进入与退出状态」「位置」 | 原作幕后的四星到五星突破没进 Design，留出评测里 6 次有 2 次被改成与原作相反 |
| **Design**：设计循环（定向、高杠杆清单、有界调研、裁决、结晶）；高杠杆处出实质不同的候选；World 与人物双向压力测试；成批写正文前先补全这段 Design；已知问题自己修 | managed 侧没有，只在 host Skill | 续写的推进只有原作一半，作者第二轮才纠正（[代作者使用](../2026-10-18-doupo-proxy-author/README.md)） |
| **Design 审稿**：whole-book 七项，包括 Intent 不能靠宣言自证、长篇容量 | 设计审稿提示只有一句「人物、因果、节奏、长期承诺和设定」；Reviewer 读不到 Story Language | 续写的设计审稿 pass，却放过 20 处日常账目与慢一半的推进；篇幅意图一万字配 1,200 字的 Design，无人指出 |
| **消化审稿**：分歧暴露 Intent 含混时先澄清；改作者定下的 Design 前对照 Intent | 只说「结合作者目标决定」 | 留出第二次按审稿把抽自原作的 beat-0521 改成与原作相反（已知缺陷） |
| **Write / Review**：非首节要有真实前文才做连续性审稿；全部写完按顺序复核接缝；全书审查跨卷人物弧、期待回收、声音趋同、语言疲劳 | 正文 Reviewer 读不到范围外的邻节；整卷审稿超窗后拆块，块间接缝无人审；text 提示没有全书专项 | 留出两次共 7 次 `permission_denied`，都是 Reviewer 想看邻节查衔接（[记录](../2026-10-17-doupo-holdout-pipeline/README.md)） |
| **Write**：批量写之前校准代表性正文，结论写回风格依据 | 只有「第一节写完读一遍」 | 段长在三次运行里都只有原作的六成左右，记成「列明不修」 |
| **Write**：语法、指代、动作主体清楚；典故与流行表达合人物和世界 | 两条都没有 | 09-16 审稿查出指代混乱的病句；续写评委说对白偏现代（证据偏弱） |
| **Review**：声称已审须对新快照有 current 报告，否则如实说没审 | 时效能派生，但普通 turn 的对账不报过时审稿数 | 留出第二次回复说「修订并复审」，没说最后一轮修改没再审 |

## 丢失但没见到出事的

- **Source**：「这段没读完或被截断要报失败」。覆盖率只取笔记自报的 span，子任务会被自动摘要（10-15 发生 3 次）。没见到真的跳读，但属于失败静默的一类。
- **Design**：人物时点模拟视图；作者参与时一次只谈一个决策组、给实质不同的选项。
- **Review**：Target 审稿是否读 `reference/`，引擎放行、host 不给，两边说法不一致。

## 补的原则

- 补方法，不加闸。Story Language 管文件里写什么，方法与角色提示管怎么做。
- 能由系统对账的失败静默，做成可见；不能的写进提示。
- 写法改动按 [runtime 回归纪律](../../../packages/runtime/AGENTS.md)判，要超出旧配置自己的波动。
