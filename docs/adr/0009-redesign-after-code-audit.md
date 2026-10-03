# ADR-0009：代码审计后的重新设计

> 最新执行决策见 [ADR-0012](0012-own-suiming-harness.md)：参考 pi 逻辑自行实现 SuimingHarness，继续依赖 pi-ai；本文有关 pi-agent-core 内循环的条款保留为历史。

- 状态：Amended by [ADR-0011](0011-desktop-product-and-autonomous-runtime.md)
- 日期：2026-09-04
- 决策者：项目负责人

> 2026-09-07：本文保留当时决策。桌面核心产品、持续 Agent、原子 Capability、事件与凭据边界的后续修订见 [ADR-0011](0011-desktop-product-and-autonomous-runtime.md)；当前规范以需求、架构和技术栈为准。

## 背景

ADR-0008 基于文档审核和少量代码抽查。本 ADR 基于对全部源码的分模块审计：Story 内核、Artifact 与执行状态、Agent 与模型层、Cloud 与同步、CLI 与 TUI，每项结论都有 `文件:行号` 证据，两个关键缺陷有可运行的复现脚本。之前的实现由 Codex 在 4 天内完成，机制测试 219 项通过，但审计发现它在四个层面上偏离了产品目标。

### 已复现的缺陷

1. **发布后无法提交。** 作者在 `release publish` 之后修改任意一章正文，`suim commit` 抛 `local_store_corrupt`。原因是 `exportPortableStoryPackage` 把 stale 的 Release 静默剔除，`#evidenceForCheckoutCommit` 再按文件集合比对失败。除非手删 `release/`，作品无法继续。
2. **局部修改导致全部 lineage 丢失。** 作者修改一个地点文件，`#carryPortableEvidence` 对整包 evidence 做 all-or-nothing 校验，失败即全部丢弃，所有章节 lineage 变为 `unbound`。`local-project-service.test.ts` 把这个行为固化为预期。这直接击穿了"Design 变化只让受影响正文 possibly-incompatible"的设计意图。
3. **双进程互相抹除执行状态。** `LocalProjectService.open` 在 `finally` 中立即释放 project lock，锁只覆盖 commit；`saveExecutionState` 是无版本校验的 `DELETE` 全表加重插。两个进程各持启动时的快照，后写者抹掉前者的 Run 记录。
4. **崩溃窗口无自愈。** `commitCheckout` 在数据库提交后、journal 写入前崩溃且本次触及 StoryText 时，磁盘上 story 等于 head、evidence 等于 parent，恢复逻辑只识别"checkout 等于 parent"，之后所有命令抛 `portable_evidence_checkout_changed`。

### 结构性问题

**Story 内核。** bind、compile、evaluate 首错即 throw，整本书只出一条诊断，几百 Beat 无人值守时每轮只能修一个错。`enforceWorldReachability` 默认开、refs 缺失即失败，"先写设定再写 Beat"的正常顺序无法 bind。`secret:` 没有 identity 文件，拼写漂移静默造出两个秘密。`changes.character` 编译进 IR 但 `validateBatch` 只对 `world` scope 施规则，知情边界只写不读。refs 遗漏、已死人物出现在后续 refs、Contract subjects 不在 open / resolve Beat 的 refs 里，这些纯确定性检查都没做。`throughStoryBeatId` 只裁评估，bind 仍跑全书；StoryCommit schema 没有 `through`。`checkerVersion` 是 Literal，改一条规则历史 commit 全不可读。零外部引用的死代码一批。测试只有一个 2 Beat fixture，holder 链转移、终止清空、through、规模样本全无。

**Artifact 与执行状态。** 内存 Workspace 的 `candidateVersion` 乐观并发只防"同一内存对象的并发写"，本地只有一个写者。evidence 以 portable 包整包 import / export 作为唯一持久化格式，每次 open 和 commit 都整包重导入、拓扑恢复、`inspectRelease`，并引出上面两个 bug。StoryText lineage 以会话内临时 `av_` id 为键，靠 manifest 按 sha 转译。五个 `local/*-run-service.ts` 两两约 85% 行相同。本地的"恢复"全部是 fail 旧 Run 后从输入对象重跑，recovery point 只写不读。command receipt 在本地每个 commandId 都含新 runId，从不命中，却随每次 persist 全量重写并无限增长。三份 diff 算法、六份 sha256 / utf8 小工具。stale 判定用错误码字符串白名单区分"stale"与"真错误"，新增错误码会中断整次 commit；lineage 兼容按 Design 内容比较，Review 却按 StoryCommit id 比较，重新 freeze 相同 Design 会让全部正文审稿 stale。

