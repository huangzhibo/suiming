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
- 开发约定（常用命令、检查脚本、提交规则、测试纪律）：本文后半；只在某个目录用得上的坑写在那个目录的 AGENTS.md，见文末「各目录的约定」
- 旧仓边界：[迁移方案](docs/migration-from-suiming-story.md)
- ADR 是历史决策，不是当前规范；已完成或被取代的方案与评估在 [docs/history](docs/history/README.md)，保留形成过程，也不是现行规范。撤掉「委托」概念的理由见[需求与目标](docs/vision-and-requirements.md) 5.1 节「作者意图与对话」。
- 开源前的提交历史不在本仓：2026-10-03 开源时，之前的 409 个提交压成了一个基线提交（`chore: 开源基线（MIT）`）；本仓的另一个起点是 2023-09-28 建仓时的 8 个提交，由合并提交接入。开源基线之前的 7 位提交号（文档里 2026-10-03 及更早的条目大多是）、「看当时的提交信息」都指那段历史，本仓查不到；该保留的设计理由已经写在上面这些文档里。维护者本机在本仓旁边留有完整归档（裸仓 `../suiming-history-2026-10-03.git`），在那里用 `git log -L` 或 `git blame <提交> -- <文件>` 追到逐行的旧理由；其他环境没有这份归档。

Story Language 与 TypeBox schema 分别是 artifact 语义和机器边界的真源；不要在架构文档、Prompt、API 或 UI 中复制字段表。以下约束定义目标架构，当前代码与差距以当前状态为准。

## 核心不变量

