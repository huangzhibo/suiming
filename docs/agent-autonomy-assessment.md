# Agent 自主运行与 agent graph 评估

> 执行选型已收敛：参考 pi 逻辑自行实现 SuimingHarness，见 [ADR-0012](adr/0012-own-suiming-harness.md)与[Harness 设计](harness-design.md)。本文保留此前取证，关于 pi 内循环、Attempt 重启或替代后端的建议不再作为当前规范。

日期：2026-09-07。代码基线：main / 262ee4d。

本文保留初次设计取证；结论经后续讨论修订后已纳入 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md) 和目标规范，执行 schema 与代码尚未迁移。结论来自产品要求、实现与已有创作记录；没有执行新的真实模型对照，不能据此宣称质量或成本收益已经成立。

> 后续讨论已收敛为[桌面工作台与自主 Agent 重构方案](refactoring-plan.md)。本文保留初次评估的取证过程；新方案进一步明确 Capability 不等于 recipe、Agent 可以直接写作、专属 Agent 不必自建全部执行层，以及桌面端是核心产品。涉及这些边界的建议以新方案为准。

## 结论

**建议补齐目标驱动的 Suiming Agent，继续以一个 RunEngine 承载；保留能力配方中的方法、工具边界与确定性检查，不恢复旧的 coordinator、固定 shard / merge DAG 或通用 graph engine。**

产品仍要求专属 Suiming Agent 在本地与 Cloud 独立完成创作委托。这个目标需要 Agent 根据实际结果选择能力、处理阻塞、修订并判断是否完成。当前配方只能覆盖其中的局部步骤。host-native 的 host 可以承担这份持续决策，但不能代替 Suiming-managed 模式里的缺失能力。[需求与目标](vision-and-requirements.md)

建议将一个 Run 定义为一次有明确目标、范围和预算的完整委托，允许其中产生多次 ProjectRevision。不要仅为串联现有配方，在 Run 上面再增加一套 Goal / Workflow 状态机。该调整已纳入新设计：每次阶段提交形成一个 ChangeSet，代码按路线图实施。

## 当前到底具备什么

| 观察 | 证据与含义 |
| --- | --- |
| 产品要求自主选择能力 | 需求第 4 节要求 Agent 理解目标、选择能力；A-SOTA 要求无需逐步人工接受。能力执行完毕不等于整个目标达成。 |
| Design 有局部决策能力 | `runDesignRecipe` 固定执行 authoring → Review → 非 pass 时 resolution；模型能在每个 Task 内自主使用工具、编辑与裁决。它没有跨能力的持续决策入口。 |
| Writer 的阻塞会交还调用方 | `runWriteRecipe` 要求调用方点名 Beat，并在开始前验证当前已提交 DesignCommit。Writer 返回 blocked 时，配方保存结果并结束 Run，不会自行修 Design、重新 freeze、重试写作。 |
| 配方结束和目标达成尚未分开 | Writer 的 blocked 结果可以对应 `Run.status = completed`。这能表达“本次配方返回了阻塞报告”，不能直接作为“创作委托完成”的判据。 |
| 恢复依赖固定执行顺序 | `executeTask` 按已完成 Task 的位置与 kind 复用结果；恢复构造的 `loop.messages` 为空。现有机制支持固定配方重入，不提供动态 Agent 决策过程的直接续接。 |
| Run 绑定启动基线 | `EngineRun` 与 `RunWorktree` 的基线固定；恢复要求 Project head 等于 Run 的原始 baseRevisionId。不能直接在同一 Run 里多次提交后继续套用现有恢复。 |
| steer 作用于当前 Task | steering queue 被当前 agent loop 取走并注入下一轮；后续 Task 从自己的 prompt 开始，不会自动继承先前的作者补充。 |

代码入口：[RunEngine](../packages/runtime/src/harness/suiming-harness.ts)、[agent loop](../packages/runtime/src/harness/loop.ts)、[Design 配方](../packages/runtime/src/harness/agent.ts)、[Writer 方法](../packages/runtime/src/harness/writing-methods.ts)。

[ADR-0009](adr/0009-redesign-after-code-audit.md) 删除重复 coordinator / executor 和收益未证实的 DAG 机制有充分理由；这些理由不能推导出“跨能力自主决策也不需要”。目前保留了 `Task.dependsOn`，但依赖记录本身不会产生目标理解、下一步选择或完成判断。

## 三条路径的取舍

