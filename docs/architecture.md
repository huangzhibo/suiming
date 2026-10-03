# 系统架构

本文定义当前架构：模块边界、数据流向、真源与自建范围。2026-09-07 的产品选择见 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md)，执行方向由 [ADR-0012](adr/0012-own-suiming-harness.md) 修订，Canon 存储由 [ADR-0010](adr/0010-git-as-canon-storage-engine.md) 改为 git；具体执行规格见 [Harness 设计](harness-design.md)，完成度与已知缺陷见[当前状态](current-status.md)。

> **本文的纪律：每条架构属性都要能指到验证它的代码或测试。**2026-09-12 的[收敛方案](consolidation-plan.md)第 7 步逐条核对过一次，指不到的已经删掉——包括当时写着但并不存在的 `rg` 工具、`pg_trgm` 搜索后端、`stateAt(t)` 接口、能力效果四级分类，以及「所有界面的请求契约由唯一命令目录生成」。剩下的每条都可以顺着文中点名的标识符查证。这不是文档洁癖：上一轮排查中我们自己按一份写着六阶段的规范去读四阶段的实现，绕了一圈。

## 1. 结论

> **版本化 Story Artifact 保存作品长期记忆；单一 Agent 在作者的 checkout 上用受限文件工具迭代创作；Checker 验证确定性边界；Review 提供可反驳的判断；checkout 的 diff 作为一个 ChangeSet 原子推进 ProjectRevision。**

`suiming` 是唯一产品和代码根。核心产品是 Electron 桌面创作工作台，主进程直接运行 Suiming Runtime，以自有 `SuimingHarness` 执行模型 / 工具循环，通过 `pi-ai` 调用模型。作者也可通过 `suim session send` 和 Codex / Claude Code / Grok 创作；host-native 直接编辑作品目录再由 `suim` 检查提交。Cloud 目前只提供 Canon 存储与显式同步，没有执行；远程运行与 Web 是解冻后的扩展。

managed 执行参考 pi-agent-core 的逻辑自行实现，不依赖、fork 或 vendor 其内核，也不继续评估其他后端。pi-ai 保留为多 provider 调用层。Suiming 直接维护创作所需的执行、交接与恢复；不建设通用 Agent 平台。

| 名称 | 含义 |
| --- | --- |
| Suiming / `suiming` | 产品、主仓与代码命名空间 |
| `suim` | 唯一本地 executable；无子命令打印用法，子命令提供 agent-facing CLI（TUI 已于 2026-09-13 删除） |
| 作品目录 | 一个普通 git 仓库，工作树就是作者和 host agent 直接编辑的 checkout |
| `refs/suiming/canon` | 受保护的 Canon ref，只由过 Checker 的提交推进（`CANON_REF`） |
| `.suiming/` | Local Project 的部署私有状态：SQLite 执行库、内容寻址对象目录、迁移归档。不是作品内容，目录扫描按 private 忽略 |
| `suiming-story` | 旧开发仓与一次性迁移来源，不是当前 Runtime |

## 2. 最简心智模型

```text
作者目标 / 作品 Intent
  ↓
Agent 在 checkout 上读取、修改、自检
  ↓
Agent 按需委派，独立 Review 找问题
  ↓
checkout diff → ChangeSet → Checker → 原子提交
  ↓
ProjectRevision 保存阶段成果 → Agent 继续做下去，或如实说明做到哪了
```

作者目标和 Intent 决定要解决什么；Story Artifact 记录作品是什么；Checker 只核对确定性边界；模型负责搜索、生成与语义判断。人类、host coding agent 和 Suiming Agent 三条路径修改作品的方式相同：改文件，成为候选，经 Checker 后作为一个 ChangeSet 提交。

## 3. 领域边界

| 边界 | 拥有 | 不拥有 |
| --- | --- | --- |
| Story | Story Language、Checker、硬状态重放、Frame 投影、Release 的纯规则 | 网络、数据库、模型调用 |
| Artifact | identity、路径 codec、Canon 存储（git）、ChangeSet 构造、Open Story Directory / Package codec | 故事含义、文学判断 |
| Harness | 单一 SuimingHarness、Agent / 子任务工具、Session / Task、持久事件、模型绑定 | Story Canon、独立的通用 Agent 平台 |
| Product | `suim` CLI、桌面端、Cloud API / SDK、host integrations、同步 | 独立 Story 规则 |
| Eval | Dataset、C 题库、运行绑定、盲评 | 作品真值、单一 LLM verdict |

设计顺序固定为：作品目标 → 能力 → 输入与效果边界 → Runtime service → CLI / IPC / API → 界面。**「Capability」在代码里没有对应的类型或注册表**，它是这条设计顺序的词汇：落地形态是 Agent / Worker 的工具集（`harness/agent.ts`、`harness/tools.ts`）与 `packages/sdk` 的命令目录。写文档时不要把它说成一个运行时构造。

