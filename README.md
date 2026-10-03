# Suiming

燧明界的根产品：以桌面创作工作台为核心产品，通过专属 Suiming Agent、版本化 Story Artifact、AI-native 故事语言和确定性 Checker，生成可验证的高质量长篇小说。CLI、Codex / Claude Code / Grok integrations 与可选 Cloud 共用作品与运行能力。

> **当前状态**：处在[路线图](docs/roadmap.md)的 S5——桌面工作台与自主 Agent 已贯通并收敛到 Session 模型，Cloud 只剩 Canon 与显式同步；证据最高到「真实调用」，还没有完整长篇。本阶段做的是真实长篇质量、Harness 余下切片与认证发行。具体队列见路线图第 6 节，完成度与已知缺陷见[当前状态](docs/current-status.md)；这一段只在阶段变化时改。

## 核心心智模型

```text
用户目标 / 作品 Intent
   ↓
Suiming Agent
   ↓ 在作者的 checkout 上读取、修改、自检
Agent 按需委派与独立 Review，再裁决
   ↓
checkout diff → ChangeSet → Checker
   ↓ 原子提交
ProjectRevision（阶段成果；同一个对话可以接着改）
   ↓
版本化 Story Artifact
```

- Story Artifact 是作品长期记忆；会话、任务、trace 和索引不是 Canon。
- Story Search 允许 Agent 按表达意图发现相关 Story Artifact，并回到当前版本原文核实；`refs` 只保存已确认的重要关系。
- Agent 对作者这一轮的目标负责，可直接执行或委派；Capability 是可组合的领域动作，写作方法是可选的，子任务是 task-local loop，结果先保存再交还。
- StoryOutline 保证因果完整，StoryText 保证体验完整。
- Checker 验证确定性边界，Review 提供可反驳的文学判断。
- Agent 直接在作者的 checkout 上用受限文件工具迭代，没有 shell；作者、host agent 与它只有一份候选，提交走同一条 diff → ChangeSet 路径。事件是 AG-UI 标准事件与 Suiming 扩展（`SessionEvent` 信封，threadId 是 sessionId、runId 是 turn id），作品与 diff 经领域查询读取。
- 每个 Local 或 Cloud Project 都以已提交的 ProjectRevision 为权威；本地作品目录就是 git 仓，历史随它走；正文与审稿的时效从历史派生，不另存 evidence。开放作品包是无历史的快照，支持字节稳定 round-trip、迁移和外部 Agent 接续。
- 本地 SQLite 保存 Session / Task 执行数据，Cloud PostgreSQL 保存 Canon 与同步数据；Langfuse 只观察调用，故事专属 Eval 保存质量证据。

## 安装

需要 Node 24。从源码安装本地 CLI：

```sh
npm install
npm run build
npm link -w @suiming/cli
suim --version
```

`npm link` 把全局 `suim` 指向本仓的 `apps/cli`。旧仓 suiming-story 的 CLI 也叫 `suim`，两者只能有一个在 PATH 上；在哪个仓里再跑一次 `npm link -w @suiming/cli` 就切到哪个。用 fnm / nvm 的话，每个 Node prefix 各有一份全局链接，要在 coding agent 实际使用的登录 shell 里执行，之后用 `zsh -lc 'which suim; suim --version'` 确认。

## 开始一部作品

```sh
suim init ~/stories/my-book --intent-file intent.md --agent codex
cd ~/stories/my-book
```

`init` 在空目录写最小 Design（一个空卷的 Story index）、把文本文件写成 `intent/book.md`，把目录登记为 Local Project 并提交第一个 ProjectRevision；`--agent` 装上该 host 的 Skill、agent 文件、`AGENTS.md` / `CLAUDE.md` 标记段与 `.gitignore` 标记段，可重复，也可事后用 `suim update --agent <host>` 补装或刷新。已有的 Open Story Directory 上 `init` 保留作品内容并登记；显式初始化含普通辅助文件的目录时会补齐最小故事结构。已初始化作品不能重复 `init`，后续维护用 `update`。

接入维护在作品目录执行：

```sh
suim update                  # 刷新所有已安装接入
suim update --agent grok     # 补接 Grok，或只刷新 Grok
```

`--agent` 可以重复指定多个 host。`update` 不修改故事内容，不升级 CLI 或 host 程序；未初始化目录先用 `init`。Codex agent 的作者模型配置会保留，接入器更新角色指示；TOML 重写可能调整格式和注释。

然后用所选 host 打开这个目录，用自然语言说明创作要求，例如：

> 请读取 AGENTS.md，按 suiming Skill 从现有作品意图开始，完成并审查完整 Story Design；在 Design 稳定前不要生成正文。

host 的模型与凭据照常使用；只有显式 `suim session send ...` 才走 Suiming 自己的 Agent 与 model profile（见下文模型配置）。各 host 的细节见 [integrations](integrations/README.md)。

## 产品入口

作者主要通过自然语言与 Agent 协作，同时使用 StoryOutline、人物、Contract、World、StoryText、Review 和 revision diff 等派生视图理解作品。默认自主创作不要求逐项人工接受；作者可以随时打断、修改方向、直接编辑 artifact 或回退 revision。

- 本地 CLI：无子命令显示帮助；`suim session send "创作要求"` 启动一次对话，后续用 `--session <id>` 继续。TUI 已删除。
- Coding-agent integrations：Codex / Claude Code / Grok 直接编辑同一个 Open Story Directory，再由 `suim check / commit` 接纳为 ProjectRevision。
- Local revision：`suim history` 查看线性历史，`suim rollback <revision-id>` 将历史快照恢复为新的 revision，不改写或删除既有历史。
- 本地桌面端：最终核心产品，首个工作台已实现。在 Electron 工作台中阅读与编辑正文、查看 Design / 人物 / Contract、比较修改并与 Agent 协作；主进程运行 Runtime，renderer 经 IPC 接入。
- Cloud Web：后续可选入口，复用桌面工作台，通过 Domain API 读取作品与观察远程 Agent；创作闭环验证门之后实施。

