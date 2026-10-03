# 真实运行记录（旧引擎时期，2026-09-05 / 06）

> 2026-10-02 从[当前状态](../../current-status.md)整节迁来，正文未改，只改了相对链接与标题层级。

这些是 Session 模型之前、旧 RunEngine 与固定配方时期的真实运行，里面的机制与数字只描述当时，不是当前实现；保留是因为它们是 C 题库与作者判断的证据来源。重构后的真实运行从 [2026-09-16 基线](../2026-09-16-first-real-session/README.md)算起。

最初的真实 provider 验证使用测试样例作品（现为 `packages/runtime/test/sample-work.ts`，2 个 StoryBeat）；后续 eval-022 与作者盲读记录见下文。样例暴露的三类 malformed output 都已被 Checker 或 Tool contract 拒绝、未推进 Canon，并有等价回归覆盖：

- `qwen3.8-flash` 提交非法 StoryOutline 硬状态路径；
- `qwen3.8-max` 的 Reviewer 返回 `pass + findings`；
- 顶层 TypeBox union 导致 Reviewer 把数组序列化为字符串，schema 已回退为平面 wire schema，跨字段语义由 parser 检查。

两次成功记录：单 Intent 修改直接通过；关系代价任务先因非法 `*.relationship` 路径被拒，经一次 bounded repair 后联动修改五项 Design，Reviewer pass 后提交。这证明调用、修复、Review、Checker 与提交边界可运行，不证明模型质量。

## 2026-09-05 R0：新引擎首次真实闭环

同一样例作品，provider 为 DeepSeek 官方 `deepseek-v4-flash`（`reasoningEffort: high`）。四个 Run 全部提交，全程 0 次工具错误、0 次 Checker 拒绝。观察到的问题按处置分三类。

已修复：

- Design Run 的结果报 `reviewReportId: rr_000001`，但 `review list` 为空、`review show` 报 `review_report_not_found`，随后的正文 Review 又拿到同一个 `rr_000001`。原因是 Agent 修订后原候选的 Review 对提交快照不再 current，不进入 `evidence/reviews`，session 内序号随之丢弃。结果改为始终带 `review { verdict, summary, findingCount }`，`reviewReportId` 只在 Review 仍 current 时给出，回归在 `run-engine-design.test.ts`。

留给后续步骤：

- evidence id（`rr_`、`ctx_`）是 session 内序号，非 current 的报告被丢弃后序号被下一个 Run 复用，`inputReviewReportIds` 跨历史引用可能指向另一份报告。E2 把 evidence 逐条持久化、以 sha 为键时一并解决。

B 步已修：`run show` 不带 usage（B1）；profile options 写错键名被静默忽略（B1，bind 时报 `invalid_model_options`）；Writer 猜测有看不见的 exact 片段清单（B3，Write Context 明说没有）。

## 2026-09-05 B：带预算与观测的真实 Run

- 作者目标已经被满足时，Agent 只能停下来：submit_design 拒绝无修改的提交，Run 以 `task_not_submitted` 失败，7 次调用（14.9 万 token）花在反复核对上。已修：无修改也能提交，Run 以 `unchanged` 完成，decision 带理由、没有 Review、Canon 不动；重跑 6 秒、3 次调用。
- CLI 每次取 telemetry 都新建 provider，退出时 flush 的是另一个实例，最后一批 span 丢失，Langfuse 只见 6 个 GENERATION。已修：一次调用一个实例，退出时 flush 并关闭；重跑后收到完整的 run → task → generation 树。
- 本机 Langfuse v4 跑在 events_only 模式，`/api/public/traces` 等查询端点不可用，核对走 ClickHouse 的 `events_core`。
- Langfuse 的价格表没有 DeepSeek，金额按 `gen_ai.usage.cost` 属性显示，来源仍是 pi-ai 目录价。
- eval-022（69 Beat）上一次 `unchanged` 的 Design Run：2 次调用、11 秒，第一次调用 input 5.4 万 token（Design 全量渲染），第二次 4.9 万走 DeepSeek 缓存，合计 0.008 USD。这是 F 裁剪的基线：全量渲染一次约 5.4 万 token，三个 loop 几十次调用就是百万 token 量级。

