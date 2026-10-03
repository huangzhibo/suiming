# 收敛方案：概念层、命令目录、端口与 Canon 存储

日期：2026-09-12。诊断基线：main / `52b21fb`。

**状态：历史方案，不是现行规范。**作者 2026-09-12 决定做一次全局重构而不是继续局部打补丁，范围包含概念层重审，重构期间暂停长篇质量工作。第 4 节的七步当天做完，其中第 4 步的「命令目录合一、传输适配自动生成」后来定为刻意不做，只保留共用 schema 与投影（见[系统架构](../architecture.md)）；第 5 节要的基线已于 2026-09-16 跑完（[第一次真实对话](../validation/2026-09-16-first-real-session/README.md)）。2026-09-13 的 Session 模型又推翻了本文多处「保留」：3.1 表中的 Conversation / Run / Attempt 与 DesignCommit / lineage / ContextSnapshot，3.3 的 worktree，3.4 的 `RunBudget`，第 4 节第 6 步说 harness 调用 `mergeOpenStoryFiles`、`apps/worker` 是活代码，3.7「不撤的东西」里的 Run / Task / Attempt 与 `finish`，第 6 节「不重命名 Run / Task / Attempt」；2.1 待裁的「Agent 能不能删文件」已定为能。现行形状见 [Harness 设计](../harness-design.md)第 2、16 节与[系统架构](../architecture.md)。

本文同时是诊断、目标形状与执行记录：查证推翻原判断时就地更正并写明为什么。这样的更正发生了不止四次，成了本轮最有用的产出之一——2.1 的委派 / 提问等待形态、2.2 的 `cancelled` 四处、3.5 决定 5 的 `artifactVersionId`（先后判错两次）、3.6 的 Agent 写字路径、第 3 步的度量结论、第 6 步切片 4 取消的两件，以及第 7 步查出的五条不实声称。git 的决定已写回 [ADR-0010](../adr/0010-git-as-canon-storage-engine.md)；规范更新落在[系统架构](../architecture.md)与 [Harness 设计](../harness-design.md)。

上一版全局方案是[桌面工作台与自主 Agent 重构方案](refactoring-plan.md)（2026-09-07），它的目标已经实现；本文不推翻它的产品方向，只处理它落地之后暴露的分叉与重复。

## 0. 组织原则：意图是作品的一部分，不是运行参数

产品的北极星是 A-SOTA——「从**作品意图**到可发布成稿无需逐步人工接受」（[需求与目标](../vision-and-requirements.md)）。但今天意图在实现里散在三个层次，耐久性各不相同：

| 层次 | 今天落在哪 | 耐久性 | 下次委托还在吗 |
| --- | --- | --- | --- |
| 全书意图 | `intent/**`，Story Artifact | Canon，过 Checker，有版本 | 在 |
| 委托意图 | `RunRecord.goal`，一个字符串 | 执行数据 | 不在 |
| 补充意图 | steering 队列 / 下一个 Run 的 goal | 执行数据，且实际上会丢 | 不在 |

不变量 8 要求「长期结论须写回作品」。这条对 Design 与正文成立，**对意图本身从未成立**：作者中途说的话被当成一次性执行文本用掉，没有任何路径提议把它写回 `intent/**`。机制是通的（`intent` 在 `STORY_ROOTS` 里，Agent 可写），缺的是规范与动作。

后果直接压在 A-SOTA 上。作者补充的意图分两类：

- **纠错型**（「这里写崩了，重来」）——一次性执行指示，用完即弃是对的。
- **补信息型**（「第 40 章让 Y 背叛 Z」）——这是**作品的长期事实**，Intent 里本来就没有。它被用完即弃，于是下一次委托还要再说一遍。

模型变强只能消掉第一类。第二类是信息缺口，不在输入里，再强的模型也只能猜——除非把它写回作品。所以「一次委托跑不完、需要反复补意图」有一部分不是质量问题，是**架构没有让意图沉淀**。

这条定为本轮的组织原则：

> **凡是对后续委托仍然成立的作者输入，都是作品的一部分，必须有路径提议写回 `intent/**` 或 Design，经作者确认与 Checker 后进入 Canon；只对本次有效的，才留在执行数据里。**

它不新增实体——Intent 已经是 artifact，commit 与 Checker 已经在。缺的是：委托意图与补充意图必须**被分类**，长期的那一类必须**被提议写回**。下面各节按这条原则重排。

## 1. 为什么现在做

这一版的问题不是某个模块写错了，是**规范描述的机器和代码里的机器不是同一台**。三个后果已经实际发生：

- 读规范的人（包括 host agent 与后续 session）会基于错误前提做设计。本轮排查中我们自己就按「六阶段状态机」去读一份四阶段的实现，绕了一圈。
- 规范声称成立的架构属性有几条并不成立，其中「deployment-neutral Runtime」直接决定 Cloud 能不能接。
- 每新增一个领域能力要在三套命令目录里各写一遍，三种命名。

继续打补丁会让差距变大。这一版定型之后，只做质量。

## 2. 现状诊断

### 2.1 规范与代码分叉

| 分叉 | 规范 | 代码 | 状态 |
| --- | --- | --- | --- |
| checkpoint 阶段 | [harness-design.md](../harness-design.md) 第 4 节六个阶段，含 `waiting_children` / `waiting_input`；第 6 节写「把父 checkpoint 置为 waiting_children」 | `LoopCheckpoint.phase` 只有 `ready` / `model_pending` / `tools` / `settled` | 已改规范 |
| 委派的等待形态 | 第 6 节写「父等待时不保留必须恢复的 JavaScript 栈」 | `executeChild` 是同步 `await`，父的 JS 栈确实保留着；恢复靠的是以父动作 id 作 `key` 的持久查找，不是栈 | 已改规范 |
| 提问的等待形态 | 列为 checkpoint 阶段 `waiting_input` | 是错误码 `run_waiting_input`：checkpoint 留在 `tools`，`ask_author` 动作留在 `effect_pending`，恢复时按工具名豁免「效果未知」判定 | 已改规范 |
| 恢复阶段词汇 | —— | `AttemptRecoveryPhase` 六个值只写入过 `prepared` 与 `loop`，其余四个从未使用 | 已收窄为两值 |
| 项目 CLAUDE.md | 指向 `engine/design-recipe.ts` 的 `DEFAULT_BUDGET` 与 `writeMaxTurns` | `packages/runtime/src/engine` 目录已不存在，`writeMaxTurns` 也已删除 | 已改写，保留背后的实测事实 |

死代码：

