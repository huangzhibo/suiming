# 2026-10-01：Harness 审查

## 范围与结论

审查对象是 `packages/runtime/src/harness/`（约 5300 行）与它依赖的执行状态持久化，对照三样东西：业界 2024–2026 年关于 agent harness 的公开做法（第 1 节）、本仓的需求与原则（第 2 节）、[Harness 设计](../../harness-design.md)本身。代码基于 `bbd14cb`。除阅读代码外跑了两个探针（本目录的 `bench.mts`、`binding.mts`），全部用 faux provider 与临时作品，没有调用付费模型、没有碰真实作品。

**结论：形状是对的，薄弱处在「长」。**一个根 Agent、一份消息列表、模型停下即结束 turn、作者消息排队进下一边界、计划写在消息里、子智能体只为隔离上下文——这与 Claude Code、Codex、pi 的现行做法一致，而且比多数更克制；恢复正确性（四阶段 checkpoint、文件 journal、receipt、按 key 的父子交接）比调研里看到的公开做法都细。但 Session 被设计成**永不结束**的东西，承载它的两块却都没有为「长」做过：

- 执行状态的持久化每条命令都整份克隆、整份重读，**成本随项目历史平方增长**——100 轮工具调用之后，单轮纯簿记开销从 0.1 秒涨到 0.64 秒（F1）；
- 上下文**没有生命周期**：没有窗口保护、没有自动压缩、没有大结果折叠，开场快照永不刷新；窗口一旦溢出，按现有代码会话会卡死在同一个错误上（F3、F4）。

另有一个可复现的恢复缺陷：两个 turn 之间工具面升级过、之后某个 turn 中途退出，恢复时会永久停在 `binding_mismatch`（F2）。

长篇正是这两块的主负载。建议先修 F1–F3，再做切片 C / E / F 的其余项（第 6 节）。

## 1. 业界 harness 理念

调研覆盖 2024-12 到 2026-09 的一手材料：Anthropic 工程博客与 Agent SDK 文档、OpenAI 关于 Codex harness 的文章、Cognition、Manus、HumanLayer、LangChain、pi 作者、Restate / Temporal 的持久执行文档，以及长篇生成的研究。下表只列与我们相关的结论。Anthropic 的两篇长时运行 harness、Claude Code 质量复盘、Restate 版本化、自评偏差、AGENTS.md 评测与叙事状态这几篇逐一回原文核对过；OpenAI 两篇原站拒绝访问，经镜像阅读。