符合设计、但值得知道：

- Design Run 提交后若全书 Contract 已闭合会自动做全书 DesignCommit，之后 `design freeze` 返回 `designCommitCreated: false`。
- 作者手改正文后 commit，StoryText lineage 按新 contentSha256 保持绑定到 `sc_000001`；针对旧正文的 Review 变 stale 后被丢弃。
- 正文 Reviewer 依据 style evidence（短句、少解释）给出的 revise 切中实际问题，作者据此删掉 3 段旁白。这是第一条真实的作者采纳记录。

## 2026-09-05 P：host-native 对照验收（Codex 新旧仓、Claude Code 重放）

路线图 P 验收二的第一次实测。作品是 `eval-022`（史诗三国，69 Beat、9 卷，已有 4 篇正文）的三份 scratch 拷贝，格式直接兼容，新 CLI `init` 与 `check` 一次通过。任务相同：作者补充关羽河东旧案 → 跨文件 Design 修订并冻结 → 按顺序写 beat-0004、beat-0005 正文 → 独立 text Review 与最小修订 → 提交。Codex 两组都是 `codex exec` headless、主 agent `gpt-6-astra xhigh`、子 agent 与旧仓相同的 `gpt-5.6-sol`（Writer medium / Reviewer high）；旧仓组用旧 CLI 0.1.0 与旧四个 Skill，新仓组用共享 Skill 加 `integrations/codex/agents/`。Claude Code 组由本会话按同一 Skill 亲自做 Agent，只写了 beat-0004 一篇，Writer / Reviewer 是隔离子 agent，因与其它工作交错，用时不可比。运行现场（trace、分析脚本、三个 checkout）在会话 scratchpad，不进仓。

| 指标 | Codex + 旧仓 | Codex + 新仓 Skill | Claude Code + 新仓 Skill（一篇） |
| --- | --- | --- | --- |
| 用时 | 77 min | 66 min | 不可比 |
| `suim` 调用 / 失败 | 34 / 1（猜 id 写成 `char-guanyu`） | 41 / 3（并发撞 project lock；Codex 自己的 shell 重定向到不存在的目录；dirty 时 freeze） | 36 / 1（dirty 时 freeze） |
| `--help` 查询 | 9 | 0 | 0 |
| 向作者提问 | 0 | 0 | 0 |
| 子 agent 调用（含 wait） | 31 | 24 | 6 |
| 改动的 Design 文件 | 11（含 vol-0003 / 0005 / 0008 的 Beat） | 5 | 4 |
| Design Checker 一次通过 | 2 / 2 | 3 / 3 | 3 / 3 |
| 单 Beat 检查一次通过 | Writer 报告全部通过 | Writer 报告全部通过 | 3 / 3 |
| Review 轨迹 | Design revise(3) → pass；0004 revise(3) → pass；0005 revise(2) → revise(2) → pass | Design pass；0004+0005 selection revise(4) → pass | 0004 revise(2 major 3 minor) → revise(1 major 4 minor 3 note) → 第二次修订已提交，第三轮 Review 被作者中止，最终快照 unreviewed |
| 正文码点 | 13475 / 13836 | 15718 / 17609 | 11011 |
| Context 交付 | `suim context` 写文件，hash 头尾 | `context compile` 返回 systemPrompt + 输入 + ContextSnapshot id，Review 绑定它 | 同左 |
| 版本事务 | git 提交被 Codex 沙箱拒绝（`.git/index.lock`），导出 bundle | 12 个 ProjectRevision，head clean | 10 个 ProjectRevision，head clean |
| 受保护文件（AGENTS / EVAL / Skill） | 未改 | 未改 | 未改 |