**Agent 与模型层。** Agent 三个 phase 各全量渲染一次 Design。Reviewer 只拿候选和目标，看不到 base 和 diff，却要判断"是否忠实完成目标"。Agent 看不到 Intent 引用的 style evidence，StoryText Reviewer 反而能看。system prompt 各一句，没有宪法。`replace` 必须回传整文件。Extractor 要模型一次输出整本 IR，`expectedToolCall` 不区分 `stopReason === "length"`。Source Reviewer 的分片顺序是先材料后 extraction，shard 几乎不会同时含两侧，prompt 却要求两侧齐全才出 finding，等于结构上没有召回。只有 Agent 有 bounded repair，其余四个 agent 一次 regex 失误整体失败且无 resume。没有 Run 成本累计，usage 只进 span。`config.ts` 与 `user-config.ts` 两套环境解析，生产只用后者；手写 167 行 TOML 子集 parser。

**Cloud。** 没有通用"root Task 发现、DAG 推进"抽象，两个 coordinator 各自重写约 200 行同形代码，四个 executor 各复制 interrupted、knownFailure、输入哈希校验。PostgreSQL 执行存储是"整个 project 执行态读入、内存重放、整体 upsert"的镜像设计，每次心跳删除并重插全部 lease 和 dependency，Agent 每 250 毫秒全量加载；SQL 选任务与内存重选不一致即报 corrupt。token、generation、workerId 三重 fencing 对单作者一个 Worker 池是过度设计。AG-UI 事件由 Agent 每轮 reconcile 重发、靠 eventKey 去重，Worker 不发任何事件，没有真实流式；interrupt 硬套 `RUN_ERROR`，blocked 硬套 `RUN_FINISHED`，`RunAgentInput` 的 messages、tools、state 全部忽略。成员、角色、last_owner 在单 token 部署下是常量。sync 的三方合并正确，但 push 算出 ChangeSet 后 adapter 又下载 base、重放、上传整包，服务端再 diff 一次。

**CLI 与 TUI。** `suim.cli.v1` 的 `data` 是 `unknown`，success schema 是无 tag 的 29 元 union，command 与 data 不绑定，`--json` 输出前从不校验。exit code 靠四张手抄表，Runtime 实际抛 156 种错误码，93 种未映射一律退化为 exit 1。`suim --version` 输出后再报 `invalid_cli_usage` 且 exit 2。CLI 越过 application service 直操 store 25 处，freeze 幂等编排和 `run retry` 分派写在 CLI 且绕过 `LocalRunController`，Electron 要复用只能复制。`run *` 阻塞数分钟无事件流，本地没有 RunEvent，TUI 每个事件全量 `loadExecutionState` 作为代偿。TUI 复制了 CLI 的编排与 store 直取。Skill 的安装检查只查字符串存在，不与命令表对账。

### 判断

这些问题不是零散 bug，而是同一个根因：**实现先于真实创作，把分布式 SaaS 的机器和一次性结构化提交的 agent 形态当成了终局**。ADR-0008 已经决定顺序，本 ADR 决定形状。凡是终局不需要、或与"worktree 上迭代的 agent"冲突的层，整体推翻；凡是直接服务作品真源和确定性检查的层，保留并修正。

## 决定

### 真源与版本

1. **保留** Open Story Directory、Story Language、ProjectRevision、从 diff 构造的 ChangeSet、content-addressed ArtifactVersion、SQLite 本地 store、journaled checkout write。这是产品的核心，审计确认其形状正确。
2. **evidence 逐条持久化。** StoryCommit、SourceCommit、ContextSnapshot、ReviewReport、Release 在 SQLite 和 PostgreSQL 中按记录存储，以内容 sha 为键；portable package 只是导入导出格式，不再是运行时的持久化载体。stale 判定返回 `{ current, reason }` 值，不用错误码白名单；逐条失效，不 all-or-nothing；stale 的 Release 不阻塞提交。StoryText lineage 以 contentSha256 为键；lineage 与 Review 的兼容性都按 Design 内容比较。
3. **修复并发与崩溃窗口。** 执行状态行级读写，带版本校验；project lock 覆盖整个写会话；崩溃恢复识别"story 等于 head、evidence 等于 parent"的窗口并补完。
4. **删除** `ArtifactWorkspace`、`ProposedChange`、`candidateVersion`、`rename` 操作、`InMemoryArtifactStore` 的独立 id 序列。候选变更的应用退化为纯函数。