| | 现状 | 处置 |
| --- | --- | --- |
| `preflight` | 2026-09-08 接过线，后被「按 Conversation 选模型」有意收窄留下的孤儿；`current-status.md` 已如实记录收窄，不属于文档分叉 | **已删**（`a917cb3`） |
| `isDurableRunEvent` | 恒 true，零调用 | **已删**（`a917cb3`） |
| `subjectsForSearchHits`、`DesignFrameOptions.preferredPaths` | 「检索命中影响 Frame」的两半都是死的 | 留到结构化意图真的产生之后接线，不删 |
| `AgentScope.write.brief` | CLI 仍暴露 `--brief`，值从不被读 | **已处理（第 7 步）**：不是删掉，是接对位置。brief 原本挂在 `scope` 上，而 `scope` 被 Agent prompt 念成「可用操作范围（不等于本次交付目标）」——作者的创作交代被当成权限说明。现在并入 `goal` |
| `env.remove` | 产品代码零调用 | **保留，但暴露出一个真问题**：`ConfinedEnv.remove` 有完整权限检查和测试，却没有任何工具暴露它，所以 **managed Agent 只能新增和修改，不能删除作品文件**；host agent 直接改 checkout 反而可以。这可能是刻意的（删除是破坏性动作），但代码和规范都没写明。**要作者裁一次**：给 Agent 删除工具，还是把「Agent 不删文件」写成明确边界 |
| `collectObjects` | 四条测试，零调用 | **保留（第 6 步）**：git 接管 Canon 后它的引用只剩执行对象一处，但回收仍是终局必需——ContextSnapshot 的 payload 每个 Run 都在涨。接线未做，因为要先处理「put 完成到插入行之间的对象会被并发 GC 当孤儿删掉」这个竞态 |
| `run_steering.consumed_at` | 从不写入 | **已删（第 6 步）**：投递事实可从 run events 派生，它是第二套真源 |
| `ExecutionResultReference.kind` 的 `change_set` / `artifact_version` | 只有测试在构造，产品代码零产出 | 第 7 步查出的新残留。它们是 git 之前的 Canon 概念——ChangeSet 现在是从 diff 构造的派生视图，根本没有 id。留着不改，因为这个 union 同时是 Cloud 的 wire schema（`sdk/src/schema.ts`），Cloud 的 PostgreSQL 里那两张表还在；Cloud 解冻时一起清 |

### 2.2 规范声称成立、实际不成立

- **deployment-neutral Runtime。**`SuimingHarnessOptions.project` 的类型是具体类 `LocalProjectService`，不是端口。这是 Cloud 接不进来的直接原因，不是「还没写 executor」。**已修**：`HarnessProjectPort`，`packages/runtime/src/harness/` 对 `../local/` 的 import 归零。
- **Run 预算覆盖根任务、Worker、Review、压缩、重试和失败调用。**`DEFAULT_RUN_BUDGET = Object.freeze({})`；Agent、delegate 出的 Worker、review 子 Task 的 `maxTurns` 全是 `Number.MAX_SAFE_INTEGER`。创作路径上 `budget_exhausted` 不可达，只有 `rank.round` 的 3 是活的。
- **接受暂停后等待当前动作有界收口。**`LocalRunController.waitForIdle` 是无界 `Promise.allSettled`，`run.cancel` 这条命令自己没有超时。全仓唯一的有界等待在退出路径（`apps/desktop/src/main.ts` 的 3500 / 5000ms race），是调用方自己加的，不是 Runtime 的属性。**已修**：`waitForIdle` 返回 `"idle" | "timeout"`，默认 30s 兜底，`run.cancel` 用 5s 并如实回 `interrupting`。
- **唯一命令目录。**见 2.3。
- `cancelled` 不在终态集合里，实际是**四处**（复核时多查出两处）：`LocalRunController` 的判活、`HarnessRun.#interrupt` 的跳过集合、`isRunTerminal`、Cloud 的 `runs` / `attempts` CHECK。挡住 `failRun` 的不是终态判断，是后面 `#clearActiveRun` 的「会话不持有活动 Run」——记账顺序的巧合。**已修**，追加 migration 003。
- Cloud PostgreSQL adapter 每次整项目 upsert，实体 version 从不参与写入判断；migration CHECK 不含 `cancelled`。

### 2.3 三套命令目录

`packages/sdk` 里并存三个目录，不是一个目录三个传输：

| | 数量 | 命名 | 消费者 |
| --- | --- | --- | --- |
| `SUIM_CLI_COMMANDS` | 46 | `project.*` / `run.*` / `cloud.*` | CLI 与三个 host |
| `LOCAL_COMMANDS` | 31 | `workspace.*` / `run.*` / `models.*` | 桌面 IPC |
| `DOMAIN_API_ROUTES` | 11 | `project.*` / `revision.*` / `run.*` | Cloud HTTP |

**2026-09-12 复核更正了上一版对这一节的两处判断。**

一、**三套目录不是三种命名风格。**HTTP 那套的 `operationId` 已经是点号领域名（`project.read`、`revision.diff`、`revision.commit`、`run.interrupt`），上一版写的 `diffRevision` / `commitRevision` 是 TypeScript 对象键，不是命令名。真正的分叉只在名词：`project` / `revision` / `workspace`。

二、**不是所有同名动作都是同一件事。**diff 尤其：

| | 比的是什么 |
| --- | --- |
| `project.diff`（CLI） | checkout 对 head |
| `revision.diff`（HTTP） | 两个已提交版本 |
| `workspace.diff`（IPC） | 三件事合一个名字：不带参数时是 checkout 对 head，带 `revisionId` 是版本对父版本，带 `runId` 是 Run 当前版本对 worktree |

所以 diff 的问题不是「三个名字一件事」，是 **IPC 把三个动作塞进了一个名字，CLI 与 HTTP 各只暴露其中一个**。合一要先把这三件事分开命名，再让三个传输各取所需——直接把三个名字并成一个会把 IPC 的重载固化下来。

真正确认的重复：**`project.status` 与 `project.diff` 是同一条命令的两个名字**——`LocalProjectService` 里是同一行实现（都返回 `#buildCheckoutCandidate().diff`），CLI 目录里映射到同一个 `SuimCliDiffDataSchema`，`diffSideSchema` 只有元数据没有内容，所以两者输出逐字相同。

代价不是抽象的：SKILL.md 第 27 行教 host「执行 `status`；若已 dirty，再执行 `diff`，区分既有候选和本次任务范围」——**第二条命令拿不到任何新信息**，每次 host 会话都白跑一遍。第 143 行同样。

