# C 题库：确定性长程题

ADR-0008 决定 9 与它的验证门要求从真实长篇 Run 暴露的失败里抽取不少于 20 道确定性长程题作为 C-SOTA 的最低证据，进入回归。这里登记每道题的来源、它对应的确定性边界（硬状态、secret 知情、Contract 生命周期、refs 依赖、Checker），以及现状。题目只收"Checker 能判对错"的形式；纯语义问题（旁白复述、格言短句、AI 味）留给 Reviewer，不进题库。

**状态：活登记表。**当前 17 道，最近一次补题是 2026-09-06；eval-022 暂停推进之后还没有新题，差额继续从当前测试台的真实运行里补。

状态含义：**回归**——已有确定性测试；**待声明**——eval-022 的 Design 还没写相应硬状态或 secret，写上之后现有 Checker 就能抓；**待机制**——Story Language 或 Checker 还没有这类边界，需要先决定要不要加。

## 来源

- P（2026-09-05）：Codex 新旧仓对照与 Claude Code 重放在 eval-022 上写 beat-0004、beat-0005 并独立 Review，见[旧引擎时期的运行记录](validation/2026-09-05-old-engine-runs/README.md)的 P 节。三组共 7 轮 Review、约 25 条 finding。
- R1（2026-09-05）：Suiming 自己的 Agent 在同一 checkout 上的真实 Run（DeepSeek V4 Flash）：Design → 两篇正文 → selection Review，6 条 finding。

## 题目