### Story 内核

5. **Checker 累积诊断。** bind、compile、evaluate 不再首错 throw，返回全部诊断；freeze 的条件是范围内零诊断。
6. **范围冻结落到内核。** `bind(sources, { through })`、StoryCommit schema 增加 `through`，Source 的材料边界复用同一语义；Release 区分全书与范围 commit。
7. **补齐 C 关键的确定性检查。** 正文提到但 `refs` 未引用的人物；已死人物出现在后续 refs；Contract subjects 必须在其 open / resolve Beat 的 refs 中；`secret` 必须先在 Beat 中声明再 `revealed`；`character` 与 `reader` scope 只承载 `secret.revealed` 且可读；`stateAt(t)` 增量快照供 Frame 使用。
8. **删除或降级** `enforceWorldReachability` 默认强制（改为 warning）、removed-syntax 守卫、`checkerVersion` Literal、commit 内嵌 `finalState`、IR wire 层重复、Book 到 Design 的改名导出、TS 内嵌文风散文、零引用的派生视图代码。修 `deriveRelease` 的展开溢出与章节边界越界。

### Agent 引擎

9. **一个引擎，多个配方。** `RunEngine` 是唯一编排实现：一个 capability 是一份配方，由角色 prompt、初始 Frame、工具策略、完成契约和后置检查组成；引擎把配方执行为一串持久 Task，每个 Task 是一次 agent loop。Local 在进程内运行引擎，Cloud 由 Worker 领取 Task 后运行同一引擎。删除五个 `local/*-run-service.ts`、两个 coordinator、六个 executor、`design-task-contracts.ts`、`source-read-request.ts` 与 planner。
10. **内循环采用 `@earendil-works/pi-agent-core`。** 修订 ADR-0003：循环、工具执行、steer、abort 由 pi-agent-core 提供；Suiming 拥有工具集、system prompt、模型绑定、Task / Attempt、每次调用前的 ContextSnapshot、成本上限、提交。pi 的 session、compaction、context 不是真源。
11. **worktree 与工具。** 沿用 ADR-0008 决定 14。工具集固定为按范围 `read`、`rg` / Story Search、`apply_patch`、`write`、`create / delete`、`check`、`frame`、`submit`，限制在 worktree 根内，没有 shell。工具返回 `isError` 即为通用修复步，取代只有 Agent 才有的 bounded repair；`stopReason === "length"` 单独处理，不进入修复。
12. **Design 配方。** authoring loop 在 worktree 迭代直到 `submit`；review loop 使用只读工具，输入是 base、diff、Frame 与目标；resolution loop 只在 review 非 pass 时运行。Agent 与 Reviewer 都能看到 Intent 引用的 style evidence。
13. **Writer 配方。** 按 StoryBeat 一次 loop，初始 Frame 见 ADR-0008 决定 2，输出经 StoryText 验证与 exact Intent 检查。
14. **Source 与 Review 配方取代 shard / merge DAG。** Source Read 是 agent 在材料上按范围读取并把笔记写入 worktree 的 loop，MaterialEvidence 简化为读取范围的区间并集，SourceCommit 要求并集覆盖全文；Source Extract 是 agent 在 Source namespace 逐文件 write 并 `check` 的 loop，不再要求单次输出整本 IR；Source Review 与 StoryText Review 是持只读工具的 loop，可以自行定向比对材料与 extraction、Design 与正文。分层 plan / shard / merge 与 fan-in 参数整体删除。长程一致性由 Checker、硬状态、Contract 生命周期与 Frame 承担，与 ADR-0008 决定 7 一致。
15. **执行状态收窄。** Run、Task、Attempt 三态加 AbortSignal 中断；恢复点是"最后一个完成的 Task 加仍在的 worktree"，retry 从该点继续；删除本地的 command receipt、`completeInterrupt`、`deferRunCompletion`、`initiatedBy`、无人写入的 `contentSha256`。Cloud 的 lease 只保留 token 与过期时间，删除 generation 三重 fencing；PostgreSQL 执行存储改为行级读写。