**已修。**`project.status` 返回摘要，`project.diff` 保留逐文件清单。摘要不是新发明的形状——`readProjectStatus` 本来就是 Agent `status` 工具的输出，按「一个投影，多个传输」接给 CLI；`state` 也从 `changeOperationsBetween` 派生，与 ChangeSet 的构造用同一个判断，不另立一套 clean / dirty 规则。SKILL.md 的两处说法同步改成「clean 时不必跑 diff」，host 文件已重新生成。这是本轮唯一一处 host 面向机器契约的形状变化。`run.list` 与 `run.steer` 曾经同名不同 schema（已修，见 3.2）。

**「CLI 自己 `new SuimingHarness`」这条上一版也写过头了。**复核后：两条路径用的是同一个 harness 类、同一份 options；lease 在 `SuimingHarness.startRun` 获取，事件持久化在 harness 内部，所以 CLI 并没有绕开跨进程保护或事件真源。`LocalRunController` 的 `local_run_already_active` 是进程内单窗口守卫，不是安全边界。真正的差别是执行模型——CLI 阻塞到完成并流式输出 NDJSON，桌面是 launch 后 attach——这是正当的传输差异，不是要消除的重复。**照字面把 CLI 接到 `run.launch` 会破坏它的阻塞语义，不要做。**

### 2.4 与 git 的结构性重复

ProjectRevision 层实现了快照、线性历史、diff、rollback、每 Run 一个 worktree、三方合并与 push / pull。净删除量约一两千行且交错（[ADR-0010](../adr/0010-git-as-canon-storage-engine.md) 原估的「五六千行」按文件计，其中大部分是留下来的领域逻辑）。作者 2026-09-12 决定强制转 git、删除自定义版本层，理由是当下大模型偏向 coding 训练，除 Story Language 与 artifact 外不必制造概念差异。

## 3. 目标形状

### 3.1 概念层：保留什么、合并什么

| 概念 | 处置 | 依据 |
| --- | --- | --- |
| Conversation | 保留 | 作者交互容器，一个会话含多次委托；Run 结束后追问沿用它 |
| Run | 保留 | 它持有 lease、作品基线、预算、entry，这四样无处可挂；`rank` entry 证明一个 Run 可以有多个顶层 Task，不与根 Task 一一对应 |
| Task | 保留 | 独立输入契约、权限与结果契约 |
| Attempt | 保留 | 冻结执行绑定，显式换模型与重试归因依赖它 |
| checkpoint 阶段 | **合并为一套词汇** | 保留 `LoopCheckpoint.phase` 四阶段为唯一真源；删除 `AttemptRecoveryPhase` 的四个死值，只留「有无恢复点」 |
| ChangeSet | **降为派生视图** | git 接管后 diff 是仓库固有的，`change_sets` 表与其读写路径整个删除 |
| ProjectRevision | **改为 git commit** | id 即 commit sha |
| MaterialEvidence | 重新评估 | ADR-0009 决定 29 未做；runtime session 仍整包重建，SQLite 已逐条记录，两处逻辑择一 |
| Story Language / DesignCommit / lineage / ContextSnapshot / ReviewReport | 保留 | 领域语义，git 不懂也不该懂 |
| 「委托」这个概念 | **整个撤掉**（2026-09-12 作者决定） | 先是发现「完整委托」在一次会话里造成过三次误读（被读成「全自动」、被读成「Run 承载交付契约」），改述为「Run 是一次委托的执行与资源边界」。作者随后判定**这个概念本身现阶段不要**：Codex 与 Claude Code 都没有它，产品以**意图**为核心。见 3.7 |
| 角色契约的归属 | **移到 Context 编译器** | 见 3.6 |
| 委托意图 `RunRecord.goal` | **保留但降级** | 它是执行数据里的一个字符串，不是作品事实。长期部分按第 0 节写回 `intent/**` |
| 补充意图（steering / 追问） | **必须分类** | 纠错型留执行数据；补信息型由 Agent 提议写回 Intent 或 Design，作者确认后提交。这是 A-SOTA 的结构性改善，不靠模型变强 |
| Frame 的 seeds | **接线** | Agent 两处都传 `seeds: []`，裁剪机制形同虚设；意图结构化之后 seeds 有了来源。`subjectsForSearchHits` 与 `preferredPaths` 是这条的两个未接线半边 |

对外表达按[作者工作台设计](../web-product-design.md)第 4.4 节：界面不出现 commit / branch / merge，也不画提交图。

### 3.2 命令目录收敛为一套

一个目录定义领域动作与 schema，CLI、IPC、HTTP 是生成的传输适配：

- **同义的领域动作用一套名字，其余不动。**2026-09-12 定：改名只覆盖 CLI 与桌面 IPC 真正同义的四条（`diff` / `commit` / `rollback` / `check`），统一到 CLI 的 `project.*`。**不做全量改名**——`models.*`（8 条，桌面独有）、`workspace.show / files / read / save`（渲染层投影）在 CLI 里没有对应物，改它们是纯 churn。

  判断依据不是风格偏好：没有任何运行期消费者会同时看到两套目录（host 只见 `suim --json *`，渲染层只见 IPC，Cloud 只见 HTTP），所以三套名字的代价由读代码的人承担，而那个代价的具体表现——同名不同形状——已经由共享 schema 加守卫测试挡住。真正同义不同名的只有四条，这才是改得起的规模。

- **同名命令只允许一份 payload，信封归传输。**CLI 有 `suim.cli.v1` 外壳、IPC 是裸的，这是信封差异；`check` 与 `commit` 曾在 CLI 侧多包一层 `diff`，那是 payload 分叉，已删（要逐文件清单单独取 `diff`）。唯一例外是 `project.diff` 本身：CLI 给 artifact 身份与 sha（host 有文件工具能自己读内容），IPC 给解码后的正文（渲染层读不到文件）。这是消费者能力差异，守卫测试里写明理由，不当漏网。这不是风格偏好，有三条客观依据：它是最大的目录（46 > 31 > 11）；它是**唯一有机器强制的外部契约**的——`scripts/check-host-integrations.mjs` 直接从 `SUIM_CLI_COMMANDS` 派生 SKILL.md 的必需片段，改名就要改三个 host adapter 与校验脚本；`run.*` 本来就是两套目录共用的前缀，说明 LOCAL 已经部分采用了这套命名。`models.*`（8 条，桌面独有，CLI 无对应）保留原名。

