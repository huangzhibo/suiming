# Graph Engineering 对 Suiming 的适配研究

**状态：历史研究（2026-09-07，2026-09-12 补第 1.1 节），不是现行规范。**结论已用于 [ADR-0011](../adr/0011-desktop-product-and-autonomous-runtime.md) 与 AGENTS.md 不变量 5、8；关于 pi 内循环与替代后端的建议由 [ADR-0012](../adr/0012-own-suiming-harness.md) 取代。文中的 `RunEngine` 现为 `SuimingHarness`；Run / Attempt、worktree、ContextSnapshot、Cloud 执行存储，以及第 1 节表中「执行中调整任务结构」一行与第 1.1 节说「已经在做」的 `plan` / `execute_task`，都已于 2026-09-13 删除。现行执行模型见 [Harness 设计](../harness-design.md)第 2 节。

日期：2026-09-07。代码基线：main / `262ee4d`，连同本轮[重构方案](refactoring-plan.md)。

本文讨论以任务、Agent 协作和运行状态为共同组织对象的 Graph Engineering；不把它等同于预设流程、LangGraph、知识图谱或界面上的节点图。

## 1. 结论与采用范围

**Suiming 适合采用以任务和证据依赖为核心、由单一 Agent 调整的 Graph Engineering。应将其作为自主 Agent 重构的一部分设计，而不是仅在运行后画图。**

采用范围有明确差别：任务结构与运行证据值得成为正式执行依据；Agent 委派按工作需要形成；自由通信、任意拓扑和自动搜索最优协作结构保留为需要实验支持的研究项。

| 能力 | 适配判断 | 决策 |
| --- | --- | --- |
| 显式任务、依赖、交付范围与计划调整 | 高 | 纳入自主 Agent；单步委托可以只有一个工作节点 |
| 绑定实际输入、结果与 evidence，支持局部恢复 | 高 | 复用并补齐现有执行记录与领域检查 |
| 按目标委派独立 Worker / Reviewer | 高，但有边界 | 一个 Agent；Worker task-local，按需选择 profile 与权限 |
| 独立研究或检查的并行执行 | 场景相关 | 先证明输入独立、输出隔离与实际收益；不自动并行相邻正文 |
| 桌面展示计划、执行和影响关系 | 高 | 直接消费真实结构；简单任务用清单，复杂依赖用局部图 |
| 持久 Agent 人格、自由群聊、任意重连的协作网络 | 当前证据不足 | 不作为本轮基础设施 |
| 自动进化 graph 模板与组织策略 | 有研究价值 | 进入 Eval，不能凭模型自评分数自动晋级 |
| 执行中调整任务结构，且只能向前生长（2026-09-12 补） | 已在做，此前未命名 | `plan` / `execute_task`；撤销仅限未执行且无剩余依赖的任务，已完成的不回改为 pending。见第 1.1 节 |
| 通用 graph engine、图数据库、第二套状态库 | 当前无必要 | 保留单一 SuimingHarness 与现有执行存储；框架替换另作收益验证 |

这是对终局需要和当前证据的共同判断。长期创作确实需要管理多项有依赖的工作；现有样例不能证明加入 graph 后小说更好，也不能证明更复杂的 Agent 网络终局必需。

### 1.1 我们落在什么位置（2026-09-12 补）

本文原表按能力划分，缺一格：**执行中调整任务结构**。这不是待评估项，而是 `plan` / `execute_task` 已经在做的事，此前只被写成执行纪律（见第 5 节「已经完成的 Task 仍是完成过的历史」），没有正面命名，结果它既不在已采用清单也不在排除清单里——而它恰好是与外部 agent graph 工作最可比的那部分。

