# 技术栈

本文记录已确认的技术选择及其边界。技术服务产品目标，不定义 Story Language；框架发生变化时，Story Artifact、Domain API 和 Eval 语义应保持稳定。

桌面产品由自有 Runtime / SuimingHarness + pi-ai 支撑：执行方向见 [ADR-0012](adr/0012-own-suiming-harness.md)与 [Harness 设计](harness-design.md)，桌面目标见 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md)，完成度见[当前状态](current-status.md)。

## 1. 技术选择

| 层 | 技术 | 用途 |
| --- | --- | --- |
| Runtime | Node.js 24；Electron 内置 Node 需实测兼容 | 本地与 Cloud 共享 TypeScript Runtime；桌面在主进程内运行 |
| Language | TypeScript 6，strict | 全部业务代码与协议 |
| Schema | TypeBox 1.x | Story Language、能力输入输出和 HTTP schema |
| Monorepo | npm 11 Workspaces | 少量 app/package 的直接管理；暂不引入 Turborepo/Nx |
| API | Fastify + TypeBox + OpenAPI | Cloud Domain API、鉴权与类型化诊断 |
| 工作台前端 | React 19 + Vite + TanStack Router/Query + shadcn/ui + Streamdown（Markdown 渲染，含流式）+ CodeMirror 6（源码编辑与 merge 比较） | 桌面首先实现，后续 Cloud Web 复用作品编辑与复杂视图；正文、设计文档与 Agent 消息共用一条 Markdown 管线 |
| 基础 UI 控件 | shadcn/ui + Tailwind v4；已接入 `apps/web`（组件源码在 `src/components/ui`，由 shadcn CLI 生成后随仓库维护） | 导航、按钮、表单、菜单、弹层与分栏基础；故事可视化和作品语义由 Suiming 负责 |
| AI 交互客户端 | `@tanstack/ai-client` / `ai-react`；已接 typed IPC | 复用消息 view state 与流处理，不引入其服务端 loop / provider 层 |
| Desktop | Electron 42；首个工作台已实现 | 作者面向的本地界面；主进程直接运行 `packages/runtime`，渲染层经 typed IPC，不起 localhost HTTP |
| CLI | Commander + TypeBox-derived JSON schema | `suim` executable、host-agent commands、headless automation 与 Cloud sync |
| Host integrations | Codex / Claude Code / Grok 原生 instructions、Skills 与 `suim --json` | 在现有 coding-agent 产品中直接创作同一个 Local Project |
| Cloud Database | PostgreSQL + Kysely | Cloud Canon 事务（Project、ArtifactVersion、ProjectRevision）、权限与同步；没有执行数据，也不做数据库搜索 |
| Local Canon | 作品目录的 git 仓（isomorphic-git）| `refs/suiming/canon` 是权威：revision = commit，快照 = tree，history = 祖先链 |
| Local Store | SQLite（Node `node:sqlite`）+ content-addressed object directory | **只有执行数据**：Session / Task、inbox、持久事件、命令回执、执行对象、部署登记与同步状态 |
| Cloud Object | S3-compatible API；开发环境 MinIO | 大 artifact（如 Source 原文）与导出包 |
| 界面事件 | AG-UI 标准事件 + 类型化 Suiming 扩展；已替换旧事件词汇 | 一份持久事件契约，经进程内 subscription 与桌面 IPC 消费；不长期双写两套协议 |
| Model | `@earendil-works/pi-ai` | 多 provider 调用、tool calling、structured output 与 streaming |
| Agent Harness | Suiming 自行实现，参考 pi-agent-core 逻辑 | 唯一模型 / 工具循环、持久动作、交接、控制与恢复；pi-agent-core 依赖已删除，没有预算，有每轮用量检查点（[Harness 设计](harness-design.md)第 10 节） |
| Telemetry | OpenTelemetry；Langfuse 可选 | 模型与工具 trace、成本、延迟和辅助评分 |
| Test | Node.js test runner + `tsx`；Playwright 驱动真实 Electron | 领域与恢复测试、桌面 E2E 与真实创作验收 |
| Quality | Biome + TypeScript | 格式、lint 与类型检查 |

