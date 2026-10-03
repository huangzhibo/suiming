# Suiming Harness 设计

2026-09-13 改版。上一版（2026-09-07 设计、H1–H4 已落地）的执行模型是 Conversation → Run → Task → Attempt 四层，本版把它收成 **Session = 根 Agent**，并把「调研」正式纳入 Agent 的能力面。决策依据见 [ADR-0012](adr/0012-own-suiming-harness.md)，产品与领域边界见[系统架构](architecture.md)，实现进度与已知缺陷见[当前状态](current-status.md)，实施切片见第 13 节。

> **本文的纪律与[系统架构](architecture.md)相同：每条属性都要能指到验证它的代码或测试。**本版是设计稿：沿用的机制（四阶段 checkpoint、动作重放、文件 journal、提交对账、父子交接）都指得到现有测试；**本版新增的部分在第 14 节如实标成「没有测试」**，实现到哪一行就把哪一行的测试名补上，不用相邻的测试冒充。

## 1. 自建的是什么，不是什么

Suiming 自建 harness 只有一个理由：做一个**对 Open Story Package 原生匹配的官方智能体**。价值在原生领域工具面（`frame` / `write_context` / `check` / `commit` / `review` / `story_guide`）和 Frame Context 编译（`design-frame.ts`、`write-context.ts`、`review-context.ts`、`source-context.ts`），不在执行循环本身（`loop.ts`）。循环的形状照 Codex 与 Claude Code：**会话就是一份消息列表，作者说一句、Agent 干活、停下，作者再说一句**。

继续依赖 `pi-ai` 的多 provider 调用、消息、工具声明和流式响应类型（0.99.2，它是模型层不是 agent 框架）；不依赖 pi-agent-core，不 fork、vendor 或按字段改名搬入其内核，不建设可切换执行后端。`SuimingHarness` 是唯一执行实现，根 Agent 与子智能体共用一份 loop。