### 事件与界面

16. **Suiming RunEvent v1 取代 AG-UI。** 修订 ADR-0004 为 Superseded。事件由引擎在发生时发出：`run.started / finished / failed / interrupted / blocked / awaiting_input`、`task.started / completed`、`text.delta / text.completed`、`tool.started / completed`、`activity`、`revision.created`。payload 只带稳定 id 与摘要。Local 与 Cloud 都持久化带序号的 RunEvent，现有泛型 event store 保留，只换校验 schema 与词汇；传输是进程内 subscription、Electron IPC、SSE 加 `afterSequence`。删除 `ag-ui-*`、`sdk/ag-ui-agent.ts` 与相关 schema、测试和迁移中的协议名。AG-UI 只在真有第三方客户端时作为单向投影 adapter 出现。
17. **CLI 修正。** `suim.cli.v1` 改为逐命令 discriminated schema，`data` 与 command 绑定，`--json` 输出前校验；exit code 从错误类别派生，删除手抄表；freeze、retry、evidence 查询下沉到 Runtime service；`run *` 增加 `--events` 以 NDJSON 流式输出 RunEvent；`run source-*` 自动解析当前 root evidence，调参下沉配置；修 `--version`；删除非 JSON 模式、`process.cwd()` 回退等死代码。契约仍叫 v1，因为没有外部消费者。
18. **TUI 缩减为最小开发者控制台。** 只保留启动 Run、流式 transcript、interrupt、status；删除作品侧栏、`/diff`、`/rg`、`/search`、selector 与 ingest / rollback 编排，约 500 行。作者界面按 ADR-0008 由桌面端承担。
19. **Skill 与检查脚本。** Skill 补 exit code 表、`run *` 被 host 超时杀掉后的 `run show / retry` 路径、`open` 失败时的 `init`；`check-host-integrations.mjs` 从命令表生成对账，而不是查字符串存在。

### 模型层

20. **保留** Model Gateway 的 bind、非敏感 snapshot、凭据用途区分、`json-file-credential-store`。
21. **简化** 删除 `config.ts` 的重复环境解析，手写 TOML parser 换为库，共用一次 load；删除仅测试使用的 `complete()`，trace 收进 `gateway.stream`；模型调用返回 usage。
22. **补** `writer` profile、Run 级成本累计与上限、宪法派生的带版本 prompt 片段。

### Cloud

23. **stores 冻结保留，编排替换。** PostgreSQL project store 的 revision 与 CAS、migrator、S3 adapter、泛型 run-event store、Domain API 与 SDK 的 routes / schema / client / codec、sync 的合并核心保留。Cloud 的 capability 执行随决定 9 迁到共享引擎。删除成员、角色、last_owner、未使用的 `DomainApiRevisionSummarySchema`；Domain API 幂等 receipt 改为 head CAS；sync push 直接传文件，修 `open-story-merge.ts` 未包装的 `ArtifactError`；`history` 返回摘要。这些在 Cloud 恢复投入时执行，除非引擎迁移必须触及。

### 流程

24. **测试纪律。** 新增测试必须覆盖发布后改稿、局部 evidence 失效保留、双进程、host commit 崩溃窗口、holder 链转移与终止清空、through 范围、500 Beat 规模样本。审计发现的两个复现脚本进入回归。
25. **路线图任务重编号。** ADR-0008 的 Q1 到 Q8 由本 ADR 的迁移顺序取代，见路线图 M5。

### 收敛

以下决定在目标形状上进一步合并"同一件事两套实现"或"本可以是参数却成了类型"的地方，是对决定 6、9、14 的细化。