依赖采用 lockfile 固定实际版本，定期升级；本文只固定具有架构意义的主版本或技术家族。

## 2. 为什么选择这套组合

### Fastify + TypeBox

Cloud Domain API 同时服务 Web、本地同步和远程外部 Agent，不能只存在于前端框架的 Server Function 中。Fastify 提供轻量服务端和成熟插件边界，TypeBox 让 runtime validation、TypeScript 类型与 OpenAPI 使用同一 schema。

不采用 tRPC 作为唯一 API，也不让 Web 解析 CLI 输出。内部 Agent 直接调用 Domain Service，HTTP 只承担远程边界。

### React + Vite + TanStack

作者端是对话、编辑、长运行、筛选、diff 和派生视图密集的应用，不以 SEO 为主。TanStack Router 提供类型安全路由与 URL 状态，TanStack Query 管理服务端数据，Vite 保持构建和部署直接。

renderer 用 `ai-client` / `ai-react` 管理对外消息与交互状态，Query 读取作品、版本、Review 和持久 session。Suiming 编写业务 activity / diff / Review 组件和 typed IPC connection adapter；启动与恢复通过唯一命令，attach 只读。客户端的 stop / retry 不决定后台生命周期，也不因客户端限制改动领域语义。

首期不采用 Next.js，也不依赖仍在演进的 TanStack Start 全栈层。未来营销站、公开 Reader 或需要 SSR 的产品入口独立评估，不能反向改变作者端 Domain API。

产品与交互真源见[作者工作台设计](web-product-design.md)，参考 Langfuse 界面模式的边界在它的第 8 节。

### Electron 桌面与执行底座

Electron 是核心作者应用；`apps/desktop` 承载主进程 / preload，`apps/web` 承载首先用于桌面的共享 React 工作台。Runtime、Local Store、凭据与 session owner 位于主进程，renderer 经受限 typed IPC 调用同一命令目录；不建立 localhost server，不把 Node Runtime 放进 renderer。CPU 密集的纯计算可移出主线程，不复制运行状态机。

执行用自有 SuimingHarness，pi-ai 只提供模型协议（为什么自建见 [Harness 设计](harness-design.md)第 1 节）。自有 Harness 的可靠性通过本项目故障注入与实际运行验收，不从可修改性推导更优质量或更低成本。Agent 拿到的是受限文件工具，没有通用 bash 工具（[系统架构](architecture.md) 6.2）。

重载 renderer、关窗与退出时 turn 怎么收尾见 [Harness 设计](harness-design.md)第 11 节。打包须验证 Electron 内置 Node、`node:sqlite`、中文输入、长文本和退出恢复；先验收 macOS，再按平台实际验证声明支持。安装、升级、备份与导出属于产品交付，不能以开发服务器能打开代替。

### CLI

`suim` **无子命令时只打印用法**，不进入任何交互界面；`session send` 提供 headless Agent，其余领域与 Cloud 子命令调用同一 application service。所有供 host adapter 使用的命令都提供版本化 JSON schema 与明确 exit code。

### Coding-agent integrations

Codex、Claude Code 和 Grok integrations 是薄的 host adapter，使用各平台原生的 instruction / Skill 机制，但不复制 Runtime、Story schema 或状态。adapter 告诉 host 如何读取 Story Language、直接编辑 Open Story Directory，以及何时调用 machine-readable 的 `suim --json`。具体平台文件布局可以随 host SDK 演进，稳定契约是当前 Story Language、capability schema 与 `suim --json` command schema。