## 4. Story Artifact 与版本

### 4.1 identity 与路径

Artifact 的标识不能混用：

- `namespace` 区分 Target 与每个 `sourceId`；
- Story Language identity 是 namespace 内的 `(kind, localId)`；引用按它写（frontmatter 是 `character: [李牧]`，不是路径），所以跨 Volume 移动不改变 beat id；
- 路径是它在 Open Story Directory 里的位置。**identity 与路径都是事实，一起扫出来一起带着**（`CandidateArtifact.path`），不是一个从另一个推出来的；
- `artifactVersionId` 是**内容寻址**的：`av_` + sha256(mediaType‖contentHash)（`artifact/version-storage.ts`），只由字节和 mediaType 决定，与存到哪里无关。它不进入 Story Language、交换格式，也不在候选上——只有 Cloud 的版本清单（`RevisionArtifact`）带它。

2026-09-14 之前路径是投影的：`pathForIdentity(identity, candidate)` 拿 `outline/story/index.yaml` 反推 StoryBeat 所属的卷。代价是 Checker 拿到的卷号来自它自己推出来的路径，于是 story-outline 里那条「文件所在的卷必须与 index 一致」的规则永远自证通过；真正在拦的是扫描阶段的 `noncanonical_story_path`，而它抛异常而不是产生 Checker 诊断——一个还没写进 index 的新 Beat 文件会让 `status` / `diff` 与 turn 开场一起炸。现在扫描保留真实路径，那条双向规则第一次做实事（诊断给出「加进卷里或删掉文件」两条出路），`noncanonical_story_path` 与 `path_projection_mismatch` 两道重复的闸删掉。**换卷因此是两步：改 index 加 mv 文件。**顺序只有 index 能表达（eval-022 第一卷是 1 68 2 3 4 5 69 6 7），路径可信只有 mv 能保证。

`pathForIdentity` 保留下来，但它现在是**在候选里查表**：只有解析 Story Language 的引用（手上只有 kind + localId）才需要它，引用可能指向不存在的 artifact，所以查不到就抛。手上已经有 artifact 时直接读 `artifact.path`。

`artifactVersionId` 看着像存储行 id，其实不是——这一点 2026-09-12 判错过两次。它现在的用途只剩 Cloud PostgreSQL 的内容寻址存储 key（`artifact_versions`）；本地 git 不用它。派生层比较文件是否变化用的是 `CanonStore.fileDigests`（git 实现是 blob oid），只要求同一实现内可比较。

未修改 artifact 经导入再导出保持原始字节；修改只重新序列化被修改的 artifact。一个事实只由拥有它的 artifact 表达，人物轨迹、关系反向边、Contract 生命周期、时间线、影响图都从明确 revision 派生，不能独立编辑。

### 4.2 两种 Commit

- `ProjectRevision` 是基础设施版本：**一个 git commit**，id 就是 commit sha，快照就是它的 tree，history 就是 canon ref 的祖先链。它允许尚未闭合的 StoryContract，用来保存合法的工作进度。类型上只有 `{id, parentId}`——版本里有哪些文件要读快照；逐 artifact 清单是 Cloud 自己的需要（它的对象存储按 `artifactVersionId` 取内容），不进共享的版本身份。为了填那份清单，git store 曾经把每个 revision 的整棵 tree 连字节读出来：eval-022 的 121 文件 / 21 版本，未走缓存的 `history()` 234 ms，瘦身后 5 ms。
- 没有第二种 Commit。DesignCommit 与 StoryText lineage 在 2026-09-13 删除（[evidence 派生设计](derived-evidence-design.md)）：正文的 Design 时效由 `artifact/derived.ts` 从历史派生——`writtenAt(path)` 是该路径最后一次变化的 revision，比较那个 revision 与 head 下 Beat 的 Design 闭包（`designClosurePaths`，即 Frame 给 Writer 的那一套）的 `fileDigests`，没变是 `current`，变了是 `design-changed` 并列出变过的文件。Design 重开不删除正文，只让受影响的正文变黄；Release 只接受每篇正文都 `current`。

### 4.3 Canon 是 git，候选是普通 commit

作品目录本身是 git 仓库（`artifact/git-canon-store.ts`）。**任何人都可以在里面 commit——那是候选**；`suim commit` 跑完 Checker 才推进受保护的 `refs/suiming/canon`。门禁仍是结构性的：普通 commit 再多也进不了 Canon。作者当然可以 `git update-ref` 手动搬 ref 绕过去，但那与直接改 `.suiming` 里的数据库是同一级别的动作，不是新增的弱化。

Checker 只在 promote 时跑。候选 commit 按定义就是未检查的，这正是「候选」的意思；要在候选时也跑就得往作者的仓库里装 git hook——那是第二套机制、可绕过、且侵入作者的仓库，`suim check` 已经在那里。