- **合一是取并集，不是选一份。**两套目录里有两个同名命令，schema 却不兼容，而且住在同一个包里：

  | | CLI `run.list` | LOCAL `run.list` |
  | --- | --- | --- |
  | `currentRevisionId` / `model` | 无 | 有 |
  | `createdAt` / `updatedAt` / `result` / `failure` | 有 | 无 |
  | `status` | 枚举 `runStatusSchema` | **自由 `Type.String()`** |

  `run.steer` 同理：CLI 输出带 `projectId`，LOCAL 不带。今天两者不会在运行期相遇（各走各的传输），所以不是活 bug，是维护陷阱——读 SDK 的人拿到哪一份取决于他 import 了哪个文件。LOCAL 的 `status` 被弱化成自由字符串是其中唯一的实质缺陷。
- CLI 与桌面共用领域投影与 schema；差异只在传输、执行模型与 exit code。~~不再自己 `new SuimingHarness`~~ 这条复核后取消，理由见 2.3。
- 新增能力只写一次。今天要写三遍是这条收敛的直接收益。

**重复的是投影，不是逻辑。**领域逻辑都在 `LocalProjectService`；CLI 与 `LocalWorkspace` 各自手写一层响应形状。所以合一的单位是「一个投影 + 一份 schema」，不是重写命令实现。

已完成的第一刀（2026-09-12）确立了这个模式：`packages/sdk/src/domain-schema.ts` 是领域对象 schema 的唯一定义，`packages/runtime/src/execution/run-summary.ts` 是 Run 摘要的唯一投影，CLI 与 IPC 都调它；`usage` 原样透传存储形状，派生值（`unconfirmedCalls`）归界面算。两条守卫测试钉住：同名命令在两套目录下必须是同一个 schema，领域对象的 schema 不得在 `domain-schema.ts` 之外再定义。

按同一模式处理完的（2026-09-12）：

| 动作 | 处置 |
| --- | --- |
| `run.list` / `run.show` | `runSummary` / `runSummaries` 一份投影，`runSummarySchema` 一份 schema |
| `project.status` | 与 `project.diff` 曾逐字相同；改为返回 `readProjectStatus` 的摘要 |
| `check` | `checkSummary` 一份投影；桌面此前只拿到 runtime 拼好的一句中文 |
| `commit` / `rollback` | `revisionSummary` + `commitResultSchema`；桌面此前只回 `revisionId` |
| `history` / `export` | 只有 CLI 有，无重复 |
| `diff` | **拆成三条**：`project.diff`（checkout 对 head）、`revision.diff`（版本对父版本）、`run.diff`（Run 基线对 worktree）。此前一个名字三种行为，语义由「传了哪个可选参数」决定 |
| CLI 的 `new SuimingHarness` | **不改**：不是分叉，见 2.3 |

守卫测试三条：同名命令在两套目录下必须是同一个 schema；领域对象 schema 不得在 `domain-schema.ts` 之外定义；commit 与 rollback 的结果形状必须一致。

剩下的是**命令名本身**（`project.*` / `workspace.*` / `revision.*` 三种名词）与传输适配的自动生成，那要先按 2.3 把 `workspace.diff` 的三重语义拆开，是下一轮的工作。
- ~~CLI 的 93 种 Runtime 错误码未映射 exit code、`--version` 返回 exit 2~~ **已完成**（2026-09-12 复核）：`errorCategory()` 按规则加 overrides 派生类别，`EXIT_BY_CATEGORY` 映射到 exit code，手抄表已不存在；`--version` 返回 0，未知命令返回 2。项目 CLAUDE.md 里那条「不要再往手抄表里加行」也已过时。

### 3.3 Runtime 端口化

`SuimingHarness` 依赖一个 port，而不是 `LocalProjectService`。Local 与 Cloud 各自实现同一个 port，跑同一套契约测试。这一条做完，「deployment-neutral Runtime」才第一次成立；Cloud executor 是否解冻是另一个决定，不在本轮。

端口面已经数清了：`LocalProjectService` 有 33 个方法，harness 只用其中 15 个加两个属性。**不到一半。**另外 18 个（`status` / `diff` / `check` / `commitCheckout` / `search` / `rollbackRevision` / `ingestSource` / `subscribeExecutionState` / remote binding 等）是 workspace 与 CLI 的面，不属于执行端口。

| 层 | 成员 | 可移植性 |
| --- | --- | --- |
| 执行存储 | `saveExecutionObject` `readExecutionObject` `saveContextSnapshot` `readContextSnapshot` `loadExecutionState` `createExecutionState` `appendRunEvents` `readRunEvents` `readRunSteering` `recoverCommittedAction` | 纯记录 CRUD，Cloud 已有等价实现 |
| 作品读写 | `exportRevision` `openRuntimeSession` `commitRuntimeSession` `history` `projectId` | 领域语义，Cloud 已有等价实现 |
| **worktree 物化** | `project.paths.privatePath` → `localWorktreePath()` → `RunWorktree.create()` 直接 `mkdir` + 写文件 | **硬绑 node:fs** |

第三行是真正的设计问题，本方案上一版漏了它。处置：**worktree 保持文件系统形态，端口只提供位置**。Cloud Worker 同样跑在有磁盘的机器上，把 worktree 也抽象成接口是为不存在的需求付成本。`paths.privatePath` 在端口上收敛为一个 `worktreeRoot: string`，`RunWorktree` 不动。

判据：端口上只保留 harness 真正调用的成员；新增成员必须先有 harness 的调用点，不为「Cloud 以后可能要」预留。

### 3.4 预算与控制：改规范，不是补默认值

2026-09-12 复核后改变结论：**不为预算定默认值，改规范使其如实。**

无人值守时真正在兜底的是三道**进展型**闸——连续无交付（`task_not_submitted`）、重复同一被拒动作（`run_no_progress`）、作者暂停。它们只砍卡住的 Run；成本闸会把正常产出的 Run 一并砍掉，对症性更差。coding agent 普遍没有按次预算，也是因为人在旁边；Suiming 的差别是 A-SOTA 要求人不盯着，但这只说明「需要有东西能停下来」，不说明那东西必须是成本闸。

- `RunBudget` 机制保留（`rank` 在用，作者可显式设上限），**默认不设**。
- 规范里「Run 预算覆盖根任务、Worker、Review、压缩、重试和失败调用」改为如实描述：设置后才覆盖，默认无上限，兜底由进展型条件承担，并写明为什么。
- 代价进已知缺陷：**一个「持续产出但方向错了」的 Run 没有任何闸会停它**，只能靠作者发现。这与第 0 节是同一个问题的两面——作者必须在场，正是因为意图没有沉淀。
- 暂停与取消有界收口：`waitForIdle` 加超时，超时留下可核对的状态。
- `cancelled` 补进两处终态集合。

