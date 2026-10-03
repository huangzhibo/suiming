# 当前状态（2026-10-03）

本文只回答三件事：什么已经成立、证据到哪一级、还有哪些已知缺陷。形状以[系统架构](architecture.md)与 [Harness 设计](harness-design.md)为准；接下来做什么只在[路线图](roadmap.md)第 6 节维护，发生过什么见[变更记录](changelog.md)。

## 概览

桌面工作台与自主 Agent 的主路径已贯通，并收敛到 Session 模型：

- **执行**：只有 Session（根 Agent，一份连续的消息列表，idle / running / paused）与 Task（子智能体）。Agent 直接在作者的 checkout 上工作，与作者、host agent 共用一份候选和一条提交路径。创作路径没有预算。
- **作品**：本地作品目录就是 git 仓，`refs/suiming/canon` 只由过 Checker 的提交推进；SQLite 只存执行数据。审稿与材料笔记是普通作品文件，正文 / 审稿时效与 Source 覆盖率从 git 历史派生。
- **入口**：Electron 桌面是核心产品；`suim` CLI 与 Codex / Claude Code / Grok 三个 host 共用同一 Runtime 与 Checker。Cloud 只剩 Canon 与显式同步，产品冻结。
- **证据**：最高到「真实调用」——2026-09-16 重构后第一次完整真实对话（[基线](validation/2026-09-16-first-real-session/README.md)），以及 2026-10 起斗破前 120 章的忠实抽取与留出评测。没有任何能力达到「真实长篇」。

验证（2026-10-03）：`npm run check` 通过；`npm test` 388 项，383 通过、5 skip——那 5 条要真实 PostgreSQL / S3 / 双进程，2026-09-30 起用一次性容器真跑过，11 项全过。桌面 E2E 整套 19 / 19。真实模型回归现有八个任务，2026-10-03 换成 GPT-6.1 Sol 后的新基线是 23 / 23（[记录](validation/2026-10-01-harness-regression/README.md)）。各次运行的起伏见[变更记录](changelog.md)。

## 能力与证据

| 能力 | 实现 | 最高证据 |
| --- | --- | --- |
| Story Language、Checker、硬状态时间线、Contract 生命周期、Release 切分 | `packages/story` | 真实调用：真实运行中的模型产出由它检查与拒绝 |
| Open Story Directory / Package codec，路径是扫描得到的事实 | `packages/runtime/src/artifact` | 机制；eval-022 的 121 文件副本端到端 |
| Canon：作品目录的 git 仓 | `git-canon-store.ts` | 机制；eval-022 真实作品测试 |
| 自有 Harness：checkpoint、命令事务、文件 journal、恢复、阶段提交 | `packages/runtime/src/harness` | 机制：faux provider 加真实 SQLite 与进程退出 |
| 自主 Agent：读、写、检查、委派、独立 Review、提交 | `harness/agent.ts` | 真实调用：基线里一节正文、一次审稿与按审稿修订；斗破前 120 章分段忠实抽取（并行委派、Source 审稿，[记录](validation/2026-10-03-doupo-segmented/README.md)）与留出评测的正文（[记录](validation/2026-10-03-doupo-mini/README.md)） |
| 正文 / 审稿时效、Source 覆盖率 | `artifact/derived.ts` | 真实调用：审稿时效在基线同一场景上验过 |
| AG-UI 事件、只读 attach、桌面 typed IPC | `sdk/run-event.ts`、`apps/desktop` | 机制与 Electron E2E |
| 桌面工作台：阅读编辑、比较、Review、故事轴、邻域图、状态查询、检查结果、模型设置 | `apps/web` | Electron E2E（faux）与 eval-022 上的人工验收 |
| CLI 与三个 host 接入（`init` / `update`） | `apps/cli`、`integrations/` | 编译产物实际调用；Codex host-native 真实创作（2026-09-05）；Claude Code host 真实运行：斗破前 120 章忠实抽取、提升与续写（2026-10-02，[host 对照记录](validation/2026-10-02-doupo-host/README.md)） |
| 模型凭据：API key 与 OAuth 登录向导 | `model/`、设置页 | API key 经桌面 E2E；`openai`（Sign in with ChatGPT）的登录、调用与 token 刷新到真实调用；其余 OAuth 只到机制 |
| Cloud Canon 与显式同步 | `packages/cloud-*`、`apps/api` | 机制；真实 PostgreSQL 18.6 与 MinIO 上 11 项集成测试 2026-09-30 真跑通过 |
| 观测 | OpenTelemetry，Langfuse 可选 | 真实 Langfuse（2026-09-11） |
| 盲评 `suim rank` | `harness/rank-experiment.ts` | 机制；与作者判断的一致率还没量过。两种口径见[路线图](roadmap.md)第 5 节 |
| 长篇 | — | 无 |