ChangeSet 只从 diff 构造：人类、host agent 与 Suiming Agent 改的是同一个 checkout，`commit` 扫描实际文件、按 identity 计算候选、运行 Checker、原子推进 canon ref。没有第二种提交方式，也没有 `rename` 操作：identity 变了就是 delete 加 create，Checker 的引用检查兜底，Beat id 本身不可变（`artifact.test.ts`「identity 改名表现为 delete 加 create；未同步确定性引用时不能提交」）。**同一 identity 换了路径是 `replace`**——2026-09-14 起路径是扫描得到的事实而不是从 `index.yaml` 反推的投影，Beat 换卷因此是改 index 加 `mv` 两步，只做一半由 Checker 双向报出（`artifact.test.ts`「StoryBeat 换卷是两步：改 index 加移动文件；只改一半由 Checker 拒绝」、`local-project-service.test.ts`「host 换卷是改 index 加 mv 两步，diff 里两个 artifact 都算改过」）。验证失败不产生部分写入。基线陈旧的 ChangeSet 被 `change_set_stale` 拒绝，不静默覆盖（`canon-store-contract.ts`）。本地提交没有合并步骤——只有一份候选，就不存在两份候选要 rebase；`mergeOpenStoryFiles` 只在 Cloud 同步里用。回退是一个新 ChangeSet，不删除历史。

**三方合并刻意停在文件级。**git 默认是内容级（diff3），同一文件不同位置会自动合并。对散文这是风险不是升级：两侧各改一章的不同段落，git 合出来的那一版**谁都没写过**，而 Checker 只验结构与硬状态，验不了散文的连贯。规则是：内容级自动合并只用在 Checker 能验证结果的文件上。落地分两处——Runtime 自己的合并只剩 Cloud 同步一处，用文件级的 `mergeOpenStoryFiles`（本地提交没有合并步骤，见上）；作者自己在仓里 `git merge` 时由建仓写入的 `.gitattributes` 约束，`text/**` 标 `merge=binary`。两者治的不是同一条路径，不能互相替代。

### 4.4 审稿、笔记与派生状态

没有 evidence 层。审稿是 `review/<id>.md`、读材料的笔记是 `source/<id>/notes/<n>.md`，都是普通 Story artifact，走同一条 diff → ChangeSet → Checker 路径进版本；Checker 只查它们的形状（`packages/story` 的 `review-file.ts` / `source-note.ts`）。「这份审稿对当前稿还算不算数」「材料读到哪了」「能不能发布」都是 `artifact/derived.ts` 按需从历史算的投影，不落盘：`reviewCurrency` 拿审稿 frontmatter 里的 `subjects`（审的时候每个主体文件的内容摘要）与当前候选的同一批路径比，摘要不同、文件没了、或者审稿之后才成为主体的文件（新写的正文、新加的 Design）都让它 stale，不看历史；`revision`（引擎 Reviewer 写 `candidate`）只是展示标签（`derived.test.ts`「审稿时效比的是审的时候主体文件的摘要，不是审稿进版本的时间」）；`sourceCoverage` 取 `material_sha256` 等于当前材料的笔记的 span 并集；`releaseReadiness` 要求正文完整、全部 `current`、有一份 `current` 的全书正文审稿。

判定逐条按路径进行，无关修改不让整批失效（`local-project-regressions.test.ts`「host 修改一章正文只让审查该章的审稿失效」）。stale Release 只是不能发布，不阻塞作品继续提交（同文件「发布 Release 后 host 修改正文仍能提交」）。派生层只依赖 `RevisionHistoryReader`（`history` / `fileDigests` / `snapshot`），Local 由 git 实现，Cloud 的 `CanonStore` 用两个 snapshot 的 hash 表相减是同一份代码（`derived.test.ts` 用一串快照冒充历史）。

portable package 是导入导出格式，不是运行时持久化载体：Open Story Package 是没有历史的快照，导入即一次提交，此后时效从导入版本起算；导入必须重新解析、核对 hash、运行 Checker，不信任包内的成功声明。本地 Open Story Directory 本身是 git 仓，历史随 clone / bundle 走。

### 4.5 Open Story Directory

Story Artifact、Open Story Directory、Open Story Package、repository-native project 描述同一作品的不同粒度，共用一个 path codec。目录扫描只接受 codec 识别的逻辑路径，排除 `.suiming`、`.git`、仓库辅助文件与临时文件，拒绝越出 project root 的 symlink 与路径穿越；Story Language 保留路径下的未知文件报错而不是静默丢弃。顶层的非保留项（`.gitattributes`、`README` 等）归为 `repository-auxiliary`，可以和作品共存但不进快照。Runtime 只实现当前格式，不读旧 `.suim`，不提供 legacy importer；验证门之前 Story Language 保持不稳定，开发期数据直接重写。