### 3.5 Canon 存储改用 git

形状按作者 2026-09-12 的选择：作品目录是普通 git 仓库，任何人都可以 commit（那是候选），`suim commit` 跑 Checker 后推进受保护的 canon ref。ADR-0010 提议的 `.suiming/canon.git` bare repo 形状**作废**——它本身就是一个刻意差异。

上一版列了「需要一起裁决的五条」。2026-09-12 逐条查证后定下，其中三条并不是开放问题：

**1–3 是作者所选形状的蕴含，不是另外的选择。**作品目录是普通 git 仓库、谁都可以 commit，那么「历史里存在未过 Checker 的候选 commit」（1）与「提交语义改为 promote 校验后移 ref」（3）就直接跟着来，没有第二种可能。

**2 的说法要改准。**不是「门禁从结构强制退为工具强制」——**Canon 门禁仍然是结构性的**：canon ref 只由 promote 移动，普通 commit 再多也进不了 Canon，不变量 3 照旧成立。作者当然可以 `git update-ref` 手动搬 ref 绕过去，但那与今天直接改 `.suiming` 里的 SQLite 是同一级别的动作，不是新增的弱化。

**4（Checker 执行时机）定为：只在 promote 时跑。**候选 commit 按定义就是未检查的，这正是「候选」的意思。要在候选时也跑，就得往作者的仓库里装 git hook——那是第二套机制、可绕过、且侵入作者的仓库；作者想提前知道结果时 `suim check` 就在那里。

**5（绑定 key）：两个选项都不选，`artifactVersionId` 原样保留。**它看着像存储 id，其实是内容寻址的——`artifactVersionId(mediaType, contentHash)` = `av_` + sha256(mediaType‖contentHash)（`artifact/version-storage.ts`），只由字节和 mediaType 决定，与存到哪儿无关。StoryText lineage 正是用它作 key（`artifact/story-text-lineage.ts` 的 `bind` / `read`），这也是对的：lineage 绑定的是「这份内容依据哪个 DesignCommit」，内容变了就该重新绑定。

  换成 git blob sha 反而更差：它是 sha1 且不含 mediaType，两个 mediaType 不同、字节相同的 artifact 会撞成同一个 key。`(commit sha, path)` 更差：同一份内容在两个 commit 里得到两个 key，lineage 会重复绑定，而且路径一改就断。

  （这一条我先后判错过两次：第一次说「领域层零消费者」，是 grep 被 `head -20` 截断、字母序把 `apps/` 与 `cloud-postgres/` 排在前面；第二次才查全，发现 lineage 就在用它。结论按查全后的事实写。）

这五条都可以推翻，但推翻需要新的理由，不是重新提问。

**三方合并不能整个交给 git。**现在的 `mergeOpenStoryFiles` 是**文件级**的：同一个 artifact 两侧都改就是冲突，双方候选都保留，作者来裁。git 默认是内容级（diff3），同一文件不同位置会自动合并——spike 实测 22 ms 且结果正确。

对散文这是风险不是升级：两侧各改一章的不同段落，git 合出来的那一版**谁都没写过**，而 Checker 只验结构与硬状态，验不了散文的连贯。一次静默的错误合并比一次冲突糟得多。

规则定为：**内容级自动合并只用在 Checker 能验证结果的文件上；Checker 验不了的必须停在文件级冲突。**`outline/story/index.yaml` 这类结构化文件两侧各加一个 Beat，git 合并后顺序若坏了 Checker 会报出来，所以可以自动合；`text/**` 的正文必须冲突。落地方式是作品仓的 `.gitattributes` 给正文路径标 `merge=binary`（两侧都改即冲突），不必自己再写一套合并。

`commitStoryChangeSet` 的四件事里三件是领域语义（要求当前 DesignCommit、范围冻结校验、lineage 绑定），只有 `artifactStore.commit` 那一行是存储，换掉即可。

### 3.8 意图库：结构已经是 wiki，缺的是生长机制

作者 2026-09-12 提出把 `intent/**` 做成「LLM wiki」式的意图知识库，只管理用户意图，并判断**对话中逐渐形成的意图库可能是 AI 时代最重要的资产**。

**结构不用建，规范里已经是了**：`intent/<id>.md` 一个意图一个文件；frontmatter 只做路由（`applies_to` / `target` / `subjects` / `style_refs`），要求本身写在 Markdown 主体；Context Compiler 按 `target / subjects` 投影而不是全量塞；明写收敛纪律（「只保留收敛后的当前认识，不保存讨论过程」「完全结晶为故事事实的重复 Intent 应合并或删除」）。「只管理用户意图」这条对应的是「不重复已经由其它 artifact 表达的故事事实」——正是它让 intent 不会变成第二套故事真源。Canon 改 git 之后编辑历史也有了。

**但它从未生长过。**eval-022 的 `intent/` 是 `book.md` 8,378 字加 `story-text-style.md` 2,786 字，`suim init --intent-file` 种下去之后 4 个 Run、480 条事件里一个字没改。所以问题不在结构，在生长机制，缺两件：**写回路径**（3.7 与已知缺陷）与**拆分压力**（没有任何规则告诉 Agent 什么时候该另起一页，默认动作是把单体撑大）。

**那个战略判断本仓就是证据。**项目 CLAUDE.md 的「踩坑得来的决定」就是一个意图库：它跨过了模型更换、跨过了 `RunEngine` 整个被删重写、跨过了 Canon 换存储——代码重新生成了好几轮，那一段没有。模型越强，可重新生成的部分越不值钱，不可反推的那部分就越是全部资产。

**决定它是资产还是沼泽的是收敛压力。**Wikipedia 能用是因为有人无情地删改。意图库的失败模式很具体：三月说「第 40 章让 Y 背叛 Z」，五月改主意说「别让 Y 背叛」，两条都在库里。Story Language 写了规则（「要求冲突时必须明确修订，不能按创建时间静默覆盖」），但 **Checker 管不了语义冲突**，今天也没有任何东西把冲突显示出来。这跟代码不一样：重复代码只是啰嗦，矛盾的意图会让模型在两个方向之间摇摆，库越大越糟。

**一条边界要守住**：wiki 可以（文件 + 路由 + 历史），本体不行。AGENTS.md 把「知识图谱 Canon」「固定 World 本体」列为非目标，具体就是别在 intent 之间加类型化关系字段——`subjects` 路由到人物地点已经够了。