## 证据等级

| 等级 | 含义 |
| --- | --- |
| 机制 | faux provider 或内存 / 真实 store 上的确定性测试通过 |
| 真实调用 | 用真实模型 provider 在真实或样例作品上跑通 |
| 真实长篇 | 在不少于 3 卷 30 个 StoryBeat 的真实作品上跑通并有作者反馈 |

## 已知缺陷

- **长篇**：尚无 3 卷 30 Beat 的完整真实作品验收。最大的真实运行是斗破前 120 章的忠实抽取与两组共 8 节的留出评测，都不是 Agent 自己写成的长篇。大型 checkpoint 的消息 / Context 对象去重、长列表和百万汉字性能还需规模数据测量。[C 题库](c-question-bank.md) 17 道（目标不少于 20），2026-09-06 补硬状态后的回归是 13 / 17。
- **作者体验**：v7 工作台已在 2 Beat 样例上验收。Library 有最近作品列表与打开 / 新建，打开任意 Open Story Directory 会就地初始化；旧仓格式不迁移，初始化失败时文件夹保持原样。上下文栏与右栏可以拖拽调宽（[调宽验收](validation/2026-09-09-pane-resize/README.md)）。邻域图只画 frontmatter 声明的引用，看二跳就再点一次，不推断隐含关系。finding 的 Runtime 锚点仍只到文件，段落定位是窗口用审稿引文在 mdast 上对出来的，Reviewer 没引原文时退回到只锚文件。同一个文件被编辑器 buffer 与外部改动（作者、host agent、Agent）同时修改时只做 CAS 比较，入口是「比较外部修改」，不自动解决，也不覆盖任何一方。
- **A / B 决策卡**（针对一段给两个改法让作者选）还没做，但不是做不了：零件都在，缺的只是 `validateProductEvent` 的 CUSTOM 白名单里的一个事件名，以及一次「作者读到一段不满意」的真实场景来定给几个改法、怎么呈现。它也是「作者否决」这类证据最干净的采集口。零件清单见[作者工作台设计](web-product-design.md) 4.4 节「A / B 决策卡」。
- **发行与认证**：当前是开发构建，没有签名安装包或升级机制。设置页的登录向导接通了 pi-ai 全部 provider 的 API key / OAuth 流程（浏览器回调、设备码、手动粘贴授权码都能转述）。到「真实调用」的：API key（另经桌面 E2E）；`openai` 的 Sign in with ChatGPT——2026-10-02 登录并真实调用，10-03 凭据文件在一次真实刷新中被重写，当天 CLI 连跑多个一到两小时的运行没有一次因凭据失败。只到机制的：refresh token 作废后的失效恢复、桌面与 CLI 同时刷新，以及 `openai-codex`、Anthropic 等其余 provider 的 OAuth。订阅额度与作者自己的 Codex 共用，界面上的花费是按 API 价的估算，不是扣费。
- **命令与 Cloud**：本地 typed IPC 命令有 SDK 目录与双向校验，但命令目录仍是三份，三个传输的适配都是手写的，理由见[系统架构](architecture.md)。Cloud 只剩 Canon 与同步，Cloud Harness host 与同等原子事件验收保持冻结；`CanonStore` 契约测试目前只有 git 一个实现在跑，Cloud 走的是自己的 store 接口与自己的测试。
- **模型预检范围**：启动只预检实际对话模型——`session.send` 在建 session 前 bind 一次 `main` profile，未配置的专用角色不挡住讨论（有意收窄）。代价是 Agent 委派到凭据或模型有问题的 writer / reviewer / source-extractor 时，失败发生在 turn 中途、token 已经花掉，而不是创建前。按实际会用到的 profile 预检需要先知道 Agent 会不会委派，未实现。
- **无人值守没有方向闸**：创作路径没有预算，兜底只有 `run_no_progress` 与作者打断，**停不住「持续产出但方向错了」的 turn**，只能靠作者发现（完整说明见 [Harness 设计](harness-design.md)第 10 节）。带交付工具的子任务另有 `unsubmittedStops >= 3` 的收口，那不是方向闸。真正的结构性改善是让作者补充的意图能沉淀回作品，见 [AGENTS.md](../AGENTS.md) 不变量 5。
- **意图库还不会生长**：写回 `intent/**` 只靠 `AGENT_PROMPT` 的一句指示。2026-10-01 起每个 turn 结束有一行确定性对账（作者说了几条、意图 / Design / 正文 / 审稿各改了什么），刻意由系统算而不是让 Agent 自报；但「作者说了长期事实却没写回」仍要作者自己从「意图未改动」看出来，漏报规模要等一次有真实作者介入的长跑给出，用来定呈现形态。「什么时候该另起一页」的拆分压力还没有，写回通了也只会往单个文件追加。来由见 AGENTS.md「能力交给模型，可见性交给系统」。
- **只活在对话里的事实，在别处看不见**：Session 的消息列表持久、完整，但不过 Checker、没有版本、不进 Open Story Package，换一个 Session 或换 host agent 就看不见；Context 头部那句「非作品事实」只是标签，不是边界。风险判断见 [Harness 设计](harness-design.md)第 2 节。
- **执行对象没有生命周期管理**：既没人回收，也没人发现丢失。2026-09-12 在 eval-022 的旧库上数过：1299 条执行对象里 1225 条的字节早已不在磁盘上，在未迁移的原库里就成立。那个库已随 SQLite schema v5 归档清空，但结论没失效——产品代码里至今既没有删除路径也没有丢失检测，`collectObjects` 只有测试在调用。丢的是 harness checkpoint 与模型输入这类执行残骸，不含 Canon 或作者记录。回收机制在，接线未做：它要处理「put 完成到插入行之间的对象会被并发 GC 当孤儿删掉」这个竞态。
- **命令回执从不清理**：每个 turn 开始构造执行状态时整份读一次。簿记成本随历史平方增长的问题 2026-10-01 已修（[Harness 审查](validation/2026-10-01-harness-review/README.md) F1，数字在那里）；一整部长篇的 Context payload 与主进程响应仍需真实负载验收。
- **上下文只有窗口保护这一层**：阈值是占位值，还没在真实 provider 上撞过线；按大小折叠、`recall` 与 commit 后 / turn 结束后的边界压缩都没做（切片 C，[Harness 设计](harness-design.md)第 7 节）。
- **版本列表规模**：版本页把全部 revision 平铺进一个下拉。一部长篇按阶段提交的节奏很快会到几百个，需要按对话、Beat 或日期分组筛选。这个问题先于任何分支需求到达；"试另一个方向"的产品形态是故事层的另一稿而不是 git 分支界面，判断与不做的理由见[作者工作台设计](web-product-design.md)第 4.4 节。
- **花费是估算**：界面与 `suim session` 显示的花费是 token 数乘 pi-ai 目录里的单一美元单价，约等于 DeepSeek 的忙时价。DeepSeek 实际分忙闲时计费（[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：忙时只在北京时间工作日 9–12、14–18 点，节假日全天闲时，闲时减半），所以闲时跑的运行实际花费约为显示值的一半到七成。2026-10-02 升级 pi-ai 之前，配置里的旧 id `deepseek-v4-flash` 已被 DeepSeek 路由到 V4.1（官方公告 V4 Flash 下线），那段时间按旧目录单价记的花费偏低，实际约为记账值的 1.5 倍（闲时）到 3 倍（忙时）。对账以服务商账单为准；要显示得准，得按 provider 接入分时与币种的计价，目前没做。

## 可以声明的能力与限制

可以声明：共享领域内核、Local / Cloud Canon 与显式同步、CLI 与三个 host adapter 成立；自有 Harness、自主 Agent、标准事件与 Electron 创作闭环已实现，经过机制、真实进程与真实调用的验证。

不能声明：完整长篇文学质量、不劣于 host 的文学效果、桌面产品全部视觉与性能目标、正式发行、生产多用户 Cloud 或 SOTA。2026-09-06 的作者盲读仍优先于更早的「效果不劣于」判断。

## 下一步

只在[路线图](roadmap.md)第 6 节维护。