## 5. Story 内核

Markdown 主体承载完整因果设计；frontmatter 只保存路由与稀疏硬状态。Checker 累积全部诊断而不是首错即停。它验证 schema、identity、引用、顺序、Contract 结构生命周期、硬状态重放、StoryText 完整性与 exact 片段，并补上对长程一致性关键的确定性检查：正文提到但 `refs` 未引用的人物、已死人物再次进入 refs、Contract subjects 不在其 open / resolve Beat 的 refs、未先声明就 `revealed` 的 secret。世界可达性只是 warning，不阻塞「先写设定再写 Beat」的正常顺序。

硬状态 IR 以 `(scope, subject, property)` 为键，只表达后文不能容忍误判的少量边界；`character` 与 `reader` scope 只承载 `secret.revealed` 并可被读取，这是知情边界与读者视角的确定性基础。

「某个时点的硬状态」**靠重放得到，没有增量快照结构**：`StateProjection` 是 `initial` 加一串按 Beat 排序的 `changes`（`story/src/ir/types.ts`），查询 t 时点就是把晚于 t 的 `changes` 过滤掉再 `evaluate`（`harness/design-view-context.ts`）。规模上限因此是「重放到 t」而不是「重放全书」，但对靠后的 t 两者相同。真要做增量快照时，`StateProjection` 的形状已经够用，不需要新实体。

Checker 不从自然语言发明 Canon，也不证明该投影的状态没有遗漏；人物动机、关系、主题、伏笔与自然语言是否支持投影，由模型 Review 判断。

## 6. Harness

### 6.1 一个引擎，持续 Agent 与原子能力

`SuimingHarness` 是唯一执行实现。参考 pi 的持久决定、工具结果确认与恢复方式，用本项目状态和存储自行实现 loop；pi-ai 复用多 provider 调用、消息、工具声明与流式响应。Context、领域工具、父子交接、控制和作品事务接入均由 Suiming 维护，不新增 pi Session / Lane / Operation 或第二状态库。具体状态、模块和故障验收见 [Harness 设计](harness-design.md)。

Agent 的动作覆盖发现与 Context、Source、Design、正文、检查、Review 与提交；Release 不是 Agent 的工具，由 `suim release publish` 生成。写作方法（`STORY_TEXT_METHOD`）是可选方法而不是状态机：Agent 可以直接写作或委派，不强制先 brief 再 Writer、先 authoring 再 Review 再 resolution。独立 Review 仍要求隔离 Context 和准确被审版本。

一个 Session 就是一个根 Agent；普通工具调用不新建 Task，需要独立工作目标或 Context 时才创建子 Task。**委派基本是串行的**：`executeChild` 以父动作 id 作为子 Task 的 `key` 同步 `await`，没有并发调度器。唯一的并行是同一次回复里委派的多个 `source-reader`（各写各的笔记），由 `runTaskLoop` 按工具声明的 `parallel` 一起推进、按派出顺序交付，边界见 [Harness 设计](harness-design.md)第 9 节。所有任务复用一个 loop 和同一引擎，不新增 per-capability service、coordinator 或 executor。

**计划不是实体**：`plan` / `execute_task` 与显式任务图随 Slice 1 删除，模型要分步就在消息里分步，不再有一份系统维护的计划要核对依赖环与剩余交付。留下的是父子委派与结果依赖分开——子任务不等待尚未结束的父 Agent，已完成历史不重写。实际读取、执行依赖和可能的故事影响分别表达；不引入第二套状态库或有效性规则。详细取舍见 [Graph Engineering 研究](graph-engineering-assessment.md)（写于 2026-09-12，文中把 `plan` / `execute_task` 写成「已经在做」，它们次日已删）。

Design / Write / Source / Review 不再是带权限预设的入口，只是桌面与 CLI 发出的消息模板（[Harness 设计](harness-design.md)第 6 节「scope 去掉」）；写入范围只随委派的 profile 收窄。固定调度职责和按位置恢复已删除，保留领域检查、独立输入和 Eval rank 协议。

### 6.2 候选与工具

**Agent 直接在作者的 checkout 上工作，没有 per-session worktree**（2026-09-13，[Harness 设计](harness-design.md)第 3 节）。作者、host agent 与 Suiming Agent 因此只有一份候选、一份 diff、一条提交路径：`project.diff` 里看到的就是三方改动的合集，`commit` 把它整个推进 Canon。上一版每个 Run materialize 一份 worktree（`.suiming/worktrees/<runId>/`），配套的三方合并、`run_merge_conflict`、`run.diff` 与基线推进一起删除。要并行跑多个 session 时再给 session 配可选工作目录，接口位置是 `HarnessSession.checkoutPath`；v1 不做，所以同一 Project 同一时刻只有一个 `running` session。

