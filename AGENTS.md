# Suiming

燧明界的根产品。以桌面端应用为最终核心产品，通过专属 Suiming Agent、版本化 Story Artifact、AI-native 故事语言和确定性 Checker，生成可验证的高质量长篇小说。作品可视化、阅读、编辑与 Agent 交互是核心能力；CLI、Codex / Claude Code / Grok integrations 和可选 Cloud 共用领域边界。

## 真源与阅读顺序

- 产品目标与验收：[需求与目标](docs/vision-and-requirements.md)
- 质量价值：[故事创作宪法](strategies/story-constitution.md)
- Artifact 语义与开放格式：[Story Language](story-language/README.md)
- 当前架构与运行协议：[系统架构](docs/architecture.md)
- 作者工作台定位与交互：[作者工作台设计](docs/web-product-design.md)；作品可视化：[可视化设计](docs/visualization-design.md)
- 执行模型与故障验收：[Harness 设计](docs/harness-design.md)；正文 / 审稿时效与 Source 覆盖率怎么派生：[派生状态设计](docs/derived-evidence-design.md)
- 技术选择：[技术栈](docs/technology.md)
- 当前完成度与已知缺陷：[当前状态](docs/current-status.md)
- 实施顺序与验收：[实施路线图](docs/roadmap.md)；接下来做什么只在它的第 6 节维护
- 发生过什么：[变更记录](docs/changelog.md)
- 命令、检查脚本的隐含约束、提交规则与踩坑记录：[CLAUDE.md](CLAUDE.md)（不只写给 Claude Code，人和其他 coding agent 改代码前也要读）
- 旧仓边界：[迁移方案](docs/migration-from-suiming-story.md)
- ADR 是历史决策，不是当前规范；已完成的方案——[重构方案](docs/refactoring-plan.md)、[收敛方案](docs/consolidation-plan.md)——保留形成过程，也不是现行规范；撤掉「委托」概念的理由见[需求与目标](docs/vision-and-requirements.md) 5.1 节「作者意图与对话」。
- 开源前的提交历史不在本仓：2026-10-03 开源时，之前的 409 个提交压成了一个基线提交（`chore: 开源基线（MIT）`）；本仓的另一个起点是 2023-09-28 建仓时的 8 个提交，由合并提交接入。文档里 2026-10-03 及之前的 7 位提交号、「看当时的提交信息」都指那段历史，本仓查不到；该保留的设计理由已经写在上面这些文档里。维护者本机在本仓旁边留有完整归档（裸仓 `../suiming-history-2026-10-03.git`），在那里用 `git log -L` 或 `git blame <提交> -- <文件>` 追到逐行的旧理由；其他环境没有这份归档。

Story Language 与 TypeBox schema 分别是 artifact 语义和机器边界的真源；不要在架构文档、Prompt、API 或 UI 中复制字段表。以下约束定义目标架构，当前代码与差距以当前状态为准。

## 核心不变量