host-native 模式使用 Codex / Claude Code / Grok 已配置的模型、凭据、会话和文件工具，不经 `pi-ai`，也不产生 Suiming-managed Session；文件变化只是 dirty candidate。`suim commit` 扫描实际 diff，Runtime 才在内部构造 ChangeSet 并提交 Local ProjectRevision。CLI 同时提供 Context、Search、Source、Design impact、Review 和 Release 等裸文件读写无法可靠替代的领域动作。用户也可以从 host 中显式调用 `suim session send`，此时切换为 Suiming Agent 与 model profile；它与 host 改的是同一份候选，两边不要同时大改同一部作品（[系统架构](architecture.md) 4.3）。

### AG-UI 与传输

界面事件用 AG-UI 标准消息、工具、Step / Activity 和交互生命周期承载通用事件，以 TypeBox 校验的 Suiming 扩展表达作品版本与持久 session 状态；标准 schema 复用上游，不手抄字段表。选它而不是继续自定义 RunEvent，也不是在 RunEvent 之外另建一层 AG-UI 投影：前者要自己维护通用协议、消息状态和界面集成，后者要长期维护两套事件词汇与映射；原生 AG-UI 加受校验的扩展只留一份界面事件契约，还能复用通用客户端。采用标准不消除业务定制，也不保证总成本一定低于自研。

事件契约与恢复规则（持久序号、先持久后发布、attach 只读、`threadId` / `runId` 的对应）见[系统架构](architecture.md) 6.5 与 [Harness 设计](harness-design.md)第 11 节。Cloud 侧没有事件存储，Cloud 产品继续冻结。

### Cloud PostgreSQL + Kysely

PostgreSQL 保存 Cloud 的作品 revision、ChangeSet、权限与审计。Story Search 不在数据库里：它是纯函数 `searchStoryCandidate`（[系统架构](architecture.md) 6.3），Cloud 现在不提供搜索，将来要有也调它。基于表达意图检索 Story Artifact 是稳定领域能力，将来换 embedding 或专用检索服务属于可替换实现，要经中文长篇消融证明收益。Kysely 保留 SQL 与事务心智模型，不要求把 Story Artifact 变成 ORM entity，也不引入代码生成客户端。

只使用 Kysely 的公开 PostgreSQL dialect、transaction 与 SQL 能力，不自定义 SQL dialect，不让查询构建器进入 Story Core。

数据库 driver 与 adapter 位于独立 `@suiming/cloud-postgres` 包，`packages/runtime` 只保留领域 port、reference semantics 和不可变 migration catalog，不直接依赖 Kysely / `pg`。composition root 创建并负责关闭 connection pool。migration runner 在一个 PostgreSQL transaction 中先取得固定 advisory lock，再核对 `suiming.schema_migrations` 是当前 catalog 的连续前缀与 checksum；所有待执行 statement 和 history insert 一起提交，任何失败都不留下半次 schema。多个 API 实例并发启动时允许等待同一 lock，不能各自猜测 migration 状态。

`PostgresCloudProjectStore` 在 object write 和 Checker 完成后才开启数据库 transaction；transaction 持有 Project row lock，重新检查 capability、幂等 receipt 与 base revision，再一起写入 ArtifactVersion reference、ChangeSet、ProjectRevision、head 和 receipt。ArtifactVersion 以 media type 与内容 hash 派生稳定 ID，文本可 inline，大对象只保存规范 object key；同 key 并发请求读取同一 receipt，不会生成两个 revision。数据库中的 ChangeSet JSONB 引用 ArtifactVersion，不复制 base64 大内容。

`packages/cloud-postgres` 只有 `PostgresCloudProjectStore` 与 `PostgresArtifactVersionStorage`，即 Canon 与同步。Cloud 没有执行，为什么删、解冻时从哪里接，见[系统架构](architecture.md)第 9 节。

### Local SQLite 与 Open Story Directory