Agent 与子任务只拥有限制在 checkout 根内的工具，清单与每个工具的重放策略只在 [Harness 设计](harness-design.md)第 6 节维护一份（代码在 `harness/tools.ts`、`harness/source-tools.ts`、`harness/agent.ts`）。`.git`、`.suiming` 与 host 接入目录（`.agents` / `.claude` / `.codex` / `.grok`）由 `ConfinedExecutionEnv` 挡在读写之外，其余整个 checkout 可写，是不是作品文件由 codec 与 Checker 在 `commit` 判。**没有 shell，也没有 `rg`**——`search` 背后是纯函数 `searchStoryCandidate`，不调用任何外部二进制（`confined-env.test.ts`「受限环境：路径逃逸、symlink 与只读策略都被拒绝，没有 shell」）。**子任务拿不到 `commit`，也不能再委派**，它的交付出口只有 `submit_task`。可修复的工具 / 领域错误作为反馈；持久化失败或 owner 失效立即停止推进，`stopReason === "length"` 单独处理。

候选不是 Canon。每次阶段提交扫描相对 head 的 diff，内部构造一个 ChangeSet，走与作者的「提交」按钮、host 的 `suim commit` 完全相同的 `commitCheckout`——Agent 只多一个 commandId 回执，用于崩溃后按回执认领已完成的提交。成功后 session 基线推到新版本，同一 turn 可以继续工作；一次提交不会自动结束这一轮。提交与恢复以 receipt 和 checkout journal 核对实际效果，不能因工具回复缺失重复 edit 或 commit。

作者与 Agent 改同一文件时，冲突在动作发生的当下解决，不攒到提交：Agent 的 `edit` 在 prepare 阶段读当前内容，`oldText` 对不上就是可修复的工具错误、模型重读再改（`agent.test.ts`「作者与 Agent 改同一文件：edit 以 checkout 当前内容为准」）；作者在编辑器保存走 `workspace.file.save` 的 `expectedSHA`，文件被 Agent 改过就报冲突并保留外部修改（`workspace.test.ts`「编辑 CAS 保留外部修改」）。作者未提交的修改会随 Agent 的下一次 `commit` 一起进版本，这是「一份候选」的直接后果（`agent.test.ts`「作者与 Agent 共用一份候选」、`cli.test.ts`「作者未提交的修改与 Agent 的改动是同一份候选」）。

### 6.3 Context 与 Frame

Context 由四个维度决定：语义层（Source、Design、StoryText）、观察入口（Book、Volume、Beat、Character、读者、Contract、Place、Resource）、时间边界、证据边界。它们形式化为纯函数 `Frame(layer, camera, t, evidence)`：`t` 只使用 StoryBeat 展示顺序，系统不维护故事内年代；Frame 只投影确定性事实，包括在场、`refs` 闭包、重放到 `t` 的硬状态、人物与读者的知情、Contract 生命周期、真实前文；人物此刻相信什么是模型推断，不是 Frame 的字段。

Frame 决定每次 loop 的初始 Context，模型在 loop 中用只读工具按需补读。模型实际输入不再作为作品的 evidence 保存（按次 ContextSnapshot 已删），只留在执行对象里供调试。Frame 同时是桌面端的渲染单元，作者看到的人物证据与模型读到的来自同一实现。

角色读取边界由具体任务契约决定：Agent 在 checkout 上渐进发现；独立 Reviewer 在指定审查域内补查；采用隔离 Writer 时防止无关父会话影响，Source Reader 不被 Target 创作目标污染。作者打开同一视图不等于模型读过它。

Story Search 是正式的发现能力，也是**唯一的搜索函数**：Agent 的 `search` 工具与 CLI `search` 都调 `searchStoryCandidate`（`artifact/story-search.ts`）。它在候选的解码文本上做结构导航、精确文本与中文双字片段匹配（超过两字的汉字段落会拆成相邻二元组），命中结果定位到原始 artifact 与原文范围，排序和摘要是可删除派生值。**没有 `rg`，也没有 PostgreSQL 全文 / `pg_trgm` 后端**：Cloud 走同一个函数。语义检索只有经中文长篇消融证明收益后才进默认路径。

### 6.4 执行状态与恢复

**只剩两种实体**（2026-09-13，Slice 1）：`Session` 是根 Agent——一份连续的消息列表，加进程 lease、当前模型绑定与累计用量，作者第一条消息时创建、作者删除才结束，可阶段提交多个 ProjectRevision；`Task` 是有目标和输入契约的子智能体。`Conversation` / `Run` / `Attempt` 三层删除，turn（作者一条消息到模型停下）不是实体。暂停、进程重启与网络重试都续同一份消息列表，checkpoint 只有一份；改变目标 / 输入契约另建 Task。