1. `suiming` 是产品和代码真源；`suiming-story` 只是一次性迁移来源、可选的历史参照和可能的 Community 发行，不是上游依赖或质量标准。
2. **Capability first。** 先定义 Agent 为完成创作目标需要具备的能力，再设计 Domain Service、API、工具和界面。不得从页面、REST endpoint、模型 provider 或 Workflow 反推领域边界。
3. 每个本地或 Cloud Project 只以已提交的版本化 Story Artifact 为作品权威。数据库、对象存储、Open Story Directory、编辑器、Context、索引和会话不得形成第二套 Canon；本地目录是可由人类和 host agent 直接修改的 checkout，文件修改只是 dirty candidate，Runtime 经 Checker 后从 diff 内部构造 ChangeSet，才推进本地 ProjectRevision。本地作品目录是普通 git 仓库，任何人都可以 commit——那是候选；权威只有受保护的 `refs/suiming/canon`，它只由过 Checker 的提交推进。「每个 Project 一个权威」不等于「全局一种存储」：本地用 git、Cloud 用 PostgreSQL 是同一套语义的两个实现；给 Cloud 换存储时，先让它通过 `CanonStore` 契约测试再迁。
4. Open Story Directory 是本地创建、repository-native project 和 Cloud checkout 共用的唯一标准目录表示；Open Story Package 是同一逻辑路径空间的可移植快照。两者必须可读、可验证、可导入和可继续创作。交换格式不携带部署内部的 project、revision、attempt、run 或 artifact version identity。Local 与 Cloud 的关联保存在包外，通过显式 checkout / import / link / push / pull 同步，不做后台双写。
5. **作者意图是组织核心，不是「委托」。**耐久的中心是 `intent/**`——它是 Canon，过 Checker，有版本；作者在对话里说的话只要对以后仍然成立，就必须有路径提议写回它。Session / Task 是**机械边界**（lease、checkpoint、按 turn 的模型绑定），作者只看到「一个持续的对话」，产品不围绕它们建概念。一个 Session 就是一个根 Agent 与一份连续的消息列表，在作者的 checkout 上直接工作并拥有作品决策权，可阶段提交多个 ProjectRevision；Run / Attempt / Conversation 已于 2026-09-13 删除，不要重建。Capability 是设计词汇不是运行时构造，落地形态是 Agent / Worker 的工具集；recipe 只剩可选的写作方法（`STORY_TEXT_METHOD`）与可修改的计划模板，固定创作配方已删除，不要重建。Agent 可以直接执行或委派，计划写在消息里、随时调整，不是实体（没有 plan / 任务依赖），普通工具调用不自动成为 Task；已完成历史不重写；不新增 graph engine 或状态库。
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
- Model Gateway 直接使用 `@earendil-works/pi-ai`，复用其 provider、消息、工具声明和流类型；显式 profile 选择模型，每个 turn 冻结实际 provider、model、参数、prompt 与工具声明（`taskLoopBinding`），换绑只在没有未决副作用的 turn 边界发生。参考 pi-agent-core 逻辑自行实现 Harness，不依赖、fork、vendor 或按字段改名移植其内核，不再评估其他执行路径；pi-agent-core、其文件工具和 NodeExecutionEnv 依赖已移除。pi-ai 的版本以 `packages/runtime/package.json` 为准，升级时的坑见 [packages/runtime/AGENTS.md](packages/runtime/AGENTS.md)「模型与凭据」。
- `SuimingHarness` 是唯一执行实现；根 Agent 与子任务共用一份自有 loop（`runTaskLoop`）、动作恢复与 execution store，不增加 pi Session / Lane / Operation 同义层。Session 是根 Agent（idle / running / paused 三态，一份连续的消息列表），turn 是作者一条消息到模型停下，Task 是子智能体；暂停、进程重启和网络重试都续同一份消息列表。Agent 使用受限的 checkout 文件工具（整个 checkout 可写，`.git` / `.suiming` 与 host 接入目录除外；不加载 host 的 Skill 与入口文件），子任务按角色缩小写范围；作者、host agent 与 Agent 共用一份候选与一条提交路径（`commitCheckout` + receipt），没有 per-session worktree，也没有提交时的三方合并；作者消息经持久 inbox 进入消息列表。不得新增 per-capability run service、coordinator 或 executor。
- **turn 结束不等于作者的目标达成**，系统不做这个判断——达成与否由作者看作品定。没有交付协议：模型一次响应里没有工具调用，turn 就结束回 idle；未提交的候选留在 checkout 等下一轮，Agent 在回复里说明哪些改了还没提交。**没有预算，只有每轮用量检查点**：一轮里根与子任务的用量折合到 600 万 token（缓存读按一成、输出按五倍，与模型单价无关）就在下一次请求前停下回 idle，作者说一句「继续」从原处接着跑；理由与代价见 [Harness 设计](docs/harness-design.md)第 10 节。只有三种情况 Session 停在 paused 等作者：模型请求结果未知、动作停在半途无法核对、半途换了模型或工具面；其余都回 idle 加一句原因。外部模型请求可能结果未知，不承诺 exactly-once。
- `packages/sdk` 持有命令目录。**目前是三份而不是一份**（`SUIM_CLI_COMMANDS` / `LOCAL_COMMANDS` / `DOMAIN_API_ROUTES`），传输适配也不是生成的；已经合一的是它们共用的部分：领域对象 schema 只在 `domain-schema.ts` 定义一次，Session 摘要 / 作品状态 / Checker 结果 / revision 摘要各只有一份投影，同名命令只允许一份 payload。全量改名与自动生成刻意不做，理由见[系统架构](docs/architecture.md)——不要把这条读成「已经是一份」。只有一个 agent loop（`runTaskLoop`）、一个合并函数（`mergeOpenStoryFiles`）、一个 artifact 搜索函数（`searchStoryCandidate`；原文按字查找另走 `findInMaterial`）、一个 Review 能力实现（`harness/review-task.ts`）；审稿是 `review/<id>.md`、材料笔记是 `source/<id>/notes/<n>.md`，两者都是普通 artifact，时效与覆盖率按需从历史派生（`artifact/derived.ts`）。
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

## 开工前

- 动手前对照 [Harness 设计](docs/harness-design.md)第 16 节的拆除清单，避免重建已被推翻的层；TUI 也已删除，不要重建。ADR 是历史：ADR-0009「收敛」节里的 Worker claim、DesignCommit、MaterialEvidence、三方合并做 rebase、保留 TUI 都已被推翻，不要拿它当规范对照。

## 常用命令

```sh
npm run check        # docs 链接、生成文件对账、story 隔离、biome、tsc（含测试源码）、示例作品过 Checker、设计系统 lint、integrations 对账
npm test             # node --test 全部包；需要真实 PostgreSQL / S3 / 双进程的 5 条默认 skip，没有本机 eval-022 作品时再 skip 1 条
node --import tsx --test packages/runtime/test/agent.test.ts   # 单个测试文件
npm run build        # tsc -b --force
npm run format       # biome 自动修
npm link -w @suiming/cli   # 全局 suim 指向本仓；旧仓同名，只能有一个在 PATH 上
npm run dev:api      # Cloud 开发进程（只剩 Canon 与同步），读 .env
node --import tsx apps/cli/src/bin.ts --json status    # 从源码跑 suim
npm run test:desktop   # 构建 renderer + 真实 Electron E2E；只改测试时可直接 node --import tsx --test apps/desktop/test/desktop.test.ts
cd apps/web && npx shadcn@latest add <component>   # 生成 shadcn/ui 组件到 src/components/ui，之后跑 npm run format
npm run regression:harness -- --only check-issues --trials 1   # 真实模型回归，节奏见下
```

