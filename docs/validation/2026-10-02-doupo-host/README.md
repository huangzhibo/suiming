# 2026-10-02：斗破 host 运行（Claude Code）

用 host 模式（Claude Code 按作品仓里安装的 suiming Skill 工作，确定性部分走 `suim`）把《斗破苍穹》前 120 章**忠实**抽取为 Source，原样提升为 Target Design，再从第 120 章之后续写两个 Beat。目的有三：测 host 路径本身、测续写、在桌面上看原作的结构。以后要用桌面里的 Suiming Agent 做同样的事来对比，对比协议见文末。

**作品内容不进产品仓**：作品文件都在作品目录里，这里只记数字、行为与结论。作品在 `~/stories/doupo-host-2026-10-02`。

## 现场

- Source：`~/stories/eval-011-input/斗破苍穹-0001-0120.txt`，307,785 码点，SHA-256 `1735ab9c…`——与 [2026-10-01 桌面那次真实运行](../2026-10-01-doupo-real-run/README.md)的 Source 是同一份，三次运行（桌面改编、这次 host 忠实抽取、以后桌面忠实抽取）输入一致。
- host：这一次的 Claude Code 会话（Opus 5.5）就是 Skill 说的 Agent；Reader、Writer、Reviewer 等角色是按 Skill 隔离的子 agent（不继承主会话、只拿编译好的 Context 文件）。Skill 由 `suim init --agent claude-code` 装进作品仓，与产品仓 `integrations/shared/suiming/SKILL.md` 逐字相同。
- 意图与 2026-10-01 那次相反：那次是「以原作为底本重新设计」（废除穿越、改三年之约位置等十条改法）；这次是「前 120 章不改设定，续写延续原作设定」。

## 版本与步骤

| 版本 | 内容 |
| --- | --- |
| r1 | `suim init --agent claude-code` |
| r2 | `suim source ingest`，Source id `doupo-0001-0120` |
| r3 | 12 份 Reader 笔记（每份 10 章，按章边界切；Skill 建议 6000 码点一段，host 用的模型读得下更大的段），覆盖 `[[0, 307785]]` |
| r4 | Source 抽取：6 卷 27 Beat、29 人物、16 地点、12 物品、15 份 World、5 个 Contract、9 条秘密 |
| r5 | 独立 `review:source`（revise，2 minor + 3 note）记录后按意见修 5 处 |
| r6 | 提升为 Target：写 `intent/book.md` 与正文风格意图，抽取原样复制到 `outline/`、`world/`；27 篇正文取原作章节（只剔作者按语、推书行、网站水印与重复的第 72 章，断在句中的换行接回，其余一字不动） |
| r7 | 续写 Design：新卷「续·魔兽山脉」，beat-0028、beat-0029 |
| r8 | beat-0028 正文（隔离 Writer），第 121–124 章，11,312 码点 |
| r9 | beat-0029 正文，第 125–128 章，10,756 码点；同一提交把正文带出的一个新事实回写进 Design（见下） |
| r10 | index 声明 `open_ended: true`（全书未完待续），`suim check` 全过 |

抽取的分工：先由一个子 agent 通读全部笔记定 id 登记表（人物、地点、物品、World、秘密、Contract 的 id 与落点，并核对切分——它把 6 处边界改到因果单元上，其中 4 处切在章内，给了分界句），再 10 个子 agent 并行按卷写 Beat、按类写人物 / 世界 / 地点物品与 Contract，最后主会话合并、`check`、审稿。登记表是这次能并行的前提：各卷引用同一套 id，合并后 `check` 一次通过，只剩 13 条「提到但未引用」的警告（补了 2 条实质的引用，其余是顺带一提）。

## 结果

**抽取的忠实度。**独立 Reviewer 通读笔记与全部抽取、用 `rg` 回查原文，结论 revise：5 条都是小偏差（吸掌的来历记在了药老名下、一处人物知情写过头、一处谁先认出谁、一处作者层用了第 120 章以外的知识、一处价格只取了原文矛盾说法中的一种），没有 major。知情层次最复杂的几条线（黑袍人身份、柳席之死的真相、薰儿的秘法、药老只为萧炎所知）都抽对了。原作自身的矛盾（成斗者十一岁还是十二岁、初阶九段还是十段等）照录并注明，没有调和。

**桌面结构。**作者拒绝了桌面截图权限，改用同一条 `workspace.show` 加渲染层 `axisModel` 做程序检查。r9 上：7 卷 29 Beat、37 条因果弧（`refs.beat`）、5 个 Contract 的 open / advance / resolve、29 条人物泳道（萧炎的位置迁移、雅妃两次获知秘密、柳席与加列怒之死）、14 条 World 泳道、11 条资源流转（玄重尺从药老到萧炎、宝洞分宝、紫云翼卷轴修成后消耗），541 条 frontmatter 引用；正文时效 27 篇 current、2 篇 design-changed（原作最后一篇后面接上了续写；续写第一篇的下一个 Beat 改过 Design）。修掉三个缺陷后（见下）才是这些数——修之前人物与资源泳道各有重复，28 篇正文是 design-changed。

**续写。**beat-0028 交给只拿 Writer 契约、简短 brief 与 Write Context（Design 闭包加原作第 118–120 章正文）的子 agent，一次写成、`text check` 通过、没有报 Design 冲突。通读校准：声音接得上原作（药老的「嘿嘿」「老头我」、拿吸走斗之气的三年互相挤兑），场面具体而不是扩写细纲，境界、魔核价格、吞木狐难得、悬赏内容都与原作和 Design 一致，Design 规定「不说出口」的都守住了；有一处 Writer 自己的巧思（萧炎打残的吞木狐被狼头小队捡去剖了魔晶，让偷听顺理成章）。与原作对照：原作第 121–124 章是「晋级六星！」「地阶斗技」「报复开始」「杀戮」，续写同样走到晋六星、向狼头佣兵团寻仇，细节不同（原作此时药老给了地阶斗技，续写没给）。**这个相近不能全算续写能力**：续写的 Design 是主会话写的，它对原作后文有先验知识。

