# 当前状态（2026-10-07）

本文只回答三件事：什么已经成立、证据到哪一级、还有哪些已知缺陷。形状以[系统架构](architecture.md)与 [Harness 设计](harness-design.md)为准；接下来做什么只在[路线图](roadmap.md)第 6 节维护，发生过什么见[变更记录](changelog.md)。

## 概览

桌面工作台与自主 Agent 的主路径已贯通，并收敛到 Session 模型：

- **执行**：只有 Session（根 Agent，一份连续的消息列表，idle / running）与 Task（子智能体）。Agent 直接在作者的 checkout 上工作，与作者、host agent 共用一份候选和一条提交路径。创作路径没有预算，只有每轮用量检查点：一轮的折算用量到 600 万 token 就停下，等作者说继续，与模型单价无关（[Harness 设计](harness-design.md)第 10 节）。
- **作品**：本地作品目录就是 git 仓，`refs/suiming/canon` 只由过 Checker 的提交推进；SQLite 只存执行数据。审稿与材料笔记是普通作品文件，正文 / 审稿时效与 Source 覆盖率从 git 历史派生。
- **入口**：Electron 桌面是核心产品；`suim` CLI 与 Codex / Claude Code / Grok 三个 host 共用同一 Runtime 与 Checker。Cloud 只剩 Canon 与显式同步，产品冻结。
- **证据**：最高到「真实调用」——2026-09-16 重构后第一次完整真实对话（[基线](validation/2026-09-16-first-real-session/README.md)），以及 2026-10 起斗破前 120 章的忠实抽取与留出评测。没有任何能力达到「真实长篇」。

验证（2026-10-07）：`npm run check` 通过（含示例作品 `examples/sanguo` 过 Checker）；`npm test` 457 项，452 通过、5 skip——那 5 条要真实 PostgreSQL / S3 / 双进程，2026-09-30 起用一次性容器真跑过，11 项全过；另有 1 条要本机的 eval-022 作品副本，CI 与别的机器上会多 skip 这一条。桌面 E2E 21 条：整套 20 条 2026-10-07 两次全部通过（含「分栏调宽」的全屏段、删掉半途核对后改成作废重发的「主进程 SIGKILL 后重开」、点开对话动作看完整结果），同日审查后补的第 21 条「子任务停下再续做」单跑通过，换回修复前的对话显示代码它会失败。真实模型回归现有六个任务（2026-10-04 从八个收敛、判分收紧），GPT-6.1 Sol 上的新基线是 2026-10-05 的 18 / 18；2026-10-07 升 pi-ai 1.0.4 后全套 5 / 6，没过的那项是判分只认用词、漏判了正确的修法，判分已改，那项重跑 3 / 3（[记录](validation/2026-10-01-harness-regression/README.md)）。各次运行的起伏见[变更记录](changelog.md)。

## 能力与证据

| 能力 | 实现 | 最高证据 |
| --- | --- | --- |
| Story Language、Checker、硬状态时间线、Contract 生命周期、Release 切分 | `packages/story` | 真实调用：真实运行中的模型产出由它检查与拒绝 |
| Open Story Directory / Package codec，路径是扫描得到的事实 | `packages/runtime/src/artifact` | 机制；eval-022 的 121 文件副本端到端 |
| Canon：作品目录的 git 仓 | `git-canon-store.ts` | 机制；eval-022 真实作品测试 |
| 自有 Harness：checkpoint、命令事务、写入冲突检测、被打断之后补结果续跑（不做半途核对）、阶段提交、进展型兜底与每轮用量检查点 | `packages/runtime/src/harness` | 机制：faux provider 加真实 SQLite 与进程退出 |
| 自主 Agent：读、写、检查、委派、独立 Review、提交 | `harness/agent.ts` | 真实调用：基线里一节正文、一次审稿与按审稿修订；斗破前 120 章分段忠实抽取（并行委派、Source 审稿，[记录](validation/2026-10-03-doupo-segmented/README.md)）与留出评测的正文（[记录](validation/2026-10-03-doupo-mini/README.md)）；《三国演义》前五十回抽取到整合（[记录](validation/2026-10-04-sanguo-example/README.md)） |
| 正文 / 审稿时效、Source 覆盖率 | `artifact/derived.ts` | 真实调用：审稿时效在基线同一场景上验过 |
| AG-UI 事件、只读 attach、桌面 typed IPC | `sdk/run-event.ts`、`apps/desktop` | 机制与 Electron E2E |
| 桌面工作台：阅读编辑、比较、Review、故事轴、邻域图、状态查询、检查结果、模型设置 | `apps/workbench` | Electron E2E（faux）与 eval-022 上的人工验收 |
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