1. `suiming` 是产品和代码真源；`suiming-story` 只是一次性迁移来源、可选的历史参照和可能的 Community 发行，不是上游依赖或质量标准。
2. **Capability first。** 先定义 Agent 为完成创作目标需要具备的能力，再设计 Domain Service、API、工具和界面。不得从页面、REST endpoint、模型 provider 或 Workflow 反推领域边界。
3. 每个本地或 Cloud Project 只以已提交的版本化 Story Artifact 为作品权威。数据库、对象存储、Open Story Directory、编辑器、Context、索引和会话不得形成第二套 Canon；本地目录是可由人类和 host agent 直接修改的 checkout，文件修改只是 dirty candidate，Runtime 经 Checker 后从 diff 内部构造 ChangeSet，才推进本地 ProjectRevision。本地作品目录是普通 git 仓库，任何人都可以 commit——那是候选；权威只有受保护的 `refs/suiming/canon`，它只由过 Checker 的提交推进。「每个 Project 一个权威」不等于「全局一种存储」：本地用 git、Cloud 用 PostgreSQL 是同一套语义的两个实现；给 Cloud 换存储时，先让它通过 `CanonStore` 契约测试再迁。
4. Open Story Directory 是本地创建、repository-native project 和 Cloud checkout 共用的唯一标准目录表示；Open Story Package 是同一逻辑路径空间的可移植快照。两者必须可读、可验证、可导入和可继续创作。交换格式不携带部署内部的 project、revision、attempt、run 或 artifact version identity。Local 与 Cloud 的关联保存在包外，通过显式 checkout / import / link / push / pull 同步，不做后台双写。
5. **作者意图是组织核心，不是「委托」。**耐久的中心是 `intent/**`——它是 Canon，过 Checker，有版本；作者在对话里说的话只要对以后仍然成立，就必须有路径提议写回它。Session / Task 是**机械边界**（lease、checkpoint、按 turn 的模型绑定），作者只看到「一个持续的对话」，产品不围绕它们建概念。一个 Session 就是一个根 Agent 与一份连续的消息列表，在作者的 checkout 上直接工作并拥有作品决策权，可阶段提交多个 ProjectRevision；Run / Attempt / Conversation 已于 2026-09-13 删除，不要重建。Capability 是设计词汇不是运行时构造，落地形态是 Agent / Worker 的工具集；recipe 只剩可选的写作方法（`STORY_TEXT_METHOD`）与可修改的计划模板，固定创作配方已删除，不要重建。Agent 可以直接执行或委派，允许预规划与动态调整，普通工具调用不自动成为 Task。父子委派与结果依赖分开，已完成历史不重写；不新增 graph engine 或状态库。
6. Worker 是 task-local agent loop，无持久人物记忆、不自由互传消息、不直接提交 Canon。结果先经校验持久保存，再以引用交还父调用，不让主模型转录完整 JSON 或正文。每次提交由 Agent 收敛为一个 ChangeSet；同一候选同一时刻一个写入 owner，独立并行须有输入与输出隔离及实际收益。
7. 模型负责搜索、生成和语义判断；Checker 只验证 schema、引用、顺序、硬状态和版本等确定性边界。Review 帮助发现问题，但不拥有作品权限。
8. Story Artifact 保存长期记忆。按表达意图检索是正式的 `read` 能力，搜索结果只是回到原始 artifact 的入口；Session、Task、事件、消息、trace、索引与摘要都是运行或派生数据，长期结论须写回作品。正文与审稿的时效由 Canon 历史派生，不另存 evidence；实际读取、硬依赖与可能的故事影响不能混为一谈。
9. 本地 SQLite 保存 Session / Task 持久执行真源，**只**保存执行数据、部署登记与 remote binding，作品版本不在里面；Cloud 只保存 Canon 与同步，没有执行数据；OpenTelemetry 输出、Langfuse 等后端只承载可丢失的调用观测；Suiming Eval 保存故事专属质量与策略晋级证据。三者只用稳定 ID 关联，不互相镜像完整数据。
10. 所有界面共用 AG-UI 标准事件与类型化 Suiming 扩展，不长期保留双协议投影。消息与事件先持久化再发布，subscription 与 IPC 只是传输；发消息与恢复走命令，attach 只读，重连不重执行。AG-UI 的 threadId 就是 sessionId、runId 就是 turn id；作品提交、同步与完整读取走 Runtime / Domain API。SDK、Local、CLI 与桌面已使用同一 SessionEvent 信封。
11. 桌面与 CLI 共享同一 Story、Agent、Capability、Checker 和 Model Gateway 语义；Codex / Claude Code / Grok integrations 通过 Open Story Directory 与 `suim` CLI 复用同一 Story、Checker、ProjectRevision 和 Cloud sync，不复制 Runtime。只有真实负载或评测证明需要，才引入 Redis、ClickHouse、通用 graph/workflow engine、向量数据库、CRDT、Ranker 或 Reward Model。
12. 当前只验收长篇小说。先用真实创作、作者选择和修订建立可信 Dataset，再用同输入、同预算的真实长篇消融或 paired blind eval 验证复杂机制和策略晋级；旧仓不是默认基线。系统可以提出创作策略改进，不能自行修改故事宪法、作者 Intent 或评测标准。

## 工程边界