参考基线仍是 pi 仓库 commit `7d8ab31a477ecc07b36f56ffcae58c79307a68be`（agent package `0.85.1`），本地 `~/github/pi`，只作设计与故障场景参考。本版另参考了 NVIDIA 的 [SoL-Pi](https://github.com/NVlabs/SoL-Pi)（本地 `~/github/SoL-Pi`，MIT）四个省 token 机制里的三个半——它是 Pi 扩展，装不进我们的 loop，机制按第 7、8 节的说法自己实现，不引入依赖。

## 2. 模型：Session 与 Task，没有 Run 和 Attempt

| 对象 | 稳定语义 | 生命周期边界 |
| --- | --- | --- |
| Session | 一个根 Agent：一份连续的消息列表、当前模型绑定、累计用量、lease；工作目录就是作品 checkout | 作者第一条消息时创建；作者删除才结束。切换页面、attach、退出应用、进程重启、换模型都不新建 |
| turn | 作者一条消息到 Agent 停下之间的那一段消息 | 不是实体，不持久成状态机。AG-UI 的 `runId` 就是 turn id |
| Task | 一个子智能体：有输入契约、写入范围、结果契约，有自己的消息列表与 checkpoint | 普通工具调用不新建；`delegate` / `review` 才新建；完成后只读 |

**和 Codex / Claude Code 的对应**：Session ↔ 它们的 session / thread（rollout、transcript JSONL）；turn ↔ 它们的 turn（内存态）；inbox ↔ Codex 的 pending input、Claude Code 的排队消息；Task ↔ Claude Code 的 `Task` 工具与 sidechain transcript。它们都没有 Run 和 Attempt。

**为什么去掉 Run。**Run 承载的东西——lease、预算、worktree、作品基线、本轮目标——除了「本轮目标」都是 session 级的；「本轮目标」只是作者说的一句话，进消息列表即可。Run 的七态状态机（pending / running / interrupting / completed / failed / interrupted / cancelled）描述的是一个 turn 的结局，而 turn 的结局对作者只有一个意义：Agent 停了，看看它说了什么。

**为什么去掉 Attempt。**它做的三件事都有更便宜的载体：冻结绑定 → checkpoint 里已有的 `binding` hash，改成按 turn 冻结（第 4 节）；归因 → 每条 `AssistantMessage` 自带 `provider` / `model` / `api`（pi-ai 类型）；失败重试 → 消息列表继续，失败的调用留在 `calls[]`，新调用新 id（现在的 `retryOf` 就是这么做的）。「有未确认副作用时拒绝换模型」这条规则原样保留，只是不再需要一个实体来承载它。

**为什么去掉 worktree。**它是 Run 模型的产物：每个 Run 要一份可整体丢弃的隔离候选，「Run 完成 → worktree 释放」就是当时的「不留残局」机制。Codex 与 Claude Code 都直接在用户的 checkout 里干活，作者在编辑器里看着文件变。我们的 checkout 本来就是「任何人都可以改的候选」（AGENTS.md 不变量 3），host agent 走的正是这条路：改文件 → `suim commit` 扫 diff → Checker → 推进 `refs/suiming/canon`。Agent 也走这条路之后，作者、host agent、Agent 三方只有一份候选、一份 diff、一条提交路径；worktree 带来的三方合并、`run_merge_conflict`、`run.diff`、创建 / 回收 / 基线推进（87 处引用、18 个文件）一起消失。要并行跑多个 session 时再给 session 配可选的 worktree——Claude Code 的 `--worktree` 就是这个形状——接口位置是 session 的工作目录，v1 不做。

**为什么留 Task。**writer 子智能体一跑十几分钟，进程死了要从它自己的 checkpoint 接上，不能从零重跑；`read_result` 的回读靠它。事实是 eval-022 的四个 Run 里 `delegate` / `plan` / `review` 一次都没用过（read 93、search 10、check 4、edit 2、commit 1），所以子智能体机制本版不投入；它是为长篇规模留的，不是为现在。

**`plan` / `execute_task` 删掉。**预规划、`dependsOn`、撤销未执行计划、task contract 对象——这一整套零使用，而它是 Task 记录里最重的部分（planned 状态、依赖校验、`cancelPlannedTasks`）。要计划就写在消息里，Claude Code 的 TodoWrite 也只是文本不是实体。Task 只剩两个来源：`delegate` 与 `review`。

## 3. 生命周期

Session 只有三个状态：

| 状态 | 含义 | 离开它的方式 |
| --- | --- | --- |
| `idle` | 等作者 | inbox 来了新消息 → `running` |
| `running` | 一个 turn 在跑 | 模型停下 → `idle`；作者 `interrupt` → `idle`；需要作者处理 → `paused` |
| `paused` | 要作者处理才能继续，带结构化 reason（第 10 节） | 作者处理后 `resume` → `running`；作者 `interrupt` → `idle` |

没有 completed / failed / cancelled：session 不会「完成」，错误显示出来后继续，作者删掉才没了。`lastFailure` 是记录字段不是状态。

**turn 开始**（`idle` 且 inbox 有未消费消息）：

1. 拿 lease，按当前模型、systemPrompt、工具面重算 binding。工具面与宪法的升级在 turn 边界生效，不再「新工具留给下一个 Run」；中途恢复（有 `effect_pending` 的调用或动作）仍要求同一绑定。
2. 在作者消息后附一行确定性状态：当前版本、自上个 turn 是否有人提交过、checkout 里未提交的文件数，在消息被取走的那一刻算（turn 中途 Agent 改过或提交过，附注跟着变）。这几行代替上一版 32,000 码点的历史文本注入——历史就在消息列表里，对 provider 的 prompt cache 也更友好。会话第一次跑时的开场（作品状态与 Design Frame）只写一次，标明是「会话开始时的快照」。

Agent 直接在作品 checkout 里读写，没有自己的目录；作者在两个 turn 之间改过、提交过什么，Agent 下一步 `read` 到的就是什么。**一个 Project 同时只有一个 `running` session**（v1）：前一个停下之前，另一个 session 的 `session.send` 直接被拒绝（`session_running`），同一个 session 再说一句则排进它的 inbox（`local-session-controller.test.ts`「一句话开一个 turn；同一作品同时只跑一个」）。

**turn 结束**：模型一次响应里没有工具调用，turn 就结束（Codex / Claude Code 语义）。没有 `finish`，没有「交付协议」，没有三次催交。系统在 turn 结束前发一份对账（ACTIVITY_SNAPSHOT `suiming.turn`，2026-10-01 实现）：本轮作者消息数、turn 开始与结束时 checkout 之差按意图 / Design / 正文 / 审稿 / 其它分类的文件、Agent 提交了几个版本、结束时还有几个文件未提交，以及这一轮没取写作依据（`write_context` 或委派 writer）就整篇 `write` 的正文（2026-10-03 加：斗破留出评测里根 Agent 三节正文都凭 Frame 自己写，没人发现；从这一轮的动作事件算，writer 子任务的写入与 `edit` 小改不算）——纯算术，进事件不进 prompt；调研来源与落盘数（第 8 节）随切片 E 加进来。「作者目标是否达成」由作者看作品定，系统不判。

**未提交候选就是脏的 checkout。**上一版要求 Run 结束前 worktree 必须干净（`finish` 的 `invalid_delivery`），因为 worktree 随 Run 释放；本版候选就在 checkout 里，`project.diff` 看得见（作者、host agent 与 Agent 的改动是同一份 diff），下一个 turn 可继续或提交。「不留残局」的实质——候选不能静默丢失——由 checkout 本身加 turn 结束的对账保证，不再由交付协议保证。

**`interrupt`** 一个命令代替上一版的 pause / cancel / interrupt：中止当前模型调用（checkpoint 记 `interrupted`，下次续接时弹掉半截响应）和正在跑的子任务，消息列表原样，回 `idle`。取消不回滚已提交作品。

**关闭**：作者删除 session。删的是 inbox、事件与 checkpoint，execution object 按引用计数留待回收；checkout 不动——它不属于任何 session，未提交的改动仍在 `project.diff` 里。

**owner 与 lease**：每个 `running` / `paused` 的 session 有一个进程 owner（pid + hostname + 每次领取的 ownerId）。`LocalProjectService.open` 只收敛持有者已死的 session：回 `idle` 并记一句 `process_restart`；checkpoint 里有未决副作用的，下一个 turn 开始时才落进第 10 节的三种 `paused`。所有推进与提交核对 ownerId 与实体版本，陈旧 owner 的写入被拒绝。

## 4. 执行循环

`runTaskLoop` 是唯一的模型 / 工具循环，根 Agent 与子智能体共用。它在短事务内保存决定，事务外调模型或工具，返回后再以短事务确认；等待网络、子任务或作者时不持有数据库事务或 project 文件锁。

| checkpoint 阶段 | 允许做的工作 | 下一持久边界 |
| --- | --- | --- |
| `ready` | 取走 inbox 新消息、投影 Context（第 7 节） | 登记准确请求进入 `model_pending` |
| `model_pending` | 执行已登记的 ModelCall，或核对遗留请求 | 完整响应与动作批次原子确认后进入 `tools` |
| `tools` | 按记录执行、核对或交还动作 | 全批结果按原始顺序入消息后回到 `ready`；委派停在这里 |
| `settled` | turn 已结束或被打断 | inbox 新消息 → `ready`（这就是 turn 续接，现有 `finishTerminated` 路径） |

ModelCall 保持 `prepared → effect_pending → received | failed | unknown`；Action 保持 `planned → effect_pending → result_ready → delivered`。登记为 prepared 不表示已发送，恢复时停在 prepared 的请求直接撤回、回到 ready 重新组装，期间到达的作者消息一起带上（unknown 的重发除外，它按冻结的 Context 发）。调用 Gateway 前先确认 effect_pending，进程退出后即使实际未发送也只能按可能已发送处理；但确认之后、发出之前在进程内发现作者已停止时，请求确定没有发出，退回 prepared——留着 effect_pending，作者自己的停止就会让下一句停在「模型请求结果待确认」。unknown 请求的重发产生新调用 id 并关联原请求。完整响应的模型消息、全部动作身份与 `tools` checkpoint 一起确认；`stopReason` 为截断、取消或错误的响应不授权执行其工具调用。

**binding 按 turn 冻结。**`taskLoopBinding` 的输入是模型快照、systemPrompt、工具声明，不再包含第一条消息。turn 开始时重算并写进 checkpoint；恢复时比对的是 checkpoint 里那份，而重绑只允许在 `ready` / `settled`（没有 `effect_pending`）发生。

**只有两种重放策略**：`replay: "read"`（结果随 prepared 冻结，恢复直接复用；无结果时对同一输入重算）和 `replay: "reconcile"`（按工具自己的幂等机制核对：文件 journal 的前后 hash、领域 receipt、子 Task 的 key）。动作状态机因此只是分派器，每个 reconcile 工具各自回答「进程退出后怎么知道做没做」。

**等待不是阶段。**委派表达为 `tools` 阶段里一个停在 `effect_pending` 的动作：`executeChild` 以父动作 id 作为子 Task 的 `key` 同步 `await`；进程重启后父从 checkpoint 重放到同一次委派，按同一个 key 找到已完成的子 Task 直接读结果——恢复靠持久 key，不靠 JavaScript 栈。**作者提问不再是工具**：模型在文本里问，停下，turn 结束；作者的回答是 inbox 的下一条消息。上一版 `ask_author` 的 `run_waiting_input` 与序号核对随之删除。

**steering 只给根 Agent。**上一版把 `readRunSteering` 传给每个子任务，作者插话会进正在跑的 Worker；本版 inbox 只由根 loop 的 `ready` 阶段取走，子任务不 pull。要改子任务的方向就 `interrupt`。

**进展型兜底只剩一道**：连续三次重复同一个被拒绝的动作（工具名 + 参数 + 拒绝内容同指纹）→ 结束本 turn 回 `idle`，`lastFailure` 记 `run_no_progress`，作者的下一条消息就是继续；不进 `paused`，因为作者要做的事就是说一句话。上一版的「连续无交付 → `task_not_submitted`」随 `finish` 一起消失。代价照旧写明：一个「持续产出但方向错了」的 turn 没有闸会停它，只能靠作者看到；这是已知缺陷不是设计留白，缓解手段是第 3 节的对账和第 8 节的可见性。

工具参数错误、Checker 诊断（`StoryParseError`）与可修复的领域拒绝作为工具结果反馈给模型；存储损坏、写入失败、owner 失效等基础设施故障停止推进，不伪装成模型可修复的业务错误。

## 5. 动作效果与恢复规则

| 动作 | 正常执行前必须保存 | 进程退出后的核对方式 |
| --- | --- | --- |
| read / search / check / frame / write_context / project_status | 查询与明确版本 / 内容 hash | 有结果就复用；无结果只对同一输入重算。输入已变时不能把新读数冒充旧结果 |
| write / edit / delete | 路径、预期前后内容 hash、新内容引用和 journal 身份 | 当前为 before 则执行，为 after 则补确认，其余为冲突；路径权限与 symlink 边界重新检查 |
| commit（`freeze` 参数随切片 G 删除） | 动作 id、输入指纹、基线与领域命令 id | 查领域 receipt；已提交就返回原结果，未提交才重入，输入不同报冲突 |
| delegate / review | 子 Task id 与父 action id；子任务的初始 prompt 在创建时算好、存进它自己的 checkpoint（不再把整份候选 base64 冻进 `prepared`） | 查已有子 Task；运行未完成工作或返回已保存结果，不重复创建 |
| web_search / fetch（未实现，下面三行都是切片 E / F 的设计） | 查询或 URL、时间戳 | 有结果就复用；无结果重取，取回内容不同时存为新对象并标 `refetched`——它们是外部读取，不是副作用 |
| save_material | 来源对象 id、目标路径、journal 身份 | 与 write 相同 |
| run_command | 命令、checkout 的文件 hash 表 | 有结果就复用；停在 effect_pending 则不重跑，把「结果未知」与文件差集作为错误结果交给模型决定 |

没有一行会让 session 因「外部效果未知」暂停：本版所有工具要么是读取，要么有自己的幂等核对，`run_code` 的未知交给模型而不是作者。将来出现真正的外部写（例如发布到第三方平台）再加暂停那一行，不预留。

一次多文件修改的 journal 必须在任何文件替换前完整保存，恢复完成整批或报告冲突后才允许下一个写动作。作品提交与其领域 receipt 在同一个数据库事务确认；执行 Action 的确认允许晚于作品事务，退出后通过 receipt 补记，不重做提交。

**`commit` 工具就是 `commitCheckout` 加 commandId receipt。**作者的「提交」按钮、host agent 的 `suim commit`、Agent 的 `commit` 三条路只剩这一条：扫 checkout diff → ChangeSet → Checker → 推进 `refs/suiming/canon`。上一版 `commitManagedChangeSet` 的三方合并没有了：作者与 Agent 改同一文件时，Agent 的 `edit` 在动作时读的就是作者改过的内容（`oldText` 对不上就失败、模型重读），作者在编辑器保存走 `workspace.file.save` 的 `expectedSHA`（文件被 Agent 改过就报冲突、保留外部修改）。两边都在动作发生的当下解决，不攒到提交时。

外部模型请求属于结果可能未知的调用：已确认的响应直接复用；请求已发但结果未确认时保留最新持久部分和未知用量，默认 `paused` 让作者决定是否重发；显式授权的重试策略可以继续，但必须展示未知成本，不承诺 exactly-once。

请求有了结果、只是结果是瞬时失败（流中断 `terminated`、`Connection error.`、429、5xx，按 pi-ai 的 `isRetryableAssistantError` 判）时不必等作者：`runTaskLoop` 撤回这次响应和它带出的工具调用，退避 2 / 4 / 8 / 16 / 30 秒在同一个 turn 里重发，最多 5 次，用尽才回 idle 报 `model_call_failed`（附重试次数）；失败的调用照记账，作者停下立即生效。订阅额度用尽、401 这类不重试。2026-10-02 斗破抽取经代理连 ChatGPT 时一小时内断了两次，每次都结束整个 turn。

## 6. 工具面

根 Agent 的工具按能力分组；每个工具只有一种重放策略。上一版的 `finish`、`ask_author`、`read_conversation`、`plan`、`execute_task` 删除，其余不动。

| 能力 | 工具 | replay | 说明 |
| --- | --- | --- | --- |
| 读取作品 | `read` `list` `search` `frame` `write_context` `project_status` `read_result` | read | `read` 结果过大时按第 7 节折叠；`list` 列一层目录（2026-10-01 加回，没有 shell 时找审稿、资料、正文的准确路径只能靠它），`.git` / `.suiming`、host 接入目录、symlink 与读范围之外的文件不列 |
| 修改候选 | `write` `edit` `copy` `move` `delete` | reconcile（journal） | `copy` 把一个文件或整个目录原样复制到新路径，内容不经过模型（2026-10-02 加：斗破抽取的「原样提升」没有它时让模型把 176 个文件逐个重打一遍，约 35 分钟），每个目标文件照 `write` 先准备 journal 再落盘。`move` 与 `mv` 同义，挪完原处不留，目标已有不同内容时拒绝（2026-10-03 加：120 章整合给 153 节分卷时只能逐个 `copy` 再 `delete`；换卷就是改 index 加 `move` 文件）。可写范围是整个 checkout（`.git` / `.suiming` 与 host 接入目录除外，见下）；Story 根之外的文件是 repository-auxiliary，永远不进版本，`commit` 结果点名跳过的文件。`write` / `edit` 带可选 `check: true`（2026-10-02 已实现，Writer 的交付句改为「全文完成的那次 write 带 check」）：改完立刻对候选跑 Checker，一次观察返回两者，省一个模型来回；结果也给写入后的字数（同日加，Writer 曾把 6,745 码点报成「约一万字」）（SoL-Pi Action Fusion 的无 shell 版；DeepSeek 写一万字要 write 四五次、每次后跟一个 check，实测见 CLAUDE.md） |
| 检查与提交 | `check` `commit` | read / reconcile（receipt） | Checker 在 `commit` 处把关不变，StoryText 完整性与 exact 片段也在这道 Checker 里；`check` 与 `write` / `edit` 的 `check: true` 跑的都是对整个候选的同一判定（PASSED / ISSUES / FAILED）。单 Beat 的 `checkStoryText` 只在 CLI `suim text check` 后面，引擎不调用 |
| Context | `compact_context` | read | 模型主动压缩；系统触发的压缩见第 7 节 |
| 子智能体 | `delegate` `review` | reconcile（Task key） | `delegate({ profile, goal, storyBeatId?, sourceId? })`：角色定义与写入范围都由 profile 决定（第 9 节），不再传 `writablePaths` |
| Story Language | `story_guide` | read | 从真源 schema 查 Target / Source 的格式，不凭记忆猜字段。Source 是小说原作：原文按码点区间用 `read_source` 读（笔记的 span 与它对齐），覆盖率用 `source_coverage` 查，笔记用 `write` 写成文件；`record_source` / `source_notes` 已拆（第 16 节） |
| 调研 | `web_search` `fetch` `save_material` | read / read / reconcile | **未实现（切片 E）**，设计见第 8 节 |
| 计算 | `run_command` | reconcile | **未实现（切片 F）**，设计见第 8.5 节：本机 shell 在 Seatbelt 里跑，只能读写 checkout、无网络，结果直接落文件，改动清单随结果回来 |

**scope 去掉。**上一版 `run.design` / `run.write` / `run.review` / `run.source.*` 是「权限预设 + 交付检查」。前者在长会话第二轮就不成立——作者顺口一句「顺便改下大纲」；后者是在判「作者目标是否达成」。这些入口变成消息模板（桌面「写这个 Beat」发的是「完成并提交 beat-0004 的正文」这句话）。写入范围放开到整个 checkout：哪些路径是合法作品文件由 codec 与 Checker 在 `commit` 时判，工具层不再设第二道（上一版 `writable()` 的正则与 `writableRoots` 一起删）。

**host 接入文件不进 Harness（2026-10-01）。**作品仓里常装着 `suim init / update --agent` 写的 Codex / Claude Code / Grok 接入文件：Skill（带一份 Story Language 副本）、`.codex/agents/*.toml`、`AGENTS.md` / `CLAUDE.md` 里的 Suiming 标记段。两种执行者在同一个 checkout 上汇合的是作品文件、Checker、`commitCheckout`、写手与审稿的角色契约（`writerSystemPrompt` / `reviewerSystemPrompt` 同一份源出两个变体，host 经 `suim context compile` 取）和审稿落盘（`composeReviewFile`）；主 Agent 怎么干活各写一份——SKILL 写给有 shell、有自己子 agent 的 host，`AGENT_PROMPT` 与工具描述写给 Harness。所以 Harness 不加载 Skill、`AGENTS.md`、`CLAUDE.md`：那是一套它执行不了的第二份指令（跑 `suim` 命令、派 `suim_storytext_writer`），每轮还要多付 token。`.agents/` `.claude/` `.codex/` `.grok/` 对模型的文件工具与 `.git` / `.suiming` 一样不可见（`ConfinedExecutionEnv` 的 `HOST_ADAPTER_ROOTS`，按小写比）：读了只拿到用不上的指令，改了不进版本、turn 对账只比作品文件也看不见——`list` 加回之后它们第一次出现在模型眼前，装上接入文件的回归里读到 Skill 的两次都照它改用委派 Writer，花费约为平时的 2.5 倍（[记录](validation/2026-10-01-harness-regression/README.md)）。作者的文件视图照常可见（`hostAdapters: "visible"`）。入口文件不藏：作者可能在标记段外写了自己的东西，Agent 看得见但不自动加载，作品要长期遵守的约束在 `intent/**`。新加一种 host 时根表要跟上，`cli.test.ts` 按 `installHost` 实际写出的路径核对。入口文件里的 Suiming 标记段原本叫所有读者「先读 Skill」，Agent 读到就去试（18 次里 1 次读了两份被拒），现在只点名给 host，并告诉应用内的 Agent 不是写给它的（`host-install.ts` 的 `ENTRY_BLOCK`）。两边**同时**在一部作品上跑仍会互相覆盖：没有 per-session worktree，作品锁只锁 open 与 commit（第 2 节）。

**`submit_review` 校验引文（2026-09-13 随切片 G 落地）。**Reviewer 的每条 finding 带 evidence 引文，审稿页把 finding 锚回段落靠的就是它；引文找不到时页面只能静默只锚文件——典型的失败静默。`review-authoring.ts` 的 `quoteMissing` 在落盘前拒绝引文不在锚定文件里的 finding（去空白与引号后逐字匹配，规则与渲染端 `anchors.ts` 相同），拒绝作为工具错误回到 Reviewer，host 的 `suim review record` 走同一处。这是 AGENTS.md 说的「malformed output 由 tool contract 拒绝」，规则来自 SoL-Pi 的 Evidence-Preserving Reducer。余下的差别：校验按整个文件匹配，页面按段落锚，跨段的引文过得了校验、锚不到段落。

工具描述是 prompt 的一部分：`taskLoopBinding` 的哈希包含工具声明，改措辞就是换了绑定，只能在 turn 边界生效。描述里不复制 Story Language 字段表。

## 7. Context：Frame、折叠与压缩

每次模型调用经过现有 Context Compiler / Frame：初始 Frame 是 `design-frame.ts` 按种子裁剪的 Design（超过 `DESIGN_FRAME_FULL_RENDER_CODE_POINTS` 才裁），Write / Review / Source 各有编译器。**按次 ContextSnapshot 拆掉**（第 16 节）：模型的实际输入（投影之后的那份）随 checkpoint 保存：当前请求那份在最新的恢复点里，历史请求的留在当时的恢复点里（旧恢复点不删），供回看与调试；不再为每次调用生成 evidence，`noteRead` / `contextArtifacts` / `suiming.context` 事件 / `sessionEvidence` checkpoint 一起删。

**窗口保护（2026-10-01 已实现，[Harness 审查](validation/2026-10-01-harness-review/README.md) F3）。**会话永续、消息列表只增不减，请求必须有办法变小。每次请求前按模型目录的 `contextWindow` 估大小（上一次请求的字节数与返回的 input tokens 校准，没有数据时按 3 字节 1 token），由轻到重，只改请求的投影、不改消息列表与 checkpoint：

- 超过窗口的 80%：从旧到新把工具结果换成占位（「较早的工具结果已清除……需要时重新读取」），清到 50% 以下；最近一条模型回复之后的结果不清。清理点（`cleared`）只往前推，两次清理之间请求前缀不变。
- 清完仍超过 70%、且工具面里有 `compact_context`：在这次请求末尾加一句附注请模型先压缩，附注不进消息列表。
- 估计值超过整个窗口：不发，报 `context_overflow`，提示开新对话或换更大窗口的模型。
- provider 自己报超限（pi-ai `isContextOverflow`）：撤回那次响应，把能清的全清掉重试一次；清无可清或已经试过就报 `context_overflow`，不无限重发。

阈值是占位值，要在真实长运行里调。它是下面「折叠」的粗版本：按位置清而不是按大小与发送次数折，占位符不带头尾摘录，取回就是重读，没有 `recall`。

**折叠（SoL-Pi ObservationPack 的改法，未做）。**eval-022 四个 Run：137 次模型调用，`pi-context` 每次 48–492 KB，合计 30 MB；`read` 93 次，每次读的正文从此留在每一次请求里，直到模型想起来 `compact_context`（四个 Run 里调过一次）。规则：一个工具结果超过 10 KB 时，前两次请求全量发，之后在 `ready` 阶段的投影里换成占位符（头尾各 512 字节 + 原动作 id + 大小 + 取回方式）；历史消息与 checkpoint 不改。取回比 SoL-Pi 简单：`read` 的原文就在 checkout 里，占位符只说「`read path offset` 可重读」；`frame` / `write_context` / `search` / `fetch` 这类编译或抓取结果按动作 id 从 checkpoint 或对象回读（`recall` 工具，read）。代价是第三次发送时 provider 的 prompt cache 断一次；大结果 + 长会话稳赚。

**压缩在边界做，不在中途做（未做）。**上一版只有模型主动的 `compact_context`；本版系统也会触发，但触发点是两个天然边界而不是 token 阈值：

- **`commit` 之后**：候选已进 Canon，提交前的读取都是死重，Frame 可以从新 head 重新生成；
- **turn 结束后**（`idle`）：没人在等，摘要调用可以慢慢做，下一个 turn 开始时使用。

中途的窗口保护见上。边界压缩复用现有 `reduction` 机制——摘要由模型生成，记录来源范围与摘要调用，替换 `throughMessage` 之前的非作者消息；原始消息、动作结果与未应用指令不删。压缩之后自动追加一次 `project_status` 与 Frame 重建，对应 SoL-Pi 在压缩后要求重建计划。SoL-Pi 的 cache 写读比经济模型不采用：对我们是过度设计，边界已经把「压缩掉正在用的东西」这个主要风险去掉了。

## 8. 调研

### 8.1 定义与边界

作品需要的外部知识：史料、地理、行业与制度知识、类型样本、读者口碑、同题材作品的处理方式。它**不是 Source**——Source 是小说原作（改编来源），走 `source/**` 与 Source 工具；调研的对象在作品之外。

产物位置由 Story Language 定义（[artifacts.md](../story-language/artifacts.md)）：原始资料进 `reference/materials/**`，按稳定主题维护的认识进 `reference/research/<topic-id>.md`，不按会话堆报告。二者都不是 Canon 事实：只有被选择并写进 Design 或 Intent 的结论才约束后续任务。这条与 host 侧 SKILL 里 Researcher 的契约一致（「只返回可合并的认识、分歧、适用边界、启发和来源，不替作品决定 Canon」），managed 侧本版补齐。

「深度调研」不是一个特殊模式：它就是 Agent 或 Researcher 子智能体在一个 turn 里多轮 `web_search` → `fetch` → 读 → 再搜的循环，深度由模型按问题决定，上限只受显式预算约束（默认不设，与创作路径一致）。

### 8.2 工具

pi-ai 不带 provider 原生的 web search，三个工具都是我们自己的：

| 工具 | 做什么 | 结果 | replay |
| --- | --- | --- | --- |
| `web_search({ query, limit? })` | 调配置的搜索后端 | `[{ title, url, snippet }]` | read |
| `fetch({ url, offset? })` | GET 一个 URL，HTML / PDF 转成文本，存为 content-addressed 执行对象 | 第一页文本 + `objectId` + 总大小；分页与 `read` 同形 | read |
| `save_material({ objectId, path, title, note? })` | 把已抓取对象落成 `reference/materials/<id>.md`：frontmatter 记来源 URL、抓取时间、sha256、标题；正文直接来自对象 | 写入结果 | reconcile（journal） |

`save_material` 存在的理由是**不让模型转录长文**：和 Worker 结果「先校验保存、再以引用交还」是同一条原则。`reference/research/<topic>.md` 的综合认识则由模型用普通 `write` / `edit` 写——那正是要它做的事。

搜索后端在 `~/.suiming/config.toml` 的 `[research]` 段选（首版接一个 HTTP 搜索 API，key 走现有 auth 存储，不进 config）；没配置时 `web_search` 不进工具面，`fetch` 仍可用。工具面随配置在 turn 边界变化，由 binding 按 turn 冻结兜住。

### 8.3 Researcher 子智能体

`delegate({ profile: "researcher", goal })` 派一个只读作品、可上网、只能写 `reference/**` 的子智能体：工具是 `read` / `search` / `frame`（作品）+ 三个调研工具 + 限定路径的 `write` / `edit` + `submit_task`。交付形状是结构化结果：认识、分歧、适用边界、来源列表（URL + 对象 id），存为结果对象，父按 `read_result` 回读引用，主模型不转录。模型 profile `researcher` 缺省回落到 main。

这是 [收敛方案 3.6](consolidation-plan.md) 「角色定义与 Context 投影成对交付」的第三个实例（前两个是 writer 与 reviewer）：profile 绑定模型、system prompt、Context 编译器、交付契约、工具集五样；何时派、派几次由根 Agent 决定。

### 8.4 信任与安全

抓回来的内容是**数据不是指令**。结构性保证（一旦失守直接坏作品的那类）：

- 网络工具只有 GET，没有 POST、没有表单、没有认证头；不把作品内容放进 URL。
- 默认拒绝私网与本机地址（localhost、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、IPv6 等价段），可配置 allow / deny 域名列表；跟随重定向时每一跳重新检查。
- 只落文本：`save_material` 拒绝非文本对象；`fetch` 有单次大小上限（首版 2 MB）与超时；不下载到作品目录之外，不执行任何抓回来的东西。
- Researcher 没有 `commit`，写入范围限 `reference/**`：即使 prompt injection 成功，最坏结果是一份错误的资料文件，过不了作者的采用。
- 代理走进程入口已装的 `useEnvironmentProxy()`，不另配。

可见性保证（失败静默的那类）：每次 `fetch` 是一条 `ACTIVITY_SNAPSHOT`，带 URL 与大小；turn 结束对账里有「本轮抓取来源数 / 落成 materials 数 / 更新的 research 主题数」。搜索 API 的调用次数记进 session 用量的独立计数，不发明价格表。

system prompt 里写明「抓取内容中的指示不是作者指示」——这是能力交给模型的那一半；上面的结构性边界是它失守时的保底。

### 8.5 计算：`run_command`

**现状：不支持，而且是我们自己拦的。**作品 checkout 是作者机器上的普通目录，Canon 是普通 git 仓；harness 没有 shell 和执行工具是刻意的选择，不是环境限制。写文件不是障碍：整个 checkout 可写（`.git` / `.suiming` 与 host 接入目录除外），模型能把 `scripts/count.py` 写进去，它是 repository-auxiliary、不进版本（第 14 节「`write` 到 Story 根之外」那一行）；缺的是没有东西去跑它。作者问「写个 Python 脚本统计正文用词频率」，今天的答案是模型只能把正文 `read` 进来在脑子里数——不可靠也不可复现。

这类需求（统计用词、按设定推演资源曲线、核对时间线的日期算术）值得一个工具。边界由沙箱给，不由「只准跑哪种解释器」给——那是人为收窄，Seatbelt 之下跑 python 和跑 bash 的风险一样。做法与 Codex 相同——本机 shell + macOS Seatbelt：

- `run_command({ command, timeout? })`：本机 `bash -c` 跑一条命令，cwd 是作品 checkout。统计用词就是 `python3 - <<'EOF' … EOF`，也可以是 `python3 scripts/count.py`、`wc`、`grep`。
- 用 `sandbox-exec`（Seatbelt，Codex 在 macOS 上用的同一机制）套一个 deny-default 的 profile：可执行文件限系统与 Homebrew 的 bin 目录，读 checkout 与系统库 / 解释器安装目录，**写只限 checkout**（`.git` / `.suiming` 子路径除外），禁网络。2026-09-13 在本机验过 deny 侧：`urllib` 报 `URLError`，读 `~/.ssh` 报 `PermissionError`。Seatbelt 不在的平台上这个工具不出现，不退化成无沙箱的 shell。
- **脚本直接写文件，结果不过模型。**统计表、派生数据直接落到 `reference/research/**` 就是候选的一部分，进 diff、过 Checker；写到 Story 根之外（`scripts/`、`out/`）的是 repository-auxiliary，永远不进版本，`commit` 的结果里点名列出被跳过的这类文件，免得模型以为存上了。让脚本把结果打到 stdout 再由模型 `write` 一遍，是让模型转录长文——违反第 8.2 节 `save_material` 的理由。文件 journal 不受影响：journal 只核对单个动作 prepare 到 execute 之间的前后 hash，动作之间的文件变化对下一个动作就是新的 before，和作者自己改文件一样。
- 工具结果 = stdout / stderr + **本次改动的文件清单**（执行前后各扫一次 checkout hash 的差集，确定性），过大时按第 7 节折叠；超时（首版 60 s）与输出上限如实标明。
- 重放是 `reconcile`：prepare 冻结 checkout 的 hash 表；恢复时发现动作停在 `effect_pending` **不自动重跑**——把「上次执行结果未知」和从冻结表到现在的文件差集作为错误结果交还模型，由它看情况决定重跑或收拾；不为此暂停 session。
- 命令留在动作记录里可回读；要留给以后用就写成 `scripts/*.py` 放在 checkout，它是 repository-auxiliary，git 里随作者的意愿处理，不进版本。
- 宿主有什么解释器用什么；工具描述里如实列出探测到的（`python3` / `node` 等），没有就不提。首版只做 macOS——产品先发 macOS；Linux 走 bubblewrap / Landlock 的路 Codex 也铺好了，到时候照抄。
- 第三方包：解释器自带的标准库；禁网所以 `pip install` 自然不通。要分词就把纯 Python 的 wheel 随应用打包进一个私有 `site-packages`，profile 里加一条可读路径。

不做的：无沙箱的 shell、Node 的 `vm` / `worker_threads`（不是安全边界）、Pyodide / 容器 / VM（本机目录 + Seatbelt 已经够，14 MB 的 wasm 解释器是为不存在的隔离需求付成本）。

### 8.6 host 侧

Codex / Claude Code / Grok 自带网络能力，调研方法论在共享 SKILL 里已写（定向 → 发现与调研 → 候选与裁决），`suim` 不需要 `fetch` 命令；`reference/**` 的落盘规则两侧相同。

## 9. 子智能体与写入权

父子交接沿用现有五步：父发出委派动作并保存 action id → 一个事务创建子 Task（`key` = 父 action id）→ 同一 harness 在父调用内同步推进子 Task，父不持有 DB 锁 → 子结果过 schema、权限与领域检查后先写完整结果对象，再原子确认 Task 结果 → 父以同一 action id 保存工具结果，消息追加与 checkpoint 推进原子确认。通知只用于唤醒，丢失或重复不改变结果。

`delegate` 的 profile 是角色定义，**写入范围随角色走**：`writer`（Writer 契约 + Write Context + 只写那个 Beat 的正文文件；交付前全文完成的那次 `write` 带 `check: true`，跑的是对整个候选的同一判定）、`reviewer`（`review` 工具单独走，只读 + `submit_review`）、`source-reader`（只写自己的笔记 `source/<id>/notes/**`；2026-10-02 之前是只读，分段读原作的子任务只能把整份笔记塞进报告让父 Agent 抄）/ `source-extractor`（不带范围时只写 `source/<id>/outline/**` 与 `world/**`；带 `span` 与 `beatRange` 时只写号段内的 Beat 与这段的笔记 `notes/<号段>.md`，见下文「Source 抽取的分工」）、`main`（与根相同的写范围）。`researcher`（只写 `reference/**`）随切片 E 才有，现在 `delegate` 不接受它。上一版的 `writablePaths` 参数删掉。子智能体的工具（`agent.ts` 的 `subagentTools`）是 `project_status`、文件工具（按写范围给 `write` / `edit` / `copy` / `move` / `delete`）、`search`、`check`、`frame`、`compact_context`、`read_source` / `source_coverage` / `story_guide`，加交付用的 `submit_task`；根 Agent 有而它没有的是 `commit`、`delegate`、`review`、`write_context`、`read_result`。Worker 是权限形状——task-local、无 `commit`、不递归委派、不 pull inbox——不是角色；两者正交。

没有预规划：`plan` / `execute_task` 已删（第 2 节）。根 Agent 要分几步做，写在自己的回复里；`delegate` 是同步调用，结果回来再决定下一个。例外是写入不重叠的：同一次回复里委派的多个 `source-reader`（2026-10-02 起），以及带 `beatRange` 的 `source-extractor`（2026-10-03 起，分段抽取与补全）同时执行，见下一段。

写入权规则不变：同一候选同一时刻一个写入 owner，根 Agent 等待子 writer 时不写该候选；独立只读任务或隔离输出才能并行。**并行只开给读原文**（2026-10-02，斗破抽取里 3 个 source-reader 一次派出却串行跑了约 30 分钟，host 12 个并行 4–9 分钟——真实收益成立）：工具声明 `parallel(params)`，`runTaskLoop` 把同一次回复里相邻的可并行动作一起推进到 result_ready，再按派出顺序交付，模型看到的顺序是确定的（乱序结果）；整组共用 turn 的 signal，作者打断时一起停，一个出基础设施故障就等同组停下再抛第一个（取消传播）；没有预算，用量各记在自己的 Task 上（共享预算）；各写各的笔记，同一文件被两个动作写时第二次落盘由 journal 报 `file_write_conflict`（隔离输出）；恢复时停在 effect_pending 的同组动作照样一起 reconcile。checkpoint 的写入为此排队：快照在调用时同步取，后取的一定后落盘。2026-10-03 起带号段的 `source-extractor` 也并行：各写自己号段的 Beat 与这段的笔记，号段不重叠写入就不重叠。writer 不并行——后一节的 Write Context 要带前一节刚写好的正文；整合、统一修与 `main` 会大面积改同一棵目录。不新增 graph engine。

### Source 抽取的分工（2026-10-03 定）

忠实抽取一部原作（斗破前 120 章约 31 万字）要同时满足：忠实完整（包括没被强调的伏笔）、与模型窗口无关（默认的 GPT-6.1 Sol 是 272k，DeepSeek 是 1M；中文约一字一 token，120 章原文本身就接近 272k）、语义只有 Story Language 一份、并行时写入不重叠、覆盖有确定性证据（笔记 `span`）、中断可续、host 能照做、少花输出、查漏有独立于抽取者的第二双眼睛。按这些约束定的流程是 **分段抽取 → 整合 → 事后补全 → 统一修 → 审稿一轮 → 提升**：

1. **分段抽取（并行）**：按章界分段，每段原文不超过窗口的两成左右。每段一个 source-extractor 直接读原文、写这段的 Beat（各段预分 Beat 号段，Beat id 是身份不是序号），再写一份短笔记：`span` 加交接——这段新出场的对象、数值、知情变化、未解问题、截在段界上的事件。它不建人物档等全书对象。分段由 `source_coverage` 的 `segments` 现成给出（在章标题处切、长短接近，第 k 段号段从 k×100+1 起，只有一段时不设上限），根 Agent 照着在同一次回复里派出；各段互不等待，跨段衔接归第 2 步。要模型自己规划分段时，GPT-6.1 Sol 两次都只先派第一段（10-03 的 120 章先派一个 reader，前 24 章只派第一段、还要它给下一段交代状态），说明里写「一起派出」压不住。
2. **整合（串行）**：一个 source-extractor 读全部 Beat 与笔记，建人物 / 地点 / 物品 / World / Contract（人物基底按全书证据）、声明 Secret、定分卷写 index、连跨段 `refs.beat`、合并被段界切开的事件、统一异名，`check` 通过。
3. **事后补全（并行）**：每段一个 source-extractor，拿这段原文与整份 Design，带着全书的答案回头看：补漏记的情节与没被强调的伏笔、修错，只改这段的 Beat；跨段改动列清单交回。没被强调的伏笔只有知道后文揭示才认得出，所以查漏放在整合之后，不放在第一遍。
4. **统一修（串行）**：按清单改跨段的东西，`check`。
5. **审稿一轮（只读）**：整书层面的一致性与语义；不为求 pass 反复审。

**为什么不是以前的「先读后抽」**：并行 reader 先把原文改写成笔记，抽取再读笔记。笔记要么太短丢因果（10-02 GPT 版只有原文的 12%），要么太长等于照抄（10-03 小样本 62%–79%，与原文 8 字片段重合仅 11%，是逐段复述）；而写好的 Beat 本身就是笔记该有的样子（因果完整、可以详细），先笔记后 Beat 是同一件事做两遍、多损失一道。并行 reader 各只看见自己那一段，伏笔更认不出来；Source 审稿读笔记加抽取时，笔记里漏掉的东西抽取与审稿共用同一个盲区。**为什么不是单个抽取者边读边写**：与窗口无关、也只读一遍，但全程串行，而且没被强调的伏笔在第一遍读不出来，照样需要带着答案的第二遍。**为什么第二遍是补全而不是审稿**：目的是让抽取更完整，做成只读审稿就要「出意见 → 派子任务改 → 再审」，10-03 的 120 章运行来回了三轮。

窗口只决定分段大小；超长的书在第 2 步先按卷整合、再整书整合，流程不变。Story Language 不变：笔记仍是 `span` 加交接，覆盖率与 `review:source` 的规则照旧。这是给根 Agent 的计划模板（写在 `delegate` 的说明与抽取方法里），不是代码里的固定流水线；分段与补全两步按写范围并行，整合与统一修串行。

子失败返回结构化失败与实际完成范围，父可改策略、新建工作或问作者，不自动无界重试；`paused` 之后 `resume` 沿用子 Task 自己的 checkpoint。已完成的 Task 不重开，修订另建。

## 10. 模型切换、预算与暂停原因

**换模型**：没有单独的换绑命令，新模型随 `session.send` 的 `model`（或 `session.resume` 时的绑定）一起给，checkpoint 的 binding 在下一个 `ready` 重算；每条 `AssistantMessage` 自带实际 provider / model，归因不需要额外记录。存在 `effect_pending` 的模型调用或动作时拒绝，先处理该状态；不靠换模型跳过恢复。新绑定不带入原模型的思考档位（[对话模型选择](#对话模型选择与默认配置)）。子 Task 的绑定在它创建时冻结，跑完为止。

**预算拆掉。**`RunBudget`（maxModelCalls / maxTotalTokens / maxCostUsd）、`describeBudgetOverrun`、请求预留记账、`budget_exceeded`、CLI 的三个 `--max-*` 与桌面的预算展示一起删：默认本来就是空对象，桌面 2026-09-10 已删预算表单，没有一个真实 Run 设过它，Codex / Claude Code 也没有。留下的是**用量**：session 累计的已知 usage 与未确认调用数照常显示（`model_call_unknown` 时作者要看的就是它），在途调用可能超出估计，缺失用量不能当作已确认的零。根 Agent 与子任务的 `maxTurns` 都是 `Number.MAX_SAFE_INTEGER`，唯一活着的默认上限是 `rank-experiment.ts` 的 `maxTurns: 3`（脚本参数）。兜底只剩 `run_no_progress` 与作者打断，停不住「持续产出但方向错了」的 turn；这是有意的取舍（成本闸会误砍正常产出），代价见第 4 节「进展型兜底」。**这一段是「没有预算」的完整说明，其它文档只留一句加链接。**

**`paused` 只剩三种**，都是「不问作者就不能安全继续」的情况，沿用 `ExecutionFailure` 形状，命令查询与 AG-UI 扩展共同携带：

| reason | 触发 | 作者能做的 |
| --- | --- | --- |
| `model_call_unknown` | 请求已发、结果未确认 | 重发（承担未知成本）或 interrupt |
| `action_effect_unknown` | 恢复时某动作停在 `effect_pending` 且无法核对 | 查看该动作后 resume 或 interrupt |
| `binding_mismatch` | 中途恢复时工具面 / 模型与 checkpoint 不符（原 `attempt_binding_mismatch`） | 换回原绑定 resume，或 interrupt 后在 turn 边界重绑 |

上一版会暂停的其余情况都改成不需要作者动手：`run_no_progress` → 结束本 turn 回 `idle`（第 4 节）；`file_write_conflict` → 作为工具错误交给模型（它读到的已经是新内容，重读再改），不结束 turn；`run_merge_conflict` 随 worktree 消失；`budget_exceeded` 随预算消失；`process_restart` → 没有 `effect_pending` 时直接 `idle` 并记一句，有则落进上面三种之一。`resume` 只服务这三种，不默认重发 unknown 的请求；`send` 在 `paused` 上拒绝并带 reason。

## 11. 桌面、命令、事件与 owner

命令目录仍由 `packages/sdk` 定义（三份目录的现状与理由见[收敛方案 3.2](consolidation-plan.md)）。`run.*` 21 条收成下表；只在一个传输上有的命令标了出处（CLI 是 `SUIM_CLI_COMMANDS`，IPC 是桌面的 `LOCAL_COMMANDS`）：

| 命令 | 语义 |
| --- | --- |
| `session.send { sessionId?, text, model? }` | 入 inbox；没有 sessionId 就新建 session；`idle` 则启动 turn，`running` 则在下一边界注入；本进程正在跑另一个 session 时拒绝（`session_running`）。返回 `{ sessionId, sequence }`。换模型也走它：没有单独的换绑命令（第 10 节） |
| `session.interrupt` | 第 3 节 |
| `session.resume` | 从 `paused` 继续；显式重发结果未知的请求用 `retryUnknown`（CLI `--retry-unknown`） |
| `session.list` / `session.show`（CLI）/ `session.tasks`（IPC） | 查询；摘要投影只有一份（`sessionSummary`），标题是 inbox 第一条。候选 diff 是 `project.diff`，没有 `session.diff`——候选不属于 session |
| `session.inbox`（IPC） | 作者消息队列，每条带是否已被取走 |
| `session.events`（CLI，`--after`）/ `session.attach`（IPC，`afterSequence`） | 从持久游标读事件；attach 只读，不启动执行 |
| `session.delete`（IPC） | 第 3 节 |
| `rank`（CLI） | Eval 协议，见下 |

上一版的 design / write / review / source.* 入口变成桌面与 CLI 的消息模板；`run.steer` 与 `run.launch` 合成 `session.send`；pause / cancel 合成 `interrupt`；`run.retry` 合成 `resume`；`run.diff` 删除。

**AG-UI 映射天然对上**：`threadId` = sessionId，`runId` = turn id，`RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` 每个 turn 一对；消息、`ACTIVITY_SNAPSHOT`（`suiming.action` / `suiming.task`，2026-10-01 加了 turn 结束对账 `suiming.turn`）、`CUSTOM`（只有 `suiming.session`，替代 `suiming.run`；`suiming.context` 随按次 ContextSnapshot 删除）。白名单在 `sdk/src/run-event.ts` 的 `validateProductEvent`。事件先持久后发布，稳定 id 补发去重；短批增量先持久再发。桌面 `sessionGenerating` 仍由 `RUN_STARTED` / `RUN_FINISHED` 派生。

`rank` 不是对话：它是脚本驱动的 Eval 协议（同一 Beat 多版正文匿名打乱交给隔离评委）。它用 `session.kind = "rank"`——没有 inbox、没有根 loop，由脚本创建若干 `rank.round` Task 并把汇总存为 session 结果——零新存储；不搬出 harness。

Electron 主进程拥有 Runtime、数据库连接、凭据与 session owner。renderer reload、attach / detach、关窗只改订阅；明确退出则 interrupt 在途 turn、有界收口（`waitForIdle` 30 s，`interrupt` 路径 5 s）、释放 owner，重开后 session 回到 `idle` 并记一句 `process_restart`，作者一句话就续上。观测：每次进程内驱动建一个 trace，`langfuse.session.id` = sessionId，重启用新 trace；不试图跨进程恢复 span。

## 12. 存储与模块边界

**本地 SQLite v6**（v5 是 Session 模型，v6 只多删了 `context_snapshots`；Canon 在作品目录的 git 仓，[ADR-0010](adr/0010-git-as-canon-storage-engine.md)；SQLite 只有执行数据）：

| 表 | 内容 |
| --- | --- |
| `sessions(id, project_id, status, data_json)` | kind、model、usage、checkpointRef、lease、turn 序号、lastFailure、时间戳、version |
| `tasks(id, session_id, status, data_json)` | kind、key、parent action id、input、model（冻结）、checkpointRef、usage、result / failure |
| `session_inbox(session_id, sequence, text, queued_at)` | 作者消息队列；第一条消息也在这里 |
| `session_events(session_id, sequence, event_json)` | AG-UI 事件日志 |
| `execution_command_receipts` / `execution_objects` / `projects` / `remote_bindings` | 不变 |

删 `conversations` / `runs` / `attempts` / `run_steering` / `run_events` / `context_snapshots`。checkpoint 仍按 [checkpoint 归档](#checkpoint-归档)的片段引用保存。

**旧数据不迁**（2026-09-13 作者决定）。v4 → v5 走 v2 → v3 同一条路：归档数据库文件与对象目录后清空执行数据，新库从空开始。eval-022 的 4 个 Run / 480 条事件不进新库——它们采用的作品结论都在 Canon 的 git 里，一个字不丢；不为四个 Run 写任何转换器。

**Cloud 执行 adapter 删掉。**`apps/worker`、`apps/api` 的 run 路由、`packages/cloud-postgres` 的 execution / run-event store 与对应 migration 加起来约 2400 行，Worker 领到 Task 只会以 `cloud_task_executor_not_found` 确定性失败，是 G3 决定的刻意空洞；为它把 schema 改成 session 是没有用户的成本。Cloud 只保留 Canon（PostgreSQL / S3 的 `CanonStore`）与显式同步；将来解冻时接口位置是 `HarnessProjectPort`，不是今天这份 PG 执行表。「Local 与 Cloud 服从同一状态转换、每类存储跑同一套契约测试」这条随之从规范里撤下，等有第二个实现再写回来。

**模块边界**（从目录树读不出来的）：

- `suiming-harness.ts` 是唯一组合入口，`loop.ts` 是唯一循环，动作状态活在 `loop.ts`。进程内句柄从 `HarnessRun` 改叫 `HarnessSession`，它仍不是持久实体。
- `SuimingHarness` 只认 `HarnessProjectPort`；`harness/` 对 `local/` 的 import 保持为零，由 `project-port.test.ts` 钉住。端口成员改成 session 语义（`readInbox` / `queueInbox` / `readSessionEvents` / `appendSessionEvents`），`paths.privatePath`（worktree 落点）换成 `checkoutPath`，`commitRuntimeSession` 换成带 receipt 的 `commitCheckout`，`openRuntimeSession` / `saveContextSnapshot` / `readContextSnapshot` 删除；新增成员必须先有 harness 的调用点。
- `worktree.ts` 删除；`ConfinedExecutionEnv` 的 rootPath 是 checkout；`story-search` 扫 checkout。
- 调研工具的网络实现放 `harness/research/`（undici + HTML / PDF 转文本），只被 harness 调用；搜索后端 adapter 与模型 provider 一样是可替换的，但不做成第二个 gateway。`run_command` 的 Seatbelt profile、解释器探测与子进程封装放 `harness/sandbox/`。
- 不为过去的运行数据维护第二内核；格式不兼容在模型调用前拒绝打开（`unsupported_local_store_schema`）。

## 13. 实施切片

按行为变化从大到小、词汇改名放最后：

| 切片 | 内容 | 规模 |
| --- | --- | --- |
| A | Run 变长寿：turn 结束不 complete、`idle` 上再来消息走续接路径；删历史文本注入、交付协议、`ask_author`、`plan` / `execute_task`、scope、预算、`writablePaths`、Source 三个工具；第一条消息走队列。**删 worktree**：Agent 直接在 checkout 工作，`commit` 走 `commitCheckout` + receipt，删三方合并与 `run.diff`。写范围放开到整个 checkout，`paused` 收成三种。**2026-09-13 全部落地** | `agent.ts` −300 行，`suiming-harness.ts` 约四成，`worktree.ts` 与 18 个文件的引用 |
| B | 实体合并：Conversation / Run / Attempt → Session；SQLite v5（归档后清空，不迁）；删 Cloud 执行 adapter | `in-memory-execution-state.ts` 约四成，`types.ts` 重写；删约 2400 行 |
| C | loop 与 Context：binding 按 turn、steering 只给根、折叠、边界压缩、turn 边界状态行与对账、`write` / `edit` 的 `check`、`submit_review` 引文校验。**已落地**：引文校验（2026-09-13，随 G）；窗口保护（折叠的粗版本）、状态行现算、turn 结束对账（2026-10-01）；`write` / `edit` 带 `check`（2026-10-02） | `loop.ts` 100 行内，各工具各 30 行 |
| D | 命令目录 / CLI / 桌面改名；AG-UI `suiming.session`；TUI 一并删（1000 行的开发者控制台，产品是桌面，改名等于重写它） | 机械改名，文件表要列全 `*.css` / `*.json`，改完 grep 旧名归零 |
| E | 调研：三个工具、Researcher profile、config、安全边界、对账项 | `harness/research/` 新增约 400 行 |
| F | 计算：`run_command`（Seatbelt profile、解释器探测、超时与输出上限、折叠） | `harness/sandbox/` 新增约 150 行，无新依赖 |
| G | evidence 层改 Canon 历史派生：DesignCommit freeze、StoryText lineage、按次 ContextSnapshot、MaterialEvidence 与 ReviewReport 的 snapshot 绑定拆掉；Review 与 Source 笔记是普通文件，时效按需算。设计见 [Evidence 改为 Canon 历史派生](derived-evidence-design.md)，排在 B 之后。**2026-09-13 已落地** | 净减约 2600 行 |

A 与 B 各一个提交序列；C 的各项彼此独立可分别提交；`submit_review` 引文校验不依赖前面任何一片，可以先做。每片先补验收测试再改代码，测试名进第 14 节的表。

## 14. 故障验收

每一行是一种故障或操作，右边是它必须得到的结果，最后一列点名覆盖它的测试（`文件名`「测试名」，文件在 `packages/runtime/test/`，另注的除外）。测试改名时同步这张表——切片 A / B 落地后这张表曾漏改半个多月，一半的测试名指向不存在的测试（2026-10-02 按 grep 重写）；**「没有测试」的行实现时补**。

| 故障或操作 | 必须得到的结果 | 覆盖它的测试 |
| --- | --- | --- |
| 请求仅 prepared 即退出；effect_pending 后响应未确认 | 前者撤回、回到 ready 重新组装；后者按结果未知处理，计费不伪装为零 | `agent-loop-persistence`「请求前恢复点保存失败时不调用 provider、不执行工具」；`harness-recovery`「未知模型结果默认停下；显式重试保留旧调用记录与同一 loop」 |
| 作者停止落在 effect_pending 已确认、请求还没发出之间 | 退回 prepared，turn 回 idle 不记故障；下一句只发一次请求，带着停止前后两条消息，不进 paused | `agent`「interrupt：停止落在请求记为已发出、实际还没发出时，下一句照常回答并带上新消息」 |
| 响应已保存、工具尚未执行 | 使用原消息、动作 id 与参数，不重新请求模型决定 | `agent-loop-persistence`「用量持久确认失败时不执行该响应中的任何工具」 |
| 多工具批次中途退出、结果乱序到达 | 复用已保存结果，核对在途效果，按模型原始顺序交还 | `agent-loop-persistence`「工具事件保存失败时停止同批次后续工具和下一次模型调用」；`run-event-stream`「恢复对话保留消息与工具的原始次序，工具更新不移到末尾，也不修改持久事件」 |
| 文件已改或部分文件已改、执行确认缺失 | 根据完整 journal 与前后 hash 收口；冲突保留双方并暂停 | `harness-recovery`「进程在文件已改、结果未保存时退出：原动作 journal 续接，不重复相对修改」；`confined-env`「文件 journal 恢复识别未应用、已应用和外部冲突，重复 edit 不会再替换一次」 |
| ProjectRevision 已提交、Action / 基线未确认 | 查询相同 receipt，回到原 revision 并推进基线，提交数不增加 | `harness-recovery`「同一 turn 两次阶段提交；第一次 revision 已确认但动作结果丢失时，重启续接不重复提交」；`local-project-service`「open 以 head 快照恢复 managed commit 崩溃窗口」 |
| 子 Task 已创建父未唤醒；子已完成父未收到 | 恢复相同子身份、结果和父动作，无第二个 Worker | `harness-recovery`「子任务完成后父 checkpoint 确认丢失：重启续跑只交还保存的结果，同一 action 不创建第二个子任务」 |
| interrupt 时子 Task 已确认的结果与用量 | 留在执行存储里，父不因此继续推进；不回滚已提交作品 | `execution-state`「子任务只能在 running 的 turn 里建；turn 结束把还在跑的子任务标 interrupted，续跑接着来」；`agent`「interrupt：打断的 turn 回 idle 不记故障；消息列表与候选文件保留，下一句接着跑」。「父已取消、子结果迟到」仍没有测试——委派同步，无异步迟到路径 |
| 重复发送同一条作者消息 | command receipt 去重，返回原序号 | `workspace`「命令重发校验输入：并发 send 只有一个 controller，跑完后的重发返回原回执不再开 turn」；`execution-persistence`「inbox：paused 拒绝，idle 与 running 都排队，相同命令返回原序号」 |
| **turn 结束后作者再发消息** | 同一 session、同一消息列表续接；checkout 里的候选仍在 | `agent`「作者与 Agent 共用一份候选：作者未提交的修改随 Agent 的 commit 一起进版本，没有合并步骤」（第二个 turn 提交的正是第一个 turn 留在 checkout 里的改动）、「说完就停；同一 session 的下一句接着消息列表，新 session 隔离；只讨论不产生作品版本」 |
| turn 结束时候选未提交 | turn 正常结束；对账事件给出未提交数与这一轮改了哪些文件；下一 turn 可提交 | `agent-write`「未提交的模型候选不会因为停止输出而进入 Canon；候选留在 checkout 等下一轮」；对账：`agent`「turn 结束事件带对账：作者几条、意图 / Design / 正文各改了什么、提交了几个版本、还剩几个未提交」 |
| **作者与 Agent 改同一文件** | Agent 的 `edit` 以当前内容为准，`oldText` 对不上即失败并让模型重读；作者保存时 `expectedSHA` 冲突、外部修改保留；提交没有合并步骤 | 编辑侧：`agent`「作者与 Agent 改同一文件：edit 以 checkout 当前内容为准，对不上就失败让模型重读」；保存侧：`workspace`「工作台查询无需模型；编辑 CAS 保留外部修改，提交后准确比较版本」；提交侧：`apps/cli/test/cli.test.ts`「作者未提交的修改与 Agent 的改动是同一份候选：一次 commit 一起进版本」 |
| 两个 turn 之间升级了工具面或宪法 | 下一 turn 用新绑定；之后中途退出的 turn 按这一轮冻结的声明恢复（不是会话第一次请求的）；参数半途变了报 `binding_mismatch` | `agent`「半途恢复按这一轮冻结的工具声明：两轮之间升级过工具面也能续上，参数半途变了仍报 binding_mismatch」 |
| 退出后重开；显式换模型 | 重开同 session 从 checkpoint 续；换模型只在无未决副作用时生效 | `agent`「进程重启：持有进程已死的 running session 收敛回 idle 记 process_restart，下一句从 checkpoint 续」「模型结果未知才 paused；不授权重发就一直停着；换模型要先核对；重发后才能在边界换绑」；`harness-recovery`「换绑只在没有未决副作用的边界发生；停在动作中间时报 binding_mismatch」；`execution-state`「换模型只在不跑的时候；删除 session 带走它的子任务」；`conversation-model`「session 的模型独立于全局默认，思考参数真实传入；turn 边界换绑与设置保存都不打断当前回复」 |
| 指令已接收但应用前退出；应用后确认回复丢失 | 下一 Context 恰好包含一次该消息；重放返回原确认 | `harness-recovery`「作者消息已存入 checkpoint 而消息发布失败时，恢复补齐同一条消息」；`agent`「turn 进行中作者补一句：模型停下时 inbox 有新消息就在同一 turn 里继续；turn 结束后的消息等下一个 turn」；`agent-loop-persistence`「读取 steering 失败必须停止，不能冒充没有作者指令而继续调用」 |
| **子任务运行中作者发消息** | 消息留在 inbox，子任务不接收；子任务返回后根 Agent 在下一边界取走 | **没有测试**（切片 C） |
| 两进程争用、旧 owner 迟到 | 只有一个有效推进者；拒绝陈旧确认 | `local-project-regressions`「执行状态按行保存：另一进程新增的 session 不被抹掉，版本落后的写入报告冲突」；`workspace`「命令重发校验输入：并发 send 只有一个 controller…」；`execution-persistence`「SQLite 已提交但确认返回丢失时，旧实例停下，重开从原回执恢复」 |
| **`write` 到 Story 根之外** | 写入成功；`commit` 结果点名它未进版本 | `agent`「Agent 直接修改与阶段提交，不强制 Review 或子任务；不属于作品的文件不进版本，提交结果点名」（`scripts/count.py` 写进真实 checkout，`ignored` 与 `suim diff` 是同一份） |
| 模型把目录当文件读、写、删 | `is_a_directory` 作为工具拒绝回到模型手里，turn 继续；`list` 列一层目录、私有目录与读范围之外的不列 | `confined-env`「读、写、删一个目录：如实拒绝并指向 list，不抛原始 EISDIR 掀掉整个 turn」「list：列出一层目录…」——前者是 2026-10-01 真实模型回归里 Writer 读目录、原始 EISDIR 掀掉整个 turn 之后补的 |
| **动作进行中文件被外部改了** | `file_write_conflict` 作为工具错误交给模型，turn 继续 | journal 侧：`confined-env`「文件 journal 恢复识别未应用、已应用和外部冲突，重复 edit 不会再替换一次」；loop 侧**没有测试** |
| DB 写入失败、对象写入失败、IPC 发出失败 | 前两者不发布未保存结果或继续副作用；后者从持久游标重放 | `execution-state`「持久确认失败回滚命令、不发布通知，并禁止该实例继续推进」；`run-event-stream`「事件保存失败后不发布、不给后续事件放行」；`workspace`「状态与产品事件原子确认：事件 INSERT 失败时 turn 不会先收口」 |
| renderer reload / 重复 attach / 消息截断后重连 | 快照和游标一致，补齐已保存内容，模型调用与提交计数不增加 | `workspace`「状态与产品事件原子确认…」里的 `session.attach` 快照与 `afterSequence` 续读；`run-event-stream`「合批消息先保存，恢复用完整响应补齐尾部并按 id 去重」；`apps/desktop/test/desktop.test.ts`「Electron typed IPC：编辑 CAS、版本比较、窗口重载只 attach、作者回应、正文与独立审稿贯通」 |
| 模型主动压缩 | 只改变下一次输入，原消息、动作与作者指令保留 | `agent`「Context 压缩只改变下一次输入，原消息与动作在 checkpoint 里保留」 |
| 请求接近窗口；provider 报上下文超限 | 清掉较早的工具结果，请求不超窗口，原消息不改；清不动时请模型压缩；provider 超限时清理重试一次，放不下报 `context_overflow` | `context-window` 四条：「请求接近窗口时清掉较早的工具结果」「provider 报上下文超限时清掉较早的工具结果重试一次」「清掉工具结果后仍然偏大：请求末尾请模型先 compact_context」「清完仍放不下：重试一次后如实报 context_overflow」 |
| **commit 后 / turn 结束后的系统压缩** | 摘要经 ModelCall；失败保留旧 Context；压缩后 Frame 重建 | **没有测试**（切片 C） |
| **大结果折叠后模型取回** | 第三次请求起换占位符；`read` 重读或 `recall` 取回原文与 checkpoint 一致 | **没有测试**（切片 C） |
| `write` / `edit` 带 `check` | 写入失败不跑 Checker；写入成功后 Checker 结果与写入结果在同一观察里，检查不过也如实返回 | `agent`「write / edit 带 check: true：写完一并返回 Checker 结论，省掉紧跟着的一次 check 来回」；写入失败不跑 Checker 的分支没有单独断言 |
| `submit_review` 引文不在锚定文件里 | 该 finding 被拒，Reviewer 收到具体哪条；报告不落库 | `host-context`「context compile 给 host 的输入按路径列出作品文件；review record 写成 review/<id>.md…」里的 `review_quote_not_found`（host 与引擎共用 `composeReviewFile`）；Source 层锚在抽取文件上可以引原作，两边都没有才拒：`agent-source`「Source 审稿锚在抽取文件上的 finding 可以引原作…」 |
| **`fetch` 中途退出** | 有 prepared 结果复用；无则重取，内容不同存新对象并标 refetched | **没有测试**（切片 E） |
| **`fetch` 私网地址 / 重定向到私网 / 超大响应** | 拒绝，工具结果说明原因，不落任何对象 | **没有测试**（切片 E） |
| **Researcher 试图写 `reference/**` 之外或调用 commit** | 拒绝；结果对象里的来源列表可被父 `read_result` 回读 | **没有测试**（切片 E） |
| **`run_command` 超时 / 输出超限 / 试图联网、读写 checkout 之外或 `.git` / `.suiming`** | 超时与超限如实返回已捕获部分并标明；联网与越界读写被 Seatbelt 拒绝并出现在 stderr | **没有测试**（切片 F；本机 2026-09-13 手工验过联网与越界读两种拒绝） |
| **`run_command` 写了文件** | 结果里的改动清单与实际 diff 一致；Story 根内的进候选，之外的在 `commit` 结果里被点名跳过 | **没有测试**（切片 F） |
| **`run_command` 中途退出** | 有结果复用；停在 effect_pending 不重跑，模型收到「结果未知」与文件差集 | **没有测试**（切片 F） |
| 连续三次同一被拒动作 | 结束本 turn 回 `idle`，`lastFailure` 记 `run_no_progress`；下一条消息续 | `agent`「连续重复同一被拒绝动作：turn 以 run_no_progress 结束回 idle；作者下一句就能续」 |
| 一个会话里工具调用越来越多 | 每条执行命令只写自己改动的行；整份导出与整份重读执行状态的次数与工具轮数无关 | `agent`「执行命令只写自己改动的行：一个 turn 里整份导出与整份重读执行状态的次数与工具轮数无关」；单轮耗时随轮数的变化用 `docs/validation/2026-10-01-harness-review/bench.mts` 量，不做计时断言 |
| 启动 / 恢复的初始化 I/O 失败 | 记录原因、释放 lease；checkout 不动 | `agent`「turn 开始时读取作品失败：回 idle 记一句并释放 lease，下一句直接重试」「续跑时读取权威状态失败也释放 lease，并保留 checkout 里的候选文件」 |
| 收口等待本身卡住 | 有界返回，不把调用方挂死 | `local-session-controller`「waitForIdle 有界：请求收不了口时按时返回，不把调用方挂死」 |

测试层次不变：状态转换单测、faux provider 故障注入、真实 SQLite 重开与进程退出、PostgreSQL adapter 契约、真实模型跨能力委托、Electron 生命周期、作者长篇盲评。上表全部是前四层；真实模型那一层目前只有样例作品与 eval-022 的局部闭环。

## 15. 已决定与待定

2026-09-13 作者决定：**Attempt 删；旧执行数据不迁，能用就用不能用直接删；其他能删的都删。**据此本文定稿的删除清单：Conversation、Run、Attempt、worktree（`worktree.ts`、三方合并、`run_merge_conflict`、`run.diff`）、`finish` 与交付协议、`ask_author`、`read_conversation`、历史文本注入、scope 与 `run.design` 等入口、`plan` / `execute_task`、预算、`paused` 的五种原因、`writablePaths`、候选整份冻结、`promptBinding`、按次 ContextSnapshot、`record_source` / `source_notes`、`run_steering.consumed_at` 之后剩下的 steering 序号核对、`retry.ts` / `requests.ts` / `conversation-context.ts`、Cloud 执行 adapter（第 12 节）、TUI（第 13 节）、eval-022 的旧 Run 与事件。逐项判定见第 16 节。

仍待定的只有一项：**调研的搜索后端**接哪个 HTTP 搜索 API，由作者按可用性与地区定；`fetch` 与 `run_command` 不依赖它。

## 16. 拆与放开：逐项判定

判据两条：终局形态需不需要；是不是我们自己设的闸。对照物是 Codex / Claude Code 有没有同样的东西。

**拆**

| 项 | 判定与落点 |
| --- | --- |
| 预算（`RunBudget`、预留记账、`budget_exceeded`、CLI `--max-*`、桌面预算展示） | 删，第 10 节。用量显示留 |
| `promptBinding`（constitutionVersion / rolePromptVersion） | 并进 turn 的 binding 记录（systemPrompt 已在 hash 里），不单独存 |
| 按次 ContextSnapshot：`#captureContext`、`noteRead`、`contextArtifacts`、`suiming.context` 事件、`sessionEvidence` checkpoint、`TaskResultObject` 的 context 字段、`context_snapshots` 表 | 删，第 7 节。模型输入随 checkpoint 保存。eval-022 的 Canon 里 `evidence/contexts` 是零 |
| harness 里的 `ProjectRuntimeSession`：`openRuntimeSession`、`prepareStageCommit` 的临时 session、evidence 内存态导入导出 | 删。`commit` 走 `commitCheckout`，Checker 在那里跑 |
| `delegate` / `review` 的 `freezeCandidate`（整份候选 base64 进 `prepared`） | 删，第 5 节。子任务 prompt 建时算好存自己的 checkpoint |
| `delegate` 的 `writablePaths` | 删，写范围随 profile（第 9 节） |
| `record_source` / `source_notes` | 笔记改为文件，随 G。`read_source` 保留：按码点区间读原文，笔记的 span 与它对齐 |
| `ExecutionInputReference` / `ExecutionResultReference` 的 kind 联合 | Task 只有父 action id 与结果对象 id |
| `paused` 的 `run_merge_conflict` / `budget_exceeded` / `run_no_progress` / `file_write_conflict` / `process_restart` | 第 10 节：三个变成不需要作者动手，两个随宿主概念消失 |
| `commit` 的 `freeze` 参数、Source 交付门（`requireRootMaterialEvidence` / `formatSourceCheck`）、`review_scope_mismatch` | 随 DesignCommit（G）、随 `finish`、随 scope 一起走 |
| evidence 层本身：DesignCommit freeze、StoryText lineage、MaterialEvidence 与 ReviewReport 的 snapshot 绑定 | **改 git 派生**（切片 G）。作者 2026-09-12 就问过「可以去掉 DesignCommit 和血缘设计吗」；eval-022 的 Canon 里 evidence 只有 4 个 design-commit，contexts / reviews / material 全零。「正文写时依据的 Design」= 正文文件最后一次变化的 canon commit 下的 Design tree；「可能不兼容」= 那之后 Design 文件有 diff；Review 的 currency = 报告记下的 canon sha 与路径至今有没有 diff。这些 git 一条命令就给，不需要 `dc_` / `ctx_` / `rr_` 三种 id 与 Checker 里的 lineage 规则。设计见 [Evidence 改为 Canon 历史派生](derived-evidence-design.md) |

**放开**

| 项 | 判定 |
| --- | --- |
| 写范围 | 整个 checkout（`.git` / `.suiming` 与 host 接入目录除外）；合法性由 codec / Checker 在 `commit` 判 |
| `source/<id>/**` 能不能改 | 由 Checker 规则决定（原文导入后是否允许改是作品规则），不在工具层拦 |
| 子智能体的工具面 | 文件、搜索、检查、Frame 与 Source 工具 + 角色的写范围；不给 `commit`、`delegate`、`review`、`write_context`、`read_result`（清单见第 9 节） |
| `run_code` → `run_command` | Seatbelt 是边界，解释器不是；bash 在沙箱里，python 只是能跑的东西之一（未实现，切片 F） |
| 作者何时能说话 | `idle` 开 turn、`running` 排队注入，只有三种 `paused` 拒绝 |
| 工具面与宪法升级 | turn 边界生效，不等下一个 session |
| Reviewer 审什么 | 由消息定，没有 scope 校验 |

**留**（每条一句为什么）

| 项 | 为什么 |
| --- | --- |
| Checker 在 `commit`；子智能体无 `commit` | 一旦失守直接坏作品 |
| Seatbelt、私网拒绝、只 GET、只落文本 | 结构性边界，几十行 |
| 文件 journal、command receipt、lease、checkpoint 归档 | 进程退出后「做没做」只有它们能回答；归档前 checkpoint 曾到 2.8 GB |
| 折叠、边界压缩、`submit_review` 引文校验、turn 结束对账 | 第 7、6、3 节各自的数字 |
| 一个 Project 一个 `running` session | 没有 worktree 后并行会互相覆盖；要并行再给 session 配 worktree |
| `story_guide` / `frame` / `write_context` / `project_status` / `search` / `compact_context` | 原生匹配 Open Story Package 就是这几个 |
| 未确认调用计数 | `model_call_unknown` 时作者要看的就是它，几行 |
| `rejected × 3` 停 turn | 唯一的死循环闸，不进 `paused` |
| 模型输出平面 `Type.Object` | 真实 provider 把 union 下的数组序列化成字符串 |
| `rank` 作 `session.kind` | Eval 协议，零新存储 |
| telemetry span | 可丢失的观测，不是真源 |

### checkpoint 归档

2026-09-11 实现，本版沿用：checkpoint 复用 execution object 保存不可变 JSON 片段，长数组按固定块引用，恢复点只新增变化的节点；loop 只保留当前请求的完整 Context，它同时是半途恢复用的冻结工具声明；历史请求的 Context 留在当时的恢复点里。消息、动作结果与历史恢复点可完整回读；不可变消息和输入只复制一次。

### 对话模型选择与默认配置

桌面传入 `ModelChoice`（provider、model 与可选 thinking），不传凭据和任意模型参数。Gateway 根据同模型的有效默认参数与显式思考选择冻结根 Agent 绑定，存入 session；普通恢复与进程重启沿用它，不追随设置页的后续修改。思考档位由 pi-ai 模型目录与 Gateway 已接通的 API 参数映射确定；config.toml 的 `profile.thinking` 保存原始档位，绑定时转换为 API 参数。环境或运行覆盖模型、参数时，不把原模型的思考档位带入新绑定。未实现映射的自定义 API 不展示虚假的思考选择。普通对话不自动分配费用或 token 额度。