26. **一份命令目录。** `suim.cli.v1`、Cloud Domain API 与桌面端 IPC 不再各自定义命令。`packages/sdk` 持有唯一的命令目录：每条命令的名字、输入 schema、输出 schema、错误类别；CLI、Fastify 路由与 Electron IPC 是三个生成的传输适配，各自只补鉴权、幂等、进程边界这类传输层关注点。RunEvent 管事件，命令目录管请求，两者合起来就是所有界面的完整契约。
27. **一个 Worker loop。** 不再区分"Local 进程内跑引擎"和"Cloud Worker 领取 Task"。只有一个 Worker loop 和一个 claim 函数，对 Local 与 Cloud store 都成立；Local 在同一进程内启动一个 Worker，lease 对本地平凡满足。决定 9 中"Local 在进程内运行引擎"按此理解。
28. **一个 DesignCommit。** StoryCommit 与 SourceCommit 合并为 DesignCommit，字段是 `namespace`（Target 或某个 `sourceId`）与 `through`；Source 的材料边界就是 `through`，"未到期不算失败"只有一份实现。决定 6 中的范围冻结落在这个类型上；Release 只接受 Target namespace 的全书 DesignCommit。
29. **MaterialEvidence 不再存储。** 材料覆盖率是对该 Run 全部 ContextSnapshot 中针对同一 material sha 的读取范围取并集的查询；SourceCommit 冻结条件是并集覆盖全文。决定 14 中"简化为区间并集"按此实现，没有独立的 evidence 类型、层级或 stale 逻辑。
30. **一个 Review 配方。** Design Review、Source Review、StoryText Review 合并为一个 Review 配方，`layer` 是参数，prompt 按层取模板，输入是该层的 base、diff 或材料、Frame 与目标，输出统一为 ReviewDraft。决定 12 与 14 中的 review loop 都是它的实例。
31. **一个合并函数。** sync 的三方合并同时用于本地 rebase：Agent 提交时 head 已移动，与 Cloud push / pull 时两侧分叉，是同一个"共同 base 上两组 artifact 变化的合并"。不另写 rebase。
32. **一个搜索函数。** Story Search、Agent 工具里的 `rg`、CLI 的 `search` 是同一函数的三个入口；`rg` 只是本地实现细节，不是独立能力。

两项待定，收益大但有条件，在对应步骤再决定：

- **两个 store 合一。** 若能给 `node:sqlite` 写一个薄的 Kysely 方言适配而不引入 native 依赖，SQLite 与 PostgreSQL 可共用一份 schema、一份行级 store 逻辑与一份 migration catalog。在 E 步把执行状态改为行级读写时评估；Electron 打包不能因此引入 native 模块。
- **删除 TUI。** P 步给 `suim run` 加 `--events` 之后，TUI 只剩交互式中断与 transcript 渲染。若开发者不实际使用，删除 `apps/tui` 与 pi-tui 依赖，`suim` 无子命令只打印状态，中断走 `suim run interrupt`。这会推翻 ADR-0008 决定 11 的"冻结保留"，在 P 步决定。
  已决定（2026-09-05）：保留 TUI，按决定 18 缩减为最小控制台。理由：桌面端出现之前，它是唯一不经第二个 agent、由作者直接驱动 Agent 的第一方入口；R 要记录"作者否决 Agent"，中间隔一个 Claude Code 会让这份记录不干净。P 步同时把 pi-agent-core 的 steering queue 接成 `run steer`，作为中断能力的延伸；跨 Run 的记忆按不变量 8 写回作品，不建 agent 记忆。

已决定的顺序（2026-09-05，G3）：先删旧编排与 AG-UI，Cloud 引擎 host 后建。删除侧已完成，Cloud 在解冻前没有 Agent；不为冻结面提前建 host，也不让引擎的每次改动去镜像一套只跑过 2 个 Beat fixture 的旧编排。Cloud host 的形状届时再定：Worker 以 Run 为领取单位、materialize worktree 后跑同一引擎，Domain API 增加 `run.start`，执行状态改为行级 + lease。

不收敛的边界：Local 与 Cloud 的对象存储驱动不同，保持两个薄 adapter；`packages/story` 对网络、数据库、模型的隔离不动；持久执行、调用观测、质量学习三类数据各有真源，不互相镜像。

## 推翻清单