调用前保存决定与预期输入；子结果校验、写入执行对象并确认完成后，父调用才消费。检查点区分父等待、子完成、结果交还与后续动作确认。大正文与报告通过引用回读（`read_result`），不让主模型转录完整结果。执行消息复用 pi-ai 类型并保存在现有执行存储，Langfuse 和 UI transcript 不承担恢复真源。

Local SQLite 与 Cloud PostgreSQL 使用版本检查、幂等 command receipt 与各自 owner / lease 边界；Local 接管以每次领取的唯一 ownerId 作 fencing，Cloud 使用自己的 lease，拒绝旧 owner 的迟到确认（`local-project-regressions.test.ts`「执行状态按行保存：另一进程新增的 session 不被抹掉，版本落后的写入报告冲突」）。作品事务与对应 receipt 同事务确认，文件系统用 journal 恢复。外部模型请求在崩溃时可能结果未知，不承诺 exactly-once。Local 自有 Harness 已按消息、动作和父子结果恢复；Cloud host 继续冻结，不能把 Local 故障验收记为 Cloud 引擎验收。

Session 只有 idle / running / paused 三态。**turn 结束不表示作者的目标达成**——模型一次响应里没有工具调用，turn 就结束回 idle，达成与否由作者看作品定，系统不替他判断；未提交的候选留在 checkout 等下一轮，Agent 在回复里说明哪些改了还没提交，采用的长期结论写回作品或在 summary 里点名。只有三种结果未知的情况停在 paused 等作者（`model_call_unknown` / `action_effect_unknown` / `binding_mismatch`），其余都回 idle 加一句原因，再发一条消息就继续。作者消息经持久 inbox 进入消息列表，**取到第几条记在 `SessionRecord.inboxSequence` 上**，不另存一份「已消费」标记。提交 fence 只覆盖单次事务，不能使后续 turn 永久失去中断能力。

**每个 turn 冻结实际 provider、model、参数、prompt 与工具声明**（`taskLoopBinding`），换绑只在没有未决副作用的 turn 边界发生。模型按显式 profile 选择；宪法以版本化 prompt 进入调用。创作路径没有预算，只记用量，见 [Harness 设计](harness-design.md)第 10 节。

### 6.5 唯一界面事件契约

对外事件是 AG-UI 标准消息、工具与交互事件加类型化 Suiming 扩展（`SessionEventBody = AGUIEvent`，`sdk/src/run-event.ts`）；作品版本通知和持久运行状态通过扩展表达。旧 RunEvent 词汇由此替换，不保留 RunEvent → AG-UI 双协议日志或投影服务——**`SessionEvent` 这个名字只表示持久传输信封**，不是第二套事件词汇。产品事件直接从自有 Harness 的持久确认点产生，不保存 pi 事件日志。

事件持久化并带 Session 内单调序号（Cloud 的事件存储已随执行 adapter 删除，现在只有 Local）；消息可短批保存，但必须先持久化再发布（`run-event-stream.test.ts`「事件先保存再发布」「事件保存失败后不发布、不给后续事件放行」）。状态与事件需原子确认，或能从同一 checkpoint 幂等补发（`workspace.test.ts`「状态与产品事件原子确认：事件 INSERT 失败时 turn 不会先收口」）。subscription、IPC 只是传输，作品、完整 diff 与 ProjectRevision 始终走 Runtime / Domain API 回读。

发消息、打断与恢复走命令目录；attach 只读已有执行，首次返回对外消息快照，之后按 `afterSequence` 补缺失事件（桌面 IPC 是 `local-workspace.ts` 的 `session.attach`，CLI 是 `suim session events --after`）。断线和 renderer 重载只解除订阅，不中断 turn、不新开 turn。**AG-UI 的 threadId 就是 sessionId、runId 就是 turn id**，二者稳定关联但不混同；协议结束不是作品完成。

## 7. Checker、Review 与 Eval

| 数据 | 真源 | 作用 | 不能承担 |
| --- | --- | --- | --- |
| 持久执行 | Local SQLite | Session、Task、inbox、持久事件与恢复所需消息 / 结果、权威 usage | 通用调用分析、质量结论 |
| 调用观测 | OpenTelemetry，Langfuse 可选 | Prompt、响应、tool、延迟、token、错误 | 任务恢复、Story Canon |
| 质量学习 | Suiming Eval | C 题库、Dataset、候选偏好、盲评 | 在线调度、单一 LLM verdict |

三者以 `sessionId / turn id / taskId / traceId / ProjectRevision` 关联，不互相镜像。观测后端不可用时任务仍须正确完成（`telemetry.test.ts`「观测 flush / shutdown 超时和故障均不抛回业务」）。