- 技术栈为 Node 24、TypeScript 6、TypeBox 1.x；业务代码 TypeScript-only。
- `packages/story` 不依赖网络、数据库、模型 provider 或 UI。
- `packages/runtime` 是 deployment-neutral 的共享 Runtime，收纳 artifact、harness、原子 Capability、可选方法、events、model 与 application service；Local / Cloud 只替换存储、owner 领取与传输 adapter，桌面、CLI 和 Cloud 不另建平行 runtime。
- `packages/cloud-postgres` 是 Kysely / `pg` Cloud persistence adapter，依赖 Runtime port；数据库 driver、migration runner 与 PostgreSQL transaction 实现不得反向进入 `packages/runtime`。
- `packages/cloud-s3` 是 AWS SDK v3 / S3-compatible `CloudObjectStore` adapter；只拥有对象 client、内容完整性与物理 key prefix，不拥有 ArtifactVersion、Project 权限或对象生命周期规则。
- Model Gateway 直接使用 `@earendil-works/pi-ai`，复用其 provider、消息、工具声明和流类型；显式 profile 选择模型，每个 turn 冻结实际 provider、model、参数、prompt 与工具声明（`taskLoopBinding`），换绑只在没有未决副作用的 turn 边界发生。参考 pi-agent-core 逻辑自行实现 Harness，不依赖、fork、vendor 或按字段改名移植其内核，不再评估其他执行路径；pi-agent-core、其文件工具和 NodeExecutionEnv 依赖已移除。pi-ai 的版本以 `packages/runtime/package.json` 为准，升级时的坑见 CLAUDE.md。
- `SuimingHarness` 是唯一执行实现；根 Agent 与子任务共用一份自有 loop（`runTaskLoop`）、动作恢复与 execution store，不增加 pi Session / Lane / Operation 同义层。Session 是根 Agent（idle / running / paused 三态，一份连续的消息列表），turn 是作者一条消息到模型停下，Task 是子智能体；暂停、进程重启和网络重试都续同一份消息列表。Agent 使用受限的 checkout 文件工具（整个 checkout 可写，`.git` / `.suiming` 与 host 接入目录除外；不加载 host 的 Skill 与入口文件），子任务按角色缩小写范围；作者、host agent 与 Agent 共用一份候选与一条提交路径（`commitCheckout` + receipt），没有 per-session worktree，也没有提交时的三方合并；作者消息经持久 inbox 进入消息列表。不得新增 per-capability run service、coordinator 或 executor。
- **turn 结束不等于作者的目标达成**，系统不做这个判断——达成与否由作者看作品定。没有交付协议：模型一次响应里没有工具调用，turn 就结束回 idle；未提交的候选留在 checkout 等下一轮，Agent 在回复里说明哪些改了还没提交。**没有预算**，理由与代价见 [Harness 设计](docs/harness-design.md)第 10 节。只有三种情况 Session 停在 paused 等作者：模型请求结果未知、动作停在半途无法核对、半途换了模型或工具面；其余都回 idle 加一句原因。外部模型请求可能结果未知，不承诺 exactly-once。
- `packages/sdk` 持有命令目录。**目前是三份而不是一份**（`SUIM_CLI_COMMANDS` / `LOCAL_COMMANDS` / `DOMAIN_API_ROUTES`），传输适配也不是生成的；已经合一的是它们共用的部分：领域对象 schema 只在 `domain-schema.ts` 定义一次，Session 摘要 / 作品状态 / Checker 结果 / revision 摘要各只有一份投影，同名命令只允许一份 payload。全量改名与自动生成刻意不做，理由见[系统架构](docs/architecture.md)——不要把这条读成「已经是一份」。只有一个 agent loop（`runTaskLoop`）、一个合并函数（`mergeOpenStoryFiles`）、一个搜索函数（`searchStoryCandidate`）、一个 Review 能力实现（`harness/review-task.ts`）；审稿是 `review/<id>.md`、材料笔记是 `source/<id>/notes/<n>.md`，两者都是普通 artifact，时效与覆盖率按需从历史派生（`artifact/derived.ts`）。
- 标准事件 schema 复用上游，Suiming 扩展用自己的 TypeBox 边界。事件带持久序号，对外消息可恢复（Cloud 的事件存储随执行 adapter 已删，解冻时按同一契约重建）；完整 Story Artifact 与 diff 不进入事件流，客户端 view state 不是运行真源。
- Cloud 以 PostgreSQL 保存 Canon（Project、ArtifactVersion、ProjectRevision）与同步元数据，以 S3-compatible Object Storage 保存大对象；没有执行数据（见不变量 9）。本地不同构：作品版本在作品目录的 git 仓里，SQLite 与 content-addressed object directory 只承担执行数据与执行对象。详细模型 trace 通过 OpenTelemetry 发送到可替换后端。
- Fastify + TypeBox 定义 Cloud Domain API。桌面 `apps/desktop` 的主进程持有 Runtime 与凭据，`apps/web` 的 React + Vite 工作台经 typed IPC 接入；Router / Query 管领域查询，TanStack AI client / ai-react 管消息 view state，不引入其服务端 loop。首个真实 IPC 切片验证恢复与交互；重载 renderer 不停正在跑的 turn，明确退出应用则保存并有界结束，重开恢复。CLI 拥有 `suim` 与 machine contract。
- 核心执行由 Suiming 自行实现，pi-ai 只承担模型调用与协议；Codex / Claude Code / Grok 继续作为 host-native 入口，不构建 managed 第二后端或多引擎抽象。新版 pi 已有持久 Harness，不能用旧版本占位代码作为自建理由；不宣称自建自动带来更高质量、更低成本或独占可视化能力。
- 凭据按 provider 实际认证、额度与限制接入，删除仅凭订阅标签禁止 automation 的判断及无独立用途的配置；未验证的登录、刷新或调用方式不标为支持，不能宣称另一产品订阅可直接用于标准 API。
- Codex / Claude Code / Grok integrations 是一等本地入口，但只是各 host 的薄 instruction / Skill / command adapter。host 可以直接修改 checkout；`suim commit` 扫描实际文件 diff 并在 Runtime 内部构造 ChangeSet，adapter 和模型都不手写 ChangeSet，也不直接读写 `.suiming`。CLI 还必须为 host 暴露 Context、Search、Source、Design impact、Review、Release 与 Cloud 等经过验证的领域能力，不能只剩通用文件命令。
- story package codec 是 Open Story Directory 与 Open Story Package 的共同机器边界；Story Language 保留路径必须完整 round-trip，仓库辅助文件可以共存但不得进入 artifact snapshot。Runtime 只接受当前格式；开发期旧数据直接一次性重写或丢弃，不实现 legacy codec / importer。
- **能力交给模型，可见性交给系统。**prompt 是真手段，模型能做的事会随它变强而变好；不要为了「不依赖模型」去造闸，那会把产品做窄。判据不是「模型能不能做」，是「**没做会不会有人发现**」。**失败静默、代价延后转移**的行为要有确定性的对账或显示——不是不信任模型，是不能只有模型自己知道做没做：意图写回只有 `AGENT_PROMPT` 一句指示，模型多半做得到，但 eval-022 跑了 4 个 Run、`intent/` 一个字没改，一周没人发现；缺的是对账（这一轮作者说了几条、几条真的改了 `intent/**` 或 Design，纯算术），不是闸——2026-10-01 起每个 turn 结束都带这份对账。**一旦失守直接坏作品**的行为则必须结构性保证，与模型强弱无关：Checker 拒绝、路径越界、subagent 没有 Canon 提交权、malformed output 由 tool contract 拒绝，都属此类。
- 新增领域实体、持久状态、协议或服务前，必须证明终局必需且现有边界无法表达。
- UI/UX 一致性是验收要求：同层布局、同类控件、状态语义与导航行为遵循[作者工作台设计](docs/web-product-design.md)第 7 节，复用已有组件与全局 token；新增能力先融入现有交互，避免重复入口与页面私有样式。公共规则修改后检查受影响工作面。
- 代码与文档使用自然、清晰的简体中文，避免翻译腔和 AI 味；协议与通用技术术语保持稳定英文。