| 对象 | 处置 | 替代 |
| --- | --- | --- |
| 内存 `ArtifactWorkspace`、`candidateVersion`、`ProposedChange`、`rename` | 删除 | 每 Run 一个 worktree，diff 构造 ChangeSet |
| 五个 `local/*-run-service.ts` | 删除 | `RunEngine` 进程内运行配方 |
| `design-coordinator`、`source-read-coordinator`、六个 executor、`design-task-contracts`、`source-read-request`、planner | 删除 | `RunEngine` 加 Worker 领取 |
| Source Read / Extract / Review、StoryText Review 的 plan / shard / merge 与 fan-in | 删除 | agent loop 加只读工具，区间并集覆盖 |
| Agent 单次 `submit_design_changes`、操作翻译层、只有 Agent 才有的 bounded repair | 删除 | 工具集加 `isError` 修复步 |
| evidence 以 portable 包为运行时持久化 | 删除 | 逐条存储，以 sha 为键 |
| 错误码白名单式 stale 判定、all-or-nothing evidence carry | 删除 | 值类型判定，逐条失效 |
| `ag-ui-events`、`ag-ui-agent-handler`、`ag-ui-composition`、`sdk/ag-ui-agent`、forwardedProps schema | 删除 | RunEvent v1 与 SSE |
| command receipt、`completeInterrupt`、`deferRunCompletion`、`initiatedBy`、generation fencing、PG 执行态镜像 | 删除或简化 | 行级执行状态，token 加过期 lease |
| 成员、角色、last_owner、Domain API 幂等 receipt | 删除或简化 | 单 actor，head CAS |
| `config.ts` 环境解析、手写 TOML、`complete()` | 删除 | 单一配置加载，库 parser |
| Checker 首错 throw、`enforceWorldReachability` 强制、removed-syntax 守卫、`checkerVersion` Literal、commit 内嵌 `finalState` | 删除或降级 | 累积诊断，warning，版本可读 |
| CLI 四张 exit code 表、`unknown` data、非 JSON 模式、store 直操 | 删除 | 命令目录生成的 CLI 适配，service 下沉 |
| TUI 作品视图与编排复制 | 删除 | 桌面端；TUI 本身是否保留在 P 步决定 |
| `suim.cli.v1`、Domain API、IPC 三套命令定义 | 合并 | 一份命令目录，三个传输适配 |
| Local 进程内引擎与 Cloud Worker 两条执行路径 | 合并 | 一个 Worker loop |
| StoryCommit 与 SourceCommit | 合并 | DesignCommit，`namespace` 加 `through` |
| MaterialEvidence 类型与层级 | 删除 | ContextSnapshot 读取范围并集的查询 |
| 三份 Review 实现 | 合并 | 一个 Review 配方，`layer` 参数 |
| 独立的本地 rebase | 不写 | 复用 sync 三方合并 |

## 迁移顺序

见路线图 M5。原则：先修复已复现缺陷与内核，再建引擎并迁移 Design，再上 Writer，再把 Source 与 Review 改成配方，最后修 CLI 与 TUI。每一步 `npm test` 保持绿色，被删除模块的测试随模块删除，不保留空壳。

## 验证门

ADR-0008 的验证门不变，另加：

- 两个复现脚本作为回归测试通过；
- 双进程同时打开同一 Project 时执行状态不丢；
- 全仓只有一个编排实现、一个 Worker loop、一个提交路径、一个界面事件契约、一份命令目录、一个合并函数、一个搜索函数；
- Checker 对一个人为植入 5 处错误的 fixture 一次报出全部 5 条；
- 500 Beat 合成样本上 bind、check、Frame(t) 的耗时可接受。

## 后果

- 约 1.5 万行代码会被删除或重写，其中大部分是 4 天内生成的编排、协议适配和 evidence 打包代码。这是接受沉没成本。
- 分布式 Worker 的部分机制被简化，Cloud 承担高并发多租户的能力下降；这与 ADR-0008 的产品定位一致，需要时再加回，并且要有真实负载证据。
- 引擎依赖 pi-agent-core，单维护者风险随 pi-ai 已承担；引擎边界保证可替换。
- Story Language 在验证门前继续不稳定，本 ADR 增加的 `through`、secret 声明规则是格式变化，开发期 fixture 直接重写。
- ADR-0002 的模块化单体形状、ADR-0003 的 pi-ai 边界、ADR-0007 的本地产品与显式同步继续有效；ADR-0003 关于 pi-agent-core 的禁令、ADR-0004 整体、ADR-0008 决定 7 与 8 由本 ADR 修订。

## 参考

- [ADR-0003](0003-pi-ai-model-boundary.md)、[ADR-0004](0004-ag-ui-interaction-boundary.md)、[ADR-0007](0007-local-tui-and-explicit-cloud-sync.md)、[ADR-0008](0008-creative-loop-before-product-surface.md)
- [系统架构](../architecture.md)、[实施路线图](../roadmap.md)、[当前状态](../current-status.md)