本地产品使用 Node.js 自带的 `node:sqlite`，避免要求用户安装 PostgreSQL、Docker 或 Cloud account。SQLite 只保存执行数据与部署登记——Session、Task、inbox、持久事件、命令回执与同步元数据；作品版本在作品目录的 git 仓里；大型或二进制字节进入 `.suiming` 下按内容寻址的 object directory。作品的事务与 baseRevision 语义由 git Canon 承担（`CanonStore` 契约，`change_set_stale` 拒绝陈旧基线），与 Cloud 的 PostgreSQL 实现是同一套语义；SQLite 这边只对执行数据做版本检查，保留本机进程锁并以每次领取的 ownerId 拒绝旧 owner 写入，不模拟分布式 Worker 服务。

Open Story Directory 是 Local Project 的 checkout，也是 repository-native integrations 和 `cloud checkout` 的统一目录格式。外部工具可以直接修改它，Runtime 通过确定性扫描和内容 hash 计算 status / diff，经 Checker 后在内部生成 ChangeSet；外部工具不提交 ChangeSet schema。更新多文件 checkout 时使用 journal + 临时文件 + atomic rename，并在下次启动时恢复；SQLite transaction 与文件系统无法假装成一个跨介质事务。

`.suiming` 不属于开放作品格式，不随 export 或默认 Cloud push 上传。remote binding 也位于其中，但 secret 只保存在用户级配置、环境变量或 OS credential store。作品目录本身就是 git 仓：ProjectRevision 是 `refs/suiming/canon` 上的 commit，作者或 host 自己的普通 commit 只是候选，进不了 Canon（[系统架构](architecture.md) 4.3）。

本地修改命令需要 project-scoped process lock；所有提交仍检查 baseRevision。文件枚举与 Open Story Package 使用同一个 story package codec：识别的 Artifact 进入 snapshot，`.suiming` / `.git` 和明确的仓库辅助文件不进入，Story Language 保留路径下的未知文件则报错，避免静默丢失。扫描拒绝 project root 外 symlink / path traversal。host 侧的 `rg` 只用于召回可读 checkout 内容，结果仍要回到已识别 artifact 才能作依据；Suiming Agent 没有 `rg`，搜索走 `searchStoryCandidate`。

Runtime 只实现当前 story package codec，不读取旧 `.suim`，也不提供 legacy importer。需要保留的开发期 fixture 和作品数据直接在仓库中一次性重写到当前格式；其余旧运行数据可以丢弃。

### OpenTelemetry + Langfuse

Suiming 直接使用 OpenTelemetry 埋点，现有 pi-telemetry 显式 TelemetryContext port 与 NOOP 保留，不引入 Agent framework integration。Local / Cloud composition root 负责 SDK 与 exporter。每次进程内驱动使用有限 trace，模型、工具与 Checker 形成 span；恢复沿用同一个 Session / Task，以新 trace 关联，不能让跨重启的 Session 对应一个必须恢复的长 span。

Langfuse 是可选的 OpenTelemetry 后端，用于查看调用树、经数据策略允许的 Prompt 与响应、延迟、token、缓存、成本、错误和辅助 score。它帮助我们避免自建通用 trace UI，但可关闭、替换或自托管，故障不能影响创作和任务恢复。CLI 退出时调用有界 shutdown，由 SDK 导出已结束的 span 并关闭 provider，不再叠加两次等待；桌面主进程在 5 秒的退出窗口内为保存和观测收尾分配时间。Cloud API 接线随真实 engine host 实现推进。执行存储保留恢复所需消息、准确调用绑定与 Context 引用、动作结果、权威用量和 trace 关联；数据归属见 Harness 设计。trace 可丢失，不能作为这些数据的唯一保存位置。

桌面主进程 → Workspace → Controller → Harness → Gateway 全程接了观测。开发时从仓库根目录运行 `npm run dev:desktop`，启动脚本加载根 `.env`，已有进程环境优先；直接运行 Electron 需由启动环境提供配置。Langfuse keys 只留在主进程。OTLP 发送 v4 header，并向子 observation 传播 session、turn / Task 与 project 的可筛选关联字段。Review 归属父 Task；模型、工具与阶段提交 Checker 分别记录。缓存 token 按互斥分类上报，费用使用实际消息用量中的金额。默认不采集 prompt / 正文，通用异常仅记录类型；导出失败或超时用脱敏诊断码报告，不影响领域结果。验收见[Langfuse 检查与修复](validation/2026-09-11-langfuse-audit.md)。