| 路径 | 收益 | 代价与判断 |
| --- | --- | --- |
| 完全由 host 承担 Agent | 直接使用 host 已有的持续工作能力，Suiming 专注 Story、Checker、Context 和版本事务 | 对 host-native 合理；若作为唯一形态，需要明确放弃独立 Suiming Agent 的产品承诺。本次不建议改变这个产品目标。 |
| 在现有配方 Run 外增加目标编排层 | 原有单配方、单基线 Run 边界改动较少 | 新层仍要拥有目标、模型决策、历史、预算、恢复与完成状态；这些职责与当前 Agent / Run 重叠。只因当前代码容易复用就增加这一层，缺乏终局理由。 |
| Run 承载完整委托，能力在其中组合 | 一份目标、预算、作者指令与运行状态；一个 Agent 持续决策，任务结果直接回到它 | 要修正恢复、提交基线和上下文接续。建议采用，改动集中在共享 Runtime。 |

## 建议的职责边界

| 概念 | 建议职责 |
| --- | --- |
| Conversation | 组织作者交互，可包含多次委托；不另设一套创作执行器。 |
| Run | 一次有范围的委托。统一目标、预算、steer、暂停与恢复、阶段提交和最终结果。暂停后继续同一委托，沿用其累计用量。 |
| Agent | Run 内唯一作品决策者。读取现状、选择下一步、委派、整合、裁决 Review、提交并判断完成。持续的是决策上下文与责任，不要求永远保留同一个内存 Agent 对象。 |
| Capability / recipe | 保存创作方法、角色契约、Context、工具权限、检查和结果。Agent 可选择、重复或切换能力；有确定性意义的局部步骤继续由代码执行。 |
| Task | 一次有明确输入、权限和结果的 agent 工作单元。保留它用于 Writer / Reviewer 隔离、恢复与归因；普通文件工具调用无需各建一个 Task。 |
| Attempt | 同一 Task 的一次实际执行，冻结模型与 prompt binding，累计调用与失败成本。修订目标或输入后应作为新工作，不能把语义变化伪装成重试。 |
| Task dependency | 记录真实的输入依赖与执行关系。需要并行时再承担相应调度约束，不要求预先生成整部小说的 DAG。 |

配方中的 Story Language、Checker、DesignCommit、lineage 与读写权限都是正式边界，Agent 不能为了完成目标绕过。Review 的结论允许基于证据反驳；复审频率与修订路线属于创作策略。需要声称新稿已审查时，Review 必须对应新稿；不能反复用相同材料抽取 verdict，直到得到 pass。

例如作者委托“处理关羽旧案设定冲突，完成下一 Beat，并解决影响阅读的 Review 问题”：Agent 可以修 Design、检查并 freeze，调用隔离 Writer，再调用独立 Reviewer；若 finding 指向 Design 就回到 Design，指向正文就修正文。每一步返回后，Agent 根据当前作品与目标继续决策。这样可以产生执行关系图，但图不必成为另一套手写工作流。

现有 [host 方法论](../integrations/shared/suiming/SKILL.md) 已表达这些创作规则。应共享角色契约与领域工具实现，避免 host 与 managed Agent 各自发展一套互相矛盾的方法。

## 必须一起解决的运行问题

1. **阶段提交与基线推进。** 一个长委托不能把整部作品一直扣在一个未提交事务里。每次提交由 Agent 整合当期候选，经 diff → ChangeSet → Checker 推进 ProjectRevision。保留 Run 的起始版本用于追溯，另外记录当前恢复位置；提交成功后推进 session 与 worktree 的基线。现有 `ProjectRuntimeSession.advanceProjectRevision` 和 Local service 已有部分能力，可复用，但仅修改 readonly 或去掉 revision 冲突检查远远不够。外部 head 移动仍要显式处理；dirty checkout 下候选未落地，就不能声称正式提交已完成。[Runtime session](../packages/runtime/src/artifact/project-runtime-session.ts)、[Local service](../packages/runtime/src/local/local-project-service.ts)

2. **动态决策的持久恢复。** 下一步由模型决定后，按 Task 位置和 kind 重放不再足够。需要持久记录已接受的动作、稳定调用身份、绑定输入与版本、工具结果及待完成动作，在重启时接续已作出的决定。特别要处理“提交已成功，但执行结果尚未确认”的窗口，避免重复提交。已有执行记录和对象存储应承担这些职责，不把 UI 事件、Langfuse trace 或模型重新规划当作恢复真源。