2026 年的综述《From Static Templates to Dynamic Runtime Graphs》（[arXiv 2603.22386](https://arxiv.org/abs/2603.22386)）提供了可用的坐标系。它把统一抽象称为 agentic computation graph：节点是 LLM 调用、检索、工具、校验或消息传递等原子动作，边编码 control / data / communication 依赖。主判据是**结构何时确定**，不是结构是否被持久化：

- **static**：部署前固定的可复用模板，结构自由度在训练或搜索后冻结。
- **dynamic**：结构在推理期为某一次 run 构造、选择或编辑。三个时点是 offline（优化可复用模板）、pre-execution（run 前一次性生成）、in-execution（执行中修改）。

综述还把三类对象严格分开：可复用模板、某次 run 的 realized graph、执行 trace。表示形式（代码 / DSL / 显式图 IR）是与 static-dynamic 正交的独立维度，代码形态下「图结构隐含在控制流里」。

按这套坐标：

| 我们的东西 | 位置 |
| --- | --- |
| 已删除的固定创作 recipe | static / offline 模板 |
| 表中「自动进化 graph 模板」 | static / offline 模板搜索（AFlow、ADAS 一类），进 Eval |
| 表中「通用 graph engine」 | 框架义（LangGraph、GraphFlow 一类），当前无必要 |
| **`plan` / `execute_task`** | **dynamic / in-execution editing** |

与 DyFlow、EvoFlow 一类同档方法的区别在于约束方向：它们可以重写结构、重跑节点、换拓扑；我们**只能向前生长与细化**——撤销仅限尚未执行且无剩余依赖的任务，已完成的 Task 不回改为 pending，`execute_task` 要求 `dependsOn` 全部 completed。可以称为**单调动态**。

单调不是偏好，是两条领域事实推出来的：阶段提交已经推进了 ProjectRevision，改结构不能让已提交的东西失效；Attempt 与 checkpoint 是恢复的依据，重写历史就无法恢复。也就是说，realized graph 之所以必须持久化并承担恢复职责，正是它只能单调的原因——**持久化不改变动态与否，但它决定了动态的方向只能向前。**

这一格补上之后，表的其余判断不变。它不新增实体、事件或命令，只是给已有行为一个准确名字，避免下次评估时把自己归错类。

## 2. 外部研究支持了什么

| 一手来源 | 可以支持的判断 | 不能据此得出的结论 |
| --- | --- | --- |
| [Graph Engineering 综述，2026-08，v2](https://arxiv.org/html/2608.21156v2) | 将任务组织、Agent 协作和运行状态作为相互关联、可调整的结构；研究范围包含依赖、恢复与跨运行的结构改进 | “graph 替代 loop”不是统一技术标准；综述本身没有证明 Suiming 的收益 |
| [LLMCompiler，ICML 2024](https://arxiv.org/abs/2312.04511) | 显式函数调用计划与依赖调度，在论文测试任务中可改善延迟、成本和准确率 | 工具并行的收益不能直接外推为长篇正文的并行写作收益 |
| [GPTSwarm，ICML 2024](https://proceedings.mlr.press/v235/zhuge24a.html) | Agent 的操作与信息流可以建模为图，节点指令和连接结构都可以成为优化对象 | 不表示更多 Agent、更多边或在线自行变更结构普遍更好 |
| [Scaling Agent Systems，2026-04 更新的 v3](https://arxiv.org/abs/2512.08296v3) | 在 260 种配置、6 类 agentic benchmark 中，收益强烈依赖任务与组织方式；可分解任务和顺序规划可能得到相反结果 | 不能把旧版本的样本数、单一增益比例或某个模型结论当作通用规律，也未验证长篇小说 |
| [Why Do Multi-Agent LLM Systems Fail?，v3](https://arxiv.org/abs/2503.13657v3) | 失败涉及系统设计、Agent 之间的偏差以及任务验证，结构化协作需要明确交接和验收 | 添加 Reviewer 或一张关系图，不会自动解决语义判断失准 |

这些研究使“显式组织复杂工作”成为有依据的候选方向。对 Suiming 的具体采用建议来自下面的代码和产品分析，属于项目推断；不能把论文提出的范式直接写成已验证的产品优势。

LangGraph 可以实现部分图执行机制，但 Graph Engineering 与具体框架不处于同一层。框架是否减少 Suiming 的持久执行代码、能否正确接入作品事务，需要单独验证；不能由概念流行直接推导选型。

## 3. 与真实创作需求的匹配

### 3.1 最值得解决的是跨步骤修订

一份委托可能同时要求修改人物、调整远处 Beat、续写当前正文并检查一致性。已完成步骤的结果会改变下一步工作；作者也可能在中途补充意图。这类工作有真实的依赖、分支和回查需求，适合由 Agent 维护显式结构。

现有 R1 已出现关羽旧案同时涉及人物、beat-0004、beat-0069 与 Contract 的修改；完整闭环需要分成 Design、两个 Writer、Review 四个 Run，由调用方串联。这里的不足是跨能力持续决策，不是缺少更多角色。[真实运行记录](../current-status.md)

graph 的潜在贡献是让“接下来哪些工作还成立、哪些必须重新安排”可以被系统核对，而不只由 Agent 在长对话里记住。它不需要预先拆出整部 69 Beat 作品的全部任务；远期目标可以保持粗粒度，在进入具体工作范围时再细化。

### 3.2 长篇包含不同程度的可分解性

| 创作工作 | 对 graph 的需求 | 推荐执行方式 |
| --- | --- | --- |
| 单段润色、局部改名、一次明确查询 | 很低 | 一个 loop 直接完成，不为展示结构强制增加规划调用 |
| 同一设定变化影响多个 Beat / Contract | 高 | 召回影响候选，Agent 判断后建立需要检查或修订的任务 |
| 相邻 Beat 的首次写作 | 有依赖，通常不宜直接并行 | 后一篇往往消费前文实际正文；按确切依赖逐步推进 |
| 多份彼此独立的材料研究 | 可分解 | 相同基线下独立读取，结果有来源，Agent 整合 |
| 独立 Review 与作者修订 | 高 | 记录准确被审版本、报告和后续处理关系，不以 pass 作为唯一停止依据 |
| 同一大段正文被多位 Worker 同时改写 | 合并与风格成本高 | 默认一个写入 owner；多个候选必须有隔离与作者 / Agent 的明确选择 |

这张表判断工作结构，不预先固化创作路线。模型可以直接完成复杂动作，也可以发现新的分解方式；运行边界检查它实际选择的输入、权限和依赖。

### 3.3 graph 不是当前阅读质量问题的直接解法

作者第一轮盲读指出：旁白替人物解释、人物转变没有页面动作、同一信息反复成立，以及 Reviewer 把弃读级问题标成 minor / note。不同组的模型、Context 和 prompt 又存在混杂。[作者原始选择记录](../author-choices/2026-09-06-blind-read-beat-0004-0005.md)

graph 可以帮助定位、分派和跟踪这些问题，不能自动判断什么文字值得读。应继续改进 Writer / Reviewer 输入与判断标准，并保持真实盲选；不能把质量修订让位给多 Agent 平台建设。

## 4. 当前已经有多少基础

| 当前实现 | 已有价值 | graph 仍需要的改变 |
| --- | --- | --- |
| `Task.dependsOn` 与 `startAttempt` | 同 Run 依赖存在性检查；前置任务未完成时拒绝启动；运行中可以增加 Task | 没有完整的计划修改、分支替代与对应验收语义 |
| Task / Attempt input、result、checkpoint 与 receipt | 稳定身份、结果引用、模型绑定、重试和状态恢复 | 动态执行须按调用与绑定输入恢复，不能只按位置 / kind 复用 |
| `ContextSnapshot` | 记录实际读入的 Artifact、内容 hash、范围与 payload；无关修改不使它失效 | 作为结果复用的输入证据，而不是另建 graph 自己的有效性规则 |
| `design impact` / `storyDependentClosure` | 按现有 refs、状态引用和主体关系召回下游候选 | 只是召回，不是完整的文学因果图；不能自动把召回集合全部重写 |
| DesignCommit、StoryText lineage、Review currency | 检查正式采用依据与报告对应内容；已有 `possibly-incompatible` 语义 | 在任务启动、结果采用和作者展示时回查已有判断 |
| 一个 RunEngine、一个 worktree | 统一 owner、工具与提交边界 | 当前单活动 Task、固定初始基线和 recipe 重入不足以直接支持可改计划 |
| Cloud ready claim 与 dependency 表 | 已有依赖筛选和持久 adapter | 当前 Cloud Worker 没有 Agent executor，不代表端到端 graph 已运行 |

代码依据：execution state（`packages/runtime/src/execution/in-memory-execution-state.ts`）、RunEngine（`packages/runtime/src/harness/suiming-harness.ts`）、ContextSnapshot（`packages/runtime/src/artifact/derived.ts`）、Story impact（`packages/runtime/src/artifact/story-impact.ts`）、正文 lineage（`packages/runtime/src/artifact/derived.ts`）、Review store（`packages/runtime/src/artifact/derived.ts`）、Cloud execution store（2026-09-13 随 Cloud 执行 adapter 一起删除，Cloud 只剩 Project store（`packages/runtime/src/cloud/cloud-project-store.ts`））。

两个具体限制会直接影响实现：

1. 当前 `executeTask` 重放只核对顺序与 kind；相同 kind 的新任务或不同输入不能靠这条规则识别。读取已完成结果时 `messages` 为空，恢复的是固定配方结果，不是 Agent 的完整决策接续。
2. 当前 `completeRun` 要求所有 Task 都为 completed；缺少逐项撤销 / 替代工作后的目标验收。动态计划不能仅修改几条边，必须同时处理被取消任务、保留的历史和剩余交付要求。

它们是已读代码的适配缺口，不表示本次复现了真实作品损坏。现有 API 新 Task 只能依赖已存在 Task，因此按正常创建路径自然形成无环依赖；增加改边接口后才需要补整体环检测，不能错误宣称当前已有“任意图可安全重连”。

## 5. 推荐的结构与执行边界

### 5.1 复用三组记录，不增加 graph 真源

| 组织对象 | 表达方式 | 作用 |
| --- | --- | --- |
| 任务与计划 | Task 的目标、交付范围、实际依赖和替代关系 | 决定哪些工作可以开始，调整后哪些仍须交付 |
| Agent 协作 | 父委派调用、子 Task、角色契约和模型绑定 | 明确谁把什么工作交给谁，结果交还给哪个调用 |
| 状态与证据 | Attempt、checkpoint、结果对象、ContextSnapshot、Artifact 与 Review 引用 | 恢复执行，核对输入和结果，解释采用依据 |

三者在同一个 RunEngine 和现有执行存储中关联。没有必要新增长期 Agent 实体、图数据库、另一个 Plan service 或 graph 专属 Artifact 格式。界面从这些记录查询计划、运行与历史视图。

根 Agent Task 可以直接调用能力，也可以按需要委派。**父子委派关系与结果依赖必须分开**：子任务属于尚在运行的 Agent，不意味着它要等 Agent completed 才能开始，否则父等子、子等父会死锁。

任务可以提前规划，也可以执行中产生。远期工作保留粗粒度目标，开始前再解析准确输入；后续 Task 可以引用尚未产生的上游交付，但 Attempt 启动时必须绑定已经存在且有效的具体结果。模型的一次普通工具调用不必都升级为 Task。

### 5.2 允许改计划，不改写历史

Agent 可以增加工作、细化未执行任务、替代或取消不再需要的分支。计划调整也使用稳定调用身份、期望计划版本与 command receipt，在现有执行记录中确认，不由 UI 自己修改关系。

Runtime 检查引用、环、权限、在途工作处置与未满足的交付条件；目标发生变化时保留作者指令依据。取消所有剩余 Task 不等于完成原委托，模型不能靠删任务绕过交付验收。

已经完成的 Task 仍是完成过的历史。输入改变导致其结果不能继续采用，应派生新的检查或修订任务；不把历史 Task 倒改为 pending，也不重写过去的 Attempt。创作中的“写 → 审 → 修 → 再审”由新任务表达，任务实例的依赖可以保持 DAG，内部 agent loop 继续循环。

可选 recipe 的步骤和依赖可以用**可修改的计划模板**表达，替代固定 recipe 执行器。角色方法、创作注意事项和示例仍适合文字指令，不必强行变成节点。模板只是 Agent 可采用的起点，不得拥有第二套调度或规定完成创作的唯一路径。

### 5.3 三类关联不能混用

| 关联 | 能据此做什么 | 不能据此做什么 |
| --- | --- | --- |
| 明确的执行 / 版本依赖 | 阻止消费不存在、失败或不符合要求的结果 | 仅因前置 Task completed 就宣称其输出仍适用于当前候选 |
| 实际读取的内容与 evidence | 内容变化后重新核对结果有效性；沿引用回到来源 | 把“读过”视为完整语义因果，或自动重写所有读过它的正文 |
| 可能的故事影响 | 召回相关人物、Beat、Contract，交由 Agent / Reviewer 判断 | 把召回边当作 Checker 硬约束；认为没有结构边就绝对不受影响 |

任务开始、结果交接和正式采用都回查已有 Context、lineage 与 Review currency。是否可复用还取决于作者要求、角色契约、模型 / prompt 绑定和实际工作目标，不能只比较文件 hash。对于 `possibly-incompatible` 等现有语义保留不确定性，不新建一套 graph 过期规则。

一个写入 owner 指同一候选的修改与整合责任；它不限制独立只读研究、隔离候选生成或准确快照下的并行审查。并行需要明确输出隔离与预算收益，不能让多个 Worker 无协调地覆盖同一正文。

## 6. 子 Agent 结果对接：自建 Runtime 能解决到哪里

### 6.1 当前有一段由模型搬运的数据链路

Codex Reviewer adapter 要求只返回 ReviewDraft JSON，共享 Skill 再要求主 Agent 将最终回复原样写到 `.suim-host/drafts/<task>.json`，调用 `review record`。这让主 Agent 同时负责判断与完整数据转录。Reviewer 配置（`integrations/codex/agents/suim_reviewer.toml`）、host 方法论（`integrations/shared/suiming/SKILL.md`）

如果结果未完整进入父上下文、被概括或转录错误，后面的 schema 和 evidence 检查只能发现部分问题，不能找回没有收到的 finding。本文没有找到足以定位作者所指那次故障的完整 trace，不能将以上风险认定为那次事件的已证实根因。

managed Reviewer 已通过 `submit_review` 调用提交结果；RunEngine 在结果对象写入后记录 checkpoint、完成 Attempt、持久保存执行状态，再返回 TaskOutcome。这里已有可靠交接所需的部分基础，但当前仍是固定 recipe 调用和重放，不能据此宣称动态父子接续已经完成。Review 配方（`packages/runtime/src/harness/review-task.ts`）、RunEngine（`packages/runtime/src/harness/suiming-harness.ts`）

### 6.2 把结果交付从模型回复中分离

目标链路如下；它描述拟议语义，不是新增公共协议的字段定义：

```mermaid
flowchart LR
    D[Agent 的稳定委派调用] --> W[子 Task / 独立 loop]
    W --> S[提交结构化结果或文件引用]
    S --> V[校验实际内容与绑定输入]
    V --> P[持久结果与完成记录]
    P --> C[恢复父调用 / 返回结果引用]
    C --> R[Agent 读取并裁决]
```

- **结果完整交付。** 完整报告保存在对象存储；正文保存为候选文件。父 Agent 接收必要摘要、结果引用和未完成事项，可以按需完整读取。摘要不是结果真源，不能要求它从一段总结重建完整 JSON 或正文。
- **明确对应关系。** 委派调用与 Task、Attempt、输入快照、结果引用相关联；多个子任务乱序完成也不会仅靠角色名或消息顺序匹配。
- **确认后接续。** 区分父调用等待、结果已保存、结果已交还等恢复位置。通知允许重复，但消费与后续有副作用的动作必须幂等；重启先取已有结果，不因最终回复缺失重新创建同一任务。
- **失败可处理。** 未提交、格式不合规、输入已过期、模型请求状态未知、执行失败分别有依据。Runtime 可返回可修复诊断或暂停原因，不能把“子模型结束输出”直接当成成功。

存储提交、执行状态确认和通知的故障窗口仍须测试；接入 `pi-agent-core` 本身不会自动提供以上保证。大结果若超过模型单次输出或上下文上限，还需分段写入 / 读取与完整性验证，不能把持久化误当成无限输出能力。

### 6.3 可以解决工程交接，不能保证语义理解

| 问题 | 自建 Runtime 的作用 | 剩余边界 |
| --- | --- | --- |
| 完成通知丢失、结果未交还、恢复后重复委派 | 持久结果、稳定关联和父调用恢复可直接治理 | 要覆盖崩溃窗口；外部模型请求不能保证 exactly-once |
| 返回 JSON 不合规、转录遗漏、版本不匹配 | 工具校验、结果引用、准确输入绑定消除或显露问题 | 结果 schema 有效不代表 finding 真实、完整 |
| 子 Agent 漏查、总结失真、主 Agent 忽略重要信息 | 保留原始交付、明确未覆盖范围、提供回读与补查 | 仍依赖模型、Context、任务契约与语义验收 |

**可靠交接不以完整 Graph Engineering 为前提。** 单一 Agent 加结构化委派和持久结果也可以解决前两类问题。graph 的额外价值是工作增多后明确结果流向、受影响任务与局部恢复范围。

host-native 也能通过受控工具或程序保存完整输出，向主 Agent 提供结果引用。当前 Codex Reviewer 是 read-only，不能简单要求它自行写文件而不调整能力契约；任何改法都保留其无作品提交权。领域结果可以由工具服务或调用程序保存，不要求 Reviewer 获得作品写权限。

### 6.4 Codex 可以承载同类交接，不能把 adapter 的缺口当成引擎限制

补充核对日期：2026-09-07；本机 `codex-cli 0.153.4`。只检查了命令帮助、由安装版本生成的 App Server TypeScript 协议和 OpenAI 官方文档，没有发起模型调用或完成端到端恢复实验。

| 接入方式 | 已确认的能力 | Suiming 要接的部分 |
| --- | --- | --- |
| Codex 原生 subagent | 创建子线程、发送后续指令、等待和收集结果；安装版协议还有调用 ID、发送 / 接收线程 ID 与状态 | 子任务通过受控结果工具交付，父任务凭引用读取；不再要求模型转录报告 |
| 程序调用 `codex exec` | `--output-schema` 约束最终输出，`-o` 由程序保存最终结果，`--json` 提供事件 | 程序校验输出、绑定输入和保存 receipt；此处是独立 Codex 执行，不代表上述参数自动作用于内置 subagent |
| Codex App Server | 动态工具请求带 `threadId`、`turnId`、`callId` 与参数；支持结果回传、线程历史读取和续跑 | 工具处理器先校验并持久保存领域结果，再返回引用；协调 Codex 执行记录与领域事务 |

一手依据：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本机协议由 `codex app-server generate-ts --experimental` 生成，`DynamicToolCallParams` 与 `ThreadItem.collabAgentToolCall` 确认了以上关联字段；动态工具目前是 experimental 接口，子线程的具体工具配置与崩溃恢复仍需实测。

因此，可以由 Codex 执行 Reviewer，经 Suiming 提供的结果工具校验和保存完整报告，返回引用给 Codex Agent。工具可通过 MCP 或嵌入 App Server 的客户端提供。这里的 `submit_review` 指结果交付能力；接入时仍要明确保存运行结果与正式提交 Review evidence 的权限差别，不能直接把带 Canon 提交副作用的命令交给只读 Reviewer。

**“可靠交接必须自建 agent 引擎”不成立。** 必须由 Suiming 定义的是作品版本、Checker、evidence 和结果采用条件；通用工具循环、子线程与会话恢复可以由 Codex 承担。嵌入式方案要明确各自拥有的记录，不镜像两套完整执行日志，也不能仅凭有 `thread/resume` 就宣称跨系统事务已具备 exactly-once 保证。

若仅修复主模型搬运 JSON 的问题，应先比较改进 host adapter 或程序接收结果的成本；不能将它单独列为选择 pi、自建整个执行引擎或引入 Graph Engineering 的理由。框架选择继续比较多 provider 的实际覆盖、桌面控制接口、领域事务接入和总维护成本。

## 7. 桌面端如何让这些结构有用

作者首先看到“要完成什么、正在做什么、交付了什么、哪里需要决定”。简单任务使用清单；发生跨 Beat 依赖、计划分支或局部重做时，展开局部图。节点采用自然工作名称并直接打开正文、diff、Review 或材料依据，不要求作者理解内部 ID。

应能查看计划如何因作者要求、Review 或新发现而改变，区分尚未执行、进行中、已完成历史和当前可采用的结果。计划调整通过 Runtime 命令执行；在图上改变关系也不能绕过输入检查与作品事务。

工作依赖图、Agent 委派图和故事人物 / 因果图可以联动定位，但不能合并成一张语义不明的大图。“可能受影响”与“必须先完成”需要文字和不同线型，不能只靠颜色区分。运行状态刷新不抢走正文焦点或作者正在查看的局部布局。

host-native 没有 managed Run 的内部记录；桌面可以展示它产生的实际提交、Context 和 Review，不能把未观测的 host 子 Agent 执行补画成事实。上述视图都是查询和 view state，不增加作品或执行真源。

## 8. 成本、替代方案与采用条件

| 方案 | 收益与成本 | 判断 |
| --- | --- | --- |
| 自主 loop + 文本计划 + 可靠委派 | 可以自主规划、复用工具和恢复交接；复杂依赖主要由模型维护 | 必须保留为强对照，不能用缺少基本恢复的弱 loop 衬托 graph |
| 现有 RunEngine 上增加显式可改任务结构 | 可核对依赖、路由结果、局部恢复并支持作者查看；增加计划更新、失效处理和调度测试 | 推荐设计方向，先把父子交接与实际依赖做正确 |
| 用 LangGraph 等替换执行核心 | 可能复用调度与 checkpoint；需重证作品事务、恢复和唯一存储边界 | 只有能替换现有职责并减少总维护时才值得另做验证；不提前叠一层框架 |
| 自由 Agent 网络与自动拓扑优化 | 可能发现不同协作策略；增加协调调用、评测变量和故障面 | 放入有预算的实验，不作为产品重构前置 |

主要新增成本不在画节点，而在准确的依赖、计划变化后的处置和恢复语义。多阶段委托、可靠结果交接、版本事务与桌面生命周期本来就是自主 Agent 所需，不能全部记成 graph 的新增成本；反过来，也不能因为已有 `dependsOn` 就宣称实现只需改几行。

## 9. 验证与实施建议

### 9.1 本次完成的验证

本次读了实际执行、Context、lineage、Review 和 host 交接代码，并运行以下已有测试，共 **38 项通过**：

```sh
node --import tsx --test --test-reporter=dot \
  packages/runtime/test/execution-state.test.ts \
  packages/runtime/test/artifact.test.ts \
  packages/runtime/test/evidence-identity.test.ts \
  packages/runtime/test/host-context.test.ts \
  packages/runtime/test/local-project-regressions.test.ts
```

这些测试验证现有状态与 evidence 基础，包括局部变化的有效性检查；没有验证尚未实现的动态 graph，也没有运行新的真实模型对照。

### 9.2 先验证交接与恢复，再判断组织方式收益

实施时在同一个 RunEngine 中覆盖以下故障与变更边界：

1. 子任务已保存结果、父调用尚未收到时退出；恢复读取同一结果，不重复委派。
2. 父调用收到结果、下一个修改或提交尚未确认时退出；依据稳定动作和 receipt 恢复，不重复副作用。
3. 子任务执行期间相关输入改变；旧结果保留可追溯，但未经重新核对不能当作当前交付。
4. 无关 Artifact 改变；不因 ProjectRevision 不同而全部重跑。
5. Agent 替换未执行分支；历史不丢，依赖不悬空，原目标不能通过撤销任务伪装完成。
6. 模型输出缺少合法提交，或通知重复 / 乱序；没有错误成功状态，也不匹配到其他委派。
7. 阶段提交后重启或遇到作者外部修改；正确推进 / reconcile 基线，不覆盖作者稿。
8. 重复 attach、暂停和进程争用；不额外启动 Agent、不重复提交，用量继续累计。

组织方式对照应比较“自主 loop + 可靠委派”和“相同能力 + 显式任务依赖”，共享 Context、角色、模型、工具、独立 Review、恢复基础与总预算。不能把 graph 组独有的更好 prompt、更多 Agent 或更多 token 计作图结构收益。

可先选择六份有代表性的委托：两份局部工作、两份跨 Beat 修订、两份材料研究与后续创作；两种组织方式各重复两次，共 24 个 Run，作为识别问题的试验而非统计证明。具体作品和预算在执行前确定，本次未发起这些模型调用。

记录目标交付率、人工接续次数、无效重跑、成本 / 延迟、错误结果采用，以及作者对盲稿和运行可理解性的判断。局部任务不应为 graph 付出强制规划开销；复杂任务应体现更可靠的交接、恢复或更少人工干预。文学质量继续由真实长篇、作者选择和修订验证。

### 9.3 对重构方案的修订

修订[重构方案](refactoring-plan.md)中“agent graph 只记录实际执行”的表述：允许预规划、运行中调整和基于准确输入的局部复用；以现有 Task / Attempt / evidence 承载，不增加 graph 执行器。可选 recipe 可以提供计划模板，模型仍可直接调用原子能力或改计划。

S1 完成稳定交接与恢复基础；S2 将显式任务结构、父子委派和持续 Agent 一起实现；S4 展示真实计划、变化与结果依据。自主 loop、任务结构与桌面视觉共同服务创作，不以引入更多角色或框架作为完成指标。2026-09-07 已按确认的边界同步规范；本报告的测试与研究不代表新运行形态已实现，源码迁移仍未开始。