**判据是「没做会不会有人发现」，不是「模型能不能做」**（作者 2026-09-12 提出、09-13 修正后的通则，见 AGENTS.md）。我原本提的方案是「先量一次，模型做得好就不做机制」，被推翻；但推翻的理由不是「不能靠 prompt」——prompt 是真手段，模型只会越来越强——而是**写回没发生时没有任何人会发现**，跑了 4 个 Run、`intent/` 一个字没改，一周无人察觉。方向改为**作者侧确定性对账**——每个 Run 显示作者说了几条、其中几条真的改动了 `intent/**` 或 Design。这是纯算术，零模型依赖，而且与 3.7 的「达成与否由作者定」同一个方向：系统不判断哪句话是长期事实，它只如实并排摆出来，让知道答案的人看见。真实长跑给出的漏报规模用来定呈现形态，不用来决定要不要做。

### 3.7 以意图为核心，撤掉「委托」

作者 2026-09-12 决定：**现阶段不要「委托」这个概念**，理由是 Codex 与 Claude Code 都没有它。

参照对象的形状很简单：你说一句，agent 干活，报告，你再说一句。耐久的东西在仓库里，会话是一次性的。没有「委托对象」，没有「交付契约」，也没有「系统判定目标已达成」这回事——**判定归人**。

这不是换词，它改了三件事的归属：

1. **耐久的中心从 Run 移到 `intent/**`。**`RunRecord.goal` 只是这一轮作者说的那句话，用完即弃；对以后仍然成立的部分必须写回 Canon（第 0 节的组织原则由此从「一条规则」升成「组织概念」）。
2. **Run / Task / Attempt 降为机械边界**——lease、预算、worktree、冻结绑定。作者不需要知道它们存在，产品不围绕它们建概念，界面上的字也都改成白话（「委托进行中」→「还在运行中」）。
3. **`completed` 不再声称「交付要求已满足」。**查证后发现原描述本来就不实：`finish` 实际检查的是兄弟 Task 都收了口、scope 内的正文 / 材料检查通过——**全是「没留残局」，没有一条在判断作者的目标是否达成**。工具描述写着「确认整份作者目标已完成」，是在要求模型做一个它做不到、也不该由系统做的判断。已改。

**不撤的东西**（免得把机制和概念一起扔掉）：

- `finish` / submit 机制本身留着。它挡的是「模型说完了但 worktree 还脏着」，那是真故障。
- Run / Task / Attempt 的结构留着。它们承载 lease、预算、冻结绑定与恢复，都是机械必需品，只是不再是产品概念。
- 意图写回规则留着，而且更中心。

### 3.6 角色定义与 Context 投影成对交付

**recipe 同时做了两件事，删除时两件一起走了。**

| recipe 做的事 | 处置 | 理由 |
| --- | --- | --- |
| 编排：哪个 Task 何时跑、各多少 turn、Design → Write → Review 的固定顺序 | **删对了** | A-SOTA 要求 Agent 按作品实际情况决定，固定顺序做不到 |
| 角色定义：writer 是什么——system prompt、Context 投影、交付契约、工具集 | **不该删** | 这不是编排。它回答「是什么」，不回答「什么时候」 |

角色定义当时住在 recipe 里，没有别的家，于是跟着一起没了。后果可以量化：`delegate` 的 `profile` 是四值枚举（`agent` / `writer` / `source-reader` / `source-extractor`），但它在下游**只喂给 `bindModel`**——选模型。四个 profile 拿到同一份 `SUBAGENT_PROMPT`、同一套工具、同一个 `submit_task`。

这一层不是 Suiming 的发明，也不是倒退回 recipe：coding agent 的现行做法（Claude Code 的 `.claude/agents/*.md`、Codex 的 agent 配置）正是**角色定义持久、编排动态**——每个子 agent 带自己的 model / tools / system prompt，何时调用由主 agent 决定。Suiming 现在只留了动态编排。

今天仓库里同时有做对的和做错的两种：

| | Review（对） | Write（错） |
| --- | --- | --- |
| 编译器产出 | `CompiledReviewContext` 含 `systemPrompt` + `prompt` + `artifacts` + `readable` | `CompiledWriteContext` 只有 `text` + `artifacts`，无 `systemPrompt` |
| managed 侧 | `reviewTask` 用 `compiled.systemPrompt` | `delegate("writer")` 用通用 `SUBAGENT_PROMPT` |
| host 侧 | `compileHostContext` 用同一个 `compiled.systemPrompt` | 用 `WRITER_HOST_SYSTEM_PROMPT`，另一条线 |
| 结果 | 两侧真的一致 | SKILL.md 声称「完全相同」，实际不同 |

后果是 `WRITER_SYSTEM_PROMPT` 在产品代码里零消费者——整个仓库最密集的写作工艺知识（把 Beat 组织成连续场面、旁白不替人物作证、同一笔账只成立一次、避免翻译腔）只有 host 路径拿得到，桌面委派出去的 writer 拿到的是「只完成给定目标与范围」这类通用措辞。Design 的七视角自检同理：只在 host SKILL 里，`AGENT_PROMPT` 无对应内容。

**实现时查出洞比这更大。**`runWrite` 只是 `runAgent` 加一个 write scope——`suim run write` 与桌面「写这个 Beat」都是 **Agent 自己写字，没有隔离 Writer**，而 `write_context` 工具当时只返回 `context.text`：

| 路径 | 谁写字 | 拿到写作方法吗 |
| --- | --- | --- |
| host `context compile write` | host 子 agent | 拿到 |
| `delegate(profile: "writer")` | 委派出的 Worker | 没有 |
| `suim run write` / 桌面写 Beat | **Agent 自己** | 没有 |

根因与 recipe 同构：`WRITER_SYSTEM_PROMPT` 把**写作方法**和 **Writer 的权限 / 交付形状**焊在一个常量里。方法对任何写 StoryText 的人都适用，权限只对隔离 Writer 适用。焊在一起，方法就只能跟着 Writer 角色走，Agent 自己写时拿不到。

处置（已实现）：按同一条判据拆成 `STORY_TEXT_METHOD` + 角色开场 + 交付形状三段，`WRITER_SYSTEM_PROMPT` 与 `WRITER_HOST_SYSTEM_PROMPT` 由它们组合而成、文本逐字不变；`write_context` 的结果带上方法，与 Context 成对交付。`WRITER_HOST_SYSTEM_PROMPT` 原本就是对交付段做正则替换，缝是现成的。

收敛规则一句话：**角色定义与 Context 投影必须由同一个编译器产出、成对交付。谁消费是传输差异，不是内容差异。**

profile 从「模型选择键」升级为「角色定义」，绑定五样：模型、system prompt、Context 编译器、交付契约、工具集。样板已经在仓库里——`reviewTask` 用 `compiled.systemPrompt`，managed 与 host 两侧真的一致；照它做，不发明新机制。