体验指标：新仓组没有一次 `--help`，没有猜 id（`design impact <kind>:<id>` 的写法直接从 Skill 拿到），Context 与角色契约由 `context compile` 一次交付；它的三次失败两次是产品缺陷（并发锁、Skill 把 freeze / commit 顺序写反），一次是 Codex 自己的 shell 错误，前两者当天已修。旧仓组多花 9 次 help 与一次错误猜测，Design 联动面更宽（11 个文件，波及三卷），是否过宽要看作者。效果指标：Design Checker 与单 Beat 检查在三组里都一次通过；独立 Review 都能在首轮抓到实质问题（旧仓 3 / 新仓 4 / Claude Code 5 条），新仓组一轮修订后 pass，旧仓组 beat-0005 用了两轮；Claude Code 组第二轮 Reviewer 在修订稿里抓到一处新引入的簿记矛盾（张飞的钱串），说明"修订后必须对新快照重审"不是形式；每轮 Reviewer 读 9.4 万字 Context 要 10 到 17 分钟，第三轮被作者中止，是 F 步该先做的直接证据。作者盲评偏好尚未做：三份正文在 scratchpad 的 `p6/{old,new,cc}-022/text/beat-0004.md`，需要作者读。

按验收二的四点"超越"逐条判：版本事务与回退（新仓每一步都是 ProjectRevision，`history` / `rollback` 可用；旧仓只有 git，且在沙箱里连 git 都提交不了）——超越；evidence 可追溯（ContextSnapshot id 进 ReviewReport，`review show` 能回到它引用的 artifact 与 hash；旧仓有内容寻址报告但 Context 只是文件）——超越；Context 不靠 host 猜（两边都编译，新仓的投影与引擎 Writer / Reviewer 完全相同）——持平偏优；预算可见——**不做，归 host**（2026-09-06 决定）：host-native 模式下模型调用在 host 进程里，Codex / Grok 自己显示花费、trace 里有每轮 usage，Suiming 不去镜像三个 host 各自会变的格式；新仓的预算只在 `suim run` 内有并已接 OpenTelemetry。真要把 host 会话与 Agent Run 放在同一看板比较时，写一次性的 trace 导入脚本，不进产品。结论：体验与效果两组指标不劣于旧仓，四点里三点超越、一点未做；作者盲评待做。是否进入 R 由作者定，建议先做 F 再进 R，因为 Review Context 单篇已达 9.4 万字。

验收过程中修掉的 host 缺口：并行 `suim` 撞 project lock、CLI 无 SIGINT、host 版 Writer / Reviewer 契约引用引擎工具名、Skill 的 freeze / commit 顺序、`check` 不说明 storyTextPassed 为 false 的原因。

同日晚补测"作者环境里从零开一部作品"：以上验收全靠 scratchpad 的 shim 与手工复制，作者按 README 根本开不了新作品（没有安装步骤、全局 `suim` 是旧仓的 npm link、`init` 拒绝空目录、Checker 与 StoryText 校验拒绝零 Beat、Skill 与 agent 文件要手工 cp）。补上 `npm link`、`suim init --intent-file --agent`、`suim host install` 后，在作者的真实登录 shell 里用 `suim init suiming-new-001 --intent-file eval-022.intent.md --agent codex` 开工，`codex exec` 默认模型、无任何 PATH 技巧，任务限定为 world/core 加第一卷前 3 Beat 并提交：31 条命令，`suim` 调用 open / status ×3 / diff / check ×5 / commit / history 全部走新 CLI；`check` 前四次被 Checker 挡回（不支持的状态字段、secret 知情作用域、重复亲缘声明、终态字段初始化为 false），第五次通过；提交为第 2 个 ProjectRevision，21 个 artifact（3 Beat、7 人物、3 地点、3 资源、core、2 份 reference），最终 clean；约 137 万 input token（126 万命中缓存）、1.6 万 output。暴露一个新缺口：Story Language 字段规则只在 `packages/story` 的 schema 与 `story-language-guide.ts` 里，Skill 让 host "以 `check` 诊断为准"，Codex 于是顺着 npm link 读开发仓源码找规则，8 条命令花在这上面；正式安装没有源码可读。需要把 schema 生成的格式指南作为 `suim` 命令暴露给 host，登记在已知缺陷。