本地 CLI 与桌面共用持久 AG-UI 与类型化 Suiming 扩展。subscription 与 IPC 只负责传输；命令启动与只读 attach 分开，重连不重执行模型。Cloud 执行和 SSE 已删除，远程 Agent 保持冻结。作品、Review 与 diff 从 Runtime 回读，客户端不拥有运行真源。

## 文档

阅读顺序与各自管什么见 [AGENTS.md](AGENTS.md)「真源与阅读顺序」，这里只列入口：

- [需求与目标](docs/vision-and-requirements.md)
- [故事创作宪法](strategies/story-constitution.md)
- [Story Language](story-language/README.md)
- [系统架构](docs/architecture.md)
- [作者工作台设计](docs/web-product-design.md)、[可视化设计](docs/visualization-design.md)
- [Harness 设计](docs/harness-design.md)、[evidence 派生设计](docs/derived-evidence-design.md)
- [技术栈](docs/technology.md)
- [当前状态](docs/current-status.md)
- [实施路线图](docs/roadmap.md)
- [从 suiming-story 迁移](docs/migration-from-suiming-story.md)
- [ADR](docs/adr/README.md)（历史决策，不是现行规范；已完成的重构方案与收敛方案同理）

## 代码形态

当前只创建已经承载真实行为的边界：

```text
apps/
  api/       Domain API handler、Fastify-compatible 注册边界与 OpenAPI projection
  cli/       suim executable、agent-facing JSON contract 与 headless 入口
  desktop/   Electron 主进程、凭据与共享 Runtime
  web/       React 作者工作台，经 typed IPC 接入桌面

packages/
  story/     Story Language、Story Core、Checker
  runtime/   artifact、SuimingHarness、events、model、local / cloud / sync
  cloud-postgres/  PostgreSQL Canon persistence adapter
  cloud-s3/  S3-compatible object storage adapter
  sdk/       Cloud Domain API schema、route catalog、wire codec 与 typed client

integrations/
  shared/    三类 coding-agent 共用的薄 Skill
  codex/     Codex project-scoped 入口
  claude-code/  Claude Code project-scoped 入口
  grok/      Grok project-scoped 入口
```

`apps/api` 已接通 PostgreSQL / S3 Canon 与显式同步；`apps/worker` 和 Cloud 执行已删除，Cloud 目前没有 Agent，共享 SuimingHarness 的 Cloud host 在解冻时实现。桌面主进程 `apps/desktop` 与共享工作台 `apps/web` 已接入同一 Runtime；`packages/eval` 尚未建立，Eval 按真实证据需求推进。

## 当前检查

需要 Node 24：

```sh
npm run check
npm test
npm run build
```

## 模型配置

Model Gateway 支持按任务配置 `main`（对话用的根 Agent）、`reviewer`、`writer`、`source-reader`、`source-extractor` 与 `judge`（盲读评委，应与 writer 不同的模型）profile。正式本地产品从 `~/.suiming/config.toml` 读取路由，从 `~/.suiming/auth.json` 或 provider credential store 读取 secret；开发和 CI 可以使用 [`.env.example`](.env.example) 中的 `SUIMING_*` 覆盖。`main` 的 provider / model 必填，其余 profile 未配置时复用 `main`，也可以使用不同 provider 或模型。每次模型调用会向显式注入的 telemetry context 发出不含 Prompt、响应正文或 secret 的 span；默认使用 NOOP。Langfuse 是可选观测后端，不是模型调用前置条件。

Cloud API 开发进程使用 `.env` 中显式的 `SUIMING_POSTGRES_*` 与 `SUIMING_S3_*` 配置：

```sh
npm run dev:api
```

API 常驻运行，响应 SIGINT / SIGTERM，默认监听 `127.0.0.1:3001`。当前 executable 用 `SUIMING_CLOUD_ACTOR_ID` + `SUIMING_CLOUD_ACCESS_TOKEN` 提供单 actor 开发认证，生产部署应替换注入的 authenticator，而不是共享这枚 token。S3 使用 AWS 默认 credential chain；只有 MinIO 等显式 endpoint 才通常需要同时配置 access key、secret key 与 `forcePathStyle=true`。完整字段见 [`.env.example`](.env.example)。

模型调用复用 pi-ai，loop、交接与恢复由 Suiming 自行实现；不建设通用 Agent 平台或 Codex App Server 第二后端。Cloud Web、生产云服务与全功能 MCP 保持冻结。作者选择、实际修订与 Dataset 持续积累，旧仓不是默认质量标准。

## 运行桌面工作台

```sh
npm install
npm run dev:desktop
```

打开已有 Suiming 作品，或选择空目录创建。桌面主进程直接运行 Runtime，无需启动 API。模型使用现有 `~/.suiming/config.toml` 与凭据存储，也可在导航轨底部的「设置」里配置（「模型配置」管 profile，「提供商」管 API key 与登录）；阅读和编辑无需模型。开发环境变量可用 `node --env-file=.env node_modules/electron/cli.js apps/desktop/dist/bin.js --project=/absolute/project/path` 显式加载。

验证使用 `npm run check`、`npm test` 与 `npm run test:desktop`。最后一项启动真实 Electron，验收中文编辑、正文 / Review / 提交、外部文件冲突、renderer 重载和主进程恢复。此入口是开发构建；安装包、签名与升级仍属于发行阶段。