| # | 题 | 来源 | 确定性形式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 张角在 beat-0005 病死后，任何更晚的 Beat 或正文都不能让他行动 | eval-022 Design 已声明 `张角.dead: true`（beat-0005） | `dead` 不可逆：更晚 Beat 的 refs / changes 再涉及张角行动即阻塞 | 回归（Checker 死亡 warning 与硬状态时间线已有测试） |
| 2 | 关羽的真名与河东旧案，beat-0004 后只有刘备、张飞知道；督邮在 beat-0069 经河东移文才知道；在此之间没有传播途径的人物不能据此行动 | Claude Code 与旧仓 Codex 的 Reviewer 都追问"表字 / 真名的知情顺序" | 声明 `refs.secret: [关羽亡命]`，beat-0004 写 `changes.character.刘备 / 张飞: secret:关羽亡命.revealed: true`，beat-0069 写督邮；Checker 拒绝未声明即揭示 | 回归（2026-09-06 在 eval-022-suiming 声明：beat-0004 `refs.secret: [关羽亡命]` 与刘备 / 张飞的 character scope revealed，beat-0069 world scope revealed；未声明即揭示的反例见 checker-diagnostics.test.ts） |
| 3 | 张飞放到案上的钱串一旦记入县簿，就不再在张飞身上 | Claude Code 第二轮 Review 的 major finding（修订稿新引入） | Resource `钱串` 的 `holder` 在 beat-0004 变为县寺；之后的正文若让张飞再掏同一串钱，Reviewer 有硬状态可引；Design 层由 `holder` 时间线守 | 回归（2026-09-06 声明 Resource `张飞的钱串`：initial holder 张飞，beat-0004 `location: 涿县县寺` 使 holder 清空；holder / location 原子规则的反例见 checker-diagnostics.test.ts） |
| 4 | 涿郡投募簿上"保人刘备"的保状是 beat-0069 索人的前提 | 三组 Design 修订都把它写进 beat-0069 | `refs.beat: [beat-0004]` 依赖：beat-0069 依赖 beat-0004，删除或改序即阻塞 | 回归（新仓 Codex 已在 beat-0069 写 refs.beat；`storyDependentClosure` 有测试） |
| 5 | 三人同到太平 的 deadline 是 beat-0045，之前必须 resolve | eval-022 Contract 已声明 | Contract 生命周期：到期未闭合阻塞 | 回归（Checker Contract 测试） |
| 6 | 严石在 beat-0005 撤离时的位置只能连续变化，不能同时在城门内外 | 新仓 Codex 首轮 Review："严石目击距离" | `严石.location` 的 `changes`：一个 Beat 只能有一个退出位置，正文里的位置由 Reviewer 对照 | 回归（2026-09-06 声明 beat-0005 `严石.location: 广宗北门外`：一个 Beat 只有一个退出位置；位置类型与时间线由现有 Checker 测试守，场面内批次由 Reviewer 对照） |
| 7 | 韩家的役只能被替一次：刘备代役后，张飞的钱不能再算韩家 | Claude Code 第二轮 Review note | 数量守恒不在 Story Language 里；退而求其次：`资源:代役钱.holder` 与 Beat 自然语言 | 待机制（数量型硬状态是否加，R 后决定） |
| 8 | 教令"三日内齐集"与关羽"投募四日"不能同时成立 | Claude Code 第二轮 Review minor | Beat 内时间不在硬状态里；只有跨 Beat 的展示顺序是确定性的 | 待机制（不打算加年代字段，ADR-0008 决定 3） |
| 9 | 焚册（beat-0005）之后杜蘅带出的人没有可循的总网，后文不能再用总册索人 | eval-022 beat-0005 自然语言 | Resource `总册.consumed: true` 在 beat-0005 声明；后文再用即阻塞 | 回归（2026-09-06 声明 Resource `太平道总册`：initial holder 张角，beat-0005 `consumed: true`；后文再持有的反例 `terminal_resource_reused` 见 checker-diagnostics.test.ts） |
| 10 | 关羽以"长生"入册后，县簿上没有"关羽"；直到旧案被翻出，官府文书里只能出现长生 | 三组正文都写了长生入册 | `secret:关羽亡命` 的 `world.revealed` 只在 beat-0069 之后为 true | 回归（与 2 同一声明：world scope 只在 beat-0069 揭示） |
| 11 | 刘备为关羽具保后，"刘备失官"的代价在 beat-0069 必须发生，不能在更早的 Beat 被提前兑现 | 新仓 Codex 把代价写进 beat-0069 与 beat-0007 | Contract advance 顺序：三人同到太平 的 advance 出现在 beat-0069、beat-0007，顺序由 Story index 决定 | 回归（Contract advance 顺序有测试） |
| 12 | 张角焚掉总册后，各地的救济路线只在"愿意承担的人"手里；beat-0008 以后的黄巾余部不能凭总册互认 | eval-022 beat-0005 | 同 9 | 回归（同 9） |
| 13 | beat-0068 插在 beat-0001 与 beat-0002 之间：正文续写的"真实前文"是 beat-0068 而不是 beat-0001 | Write Context 的 previous 选择 | `previousStoryBeatId` 按 Story index 顺序，不按 id 数字 | 回归（`host-context.test.ts`「Write Context 的前一节按 index 顺序取」，2026-10-04 补） |
| 14 | 一个 Beat 的 `changes` 只能声明自然语言里已经成立的结果：beat-0004 若写 `关羽.location: 涿郡` 而正文让他当夜离开，Reviewer 有硬状态可引 | 设计规则 | 硬状态与自然语言一致性由 Reviewer 判，Checker 守时间线 | 回归（状态时间线测试） |
| 15 | 张角在 beat-0005 的死亡时刻：Design 写"雨夜里病死"，正文写雨停后的白天 | R1 Suiming Reviewer note | Beat 内时刻不在硬状态里；只有 `dead: true` 与展示顺序是确定性的 | 待机制（与 8 同类：不加年代字段） |
| 16 | 刘备代韩跛应役后，这笔义务必须有了结（销号、转入本队或仍须应征） | R1 Suiming Reviewer minor；Claude Code 重放的"韩家双重覆盖"同源 | 义务不是资源；可退化为 Resource `代役券.holder` 或 Contract；是否加"义务"类硬状态待定 | 待机制 |
| 17 | beat-0005 撤离时阿弟与杜蘅的批次、位置前后必须一致 | R1 Suiming Reviewer minor；新仓 Codex 的"严石目击距离"同源 | `阿弟.location` / `杜蘅.location` 的 `changes` 只能声明退出位置；场面内的批次由 Reviewer 对照 | 回归（与 6 同一 Beat 声明 `杜蘅.location: 广宗北门外`） |

当前 17 道，其中回归 13、待声明 0、待机制 4（2026-09-06 把 7 道"待声明"落进 eval-022 的 Design：secret 关羽亡命、Resource 张飞的钱串与太平道总册、Place 涿县县寺与广宗北门外）。四个不同 Reviewer 在同一两篇正文上重合的类别（簿记 / 义务了结、位置连续、旁白复述 Design、Beat 内时刻）是优先级最高的一组。距离 20 道的差额由 R 的真实 Run 补：每次 Reviewer 的 major finding 若能改写成硬状态或 secret 声明，就登记一道。

## 怎么把"待声明"变成回归

1. 在作品的 Design 里补相应 `refs.secret`、`changes`、Resource 文件（这是作者层修改，走 `design impact` → 改文件 → `check` → `commit`）。
2. 用同一声明在 `packages/story/test` 里写一个最小反例（例如更晚的 Beat 让已死者行动、未声明即揭示 secret），确认 Checker 阻塞。
3. 题目状态改为回归，并在这里记下测试文件名。