2026-09-06 补齐差项后在同一作品仓（`suiming-new-001`，同时装 codex 与 grok 两个 host）做 Grok Build 真实 session（`grok --prompt-file … --permission-mode bypassPermissions --no-subagents`，模型 grok-4.6-build，默认设置）：任务是读 `design:character:张角` 视图后给第一卷续写 beat-0004 并提交。11 轮模型调用、7 条 shell 命令、0.098 美元；`suim` 调用 open / status / design guide / context compile / design impact / check / commit / history 全部成功，Grok 自己先调 `design guide` 与 Skill 目录下的 story-language 文档再写文件，`check` 一次通过（前一天 Codex 没有指南时是五次），提交为第 3 个 ProjectRevision（新增 beat-0004、人物郝岑、地点槐里东口），最终 clean。至此三个 host 都有真实 session 记录。

## 2026-09-06 按作者意见重写：Writer 在提交前耗尽预算

改完契约后用作者的修订意见作 `--goal` 重跑 beat-0004（DeepSeek V4 Flash）：brief 正常，Writer 分四次 `write` 递增写到 9,876 字节、每次后跟一次 `check`，第 8 次模型调用用完仍未 `submit_story_text`，Run 以 `task_budget_exhausted` 失败，$0.037。这是此前已观察到的"分多次 write 递增写满"行为撞上 8 次的默认预算；此前 beat-0004 成功只是因为五次写入恰好装下。处置：`writeMaxTurns` 8 → 16，契约写明可以多次 write 覆盖、check 只在全文完成后跑一次然后立即提交；不在工具层禁止多次 write（DeepSeek 一类模型每次能吐的字数有限，禁止就写不完）。

预算改 16 后四次重写全部成功（各在一份 checkout 副本上 `run retry`，brief 复用）：

| 版本 | 码点（原稿） | 模型调用 | output / reasoning token | 花费 |
| --- | --- | --- | --- | --- |
| beat-0004，V4 Flash | 10,611（16,456） | 17（含失败的 8 次） | 13.9 万 / 9.4 万 | $0.075 |
| beat-0004，V4 Pro | 9,353（16,456） | 21（含失败的 8 次） | 19.8 万 / 12.9 万 | $0.242 |
| beat-0005，V4 Flash | 8,886（14,088） | 12 | 9.6 万 / 6.7 万 | $0.039 |
| beat-0005，V4 Pro | 9,082（14,088） | 7 | 7.2 万 / 6.2 万 | $0.086 |

两次 beat-0005 的首跑分别死于 `model_call_failed terminated` 与 `Request timed out.`（DeepSeek 瞬时故障，API 本身可达），`run retry` 都从 brief 之后续上。reasoning 占 output 的六到八成，是 DeepSeek 开 thinking 的代价。四版都在 `blind-read-2-2026-09-06/` 等作者第二轮盲读（与第一轮原稿混排）。评委（deepseek-v4-pro 两轮）预筛：beat-0005 三版平均名次都是 2，pro 与原稿在两轮里互换头尾，分不出高下；beat-0004 三版 flash > pro > orig，原稿垫底，但评委仍在 flash 版里点名关羽内心自述是替人物作证式的旁白。契约修改的效果要等作者第二轮盲读定，评委只能说重写没有更差。

## 2026-09-06 作者选择记录 #1：盲读 beat-0004 四版与 beat-0005

作者原文在 [author-choices](../../author-choices/2026-09-06-blind-read-beat-0004-0005.md)。四版 beat-0004 匿名打乱后按网文连载口径读，排序 D > B > A > C，揭晓后即：新仓 Claude Code（隔离 Writer 子 agent）> 旧仓 Codex（gpt-5.6-sol）> 新仓 Codex（同模型、新 Skill）> Suiming Agent（DeepSeek V4 Flash Writer）。C 会弃读，A 会跳段。作者的判断先于来源写定，来源揭晓后排序不变。