- `CompiledWriteContext` 补 `systemPrompt`，`WRITER_HOST_SYSTEM_PROMPT` 退化为同一份的 host 变体，两条线的差异收敛到「用工具还是用 CLI」。
- `delegate` 按 profile 取对应角色定义，`SUBAGENT_PROMPT` 只留给没有专属定义的通用委派。
- Source 的两份 host prompt 同样并入对应编译器。
- 创作方法论走已有的生成模式（`strategies/story-constitution.md` → `constitution.ts`、`integrations/**` → `host-files.ts`）：一份 markdown 真源生成两种渲染，差异只在操作方式，不在创作方法。

Worker 是权限形状（task-local、无提交权、不递归委派），不是角色；角色由编译器给的定义决定。两者正交。

边界要说清：**这不是把 recipe 请回来。**recipe 规定「先 Design 再 Write 再 Review、各多少 turn」；角色定义只规定「writer 是什么」。Agent 什么时候用、用几次、要不要用，仍然它自己定。判断一条东西属于哪边的标准就是这句话——凡是回答「什么时候」的都不进角色定义。

## 4. 顺序

阶段之间不并行，每个阶段结束时规范与代码一致。

1. **收敛现状（已完成）。**删死代码、合并 checkpoint 词汇、补 `cancelled`、有界收口生效、预算改规范（3.4）、`harness-design.md` 与 `current-status.md` 改到与代码一致。这一步不改外部行为，是后面几步的地基。剩余死代码（`subjectsForSearchHits`、`preferredPaths`、`AgentScope.write.brief`、`env.remove`、`collectObjects`、`run_steering.consumed_at`）**不在这一步删**：前两个是第 3 步要接的线，后面几个各自归属见下。
2. **角色定义归位（3.6，已完成）。**profile 从模型选择键升级为角色定义：`CompiledWriteContext` 补 `systemPrompt`，`delegate` 按 profile 取对应定义，host 的两份 prompt 并入同一编译器。排在意图沉淀之前有一条具体理由——**在 writer 拿不到写作契约的情况下，没法判断「作者又说了一遍」是因为意图没沉淀还是因为委派出去的 writer 根本不知道怎么写**。不先修这个，第 3 步的效果测不准。

3. **意图沉淀。**按第 0 节：补充意图分类，长期的一类由 Agent 写回 `intent/**` 或 Design，经 Checker 进入 Canon；Frame 的 seeds 从结构化意图取，接上 `subjectsForSearchHits` 与 `preferredPaths`。这一步直接改善 A-SOTA，且不依赖模型变强，应排在端口化与存储迁移之前——后两者不改变作者要说几遍话。

调研后这一步比预想的小得多。查清的四条：

- **机制齐备。**`intent` 在 `STORY_ROOTS` 里，`allowedWriter(undefined)` 返回的 `writable` 也包含 `intent/`。桌面对话——steering 实际发生的那条路径——Agent 现在就能写 `intent/**`，commit 与 Checker 也都在。
- **缺的是指示，而且位置很准。**`AGENT_PROMPT` 已经写着「作品的长期事实与已采用结论必须落在 Story Artifact」，但紧接的一句是「运行中的补充**调整当前工作**，保留仍有效的原目标」——总则在，针对补充意图的具体指示反着指。
- **「经作者确认」不是新机制。**它就是作者对 Agent 任何改动给的确认：看得见、可回滚（不变量 5 把作品决策权给了 Agent）。为 intent 单开一道事前审批会与不变量 5 冲突，不做。
- **`write` scope 写不了 intent**（`allowedWriter` 只放行目标正文路径）。不为此放宽权限——`suim run write` 是单 Beat 窄任务，那里收到的长期事实由 Agent 在 summary 里点名，作者自己决定写不写。

于是这一步的实际内容只有一件：**指示**。已实现——`AGENT_PROMPT` 补上分类规则与「丢掉它作者下次还得再说一遍」的理由。按仓库的证据等级它留在「机制」：prompt 改动只能由真实模型验证，faux provider 测不了模型会不会照做。

度量一度被列为第二件，复核后取消：第 5 节要的基线证据已经齐了。steering 原文在 `run_steering`，**是否投递给模型可从 run events 派生**（`TEXT_MESSAGE_START` 的 `metadata.suiming.steeringSequence`，`workspace.run-steering` 已经这么算 `delivered`），写回了什么在 `finish` 的 summary 里。`run_steering.consumed_at` 因此不是「该填的空」，而是**同一事实的第二套真源**——按不变量 3 该删，随第 6 步存储变形一起删，不为它单开一次 SQLite 迁移动作者的真实数据。

seeds 接线（`subjectsForSearchHits` / `preferredPaths`）要等结构化意图真的产生之后才有输入，排在指示与度量之后。
4. **端口化与命令目录。**Runtime 依赖 port（**已完成**：`HarnessProjectPort`，15 个方法加两个属性，harness 对 `local/` 的 import 归零，守卫测试钉住这两条）；命令目录合一，CLI 接到同一条路径（**未做**）。Cloud adapter 跟随同一 port 与契约测试。
5. **git spike（已完成，通过）。**在 eval-022 的作品本体副本（151 文件 / 776 KB）与放大到 69 / 300 / 1000 Beat 的合成规模上实测 isomorphic-git 1.42.2，结论写回 [ADR-0010](../adr/0010-git-as-canon-storage-engine.md)，状态改为 Accepted。

   要点：**增量 commit 与两版本 diff 不随规模增长**——从 151 文件到 1145 文件都是 8–14 ms，而这正是创作路径上反复发生的两个操作。首次全量 `add` 线性增长（1000 Beat 时 3.1 秒），但那是一次性迁移。三方合并正确：同文件不同位置自动合并（22 ms），同一行冲突如实报 `MergeConflictError`（44 ms）。worktree 从 commit 全量物化 39 ms。

   本 ADR 原本把「对纯 JS git 实现的依赖」列为主要技术风险，**不成立**：打进主进程 bundle 只有 233 KB（桌面当前 `main.js` 16 KB，Electron 运行时约 200 MB），11 个传递依赖都是小而稳定的包，无原生扩展，不需要系统 git 二进制。

   `git worktree` 不是必需——Run 隔离沿用现有的文件物化，只改成从 git 对象读。