Review 使用独立 Task、独立 Context 与 `reviewer` profile，不强制不同厂商；模型只返回 ReviewDraft，`submit_review` 校验 schema、范围与每条引文逐字出自被审文件（Source 审稿也可以引原作）后写成 `review/<id>.md`，随下一次 commit 进版本；意见锚定实际路径，可被 Agent 反驳。同一候选不通过重复采样追求 pass；发现问题后由 Agent 修订，再决定是否建立新 Task，不建立无界回边。

正式 Eval 不能先于可信样本：先用真实长篇暴露失败，从失败中抽取确定性长程题作为 C 的最低证据，R 的强基线是同模型、同 Intent 的整书或逐章直写。策略、Context、模型路由的改进走固定输入的 paired eval，达标晋级、可回退；生成模型不能裁决自己的晋级，宪法与作者 Intent 不被运行反馈自动改写。

## 8. 产品与入口

```text
Codex / Claude Code / Grok + Skill → 编辑 Open Story Directory → suim --json check / commit
suim session send                 → 进程内 SuimingHarness → checkout → 提交
桌面端（核心产品）                  → Electron 主进程内 Runtime，typed IPC 承载命令与事件
suim cloud *                      → Cloud SDK → Domain API
Cloud Web（可选扩展，冻结）          → Domain API + 同一事件契约的 SSE
```

- **命令目录现在是三份，不是一份，也不是自动生成的**：`SUIM_CLI_COMMANDS`（CLI 与三个 host）、`LOCAL_COMMANDS`（桌面 IPC）、`DOMAIN_API_ROUTES`（Cloud HTTP）。已经收敛的是它们共用的东西——领域对象 schema 只在 `sdk/src/domain-schema.ts` 定义一次，Session 摘要 / 作品状态 / Checker 结果 / revision 摘要各只有一份投影，同名命令只允许一份 payload。全量改名与传输适配的自动生成**刻意不做**，因为三个传输各有生成不出来的元数据（HTTP 的 method / path / capability / idempotency，CLI 的选项与退出码类别），理由见[收敛方案](consolidation-plan.md) 3.2。作品查询用 TanStack Query，消息交互用 TanStack AI client / ai-react；客户端 loading、stop、retry 不决定后台 Session 生命周期。
- `suim` 是唯一 executable。无子命令打印用法；`session send` 开一个 turn 并可用 `--events` 流式输出统一事件；其余命令非交互，输出前按目录校验，exit code 从错误类别派生（`sdk/src/error-category.ts` 的正则规则加少量 override，不是手抄表）。CLI 只调用 Runtime service，不直操 store。
- 开工用 `init [path] --agent <host>`，维护接入用 `update`（发现全部已安装 host）或 `update --agent <host>`（补接或指定刷新），不暴露内部 project ID。`update` 要求作品已初始化，只更新辅助文件并保留作者模型配置；CLI 与桌面的补写结构、首次登记和失败清理共用 `LocalProjectService.initWithStarter`。见 [ADR-0013](adr/0013-cli-init-and-update.md)。
- host-native 模式使用 host 自己的模型与工具，文件修改只是 dirty candidate，不伪装成 Suiming Session。它与 Suiming Agent 改的是同一份候选，没有交接机制：作品锁只锁 open 与 commit，两边同时大改同一部作品会互相覆盖，所以不要并行跑（[Harness 设计](harness-design.md)第 6 节）。Skill 只解释读取顺序、Story Language 与 CLI contract，安装检查与命令表对账。
- 桌面端按[作者工作台设计](web-product-design.md)交付阅读、直接编辑、diff、证据联动与运行控制。Runtime、凭据与 session owner 在 Electron 主进程，renderer 只经有限 preload / typed IPC 访问；关闭创作窗口可保留主进程，明确退出则保存恢复点并有界结束，重开继续同一 Session。
- running 的 Session 持有进程 lease（ownerId + pid + hostname）；`LocalProjectService.open` 只收敛持有者已死的 Session，第二个窗口或 CLI 不创建重复 Agent。`session send` 复用持久 inbox 并按 commandId 幂等，重发同一命令只拿回原回执。
- 派生视图中的编辑必须转换回拥有该事实的原始 artifact，再经同一 ChangeSet 验证。默认自主模式允许 Agent 提交可回退 revision，不设逐项接受门；外部不可逆动作、权限升级与高额成本另行授权。

## 9. Cloud 与显式同步

**Cloud 保留自己的 Canon 存储。**PostgreSQL 保存 Project、ArtifactVersion 与 ProjectRevision，S3-compatible 对象存储保存大对象，写入顺序是先对象后事务。本地改用 git 没有波及它：Cloud 没有 git 实现，也不在本轮解冻范围内，而 `packages/cloud-postgres` 是 `apps/api` 的活代码。两者是同一套领域语义的两个实现——不变量 3 约束的是「每个 Project 只有一个权威」，不是「全局只有一种存储」；将来若要给 Cloud 也换 git，它跑的是同一份 `CanonStore` 契约测试。