对 Suiming 自己的循环，这份记录说明三件事：

- **Writer 输出的主要问题不是 Design 兑现度而是阅读体验**：旁白替人物作证与释义、Design 作者层收束句被逐字搬进正文、同一笔账与原则复述多次、人物改意没有页面动作、提前总结后文后果。beat-0005 的故事矛盾（老宋讨女儿的名字）作者愿意留，现稿要大删。
- **Reviewer 的轻重与作者不符**：6 条 finding 里第 3、4 条已到让作者弃读的程度，Reviewer 全标 minor / note；它抓到了重复与连续性，漏掉 beat-0005 的反复说理、严石"我不回了"又回去、提前讲掉后文、"不应的人锅里少一份"的歧义。第 5 条（张角雨夜死亡时刻）作者不认可列为必改：与 Design 措辞不符但读着成立的只是 note。
- **同一 Writer 模型下新 Skill 不如旧 Skill 的生活气**（A 对 B）：Write Context 与契约把条件、簿册、责任交代得更全，没有换来更好的追读体验；作者决定不再对照旧仓，以后只基于自己的结果优化。

由此定的修改（同日）：Writer 契约加入读者优先规则（旁白不作证不释义、不搬 Design 收束句、同一信息只成立一次、改意要有动作、不提前总结后果）；Reviewer 契约按读者体验定 severity（会让读者弃读或跳段的问题从 major 起，与 Design 时刻措辞不符但读着成立的只是 note）并点名上述漏项；Agent brief 要指出只需成立一次的信息与旁白不得解释之处；Attempt 的 prompt binding 增加角色 prompt 的 sha，之后的对照能归因到措辞。验证方式是同一 DesignCommit 上按作者的修订意见重跑 Writer，作者再盲读一轮。 同日做完 `run rank` 后用它评了这四版：与作者一致的是垫底与缺陷类别，不一致的是头名（评委 B > A > D > C），记在 author-choices 的一致率表。

## 2026-09-05 R1：Suiming Agent 在 eval-022 上的第一批真实 Run

同一份 eval-022 checkout（去掉旧仓辅助文件后 `init`、`check`、全书 `design freeze` 一次通过），DeepSeek 官方 `deepseek-v4-flash`。