beat-0029（伏击狼头小队）同样一次写成。这一篇暴露了**主会话自己的错**：Design 只写了「一个当场断气、另一个折了腿」，brief 却写「除那个四星少年外没有活口」；Writer 为了两边都成立，让萧炎回林子了结了折腿的人，并在 uncertainties 里如实报出。Skill 本来就要求「作者指令若引入会成为后续依赖的新事实，先修订 Design 并提交」，是 brief 越过了 Design。这个事实与原作萧炎对狼头佣兵团的做法一致，采纳并回写 Design，与正文同一次提交（正文时效因此 current）。教训写给以后的 brief：只转述 Design，不加事实。

## 发现并修掉的产品问题

| 提交 | 问题 | 怎么发现 |
| --- | --- | --- |
| `8d7c5cd` | 故事轴与属性面板只认 `secret:<id>.revealed`，Story Language 与 Checker 都接受的裸写法在轴上丢事件；`resource:` / `character:` 前缀的状态键也不进泳道 | 准备在桌面看结构时读代码 |
| `3e3fdee` | `suim check` 只给汇总：绑定期问题的信封只有「共 400 处问题，第一处：…」，设计能绑定但 Checker 不过时只有 `designPassed: false`。现在结果带 `diagnostics`，失败信封带 `error.diagnostics` | 6 个并行写 Beat 的子 agent 都撞上，各自写脚本直调 runtime |
| `f3e8627` | 故事轴把 Source 抽取里同名的人物、资源也画成泳道（并吃到 Target 的硬状态变化），Source 审稿按 localId 落到 Target 列上成了覆盖全书的区间 | 程序检查故事轴模型时发现重复泳道 |
| `de8c2ff` | host 的审稿 Context 按已提交 head 编译，Skill 却让「先审稿再提交」；照做时 Reviewer 拿到「（尚无 extraction 文件）」，命令照样成功。现在没有抽取报 `source_not_extracted`，Skill 改为先提交再编审稿上下文 | Source Reviewer 在 uncertainties 里报告了空输入 |
| `3ba3346` | 正文时效按整份 `index.yaml` 比：全书末尾加一卷续写，原作 27 篇正文全成了 design-changed。现在只比这个 Beat 在 index 里的那一段（所在卷、前后邻居） | 续写提交后看时效 |

## 未决

- ~~连载式 Target 的设计检查~~ **已定并实现（`7f9e04f`）**：三年之约、吞噬异火、迦南重逢、狼头之仇到续写末尾都还开着，`designPassed` 如实为 false，没有为它伪造 resolve。作者定：允许作者明确声明全书未完待续，不直接放宽检查。index 可写 `open_ended: true`，声明后已建立未回应的 book_end Contract 算进行中，写明 Beat 期限的与从未建立的照样报错；这部作品在 r10 写上声明后检查全过。
- ~~Suiming Agent 的 `check` 工具在这种情况下说 PASSED~~ **已修（`b249156`）**：结论改为 PASSED / ISSUES / FAILED 三种，与 CLI、桌面同一个判定（`checkFindings`）；ISSUES 表示能提交但有要修的设计或正文问题，逐条列出。回归加了两个从「Contract 没兑现」起步的任务，见[回归记录](../2026-10-01-harness-regression/README.md)。
- ~~桌面的检查结果仍只显示哪一项没过~~ **已做（`1661037`）**：检查后有诊断时提示带「查看详情」，打开按文件归类的检查结果页；作品绑不成设计时也列全部问题。做的时候查出两处：命令失败的 `code` 与诊断过不了 contextBridge（`2143453`），Contract 没兑现的诊断是英文（`29716aa`）。
- 全书 `review:design` 与续写正文的 `review:text` 未做（两个续写 Beat 要审全书 29 个 Beat，代价不相称，如实记为未审）；两篇续写由主会话通读校准。

## 用量

子 agent 的 token 数取自每个子 agent 结束时的统计（含缓存读）：Reader 12 个共约 185 万，登记表 44 万，10 个写作子 agent 共约 347 万，Source 审稿 52 万，两个续写 Writer 各约 23 万；合计约 674 万，另有主会话。墙钟：Reader 第一次 12 个同时断网（ECONNRESET）全部失败，续跑后 4–9 分钟；登记表 23 分钟；写作 11–23 分钟（并行）；审稿 13 分钟；两个 Writer 各 13、28 分钟。全程用的是作者的 Claude 订阅，没有按 token 计费的花费。

## 以后在桌面做同样的事：对比协议

- 新建作品，`suim source ingest` 同一份材料（sha `1735ab9c…`），作者消息说清「前 120 章忠实抽取并提升为 Design，不改设定；之后续写两个 Beat」，意图用本作的 `intent/book.md`。
- 对比项：抽取规模（卷、Beat、人物、地点、物品、World、秘密、Contract）、独立 `review:source` 的 finding 数与严重程度（同一种 Reviewer 契约）、故事轴上可见的结构（人物泳道、资源流转、因果弧数）、续写正文的 `text check` 与人工阅读、模型调用次数、token 与墙钟。
- 原作正文作前 27 篇 StoryText 是输入准备，不算 Agent 的工作；用同一个转换规则（剔作者按语、推书行、水印、重复章）。