单 actor 部署，没有成员与角色模型。Cloud 解冻后的 host 领取或接管 session owner，materialize 一份 checkout，由同一 SuimingHarness 推进；lease 过期后从原 checkpoint 核对恢复。Cloud 引擎 host 尚未实现：执行 adapter 与 `apps/worker` 已于 2026-09-13 随 Slice 1 删除（migration 004），解冻时的接口位置是 Runtime 的 `HarnessProjectPort`，不是今天这份 PG schema。Cloud 服务端永远重新解析、核对 hash、运行 Checker 并验证 baseRevision，不信任客户端的成功声明。

Local 与 Cloud Project 拥有独立 revision identity，不后台双写。同步通过 Cloud SDK 与 Domain API 显式执行：`checkout` 从明确 Cloud revision 建立标准 Local Project；`import` 创建独立 Cloud Project；`link` 只在内容证据匹配时建立包外 remote binding；`status` 比较同步基线、本地 revision、Cloud head 与 dirty checkout；`push / pull` 只移动已提交内容并重新验证；`unlink` 不删除任一侧数据。同一 artifact 两侧修改、引用失效或语义无法确定时报告 conflict，不用时间戳或 last-write-wins。remote binding 保存在 `.suiming`，凭据在用户级配置或 OS credential store，本地 SQLite、缓存与 trace 不上传。

Cloud 按 ADR-0008 冻结投入；引擎迁移必须触及的部分随迁移修改，其余简化在 Cloud 恢复投入时执行。当前状态：执行 adapter、run-event store 与 SSE 已于 2026-09-13 随 Slice 1 删除，Cloud 只剩数据面（Project、revision）与显式同步。

## 10. 存储与安全

- **Local Canon：作品目录的 git 仓**，`refs/suiming/canon` 是权威；revision = commit，快照 = tree，history = 祖先链。提交回执写成 commit message 的 `Suiming-Command-Id` / `Suiming-Fingerprint` trailer，崩溃后按 commandId 核对。
- **Local 执行：`.suiming/local.sqlite`**，只存执行数据与部署登记——Session / Task、持久事件、inbox、命令回执、执行对象、「哪个目录是哪个 Project」和 remote binding。**它不再持有 Canon**（schema v4 删掉了作品版本的五张表与 `projects.head_revision_id`）。大执行对象的字节进 `.suiming/objects` 的 content-addressed 目录；`.suiming/worktrees` 随 per-session worktree 一起删除。库只认 schema v6，旧版本不再升级（2026-10-02 删掉 v1→v6 的迁移链）：旧执行数据本来就不迁，把旧库挪走重新 init 即接上 git 里的版本链。
- Cloud：PostgreSQL 与 S3-compatible 对象存储承担同等语义。
- 模型凭据只有一条路：pi-ai 的 `Models.login(provider, type, interaction)`，API key 与 OAuth 都走它，凭据只落在用户级 credential store 或环境变量，配置只保存非敏感路由，renderer 不读取 secret。认证按实际 provider 能力处理，不按订阅标签拒绝 automation；未验证的登录方式不标为支持。
- 执行点重新检查项目边界、baseRevision 与成本策略，不依赖模型自觉遵守；模型与 trace 默认脱敏。

## 11. 代码形态

```text
apps/{api,cli,desktop,web}
packages/{story,runtime,sdk,cloud-postgres,cloud-s3}
integrations/{codex,claude-code,grok}
```

目录树和命名已经说明了大部分结构，这里只写从中读不出来的形状：

- `packages/story` 不依赖网络、数据库、模型 provider 或 UI（`scripts/check-story-isolation.mjs` 强制）。
- `packages/runtime` 是 deployment-neutral 的共享实现。这句话 2026-09-12 之前**不成立**——`SuimingHarnessOptions.project` 的类型曾是具体类 `LocalProjectService`，那才是 Cloud 接不进来的直接原因。现在它依赖 `HarnessProjectPort`，`harness/` 对 `local/` 的 import 归零，由 `project-port.test.ts` 钉住。Local 与 Cloud 只替换 store、传输与 owner 领取 adapter，不得为部署复制引擎或领域能力。
- `packages/cloud-postgres` / `packages/cloud-s3` 依赖 Runtime port；数据库 driver、migration runner 与 PostgreSQL transaction 实现不得反向进入 `packages/runtime`。
- `apps/desktop` 是主进程（Runtime、凭据、session owner），`apps/web` 是它的 renderer，也留给后续 Cloud Web 复用。
- `packages/eval` 在 M6 有真实 Dataset 后才创建，现在不存在。
- `integrations/*` 是共用一份 Skill 的薄安装入口，内容由 `npm run generate:host-files` 生成进 `apps/cli/src/host-files.ts`。

技术选择与暂不引入的清单见[技术栈](technology.md)。