- workspace 包的 exports 指向 dist。测试和 CLI 里 `@suiming/*` 的跨包 import 走 dist，改了 packages/* 之后先 `npm run check`（其中 `tsc -b` 会重新 emit）或 `npm run build` 再 `npm test`，否则测的是旧代码。包内测试用 `../src` 相对路径，不受影响。
- 跑被 skip 的集成测试：按 .env.example 设 `SUIMING_TEST_POSTGRES_URL`、`SUIMING_TEST_S3_*`、`SUIMING_TEST_DURABLE_DEPLOYMENT=1`、`SUIMING_TEST_DURABLE_PROCESS=1`，需要一次性的 PostgreSQL 与 MinIO。
- 真实模型调用的配置、`regression:harness` 的跑法与节奏见 [packages/runtime/AGENTS.md](packages/runtime/AGENTS.md)「真实模型调用与回归」。**回归跑的过程中不要 `npm run build` / `check` / `test:desktop`**：每个任务起新的 `suim` 进程读当时的 dist，脚本每跑完一项核对 dist 指纹，变了就停；只提交不构建不影响它。

## 检查脚本的隐含约束

`npm run check` 的任一道闸失败都让整条链失败。脚本的报错会说该做什么，下面是看报错看不出来的：

- check-docs：全仓所有 .md 的相对链接必须指向存在的文件；根目录这份 AGENTS.md 不能超过 32 KiB——Codex 默认只读这么多（`project_doc_max_bytes`），多出的部分静默截掉。只在某个目录用得上的约定放进那个目录的 AGENTS.md。
- 三份生成文件不要手改，改了真源跑对应的 `npm run generate:*`：`strategies/story-constitution.md` → `packages/story/src/constitution.ts`；`story-language/*.md` → `packages/story/src/story-language-docs.ts`；integrations/shared/suiming/SKILL.md 与 integrations/codex/agents/*.toml → `apps/cli/src/host-files.ts`。Agent 经 `story_guide` 的 `topic` 读 Story Language，`suim init --agent` 与 `suim update --agent` 把 Skill 和同一份 Story Language 写进作品仓——2026-10-02 之前只有 CLI 的 host-files 嵌了一份，Agent 只看得到字段形状，抽斗破时 Beat 写成速记、人物档写成编年、一个秘密都没声明。生成脚本读 story-language 下所有 .md，那里不能放别的 Markdown（包括 AGENTS.md）。
- check-story-isolation：packages/story/src 是白名单，只能 import 相对路径、`typebox`、`yaml` 与 `node:crypto`，也不能用 fetch、process、`Date.now`、无参 `new Date()`、`Math.random`；story 真要加依赖，先判断它是不是纯领域，再改脚本的白名单。
- check-examples：`examples/` 下每部示例作品都要过 Checker（与 `suim check` 同一个判定，不要求全书写完）。Story Language 改了，示例跟着改；示例是给第一次打开的人看的，不能是检查不通过的作品。
- check-host-integrations：要核对的命令片段由脚本从 `SUIM_CLI_COMMANDS` 生成（`cloud.*` 除外），增删 `suim` 子命令时只需让 SKILL.md 写出对应的 `suim --json <命令>`，不用改脚本；三个 host README 也要含安装路径与 smoke check。
- check:design-system 是 `apps/web` 的 ESLint，与 biome 的分工见 [apps/web/AGENTS.md](apps/web/AGENTS.md)。
- biome 只覆盖 apps/*/{src,test}、packages/*/{src,test}、scripts/*.mjs；tab 缩进，行宽 120。tsconfig 开了 exactOptionalPropertyTypes、noUncheckedIndexedAccess、verbatimModuleSyntax：NodeNext 相对 import 写 `.js` 后缀，类型用 `import type`，可选属性不能显式赋 undefined。

## 提交与完成规则

- 一个提交只做一个任务或明确子任务；机械重命名、行为变更、文档决策分开提交。
- 每个任务先补验收测试，再更新当前状态；未经真实模型验证的能力留在「机制」等级，不写成已完成。验收与风险相称：恢复与事务用故障注入，界面用真实交互，文档修改查链接与规范一致性。
- 完成一步后各更新一处，三份各管一样：docs/current-status.md 管能力、已知缺陷与测试数；docs/roadmap.md 第 6 节管队列；docs/changelog.md 管发生了什么。AGENTS.md「当前阶段」与 README 顶部「当前状态」引用块只写阶段级摘要并链接，只在阶段变化时改——以前要求同步四处，四份副本照样漂移了。
- 提交信息用 `type(scope): 中文摘要`，Harness 切片字母或 ADR 编号放在结尾括号，如 `（C）`、`（ADR-0013）`。正文写为什么；删除测试时写明它守的是什么、为什么不再需要。
- 设计原型不进生产 `apps/web`，直到视觉方向被选定；生产代码不复制 mock domain model。
- 不提交 .env、API key、Langfuse key、Local SQLite、trace payload、真实用户数据或未脱敏作品。
- 仓库是公开的：文档不写作者所在地区、代理出口与本机路径；作品副本放在哪个目录这类维护者本机信息不进仓库。

## 测试纪律

- 测试 helper 是 test/ 目录下的普通文件，按相对路径引用：story 层 fixture 在 packages/story/test/fixture.ts，唯一的样例作品在 packages/runtime/test/sample-work.ts（2 个 StoryBeat）；packages/runtime/test/synthetic-work.ts 是给 Frame 规模测试合成的 3 卷 36 Beat Design，没有文学内容，不当样例用。内存版 Cloud store（`InMemoryCloudProjectStore` 等）在 packages/runtime/test/in-memory-cloud.ts，2026-10-04 才从 runtime 的产品导出面挪出来，不要再放回 src。曾做过独立 `@suiming/testing` 包和 `@suiming/runtime/testing` 子路径导出，都因为是第二套机制或污染产品导出面被删，不要再建。
- 被删模块的测试随模块删除，不留空壳。不加只测 in-memory 假对象、或断言临时空洞（如「Worker 零 executor」）的测试；冻结面只保留能发现真问题的测试。
- 真实 provider 暴露的每种 malformed output 都要有等价回归，由 Checker 或 tool contract 拒绝，不靠改 prompt 兜底。
- 默认 skip 的集成测试不会告诉你它坏了：改 Cloud schema 后的真跑办法见 [packages/cloud-postgres/AGENTS.md](packages/cloud-postgres/AGENTS.md)。桌面 E2E 的纪律见 [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md)。
- YAML 把 64 位纯数字的 sha 解析成数字，`material_sha256: 000…0` 会被 schema 拒绝；测试里造假 sha 用 `"f".repeat(64)`。

## 错误信息与退出码

- CLI 的 exit code 从错误类别派生，不是手抄表：`errorCategory()`（`packages/sdk/src/error-category.ts`，正则规则加少量 overrides）定类别，`EXIT_BY_CATEGORY` 映射到退出码。新增 Runtime 错误码通常不需要动 CLI；只有当它落进错误的类别时才加一条 override。
- **错误信息的语言按「是不是 bug」分，不按包分**（2026-09-30 作者定）。作者正常操作就会撞到、原因在作者输入或环境的信息写中文；不变量被破坏的程序错误保持英文——作者不需要懂，看得懂英文的人也多。新增错误时按这两问判：作者正常操作会不会撞到？原因在不在作者输入或环境？都是就写中文。保持英文的是执行状态机、存储与 journal 损坏、内部契约校验、Cloud 运维、release 完整性校验、NFC 规范化与 API 参数校验，以及第三方原文（TypeBox 的 schema 错误、pi-ai）；commander 的内置错误由 `localizeCommanderError` 按模板翻，没命中的原样露出英文。**错误码永远不译**——`code` 是机器契约，`message` 是给人看的那半。改在源头而不是显示层按 code 映射：诊断带参数，`suim` 的 JSON 信封与 host agent 也要看到同一句话；这些诊断同时是模型的 `ToolRejection` 反馈，与中文的 Agent prompt / Skill 一致。排版：中文人名前不留空格（`提到了${character.name}`、`找不到人物：${id}`，人物 id 就是中文名），id、路径、字段名这类拉丁变量前后留空格。有 7 条测试断言诊断原文，改文案时一起改，断言里的标识符不能少。

## 各目录的约定

只在某个目录用得上的约定写在该目录的 AGENTS.md。Claude Code 读到那个目录里的文件时自动加载；Codex 只自动读工作目录到仓库根这一路上的 AGENTS.md，改别的目录前要自己读。

- [apps/web/AGENTS.md](apps/web/AGENTS.md)：界面与设计系统 lint
- [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md)：主进程与 IPC、桌面 E2E
- [packages/runtime/AGENTS.md](packages/runtime/AGENTS.md)：真实模型调用与回归、模型与凭据、Harness 与执行、Canon、目录与存储
- [packages/cloud-postgres/AGENTS.md](packages/cloud-postgres/AGENTS.md)：Cloud schema 与默认 skip 的集成测试