Langfuse 的 Prompt、Dataset、Experiment 和 Score 不作为 Suiming 真源。故事专属 Eval 需要绑定完整 ProjectRevision、Context、候选、随机重复、paired blind result、作者修改和发布反馈，由 Suiming 保存；需要观察时可以把其 score 副本发送给 Langfuse。完整 Prompt、provider payload 和 stream event 不默认长期复制进 Cloud PostgreSQL 或 Local SQLite。

### `@earendil-works/pi-ai`

首期采用 `@earendil-works/pi-ai` 作为默认多 provider 调用层，文中简称 `pi-ai`。它直接使用 TypeBox，覆盖 OpenAI、Anthropic、Google、xAI、DeepSeek、MiniMax、Moonshot、Qwen、ZAI 和 OpenAI-compatible provider，并保留各 wire API 的类型化参数、thinking 流、严格 tool schema、prompt cache、usage 与原始 payload 调试能力。旧包名 `@mariozechner/pi-ai` 已 deprecated，不再作为依赖。

`pi-ai` 本身就是模型调用边界。Model Gateway 是 Suiming 的应用服务，不是另一套 provider 协议。边界固定为：

- `Model Gateway` 是 Suiming 的应用模块，负责模型选择、凭据、调用记录和失败分类；
- 每类模型任务显式选择稳定的 `modelProfileId`；静态配置把 profile 映射到 pi `Model`、provider-specific 参数与凭据引用，不建立自动 Router 或模型配置数据库；
- profile 是 `main`（对话用的根 Agent）、`reviewer`、`writer`、`source-reader`、`source-extractor` 与 `judge`（`model/config.ts` 的 `MODEL_PROFILE_IDS`）。只有 `main` 必须配置，其余省略时复用 `main`；各 profile 可指向不同模型，也可共享同一 provider 和凭据；Langfuse 不是模型调用前置条件；
- Model Gateway 直接使用 pi 的 `Model`、`Context`、stream event 和 provider-specific options；不重新定义平行的 provider message、tool 声明或 stream event；工具 execute、动作效果与持久结果是 Suiming 的应用契约；
- 每个 turn 冻结解析后的 provider、model、参数与工具声明（[Harness 设计](harness-design.md)第 4 节），每次模型调用从消息列表和受控工具结果构造临时 pi `Context`；只持久化恢复、计费和 Eval 所需的结果或引用，详细 trace 通过 OpenTelemetry 输出；pi Context 不是会话、任务或作品真源；
- 工具与结果通过现有 schema、Checker 和 tool contract 校验，错误作为工具反馈供模型修正；不靠强制类型转换掩盖无效输出，也不固定只允许一次修复。恢复需要的原始消息、结果与 Context 引用先持久化；transport error 与语义错误分别处理，不能透明换模型或重复已确认副作用；
- 高杠杆任务使用 provider-specific `stream` / `complete` 参数；`streamSimple` / `completeSimple` 只用于确认不需要原生差异的调用；
- 长期上下文不靠 pi 的跨 provider thinking 转换交接，耐久的结论写回作品（不变量 8）。换模型只发生在 turn 边界，Session 的消息列表照常接着用，其中的 thinking 块由 pi-ai 按目标 provider 转换（[Harness 设计](harness-design.md)第 4 节）；
- 原始 provider payload、response id、usage、stop reason、thinking/tool 事件和错误进入可追溯 trace，但不进入 Story Canon。