| # | 理念 | 来源 | 我们 | 判断 |
| --- | --- | --- | --- | --- |
| 1 | 默认用最朴素的循环：模型调工具直到不再调用，只在测得出收益时加结构 | S1、S16、P1 | 一份 `runTaskLoop`，没有工具调用即停，没有 graph、计划实体或交付协议 | 一致 |
| 2 | 每个组件都编码了一个「模型自己做不到」的假设，模型变强就拆掉验证 | S10、BU | 2026-09-13 的删除清单与设计文档第 16 节的判据 | 一致；拆完之后缺评测确认（第 14 行） |
| 3 | 上下文是有限的注意力预算：清理旧工具结果、压缩、结构化笔记、按需检索。Anthropic 实测上下文编辑加记忆工具在 100 轮任务上省 84% token，并完成了原本失败的任务 | S4、S5、M1、H2 | 只有模型主动的 `compact_context`；折叠、窗口保护、自动压缩都没落地 | **最大缺口**（F3、F4） |
| 4 | KV cache 命中率是生产首要指标：前缀稳定、只追加，配置变化追加成新消息而不改旧消息，工具面不在会话中途变 | M1、O2 | 只追加；宪法在 system prompt；状态行附在最新一条消息；工具面只在 turn 边界变 | 大体一致；没把 sessionId 交给 provider（F5） |
| 5 | 文件系统当外部记忆；压缩先做可恢复的（留路径、丢内容），再做有损的 | M1、M2、S7 | Story Artifact 就是外部记忆，而且有 Checker 守着；设计里的折叠（占位符 + 重读）就是可恢复压缩 | 方向一致，折叠未实现 |
| 6 | 工具少而合并，错误可行动，返回人类可读名，输出有上限与分页 | S3 | 领域工具已合并（`frame`、`write_context`）；Checker 诊断带 hint；prompt 要求不展示 UUID；`read` 只按行数限 | 一致；缺列目录（F6）与按字节的输出上限 |
| 7 | 硬错误是最可靠的引导，被动的说明文字常被忽略；AGENTS.md 这类上下文文件总体不提升成功率，推理成本增加两成以上 | ST、ETH、S11 | Checker 拒绝回到模型手里；意图写回只靠 `AGENT_PROMPT` 一句 | 前者一致；后者正是外部证据说的弱信号，支持改用确定性对账 |
| 8 | 写入单线程，多出来的 Agent 只加智能、不加动作；干净上下文的 Reviewer 有效 | C1、C2、M2 | `delegate` 同步，一个候选一个写入 owner；`review` 是干净上下文的独立审查 | 一致，是 2026 年中多数来源收敛到的形状 |
| 9 | 生成与评估分离，自评偏宽；开放目标的「进展」必须带外评估。一项预注册研究里，Agent 每轮都自称有进步，56% 实测为零或倒退 | S10、PM、S17 | 独立 Reviewer；Checker 是确定性的带外验证；turn 结束不判「目标达成」，质量由作者与盲评定 | 一致 |
| 10 | 持久执行：追加式日志，非确定步骤记 journal，外部效果至少一次所以要幂等 | S12、T1、L4 | 四阶段 checkpoint、文件 journal、receipt、按 key 的父子交接 | 一致，而且比多数更深；但没测过长负载下的成本（F1） |
| 11 | 进行中的执行钉住原版本（代码、prompt、工具定义），回放对不上要大声失败，不能静默误读 | R1 | binding hash 与 `binding_mismatch` 就是这个 | 机制一致，钉错了对象（F2）。工具实现代码钉不住——桌面应用只有一份代码——由各工具的 reconcile 语义兜 |
| 12 | 失控：Agent SDK 不设默认上限但建议生产环境设预算；连续 3 次被拒就升级给人 | S16、S11、H1 | 没有预算；连续 3 次同一被拒动作结束 turn | 有意不同，理由已写；成立的前提是 turn 结束对账，它还没做 |
| 13 | 人的判断放在错误会放大的地方：先审研究与计划，再审实现 | H2、S17 | Design 就是计划；Skill 与 host 指示要求 Design 稳定前不写正文 | 一致 |
| 14 | 评测从真实失败抽 20–50 个任务，评结果不评路径，能力与回归分开；harness 与 prompt 的改动等同换模型——Claude Code 2026 年 3–4 月的三处 harness 改动（默认思考档位、思考块清理的 bug、一句「工具调用之间不超过 25 字」）各自让质量下降，最后靠逐行消融才找到 | S8、S13 | 只有 faux 机制测试与 2026-09-16 一次真实基线；`AGENT_PROMPT`、`STORY_TEXT_METHOD` 的改动没有真实模型回归 | **缺口**（3.3） |
| 15 | 长篇：结构化叙事状态（人物状态、已发生事件、待兑现承诺）让一致性与质量在 1 万到 10 万字之间不退化；多 Agent 互改会同质化，独立修改更好；现成 LLM 评委偏好文风与篇幅 | NS、LR、LB | Story Language 的硬状态、Contract 与 Checker 就是带类型的叙事状态；Reviewer 只给意见不改稿；R-SOTA 用配对盲评 | 一致，外部研究支持 Design / Checker 路线 |

来源之间有分歧的地方，我们的站位：