## 当前阶段

<!-- 本节只写阶段级摘要，只在阶段变化时改；完成度、缺陷与队列见下面链接的两份。 -->

桌面工作台与自主 Agent 已贯通，执行收敛到 Session 模型（形状见上面的不变量与工程边界，细节以[系统架构](docs/architecture.md)与 [Harness 设计](docs/harness-design.md)为准；一路怎么走到这里的见[变更记录](docs/changelog.md)）。

证据最高到「真实调用」：2026-09-16 重构后第一次完整真实对话存为[基线](docs/validation/2026-09-16-first-real-session/README.md)，2026-10 起开发期评估改用斗破前 120 章的忠实抽取与留出评测（[路线图](docs/roadmap.md)第 5 节）。没有完整长篇；2026-09-06 作者盲读指出的阅读质量问题仍是当前的质量结论，不能沿用更早的「不劣于 host」。

本阶段是[路线图](docs/roadmap.md)的 S5：真实长篇质量、Harness 余下切片（C / E / F）、认证与发行。具体队列只在路线图第 6 节维护，完成度与已知缺陷见[当前状态](docs/current-status.md)。

Cloud Web、远程 Agent 产品、生产 identity / 计费、多人协作、Reader、短剧、全功能 MCP 与通用 graph engine 不进入本轮；已有 Cloud adapter 随共享契约修正，不借此扩张 Cloud。Story Language 在验证门前不承诺兼容；真实作品、revision 与作者记录迁移前备份，不随开发执行数据一起丢弃。