3. **Agent 与 Worker 的执行关系。** 当前只有一个 `#activeTask` 槽位；直接在 Agent 的工具里递归调用现有 `runWriteRecipe` 等入口，会另建 Run / worktree，或破坏活动 Task 的中断与记账关系。能力实现应接受当前 Run / session，入口只负责发起委托。Agent 接续与 Worker 执行都要有可恢复的交接点，并继续复用同一 agent loop 实现。具体记录结构在实施规格中确定，无需引入第二个调度服务。

4. **作者指令与 Context 接续。** 明确作者补充作用于当前动作还是剩余委托，并让后续 Agent 决策及相关 Task 能读取它。作者指令的接收、应用和恢复应持久化；作品仍从当前 Artifact 与 Context 重建。运行摘要只能帮助接续，不能成为作品 Canon；长期采用的意图仍要显式写回 Intent。不能让不受限的完整对话历史成为每个 Worker 的输入。

5. **目标完成与停止原因。** Agent 提交完成判断时，应指出交付范围、当前版本和对应检查 / Review 证据。确定性部分由 Runtime 校验；文学质量由语义 Review 和作者选择评价。未完成时继续工作，无法推进时报告阻塞或请求必要输入；预算耗尽、作者停止、等待输入与目标达成必须可区分。可以研究独立完成判断，但没有证据支持现在增加一个每轮必调的 verifier 模型。也不能把 Review pass 等同于作者满意。

6. **全程预算与无进展处理。** Agent、Worker、Reviewer、失败调用与重试都计入同一委托，恢复不能清零。在相同作品和证据上反复执行、没有可说明的新进展时，应停止无效重试并给出原因。当前预算是达到阈值后拒绝新调用，单次在途调用仍可能超出阈值；不能把它称为精确扣费硬上限。中断期间返回的 usage 也应纳入恢复与预算验收。

以上属于持久自主运行的必要成本。采用 graph engine 不会自动替 Suiming 决定作品版本、作者指令作用域、提交权限和质量标准。

类似 `/goal` 的机制值得借鉴的是“检查目标是否完成、未完成则接续”。例如 Claude Code 的官方实现说明使用独立 evaluator 检查完成情况；这只说明一种停止控制方案，不能证明照搬 evaluator 就能处理 Suiming 的作品事务和质量判断。[Claude Code goal](https://code.claude.com/docs/en/goal)

## 实施位置与验证门

现在应对齐上述终局边界，把自主运行列为 M5 Creative Loop 的明确缺口。当前第二轮作者盲读、Writer / Reviewer 改进与真实正文验证继续推进；不因评估而暂停，也不把恢复旧 graph 平台列为前置工程。

方案对齐后的第一条实现验收，使用现有作品完成一份包含 Design 修正、单 Beat 写作、独立 Review 与必要修订的跨能力委托。范围小，但上述版本、恢复、指令、预算和停止边界必须完整。先证明这条真实路径，再扩展到多 Beat 与长期持续创作；不启动 Web、Cloud host 或 graph UI。

| 验收维度 | 应看到的证据 |
| --- | --- |
| 自主推进 | 不由人或外部脚本逐步指定下一项能力；Writer blocked 或 Review 发现根因后，Agent 能选择有依据的修复路径。 |
| 版本正确 | 阶段提交、Design freeze 与正文 lineage 均有效；自己的提交之后可以恢复，外部改动和未落地候选被如实处理。 |
| 恢复正确 | 在 Worker 执行、结果交接、提交成功未确认等边界中断，续跑不重复已完成工作，不重复提交，不丢作者指令。 |
| 停止诚实 | 能区分目标达成、缺输入、预算耗尽和无进展；不会以配方返回或一次 Review pass 代替完整验收。 |
| 质量与成本 | 同作品、同输入、同模型与角色契约、同总预算，对照固定能力链与目标驱动执行；记录作者盲选、确定性错误、人工干预和总成本。 |

当前真实记录已经证明单配方恢复和若干创作环节能运行；还没有证明专属 Agent 能自主完成跨能力委托。已有作者盲读中 Suiming 版落后于 host 版，但模型、Context 与 prompt 存在混杂，不能据此认定是固定配方导致，更不能宣称加上动态调度就会改善正文。host-native 可以继续作为产品效果参照；验证调度本身的因果收益应控制这些变量。[当前状态与创作记录](current-status.md)

本次建议的成功标准是：作者给出有范围的创作目标后，Suiming 能在明确预算和作品权限内持续推进、可恢复地交付，并如实说明未完成部分。是否需要更多分支、并行或 graph 设施，由真实失败与同预算评测决定。