- **长篇**：尚无 3 卷 30 Beat 的完整真实作品验收。最大的真实运行是 Agent 对《三国演义》前五十回的忠实抽取（231 节，只做到整合）与斗破前 120 章的抽取和两组共 8 节的留出评测，都不是 Agent 自己写成的长篇。大型 checkpoint 的消息 / Context 对象去重、长列表和百万汉字性能还需规模数据测量。[C 题库](c-question-bank.md) 17 道（目标不少于 20），2026-09-06 补硬状态后的回归是 13 / 17。
- **作者体验**：v7 工作台已在 2 Beat 样例上验收。Library 有最近作品列表与打开 / 新建，打开任意 Open Story Directory 会就地初始化；旧仓格式不迁移，初始化失败时文件夹保持原样。上下文栏与右栏可以拖拽调宽（[调宽验收](validation/2026-09-09-pane-resize/README.md)）。邻域图只画 frontmatter 声明的引用，看二跳就再点一次，不推断隐含关系。finding 的 Runtime 锚点仍只到文件，段落定位是窗口用审稿引文在 mdast 上对出来的，Reviewer 没引原文时退回到只锚文件。同一个文件被编辑器 buffer 与外部改动（作者、host agent、Agent）同时修改时只做 CAS 比较，入口是「比较外部修改」，不自动解决，也不覆盖任何一方。
- **A / B 决策卡**（针对一段给两个改法让作者选）还没做，但不是做不了：零件都在，缺的只是 `validateProductEvent` 的 CUSTOM 白名单里的一个事件名，以及一次「作者读到一段不满意」的真实场景来定给几个改法、怎么呈现。它也是「作者否决」这类证据最干净的采集口。零件清单见[作者工作台设计](workbench-design.md) 4.4 节「A / B 决策卡」。
- **发行与认证**：当前是开发构建，没有签名安装包或升级机制。设置页的登录向导接通了 pi-ai 全部 provider 的 API key / OAuth 流程（浏览器回调、设备码、手动粘贴授权码都能转述）。到「真实调用」的：API key（另经桌面 E2E）；`openai` 的 Sign in with ChatGPT——2026-10-02 登录并真实调用，10-03 凭据文件在一次真实刷新中被重写，当天 CLI 连跑多个一到两小时的运行没有一次因凭据失败。只到机制的：refresh token 作废后的失效恢复、桌面与 CLI 同时刷新，以及 `openai-codex`、Anthropic 等其余 provider 的 OAuth。订阅额度与作者自己的 Codex 共用，界面上的花费是按 API 价的估算，不是扣费。本地执行库（`.suiming/local.sqlite`）不做跨版本迁移：以后哪一版改了它的结构，打开作品会提示挪走旧库，之前的对话记录就看不到了；作品版本在作品目录的 git 仓里，不受影响。开发预览阶段刻意如此（执行数据按设计可丢），有安装包与升级机制之前要重新判断。
- **命令与 Cloud**：本地 typed IPC 命令有 SDK 目录与双向校验，但命令目录仍是三份，三个传输的适配都是手写的，理由见[系统架构](architecture.md)。Cloud 只剩 Canon 与同步，Cloud Harness host 与同等原子事件验收保持冻结；`CanonStore` 契约测试目前只有 git 一个实现在跑，Cloud 走的是自己的 store 接口与自己的测试。
- **模型预检范围**：启动只预检这次对话用的模型。没单独配置的角色从 2026-10-05 起跟随对话的模型，预检查过的就是它们要用的；单独配置过的 writer / reviewer / source-extractor 不在预检里，凭据或模型有问题时失败发生在 turn 中途、token 已经花掉。按实际会用到的 profile 预检需要先知道 Agent 会不会委派，未实现。
- **无人值守没有方向闸**：创作路径没有预算，兜底有 `run_no_progress`、每轮用量检查点与作者打断。检查点保证没人看着时一轮最多用掉约一次整本抽取的量（GPT-6.1 Sol 上约 $12），但它只封住用量、不判断方向，**停不住「持续产出但方向错了」的 turn**，只能靠作者发现（完整说明见 [Harness 设计](harness-design.md)第 10 节）。检查点的阈值作者在设置页或 config.toml 的 `session.usage_checkpoint` 调。带交付工具的子任务另有 `unsubmittedStops >= 3` 的收口，那不是方向闸。真正的结构性改善是让作者补充的意图能沉淀回作品，见 [AGENTS.md](../AGENTS.md) 不变量 5。
- **意图库还不会生长**：写回 `intent/**` 只靠 `AGENT_PROMPT` 的一句指示。2026-10-01 起每个 turn 结束有一行确定性对账（作者说了几条、意图 / Design / 正文 / 审稿各改了什么），刻意由系统算而不是让 Agent 自报；但「作者说了长期事实却没写回」仍要作者自己从「意图未改动」看出来，漏报规模要等一次有真实作者介入的长跑给出，用来定呈现形态。「什么时候该另起一页」的拆分压力还没有，写回通了也只会往单个文件追加。来由见 AGENTS.md「能力交给模型，可见性交给系统」。
- **书一大，Source 补全就做不了**：补全子任务要带整份抽取回头查漏，《三国演义》前五十回抽成 231 节、408 个人物之后，光开场消息就超过 GPT-6.1 Sol 窗口的七成。2026-10-04 修掉了由此引起的无限压缩，10-05 起这种委派开场就过压缩线时不发请求、以 `delegation_too_large` 交回根 Agent（不再空转，也不掀掉整轮），但补全本身仍然放不下；[Harness 设计](harness-design.md)第 9 节写的「先按卷整合、再整书整合」还没做，补全也要跟着按卷做。
- **`refs.beat` 的新写法只在前 24 章上验证过**：抽取方法原来要「每节依赖的更早那一节写进 refs.beat」，与 Story Language 不一致，Agent 抽出的作品大量连上一节：示例三国 231 节 403 条、一半只跨一节；斗破前 120 章 153 节 449 条、28% 只跨一节。依赖闭包沿这条链传下去，`impact` 改前半本任何一节都召回后文的近九成。2026-10-04 两处措辞对齐为「紧挨着的上一节不用连」，闭包对上一节的依赖只算一跳、改 Beat 时总带上下一节（示例三国的召回降到后文的 3%）。同日斗破前 24 章重抽：只连上一节的从 22 条（33%）降到 0，跨节的依赖 44 → 42（[第七圈](validation/2026-10-03-doupo-mini/README.md)）；120 章与示例三国的数据没有重抽，旧数据里的相邻连线由闭包与故事轴兜住。
- **只活在对话里的事实，在别处看不见**：Session 的消息列表持久、完整，但不过 Checker、没有版本、不进 Open Story Package，换一个 Session 或换 host agent 就看不见；Context 头部那句「非作品事实」只是标签，不是边界。风险判断见 [Harness 设计](harness-design.md)第 2 节。
- **执行对象没有生命周期管理**：既没人回收，也没人发现丢失。2026-09-12 在 eval-022 的旧库上数过：1299 条执行对象里 1225 条的字节早已不在磁盘上，在未迁移的原库里就成立。那个库已随 SQLite schema v5 归档清空，但结论没失效——产品代码里至今既没有删除路径也没有丢失检测，`collectObjects` 只有测试在调用。丢的是 harness checkpoint 与模型输入这类执行残骸，不含 Canon 或作者记录。回收机制在，接线未做：它要处理「put 完成到插入行之间的对象会被并发 GC 当孤儿删掉」这个竞态。
- **命令回执从不清理**：每条执行命令留一条，三国作品一次长运行后 9,108 条、库里约 12 MB。2026-10-07 起构造执行状态不再读它们，只在命令撞上没见过的 commandId 时按 id 查一条（原来整份读，每次约 160 ms，现在 0.2 ms），所以它只占磁盘、不再拖慢 turn。簿记成本随历史平方增长的问题 2026-10-01 已修（[Harness 审查](validation/2026-10-01-harness-review/README.md) F1，数字在那里）；一整部长篇的 Context payload 与主进程响应仍需真实负载验收。
- **上下文管理停在「机制」一级**：窗口保护（80% 清理、70% 请模型压缩、超窗如实报错）之外，2026-10-05 补上边界折叠（新一轮或产生新版本的提交之后，之前超过 10 KB 的读取结果在请求里只留头尾）与边界压缩（刚过边界时过 50% 就请模型压缩，根 Agent 压缩后换上当时的作品快照）。折叠当天在两轮[桌面走查](validation/2026-10-05-desktop-walkthrough/README.md)里都真实触发了（写作依据与原文读取过了提交或新一轮就折成头尾，最大一份 86 KB 折成 1.2 KB），边界压缩还只有 faux 测试。阈值全是占位值：70% 的压缩线 2026-10-04 在三国补全子任务上撞到过（由此引起的无限压缩已修），其余都还没在真实运行里触发；回归用的样例作品太小，碰不到，要等下一次长运行看（[Harness 设计](harness-design.md)第 7 节）。
- **长对话里点开动作**：详情从执行记录里按需读，同一份 checkpoint 解码后缓存；但子任务还在跑时每存一次就是新的 checkpoint，每点一个动作都要整份解码。三国那次 1,314 个动作的子任务要 0.7–1 秒，主进程事件循环最长卡 245 ms（2026-10-07 审查时在本机副本上量的）。checkpoint 的节点是内容寻址的，新旧两份绝大多数相同，跨读取缓存节点就能省掉，未做。
- **版本列表规模**：版本页把全部 revision 平铺进一个下拉。一部长篇按阶段提交的节奏很快会到几百个，需要按对话、Beat 或日期分组筛选。这个问题先于任何分支需求到达；"试另一个方向"的产品形态是故事层的另一稿而不是 git 分支界面，判断与不做的理由见[作者工作台设计](workbench-design.md)第 4.4 节。
- **花费是估算**：界面与 `suim session` 显示的花费是 token 数乘 pi-ai 目录里的单一美元单价，约等于 DeepSeek 的忙时价。DeepSeek 实际分忙闲时计费（[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：忙时只在北京时间工作日 9–12、14–18 点，节假日全天闲时，闲时减半），所以闲时跑的运行实际花费约为显示值的一半到七成。2026-10-02 升级 pi-ai 之前，配置里的旧 id `deepseek-v4-flash` 已被 DeepSeek 路由到 V4.1（官方公告 V4 Flash 下线），那段时间按旧目录单价记的花费偏低，实际约为记账值的 1.5 倍（闲时）到 3 倍（忙时）。对账以服务商账单为准；要显示得准，得按 provider 接入分时与币种的计价，目前没做。

## 可以声明的能力与限制

可以声明：共享领域内核、Local / Cloud Canon 与显式同步、CLI 与三个 host adapter 成立；自有 Harness、自主 Agent、标准事件与 Electron 创作闭环已实现，经过机制、真实进程与真实调用的验证。

不能声明：完整长篇文学质量、不劣于 host 的文学效果、桌面产品全部视觉与性能目标、正式发行、生产多用户 Cloud 或 SOTA。2026-09-06 的作者盲读仍优先于更早的「效果不劣于」判断。

## 下一步

只在[路线图](roadmap.md)第 6 节维护。