若某项新模型能力无法由 `pi-ai` 无损表达，依次尝试 provider-specific API 和 custom provider；仍有缺口时先用固定输入做官方 SDK 对照测试，确认存在质量或可重放差异后，再在 Model Gateway 内局部接入。只有形成两个需要长期互换的完整实现时，才按真实差异抽取调用接口。不得因假设未来替换而预先维护平行协议或官方 SDK adapter。不采用 Mastra、LangChain 或其他通用 Agent framework。

### 本地配置与凭据

本地产品以 `~/.suiming/config.toml` 作为人类可编辑的用户级配置真源，模型路由不应长期依赖项目根目录 `.env`。首期配置形态如下；`main` 以外的 profile 省略时复用 `main`：

```toml
version = 1

[models.profiles.main]
provider = "deepseek"
model = "deepseek-flash"
thinking = "high"

[models.profiles.main.options]
maxTokens = 65536

[models.profiles.reviewer]
provider = "deepseek"
model = "deepseek-flash"
thinking = "high"

[models.profiles.source-reader]
provider = "deepseek"
model = "deepseek-flash"
thinking = "low"

[models.profiles.source-reader.options]
maxTokens = 32768

[cloud]
endpoint = "https://cloud.suiming.example"
actor_id = "author-id"
```

`main` 以外的 profile（`writer`、`reviewer`、`source-reader`、`source-extractor`、`judge`）都可省略，省略时复用 `main`。这不是自动 Router，而是按 Task kind 选择并冻结实际 profile。`thinking` 是设置页写的档位，绑定时由 Gateway 转成 provider 的 API 参数（[Harness 设计](harness-design.md)「对话模型选择与默认配置」）；provider 的原生参数也可以直接写在 `options` 里。

示例沿用本项目真实调用过的 provider / 模型（`deepseek-flash` 是 DeepSeek 官方 V4.1 Flash 在 pi-ai 目录里的 id；旧的 `deepseek-v4-flash` 已从官方 provider 目录消失，写它会报找不到模型），不表示已证明它的文学质量最优；模型 id 随 pi-ai 升级可能再变，以安装版本的目录为准。正式盲排实验按协议选择 `judge`，不在可复制配置中留下虚构模型名。实际可用参数以安装版本的 provider schema 为准。

`[cloud]` 只保存非敏感 endpoint 与本地登录主体；`suim cloud` 的解析优先级为命令行 → `SUIMING_CLOUD_*` 环境覆盖 → 用户配置。endpoint 另有一层：已经建立的 remote binding 保存该 Project 实际使用的 endpoint，它只让位于命令行，优先于环境覆盖与用户配置。API key、OAuth token、Cloud access token 和其它秘密不写入 `config.toml`。Suiming 为 `pi-ai` 注入持久 `CredentialStore`：首期可以使用权限为 `0600` 的 `~/.suiming/auth.json`，macOS 后续可由同一 store port 改接 Keychain；Cloud 使用加密 secret store。本地开发期 Cloud SDK composition root 从 `SUIMING_CLOUD_ACCESS_TOKEN` 注入 Bearer token，正式登录态再接独立的系统 credential store。用户级模型认证按 provider id 保存，例如 `qwen-token-plan-cn` 与 `qwen-token-plan-individual` 是两个独立 credential scope。

`[models].disabled_providers` 保存本机停用的 provider id，未列出的默认启用。它独立于凭据与 profile；模型目录隐藏停用项，Model Gateway 拒绝新绑定（包括显式模型选择），冻结绑定继续按 turn 的绑定快照恢复。桌面开关经唯一 SDK 命令 `models.provider.setEnabled` 写入同一 config.toml，不另建偏好数据库。

本地路由解析优先级为本次对话显式选的模型 → `SUIMING_*` 环境覆盖 → `~/.suiming/config.toml`。provider 凭据遵循 `pi-ai` 语义：持久 CredentialStore 优先，provider 官方环境变量只作无已存凭据时的 fallback。`.env` 仅用于仓库开发、CI 和容器，并由启动器或 `node --env-file` 显式加载；产品运行不能搜索当前目录并静默摄入任意 `.env`。