- **Design Run**（关羽旧案的作者补充，与 P 相同）：8.5 分钟，12 次模型调用，90 万 token（其中缓存读 70 万），0.039 美元。Agent 读 5 个文件、检索 4 次、edit 5 处（关羽、刘备、beat-0004、beat-0069、Contract），Checker 一次通过，Reviewer pass，提交为新 revision。authoring 首轮 Context 6.9 万码点（含 system prompt、宪法、目标与 Frame），5 轮后因工具回读累计到 21 万；Reviewer 因 coverage 全量 9.7 万起。Frame 校准前后的数字见路线图 F 节。Agent 对已在 Frame 里的文件仍会再 read 一次，因为 edit 要精确原文；Reviewer 有 2 次读不存在路径的工具错误，自行纠正。
- **Writer Run beat-0004**：brief 阶段正常（Agent 读了前三篇正文、调 frame）；Writer 第一次调用把 65536 个输出 token 全部用在 reasoning 上，一个字没写、工具没调，Run 失败。根因三层：writer profile 没单独配置就静默回落到 agent 的选项；DeepSeek 经 pi-ai 只能开关 thinking，效果档位不会送到 API（catalog 没有 `supportsReasoningEffort`），所以改 `medium` 无效；引擎把 stopReason=length 当成"模型不肯提交"报 `task_not_submitted`。已修：引擎报 `model_output_truncated`（configuration 类）并带用量；`.env.example` 写明 DeepSeek 的限制；用 `run retry` 续跑同一 Run 复用 brief 只重跑 Writer，续跑语义在真实模型上成立。第三次尝试把 Writer maxTokens 提到 200000（模型上限 384000）后成功：Writer 7 次调用、reasoning 1.9 万、输出 6.7 万 token，写出 16456 码点，check 通过，绑定当前 DesignCommit 提交；整条 Run 含两次失败共 0.082 美元、约 23 分钟。Writer 没有按契约"一次写入"，而是分 5 次 write 递增写满同一文件（7.7k → 16.4k 字节），每次都是完整前缀而非截断，check 只看最终文件，所以通过；这是模型对单次工具调用长度的自我规避，要不要在工具层限制留给 Reviewer 命中率与成本一起判断。
- **Writer Run beat-0005**：一次成功，约 9 分钟、10 次调用、0.030 美元，写出 14088 码点（三次递增 write，每次都过 check）。
- **独立 text Review（selection beat-0004 + beat-0005）**：5.6 分钟、3 次调用、0.025 美元，verdict revise，6 条 finding 全部 text 层（4 minor、2 note），3 条不确定项。命中与 P 里三个 host 的 Reviewer 高度重合：刘备代韩跛应役后义务悬空（Claude Code 重放抓到同一类"韩家双重覆盖"）、撤离批次与阿弟位置前后矛盾（新仓 Codex 抓到"严石目击距离"）、文末逐字搬 Design 收束句与反复点破"账"母题（Claude Code 重放抓到同一类旁白复述）、应募蒙太奇同构堆叠、张角死亡时刻与 Design"雨夜里病死"不符、留守老汉身份含糊。四个不同 Reviewer（旧仓 Codex、新仓 Codex、Claude Code、Suiming DeepSeek）在同一作品上收敛到同一批失败类别，是 C 题库的第一组交叉证据。
- **一轮闭环的账**：Design 0.039 + Writer 0.082（含两次失败）+ Writer 0.030 + Review 0.025 = 0.176 美元，约 50 分钟模型时间，6 个 ProjectRevision。作者修订这一步没有做：按 R 的定义它是作者的选择，正文与 finding 都在 checkout 里等作者读。

## 附：F 步的 Design Frame 校准实测（2026-09-05）

上文 R1 说的「Frame 校准前后的数字见路线图 F 节」指这一段，原在路线图第 3 节，随那一节删除迁到这里，正文未改。

进度（2026-09-05）：`engine/design-frame.ts` 落地。始终载入 Intent、Story index、全部 Contract、world/core；seeds（作者目标的精确检索命中、本次修改的主体、Review finding 锚点、目标 Beat）经 `storyImpact` 闭包载入直接涉及的 Beat 所在整卷与被引用的人物 / 地点 / 资源 / World；其余只进带标题与 refs 的目录。工具 `read` / `frame` 的补读经 `TaskHandle.noteRead` 并入之后每次调用的 ContextSnapshot。全书 Intent 与 world/core 作为 seed 不扩散（它们的 impact 是整本书）。全书 Design Review 保持完整渲染：ReviewReport 的 coverage 要求覆盖全部 Design artifact，裁剪会让 submit_review 在 coverage 上失败。合成 3 卷 36 Beat 的 Design 上验证：authoring 首轮 Context 少于全书，补读的第三卷 Beat 进入之后的快照。eval-022 实测（2026-09-05，关羽旧案目标）：第一版把检索命中全部当 seeds，命中横跨 7 卷，Frame 载入 99 / 108 个 artifact、7.3 万码点，比全量 6.6 万还大；校准后 seeds 按命中词数只留同量级的前几个（关羽、beat-0004），非 Beat seed 涉及的 Beat 按故事顺序载入到 1.2 万码点预算为止，Frame 载入 61 / 108、4.7 万码点。真实 Design Run 的 authoring 首轮 Context（含 system prompt、宪法、目标）6.9 万码点，5 轮后因工具回读累计到 21 万；Review 因 coverage 全量 9.7 万起。两个占位阈值（2.4 万全量线、1.2 万预算）继续在 R 上调。
