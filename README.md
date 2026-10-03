# 燧明界 Suiming

[![CI](https://github.com/huangzhibo/suiming/actions/workflows/ci.yml/badge.svg)](https://github.com/huangzhibo/suiming/actions/workflows/ci.yml)

写长篇小说的 AI 工作台。专属的 Suiming Agent 在你的作品目录上读、写、自检、委派独立审稿；作品是版本化的 Story Artifact，用一套面向 AI 的故事语言（Story Language）表达，由确定性的 Checker 守住每一次提交。核心产品是本地桌面工作台，`suim` 命令行与 Codex / Claude Code / Grok 接入共用同一套 Runtime 与 Checker。

*An AI workbench for long-form fiction. See [English](#english) below.*

<!-- 这一段只在阶段变化时改。 -->
> **当前状态：开发预览。**桌面工作台与自主 Agent 已经贯通，但证据最高只到「真实调用」：还没有一部完整的长篇在它上面写完，也没有安装包，目前只在 macOS 上验证过。完成度与已知缺陷见[当前状态](docs/current-status.md)，接下来做什么见[路线图](docs/roadmap.md)第 6 节。

## 它解决什么

让 AI 在长篇尺度上持续理解同一部作品：人物、时间、关键物品、谁知道什么、长期埋下的期待，写到后面也不走样；同时作者随时能读、改、比较、回退自己的作品，不被锁进某个服务。

- **作品就是一个普通目录。**大纲、人物、世界设定、正文、审稿都是 Markdown 文件；作品目录本身是 git 仓库，历史随它走。人、Agent、外部 coding agent 改的是同一份文件。
- **只有过了 Checker 的修改才算数。**Checker 只管确定性的东西：格式、引用、顺序、硬状态（谁持有什么、谁已死去、哪个秘密何时揭开）、长期期待是否按期回应。文学好坏交给模型与独立审稿，不交给规则。
- **Agent 自主推进，作者随时插手。**一次对话里 Agent 可以直接改、委派写作或审稿的子任务、阶段性提交多个版本；作者可以打断、补充意图、直接编辑，长期成立的要求会写回作品的 `intent/`，而不是只留在聊天记录里。

```text
作者的目标 / 作品意图（intent/）
   ↓
Suiming Agent：在作品目录上读、改、自检，按需委派写作与独立审稿
   ↓
目录 diff → Checker → 原子提交
   ↓
作品的一个版本（同一个对话可以接着改）
```

## 快速开始

需要 Node.js 24 以上与 git。桌面端目前只在 macOS 上验证过，其他平台未验证。

### 桌面工作台

```sh
npm install
npm run dev:desktop
```

打开一个已有作品，或选一个空目录新建。阅读与编辑不需要模型；要和 Agent 对话，在导航轨底部的「设置」里配置：「提供商」里填 API key 或登录，「模型配置」里给各个角色选模型。目前是开发构建，安装包、签名与自动升级还没做。

### 命令行 `suim`

```sh
npm install
npm run build
npm link -w @suiming/cli
suim --version
```

```sh
suim init ~/stories/my-book --intent-file intent.md   # 新建作品，intent.md 是你的创作意图
cd ~/stories/my-book
suim session send "先读意图，设计第一卷的大纲，检查后提交"
suim status        # 作品状态：未提交的修改、过时的正文与审稿
suim check         # 跑 Checker
suim history       # 版本历史；suim rollback <revision> 恢复成一个新版本
```

不带子命令运行 `suim` 显示全部命令；加 `--json` 得到给程序用的稳定输出。

### 在 Codex / Claude Code / Grok 里写

```sh
suim init ~/stories/my-book --intent-file intent.md --agent claude-code
```

`--agent`（可重复，`codex` / `claude-code` / `grok`）会在作品目录里装上对应 host 的 Skill 与入口说明，之后用那个 host 打开目录、用自然语言提要求即可；host 用它自己的模型与凭据，经 `suim check` / `suim commit` 提交。已有作品用 `suim update --agent <host>` 补装或刷新。细节见 [integrations](integrations/README.md)。

## 一部作品长什么样

```text
my-book/
  intent/                  作者意图：当前仍然有效的创作要求
  outline/story/index.yaml 卷与节的顺序
  outline/story/vol-0001/  每一节（StoryBeat）的完整因果设计
  outline/contracts/       需要跨多节回应的长期期待
  world/                   世界设定；characters/、places/、resources/ 是人物、地点与物品
  text/                    正文，一节一个文件
  review/                  独立审稿
  reference/style/         作者选定的样章
  source/                  导入的原作材料与忠实抽取（改编时用）
```

字段的含义与写法见 [Story Language](story-language/README.md)；最小的完整例子是测试样例里的苦肉计与火烧赤壁（[`packages/runtime/test/sample-work.ts`](packages/runtime/test/sample-work.ts)）。

## 模型配置

模型调用基于 [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)，可以用它支持的各家提供商。不同角色可以用不同模型，比如 `main`（对话的根 Agent）、`writer`、`reviewer`、`judge`（盲读评委，最好与 writer 用不同模型）；除 `main` 外都可以省略，省略时用 `main`。

配置在 `~/.suiming/config.toml`，桌面「设置」改的也是这份文件：

```toml
version = 1

[models.profiles.main]
provider = "deepseek"
model = "deepseek-flash"
```

全部角色与完整形状见[技术栈](docs/technology.md)「本地配置与凭据」。凭据存在 `~/.suiming/auth.json`，经桌面设置或提供商自己的登录流程写入；开发时也可以用 [`.env.example`](.env.example) 里的 `SUIMING_*` 变量覆盖。

部分提供商支持用订阅账号登录。各家对第三方应用使用订阅登录的条款不同，以提供商的条款为准。产品只使用你自己的系统代理与环境变量里的代理设置，不内置任何代理。

## 参与开发

规范真源是 [AGENTS.md](AGENTS.md)：产品目标、核心不变量、工程边界与开发约定（命令、检查脚本、提交与测试纪律）都在那里，人和 coding agent 共用；只在某个目录用得上的约定写在那个目录的 AGENTS.md。动手之前先读。Codex、Grok 直接读 AGENTS.md，Claude Code 从 2.1.277 起也直接读，本仓没有 CLAUDE.md。

```sh
npm run check          # 文档链接、生成文件对账、biome、类型检查
npm test               # 单元与集成测试；需要真实数据库、对象存储或双进程的用例默认跳过
npm run test:desktop   # 构建桌面端并跑真实 Electron E2E
npm run format         # biome 自动格式化
```

- workspace 包互相引用的是 `dist`：改了 `packages/*` 之后先 `npm run check` 或 `npm run build`，再 `npm test`。
- 生成文件不要手改：故事宪法、Story Language 文档与 host 接入文件各有 `npm run generate:*`，`check` 会核对。
- 修缺陷先写能复现它的测试；不靠弱化断言、跳过或吞掉错误让测试变绿。
- 提交信息用 `type(scope): 中文摘要`，正文写为什么。文档与代码注释用中文。
- 开源前的开发历史压成了一个基线提交（`chore: 开源基线（MIT）`）；文档里 2026-10-03 及之前的提交号指那段历史，在本仓里查不到（见 AGENTS.md）。

Cloud（PostgreSQL / S3 上的作品存储与显式同步）目前冻结：`npm run dev:api` 能起开发进程，配置见 [`.env.example`](.env.example)，但不在当前开发重点内。

## 文档

各文档管什么、按什么顺序读，见 AGENTS.md「真源与阅读顺序」。常用入口：

- [需求与目标](docs/vision-and-requirements.md)、[故事创作宪法](strategies/story-constitution.md)
- [Story Language](story-language/README.md)：作品的语义与目录格式
- [系统架构](docs/architecture.md)、[Harness 设计](docs/harness-design.md)：执行模型、恢复与故障验收
- [作者工作台设计](docs/web-product-design.md)、[可视化设计](docs/visualization-design.md)
- [技术栈](docs/technology.md)
- [当前状态](docs/current-status.md)、[实施路线图](docs/roadmap.md)
- [ADR](docs/adr/README.md)：历史决策，不是现行规范

## 代码结构

```text
apps/
  desktop/   Electron 主进程：持有 Runtime 与凭据
  web/       React 作者工作台，经 typed IPC 接入桌面
  cli/       suim 命令行与给程序用的 JSON 契约
  api/       Cloud Domain API（冻结）

packages/
  story/     Story Language、Story Core、Checker（不依赖网络、数据库与模型）
  runtime/   作品存储、SuimingHarness（Agent loop 与恢复）、事件、模型网关、本地服务
  sdk/       命令目录、领域 schema 与事件信封
  cloud-postgres/  Cloud 的 PostgreSQL 存储
  cloud-s3/        Cloud 的 S3 兼容对象存储

integrations/  Codex / Claude Code / Grok 的薄接入（Skill 与入口说明）
story-language/  Story Language 文档（生成进 packages/story）
strategies/      故事创作宪法
```

## 许可证

[MIT](LICENSE)。Story Language 与测试里的故事示例取自《三国演义》，属于公有领域。

## English

Suiming is a desktop-first AI workbench for writing long-form fiction. A dedicated agent reads and edits your manuscript directory, delegates drafting and independent review to sub-agents, and commits in stages. A work is a plain directory of Markdown files (outline, characters, world, prose, reviews) that is also a git repository; only changes that pass a deterministic Checker — schema, references, ordering, hard state such as who holds what or which secret is revealed when, and deadlines of long-running reader expectations — become a version of the work. Literary quality is left to models and independent review, not to rules. The same runtime is available from the `suim` CLI and from Codex, Claude Code and Grok.

**Status: development preview.** It has been exercised with real models on real material but no complete novel has been written with it yet, there is no installer, and only macOS has been verified.

**Try it** (Node.js 24+, git): `npm install && npm run dev:desktop` for the desktop app, or `npm install && npm run build && npm link -w @suiming/cli` for the CLI, then `suim init <dir> --intent-file intent.md`. Configure models in the desktop settings or in `~/.suiming/config.toml`; any provider supported by [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) works.

Documentation and code comments are in Chinese. [AGENTS.md](AGENTS.md) is the source of truth for the product's invariants and engineering rules. Licensed under [MIT](LICENSE).