订阅套餐额度与单次调用参数必须分开。`maxTokens` 是单次模型输出上限，不是 Token Plan 的总额度或 Context window；套餐 Credits 由 provider 根据专属 API key 与 Base URL 在服务端扣减。Suiming 的创作路径不设调用上限（[Harness 设计](harness-design.md)第 10 节），也不能用一个虚构的“套餐 token 总数”覆盖 provider 账单状态。

凭据按 provider 的实际认证接口、权限、额度和错误处理接入。删除仅依据 `isSubscription` 或 provider 名单禁止 automation 的判断，以及仅服务于此的 `ModelCredentialUse`、CLI 选项和观测字段；不保留虚假的用途开关。当前代码已删除该规则及其专用配置。某个 OAuth provider 在 pi 中存在，不等于 Suiming 已完成登录、刷新、取消与恢复验收，也不等于标准 API 能消费另一产品的订阅。

### Cloud S3-compatible Object Storage

PostgreSQL 保存普通 Markdown/JSON artifact 和元数据；超大 Source、媒体、导出包、备份，以及恢复、审计或 Eval 明确需要长期保存的大型 Context 与模型输出进入对象存储。普通 trace payload 服从观测后端的保留策略，不默认再复制一份。对象存储中的长期对象由数据库保存引用、权限、类型和生命周期。

本地没有 ArtifactVersion（作品版本是 git blob），只有执行对象沿用同一套内容标识与 inline 判定（`artifact/version-storage.ts`）。Cloud 对外置内容先以 SHA-256 key 幂等写对象存储，并核对返回的 hash、key 与 byte length，再在 PostgreSQL transaction 中写 ArtifactVersion 引用和推进 Project head；对象写失败时不开始数据库提交，数据库失败时只可能留下未引用对象，由后续 GC 回收。不得用“先推进 revision、再补传对象”的顺序制造可见但无法读取的 Canon。

独立 `@suiming/cloud-s3` 使用 AWS SDK v3 实现该 port。逻辑 key 固定为 `objects/sha256/<prefix>/<hash>`，部署 prefix 只作用于 bucket 内的物理路径；写入同时携带 SHA-256 checksum、hash 与 byte-length metadata，读取必须重新计算内容 hash 并交叉核对响应长度、metadata 与可用 checksum。S3 client 由 deployment composition 创建并显式关闭，AWS 默认 credential chain 与显式 S3-compatible endpoint 均留在 adapter 边界。真实 MinIO 测试已覆盖跨实例读取、重复 put、输入拷贝、损坏对象拒绝、not-found 与幂等删除。

## 3. 暂不引入