6. **Canon 存储迁移。**按 3.5 的裁决执行。切片顺序（每片结束时仓库可用、测试全绿）：

   1. git 作品仓的形状与合并策略（**已完成**，随切片 4 落地）：`GitCanonStore.init` 建仓时写 `.gitattributes`，正文 `text/**` 标 `merge=binary`，结构化文件走 git 默认；已存在就不动。它是仓库辅助文件，不进 artifact 快照。
   2. git 支持的 artifact store，与现有 store 跑**同一套契约测试**；此时还不接线（**已完成**）。
   3. `LocalProjectService` 切到新 store（**已完成**）。
   4. 删除 SQLite 里的 Canon 存储（**已完成**）。

   切片 4 实际删掉的是：`artifact_versions`、`change_sets`、`project_revisions`、`revision_artifacts`、`revision_evidence_files` 五张表，`projects.head_revision_id` 一列，以及 `SqliteLocalStore` 上 15 个 Canon 成员。**`artifact_versions` 不是纯残留**——执行对象的字节存在那里，所以 schema v3→v4 把它的列并进 `execution_objects` 自己再删表；在 eval-022 上实测 1299 条执行对象、4 个 Run、480 条事件原样留下。

   **现有作品的一次性迁移改成了 `open` 里的重建。**切片 3 只在副本上验过，作者的 eval-022 与 suiming-new-001 都还停在 v3、没有 git 仓。写一个把 SQLite 版本链回放成 git 提交的 importer，是为作者明说「都是测试数据」的东西付大成本；所以 `open` 遇到「已登记但没有 canon ref」时按当前 checkout 重建创世版本，切换之前的版本链不跟过来。

   原计划里另外两件**查证后取消**：

   - **`sync/` 的文件级合并保留。**它不只服务 Cloud 同步：`suiming-harness.ts` 在 head 移动时用 `mergeOpenStoryFiles` 把 Agent 的候选并到新基线上——那正是散文场景，正是要文件级冲突。而 `.gitattributes` 只管 git 自己的合并驱动，harness 与 sync 都不走 git merge，两者治的不是同一条路径，替代关系不成立。
   - **Cloud 的 artifact 版本存储保留。**Cloud 没有 git 实现，也不在本轮解冻范围内；删掉等于让 Cloud 没有 Canon，而 `packages/cloud-postgres` 是 `apps/api` 与 `apps/worker` 的活代码。本地用 git、Cloud 用 PostgreSQL 是同一个 `CanonStore` 契约的两个实现，不违反不变量 3——它约束的是「每个 Project 只有一个权威」，不是「全局只有一种存储」。
7. **规范定稿（已完成）。**[系统架构](../architecture.md)与 [Harness 设计](../harness-design.md)重写，AGENTS.md 的不变量与工程边界逐条对照代码核实。

   核实的方法是机械的：抽出文档里所有反引号标识符和所有「引号里的测试名」，去源码里对。129 个标识符全部存在；Harness 设计故障验收表（当时第 10 节，现第 14 节）引用的 40 个测试名全部命中真实测试。

   **查出并删掉的不实声称**（写在规范里但代码里不存在）：`rg` 工具（Agent 只有 `search`，背后是纯函数 `searchStoryCandidate`，不调外部二进制）、`pg_trgm` / PostgreSQL 全文搜索后端（Cloud 走同一个函数）、`stateAt(t)` 接口（时点硬状态靠过滤 `StateProjection.changes` 再 `evaluate`，是重放不是增量快照）、能力效果四级分类 `read` / `workspace-write` / `revision-write` / `external`（代码里只有 Cloud 的 `project.read` 等访问能力）、Attempt 的 `superseded` 状态（`AttemptStatus` 没有这个值）。

   **两处说反了的**：①「`packages/sdk` 持有唯一的命令目录，CLI / Fastify / IPC 是生成的传输适配」——实际是三份目录、手写适配，合一的只是共用的 schema 与投影，全量生成刻意不做（3.2）；②「预算覆盖 Agent、Worker、Review、重试和阶段提交」——实际默认无预算，这句只在显式设了预算时成立。两处都改成了如实说法并点名代价。

   **验收表逐行点名测试**，点不到的一行如实写成「没有测试」：「父已取消、子结果迟到」在当前同步委派下不存在这条路径（`executeChild` 在父栈里 `await`，取消由同一个 abort signal 在 task 入口与每个 loop turn 边界生效），开并行委派前要先补。

   还有一条是我自己写规范时新造的不实声称，当场改掉：AGENTS.md 一度写「本地 git 与 Cloud PostgreSQL 跑同一份 `CanonStore` 契约测试」——实际只有 git 在跑，Cloud 走自己的 store 接口与自己的测试。

## 5. 验收

- 每个阶段结束时：`npm run check` 与 `npm test` 全绿，桌面 E2E 与基线一致（当前基线 330 项 / 321 通过 / 9 skip；桌面 17 项 / 15 通过，2 个既有环境失败，原因见[当前状态](../current-status.md)）。
- 规范里每一条声称的架构属性，必须能指到验证它的测试或代码；指不到的要么实现，要么从规范删除。这是本轮的核心验收，不是附加项。
- 迁移前备份并验证作品、revision、evidence、作者选择与修订。开发期旧执行数据可以一次性转写或封存只读。
- 创作行为的对照基线**不存在，且是有意放弃的**（2026-09-12 作者决定）：当前版本有已知缺陷（Writer 契约未接线、预算为空），在其上取基线会把重构风险与修复收益混在一起，分不开。代价是重构后的第一次真实委托没有可比对象，只能作为新基线本身。机械回归仍由 `npm test` 与桌面 E2E 守住；文学质量的回归**本轮无法验证**，这一点不要在验收结论里含糊过去。
- 重构完成后立即跑一次完整真实委托并完整保存过程（Run 序列、补充意图、Review verdict、作者否决），作为此后一切对照的基线。M6 E1「持续 Dataset」的缺口正是这条：`run_steering` 现有 1 条、四个 Run 中三个是冒烟，A-SOTA 要求的「作者否决」证据从未被记录。

## 6. 明确不做

- 不新增 graph engine、workflow engine、向量数据库、CRDT。
- 不解冻 Cloud executor、Cloud Web、生产 identity / 计费、多人协作、全功能 MCP。端口化让 Cloud **可以**接，不等于本轮接。
- 不做 git 分支 / 历史图界面。「试另一个方向」的产品形态是故事层的另一稿，见[作者工作台设计](../web-product-design.md)第 4.4 节。
- 不引入 TanStack AI 的 `/ui` 组件工厂与 MCP Apps，理由与重开触发点见[技术栈](../technology.md)。
- 不重命名 Run / Task / Attempt。它们的英文标识符是通用技术术语；中文表达按[作者工作台设计](../web-product-design.md)用白话，不造对应名词。