- **单 Agent 还是多 Agent**：单一写入者加干净上下文的 Reviewer，即上表第 8 行的共识形状。
- **计划工具**：Deep Agents 的 todo 与 Manus 早期的 todo.md 支持；Manus 后来、pi 与 Anthropic 在 Opus 4.6 上的实验反对。我们删了 `plan`，计划写在消息里。
- **压缩方式**：模型摘要（Anthropic）、加密的压缩项（Codex）、先可恢复后有损（Manus）、干脆换新上下文配进度文件（Anthropic 的长时 harness 与 C 编译器实验）。我们的作品本身就是进度文件，所以「换新上下文 + `project_status` / Frame + 作者原话」是天然可用的一档；设计里的模型摘要是它之上的一层，不必是唯一手段。
- **失败的尝试留不留在上下文**：Manus 留，让模型避开；Claude Code 建议两次纠正失败就清空。我们留，并以连续 3 次同一被拒动作结束 turn。

来源：

- S1 Anthropic，[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)，2024-12-19
- S3 Anthropic，[Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)，2025-09-11
- S4 Anthropic，[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，2025-09-29
- S5 Anthropic，[Managing context on the Claude Developer Platform](https://claude.com/blog/context-management)，2025-09-29
- S7 Anthropic，[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，2025-11-26
- S8 Anthropic，[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，2026-01-09
- S10 Anthropic，[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)，2026-03-24
- S11 Anthropic，[How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)，2026-03-25
- S12 Anthropic，[Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)，2026-04-08
- S13 Anthropic，[An update on recent Claude Code quality reports](https://www.anthropic.com/engineering/april-23-postmortem)，2026-04-23
- S16 Claude Agent SDK，[How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- S17 Claude Code，[Best practices](https://code.claude.com/docs/en/best-practices)
- O2 OpenAI，[Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)，2026-01（经镜像阅读）
- C1 Cognition，[Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)，2025-06-12；C2 [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)，2026-04-22
- M1 Manus，[Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)，2025-07-18；M2 Lance Martin，[Context Engineering in Manus](https://rlancemartin.github.io/2025/10/15/manus/)，2025-10-15
- H1 HumanLayer，[12-Factor Agents](https://github.com/humanlayer/12-factor-agents)；H2 [Advanced Context Engineering for Coding Agents](https://humanlayer.dev/blog/advanced-context-engineering)，2025-08-29
- L4 LangGraph，[Durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)
- P1 Mario Zechner，[What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)，2025-11-30
- BU browser-use，[The Bitter Lesson of Browser Agents](https://browser-use.com/posts/bitter-lesson-browser-agents)，2026-09-15
- ST Stripe，[You can't whisper at an AI agent](https://stripe.dev/blog/ai-steering-experiments)，2026-05-14
- T1 Temporal，[Durable, flexible multi-agent systems](https://temporal.io/blog/durable-flexible-multi-agent-systems)，2026-08-06
- R1 Restate，[Updating AI Agents safely in production](https://restate.dev/blog/dealing-with-versioning-in-long-running-agents)，2026-03-11
- ETH Gloaguen 等，[Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988)，2026
- PM Park、Choi，[When Do Agent Loops Mistake Stagnation for Progress?](https://arxiv.org/abs/2607.25152)，2026
- NS Wan、Chen，[Scaling Long-Form Story Generation via Narrative State Tracking](https://arxiv.org/abs/2609.35759)，2026-09-28
- LR [LLM Review](https://arxiv.org/abs/2601.08003)，2026；LB [LitBench](https://arxiv.org/abs/2507.00769)，2025

## 2. 我们的约束

从[需求与目标](../../vision-and-requirements.md)、AGENTS.md 与[故事创作宪法](../../../strategies/story-constitution.md)里，直接约束 harness 的是这些：

| 约束 | 出处 | 对 harness 意味着什么 |
| --- | --- | --- |
| 验收对象是长篇，C → 不伤 R → A | 需求 §1–2 | 负载是「一部书」：数千次工具调用、数十万字的作品、跨很多天的会话 |
| A-SOTA：长运行可恢复，过程可追溯 | 需求 §2 | 恢复与审计是硬要求，但恢复要在长负载下仍然便宜 |
| Session 只有作者删除才结束；作者只看到一个持续的对话 | 需求 §5.1、AGENTS 不变量 5 | 上下文必须有生命周期，否则「持续」不成立 |
| 长期结论写回作品，对话不是 Canon | 需求 §5.2、不变量 8 | 压缩可以有损，前提是该写回的已经写回；写回要可见 |
| 能力交给模型，可见性交给系统 | AGENTS 工程边界 | 失败静默、代价延后的行为要有确定性对账 |
| 没有预算，兜底只有重复被拒与作者打断 | AGENTS、Harness 设计 §10 | 失控只能靠可见性发现，可见性因此不是锦上添花 |
| 一旦失守直接坏作品的行为要结构性保证 | AGENTS | Checker、写入范围、提交权留在系统里 |
| 本地优先、单机、桌面主进程持有 Runtime | 需求 §3 | 主进程的 CPU 就是作者界面的 CPU；簿记开销直接变成卡顿 |

## 3. 设计层评价

### 3.1 与主流一致、做得好的

- **循环形状。**`runTaskLoop` 一份循环、根与子共用、没有工具调用即停，没有 graph engine、没有计划实体、没有交付协议。2026-09-13 的删除清单（Run、Attempt、worktree、预算、`finish`、`plan`）每一项都对照了 Codex / Claude Code 的做法，判据写在设计文档第 16 节。这是「harness 随模型变强而变薄」的正确方向。
- **作者介入。**作者消息进持久 inbox，根 loop 在 `ready` 边界取走；停止是一个命令；只有三种「不问作者就不能安全继续」的情况才 `paused`。这与 Claude Code 的排队消息、Codex 的 pending input 同形。
- **确定性验证在环里。**`check` 随时可调，Checker 在 `commit` 处把关，诊断带 hint 回到模型手里（2026-09-30 起 `requireDomain` 用共用的 `formatDiagnostic`）。Checker 拒绝是工具结果而不是 turn 崩溃——模型能修的错误留给模型修。
- **作品就是外部记忆。**Story Artifact、`intent/**`、审稿与笔记都是 checkout 里的文件，Context 由编译器按任务投影；会话不是 Canon。这与 Anthropic 的「结构化笔记」、Manus 的「把文件系统当上下文」是同一个思路，而且我们有 Checker 保证这份外部记忆本身不坏。
- **恢复的正确性。**effect 状态机、只有 read / reconcile 两种重放、文件 journal 的前后 hash、commit 的 receipt、子 Task 以父 action id 为 key——每条都指得到测试（设计文档第 14 节）。同日修掉的「停止落在请求发出前」也是在这套机制里加一行就收住了。

### 3.2 刻意与主流不同、理由成立的

- **没有 shell。**Codex / Claude Code / pi 都以 shell 为万能工具；我们只给领域工具与受限文件工具，`run_command` 规划在 Seatbelt 里（切片 F）。作品目录是作者机器上的普通目录，Checker 只能管到 `commit`，没有 shell 是正确的默认。代价见 F6。
- **没有预算。**与 Claude Code、Codex 一致；代价（停不住「持续产出但方向错了」）已在设计文档写明。这条成立的前提是可见性真的到位——turn 结束对账至今没做（切片 C），所以眼下它是一个没有对冲的风险。
- **子智能体只为隔离上下文，不为并行。**`delegate` 同步、一次一个；Writer 只拿编译好的 Write Context。这避开了多 Agent 系统里「各自隐含决定互相冲突」的问题。

### 3.3 失衡

**恢复正确性投入很深，长负载下的成本从未测过。**第 14 节的故障验收表有三十多行，几乎全是「进程在某个窗口退出后做对了没有」；而「第 1000 轮工具调用时这一轮要多久」「会话第 30 天上下文有多大」没有一行。[当前状态](../../current-status.md)此前记的「已验证 300 轮 checkpoint 和 32 轮 SQLite 切片」量的是 checkpoint，瓶颈不在那里。F1 与 F3 都落在这个空白里。

**上下文管理是设计文档里写得最完整、代码里做得最少的部分。**第 7 节的折叠、边界压缩、窗口保护全是切片 C，一项没落地；模型主动的 `compact_context` 在 eval-022 四个 Run 里只被调过一次。而 Session 永续恰恰把上下文增长从「一个 Run 的问题」变成了「每个对话迟早遇到的问题」。

**harness 与 prompt 的改动没有真实模型回归。**Claude Code 的复盘（S13）说得很直白：一句 prompt、一个默认档位、一个缓存优化各自让质量下降，靠逐行消融才找到。我们的 `AGENT_PROMPT`、`STORY_TEXT_METHOD`、工具描述都改过多轮，验证只有 faux 机制测试与一次真实基线。我们有别人没有的条件：结果大多可以确定性判分——Checker 过没过、有没有提交、意图写回有没有发生、审稿引文锚不锚得上。从 eval-022 与 2026-09-16 基线里挑十几个任务做真实模型回归；按基线的单价（一节正文约 0.02 美元，一次审稿加修订约 0.04 美元），跑一轮在几美元以内。

**Writer 的隔离把「写回」从耐久问题变成了正确性问题。**委派出去的 Writer 只看得到 Write Context，作者在对话里说过、却没写回 `intent/**` 或 Design 的话，Writer 根本看不见。所以意图写回的对账（已知缺口）不只关系到「换个会话还记不记得」，也关系到「委派写的这一章有没有照作者刚说的做」。

## 4. 发现

### F1 执行状态持久化随项目历史平方增长（P0）

**实测。**`bench.mts` 在样例作品上让模型连续 N 次 `read` 同一个小文件，faux provider 零延迟，量相邻两次模型调用的间隔——即 harness 每轮的簿记开销：

| N | 前 20 轮平均 | 后 20 轮平均 | 总耗时 | receipt 数 |
| --- | --- | --- | --- | --- |
| 100 | 101.8 ms | 625.7 ms | 36.5 s | 1011 |

每轮开销随轮数线性上涨（约 6.5 ms / 轮），总耗时是平方。CPU profile（`node --cpu-prof`）：73% 在 `InMemoryExecutionState.persist`——其中 `structuredClone` 38%，`SqliteLocalStore.loadExecutionState` 27%，`canonicalJson` 16%；checkpoint 归档本身不到 2%。

**机制。**每条执行命令（记一次 checkpoint、记一次用量、记一次请求……每轮约 10 条）都走 `#execute → persist(exportSnapshot())`：克隆全部 session、task 与 **receipt** 并排序；`LocalProjectService.saveExecutionState` 再从 SQLite 整份读一遍旧状态、逐条 receipt 读库并 canonical JSON 比对、写入，最后又整份读一遍来发变更通知。`SuimingHarness#drive` 的 `saveCheckpoint` 还在每次保存时 `exportSnapshot().commandReceipts.some(...)` 线性找一条 receipt。receipt 是**项目级**的，除 schema 迁移外从不清理，所以新开的会话也继承前面所有会话的开销。桌面 `workspace.show` 在 turn 期间每 100 ms 调一次，走 `#sessionList → loadExecutionState()`，同样随 receipt 数增长（未单独测量）。

**影响。**真实模型每轮几秒，前几百轮里这笔开销被掩住；按线性外推，第 1000 轮约 6–7 秒 / 轮的纯簿记，且全部占用 Electron 主进程。eval-022 四个 Run 共 137 次模型调用，一部 3 卷 30 Beat 的书会是它的数十倍。

**方向。**命令已经知道自己改了哪些实体（`#execute` 的 `changed`）和自己那一条 receipt：只写这几行并核对版本，变更通知从 `changed` 发，不重读；receipt 查重改成按 commandId 的单行查询。验收：同一个探针在 N = 1000 时后 20 轮与前 20 轮的比值有上界；不以 wall-clock 做单元测试断言，改为断言单条命令触及的行数是常数。

### F2 中途恢复用的是会话第一次调用的工具声明（P1）

**复现。**`binding.mts`：第 1 轮工具 `probe` 的描述是 v1；第 2 轮升级为 v2，模型调用 `probe`，在动作停在 `effect_pending` 时模拟进程退出；第 3 轮用同样的 v2 工具恢复。

| 情形 | 第 3 轮恢复 | 从 paused 再 resume |
| --- | --- | --- |
| 第 2 轮升级了描述 | `paused` / `binding_mismatch` | 仍 `paused` / `binding_mismatch` |
| 对照：没升级 | `idle`，回复「第二轮完成」 | — |

**原因。**`SuimingHarness#drive` 半途恢复时取 `restored.loop.calls[0]?.context?.tools` 作为冻结声明，ready 阶段也只保留 `calls[0]` 的 Context。这是 Run 时代的「首轮冻结」：一个 Run 的第一次调用就是它的绑定。Session 永续、binding 按 turn 重算之后，`calls[0]` 成了**整个会话**第一次调用，而 checkpoint 里的 `binding` 是当前 turn 的。两者一旦不同，半途恢复永远对不上。

**影响。**任何改动工具描述的版本升级、调研后端配置切换（切片 E 起工具面随配置变）、宪法修订之后，只要某个 turn 中途退出，这个会话就停在作者处理不了的 `paused`（从 paused 再 resume 仍是同一处；interrupt 之后再发消息按代码推断会落回同一处，未实测）。

**方向。**按 turn 冻结声明：重算 binding 时把它的输入（工具声明）一起存进 checkpoint，半途恢复用这一份。`binding.mts` 的情形直接转成回归测试。

### F3 上下文没有生命周期：溢出后会话卡死（P1，按代码推断）

- **没有窗口保护。**运行时代码里没有一处读 `contextWindow`；pi-ai 自带的 `isContextOverflow`（按各 provider 的报错文本与 `usage.input` 识别溢出）没有用上。
- **没有自动压缩。**唯一的压缩是模型主动调 `compact_context`。
- **溢出之后。**provider 报错 → `stopReason: "error"` → `model_call_failed` → turn 回 `idle` 记一句；作者再发一句，loop 按「失败的调用撤回重发」把同一份上下文加上新消息再发一次，仍然溢出。模型从头到尾拿不到一次能调 `compact_context` 的机会。作者唯一的出路是开新对话，对话里没写回作品的东西随之丢掉。
- 这一条没有对真实 provider 复现（faux provider 不检查窗口），结论来自代码路径；修的时候先用一个会按窗口报错的 faux 把它钉成测试。

**方向。**切片 C 里先做这一项：每次请求前按上次的 `usage.input` 与模型 `contextWindow` 判断，越过阈值先压缩再请求；请求返回溢出（`isContextOverflow`）时压缩后重试一次而不是结束 turn。压缩只能有损地丢掉已写回作品的东西，所以它与 turn 结束对账（意图写回）是一对。

### F4 开场快照永不刷新，且压缩永远保留它（P2）

根会话第一次 turn 的第一条消息是「权威作品状态（本轮起点；提交后可用 project_status 更新）」加整份 Design Frame（不超过 2.4 万码点时全量）。它只在会话第一次跑时写入（`RootLoopSpec.prompt`），之后每个 turn 都不重写；而压缩（`reduction`）保留所有 `role: "user"` 的消息，所以它永远在上下文顶部。第 2 轮起它的「本轮起点」已经不对，Design 改过之后它就是一份过期的「当前作品」。同理，每条作者消息后附的状态行在 turn 开始时算一次，turn 中途提交之后仍说旧的版本号与脏文件数。

**方向。**最小改法是改标签：注明「会话开始时的快照，不随修改更新；当前状态以消息后的附注与 `project_status` 为准」（Claude Code 的 gitStatus 就是这么写的）。更好的是压缩时不保留系统生成的开场，状态行在每次 `pullSteering` 时现算。

### F5 没有把 sessionId 交给 provider（P2）

`ModelGateway` 调 pi-ai 时只传 `signal` 与 `telemetryContext`。pi-ai 的 `sessionId` 是给按会话做 prompt cache 路由或亲和的 provider 用的；我们的消息列表只追加、宪法在 system prompt 里稳定，正是 cache 友好的形状，却没告诉 provider 这是同一个会话。传 `sessionId`（根会话用 sessionId，子任务用 taskId）是一行改动。

### F6 没有列目录的工具（P2）

工具面里没有 `list` / `glob`。开场 Frame 只列 Design 文件的路径（作品大了还会裁剪），`search` 是对 Target artifact 的文本检索。要找 `review/` 下有哪些审稿、`reference/` 下有哪些资料，模型只能猜路径或靠检索词碰。Codex / pi 靠 shell 的 `ls`，Claude Code 有 Glob。切片 F 的 `run_command` 会顺带补上，但它要 Seatbelt、只在 macOS 有；一个只读的 `list` 更便宜。

### F7 Writer 的 prompt 与权限不一致（P3）

委派 Writer 的 system prompt 写「你没有其它文件的读取权」，但它的 `ConfinedExecutionEnv` 没有 `readable` 限制，`read` 能读整个 checkout。要么收紧读范围，要么改 prompt；现在是 prompt 说一套、权限是另一套。

### F8 同一批只读工具串行执行（P3）

模型一次响应里的多个 `read` / `search` 逐个执行。正确性没问题，只是延迟；只读批次可以并发，结果按原始顺序交还（第 14 节已有这条交还规则）。

## 5. 文档漂移

- Harness 设计第 3 节与第 11 节说进程重启后 session 是 `paused` / `process_restart`；代码（`recoverUnfinished`）是回 `idle` 记一句，只有 checkpoint 里有未决副作用时下一个 turn 才落进 `paused`。第 10 节的说法与代码一致。
- Harness 设计第 6 节与第 16 节说 `read_source` 已拆掉、Source 用 `read` 读；代码里 `read_source`（按码点区间读）与 `source_coverage` 仍在根与子智能体的工具面上，拆掉的只是 `record_source` / `source_notes`。
- CLAUDE.md 说 Design Frame 在 `engine/design-frame.ts`；`engine/` 已删，实现在 `packages/runtime/src/artifact/design-frame.ts`。
- Harness 设计第 3 节用现在时写「系统在 turn 结束事件里附一份对账」；它是切片 C，还没做。

## 6. 建议顺序

1. **F1 持久化改增量。**它决定长篇能不能跑起来，而且越晚改，真实作品里积累的 receipt 越多。先写测量（本目录 `bench.mts` 加大 N），再改。
2. **F2 按 turn 冻结声明。**小改动，回归测试现成。
3. **F3 窗口保护与自动压缩**，连同 turn 结束对账一起——压缩可以有损的前提是写回可见。F4、F5 顺手做。
4. **一组真实模型回归任务**（3.3）：十几个任务，结果用 Checker、提交、写回与引文锚定这些确定性信号判分；之后改 prompt 或工具描述先跑它。
5. 其余切片 C 项（折叠、`write` 带 `check`），然后 E / F；F6 视 F 的进度决定要不要先补一个只读 `list`。（初稿把 `submit_review` 引文校验也列在这里，错了：它 2026-09-13 已随切片 G 落地，设计文档当时没跟上。）
6. 每修一项，把对应的「长负载」验收写进设计文档第 14 节——那张表目前只有「退出窗口」一个维度。

## 复现

```sh
node --import tsx docs/validation/2026-10-01-harness-review/bench.mts 100
node --import tsx docs/validation/2026-10-01-harness-review/binding.mts
node --import tsx docs/validation/2026-10-01-harness-review/binding.mts control
```

都在临时目录建样例作品、用 faux provider，跑完删除。`bench.mts` 的 N 越大越慢（平方），N = 400 以上要几分钟到几十分钟。

## 后续

- **F2 已修**（`4bc1118`）：半途恢复改用最近一次请求的工具声明，ready 阶段不再为会话第一次请求留 Context。回归在 `agent.test.ts`「半途恢复按这一轮冻结的工具声明」，同时钉住参数半途变了仍报 `binding_mismatch`；`binding.mts` 的升级情形现在恢复为 `idle`。
- **F1 已修**（`3b1e6e8`、`239f392`）：执行命令改为只写自己的写集合（改动的实体与回执），只读查询不读回执；之后量出的余项——checkpoint 归档每次保存重算没变的节点、事件流为找一条事件深拷贝整个会话——一并去掉。同一个 `bench.mts`：

  | | 修前 | 只修执行状态 | 再修归档与事件流 |
  | --- | --- | --- | --- |
  | 100 轮总耗时 | 36.5 s | 6.4 s | 4.0 s |
  | 100 轮后 20 轮平均 | 625.7 ms | 111 ms | 61.1 ms |
  | 400 轮总耗时 | 未测（按平方外推约 9 分钟） | 52.1 s | 29.5 s |
  | 400 轮后 20 轮平均 | — | 210.4 ms | 117.3 ms |

  余下每轮约 0.2 ms 的增长跟着会话的消息与调用列表走，主要是每次请求组装完整上下文；命令回执仍从不清理，每个 turn 开始构造执行状态时整份读一次。回归在 `agent.test.ts`「执行命令只写自己改动的行」。
- **F3 已修**（`eec5a32`）：请求前按 `contextWindow` 估大小，超过 80% 清掉较早的工具结果到 50%，清完仍超过 70% 请模型 `compact_context`，超过整个窗口报 `context_overflow`；provider 报超限时撤回、清理、重试一次。只改请求投影，消息列表不动。回归在 `context-window.test.ts` 四条，修前三条卡在 `model_call_failed`。阈值是占位值，没在真实 provider 上验证；按大小折叠、`recall` 与边界压缩仍未做。
- **F4 已修**（`ae8e242`）：作者消息后的状态附注在取走消息时现算；开场改称「会话开始时的作品快照」。没有做「压缩时丢掉系统生成的开场」——它是 user 消息，现在的压缩保留所有 user 消息；等边界压缩一起改。
- **F5 已修**（`784ad90`）：请求带上 loop 的 id 作 `sessionId`（根会话是 sessionId，子任务是 taskId）。
- **F6 已修**（`39a180e`）：加回只读的 `list`。F7（Writer prompt 与权限不一致）有了数据——[真实模型回归](../2026-10-01-harness-regression/README.md)里委派的 Writer 每次读 7–8 个文件——但改 prompt 要先有能量它对正文质量影响的任务，未动。F8（只读工具串行）未动。
- **3.3 的真实模型回归任务已建**（`ea904d8`）：基线 16 / 18，第一次跑就抓到 `read` 目录时原始 `EISDIR` 掀掉整个 turn（`3b54f13` 修）。
- **turn 结束对账已做**（`a782d16`）：第 6 节第 3 项建议与 F3 一起做的那一半。每个 turn 结束前发 `suiming.turn`，对话里一行字；只讨论的 turn 不显示。