| 技术 | 暂不采用的原因 | 重新评估条件 |
| --- | --- | --- |
| Redis / BullMQ | 增加一致性与运维边界；Cloud 现在没有执行，也就没有任务队列 | Cloud 执行解冻后，任务领取成为可测瓶颈 |
| Tauri | Runtime 是 Node，Tauri 需要把它做成 sidecar 并经 IPC / HTTP 通信，把 Electron 主进程能直接消掉的进程边界加回来 | Runtime 不再依赖 Node，或 Electron 体积成为分发的实证障碍 |
| Obsidian 插件 | 最快能用，但产品会绑在别人的平台、插件模型和私有状态上，与拒绝 fork coding agent 的理由相同 | 不重新评估；把目录当 vault 打开阅读不在此限 |
| ClickHouse | 适合海量 trace 分析，不适合 Story Canon | 官方云观测量超出 Langfuse/托管后端能力 |
| LangGraph / Temporal | 显式任务结构由同一 SuimingHarness 承载，不新增通用工作流执行器 | 当前执行方向已确定，不建设替代内核 |
| pi-agent-core Harness / Codex App Server / 完整 Agent framework | 已确定参考逻辑自行实现 SuimingHarness，不依赖或移植其他内核（[Harness 设计](harness-design.md)第 1 节） | 不作为当前设计的替代路径 |
| TUI（曾有的 `apps/tui`，基于 `@earendil-works/pi-tui`） | 2026-09-13 删除：它是一千行的开发者控制台，产品是桌面，把 Run / Attempt 的词汇改到 Session 等于重写一遍 | 不重新评估 |
| CopilotKit / A2UI / TanStack AI 服务端 | 已选 AG-UI 与轻量 React client，不需要额外 agent loop 或通用生成 UI 平台 | 出现现有组件与领域工具无法表达的真实交互 |
| TanStack AI 客户端的 `/ui` 组件工厂（`createChatUI` / `toolsComponents` / `interruptsComponents`） | 未评估，不是冻结项。今天接上去收不到数据：Runtime 不发标准 `TOOL_CALL_*`，工具动作投影成 `suiming.action`；两者并存即双协议投影。`toolsComponents` 无 fallback，未注册的工具名会让该次调用在转录里消失，而工具有 18 个以上；官方要求自备全部可见组件，与 workbench-v7 的一致性验收冲突 | **已裁决：`bridge.ts` 不补成双向。**决策卡的问答往返走普通消息——模型在文本里问、停下，作者的回答是 inbox 的下一条——与 attach 无关，attach 保持只读，不变量 10 不动。因此也不需要 TanStack 的 `interrupts` 通道，自建卡片即可。剩下的唯一缺口是 `validateProductEvent` 的 CUSTOM 白名单要放行一个新事件名 |
| MCP Apps（`ui://` 资源 → 沙箱 iframe） | 需要未装的 `@tanstack/ai-mcp` 与自托管 sandbox-proxy 页，撞全功能 MCP 冻结，也与「renderer 打不开外部窗口、链接渲染成 span」的安全模型冲突 | 全功能 MCP 解冻后另行评估 |
| TanStack Start / Next.js | 作者端不需要同构全栈框架 | 独立入口出现明确 SSR/SEO 需求 |
| pgvector / 专用向量数据库 | Story Search 是正式能力，但语义路由的存储与运行引擎尚未证明长篇收益 | 中文长篇消融证明语义召回在质量、Context 或成本上显著增益 |
| CRDT / WebSocket | 首期不做多人同文档实时协作，单作者单写入者足够 | 多人实时编辑成为核心需求 |
| 无沙箱的通用 shell | managed 创作由领域能力与受限文件工具覆盖，Canon 写入走 ChangeSet。需要算的（统计用词、推演资源曲线、核对日期）由切片 F 的 `run_command` 在 Seatbelt 沙箱里跑，未实现（[Harness 设计](harness-design.md)第 8.5 节） | 不做无沙箱版本；Seatbelt 不在的平台上这个工具不出现 |
| Kubernetes / 微服务 | 模块化单体足以验证产品 | 独立扩缩、故障隔离或团队边界形成实证需求 |

## 4. 部署形态

桌面是核心本地发行物；host integrations 由 host 调用同一个 `suim`。本地作品能力不依赖 Cloud：

```text
Electron renderer → typed IPC → 主进程 Runtime → SQLite + 对象目录
                                      ├→ SuimingHarness → pi-ai → model provider
suim CLI      → 同一 Runtime           └→ optional Cloud SDK
Codex / Claude Code / Grok → checkout + suim 领域命令
```

Cloud 现在只有一个应用，承担 Canon 与显式同步：

```text
api ──→ PostgreSQL
 └───→ S3-compatible Object Storage

api ┄┄OpenTelemetry（尚未接线）┄┄→ optional Langfuse
```

Cloud 开发环境使用 PostgreSQL 与 MinIO；API 从显式环境配置建立连接并有界关闭。当前静态 bearer token 只用于单 actor 开发，生产 identity 冻结。Cloud Web 与执行 host 冻结，解冻时从哪里接见[系统架构](architecture.md)第 9 节；共享契约变了，已有 adapter 随之修正，但不借此启动 Cloud Web 或远程 Agent 产品建设。
