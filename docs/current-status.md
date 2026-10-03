# 当前状态（2026-10-03）

本文只回答四件事：什么已经成立、证据到哪一级、已知缺陷、下一步。形状以[系统架构](architecture.md)与 [Harness 设计](harness-design.md)为准；每一步怎么来的在各自的验收记录与 git 历史里，文末的变更记录按日期索引。

## 概览

桌面工作台与自主 Agent 的主路径已贯通，并收敛到 Session 模型：

- **执行**：只有 Session（根 Agent，一份连续的消息列表，idle / running / paused）与 Task（子智能体）。Agent 直接在作者的 checkout 上工作，与作者、host agent 共用一份候选和一条提交路径。创作路径没有预算。
- **作品**：本地作品目录就是 git 仓，`refs/suiming/canon` 只由过 Checker 的提交推进；SQLite 只存执行数据。审稿与材料笔记是普通作品文件，正文 / 审稿时效与 Source 覆盖率从 git 历史派生。
- **入口**：Electron 桌面是核心产品；`suim` CLI 与 Codex / Claude Code / Grok 三个 host 共用同一 Runtime 与 Checker。Cloud 只剩 Canon 与显式同步，产品冻结。
- **证据**：最高到「真实调用」——2026-09-16 重构后第一次完整真实对话（[基线](validation/2026-09-16-first-real-session/README.md)）。没有任何能力达到「真实长篇」。

验证（2026-10-03）：`npm run check` 通过；`npm test` 388 项 / 383 通过 / 5 skip（10-03 补的抽取缺口、重抽暴露的缺口与续写这一路各带测试：source 角色读写范围、Source 审稿引文、抽取方法与 Agent 提示、瞬时重试、并行委派、写作依据对账、Writer 与 Target 审稿的 Source 隔离、状态里的时效；小样本迭代加的分段抽取与补全的写范围、现成分段、抽取中间态的 impact、写正文时的段落数、`move`、读者口径的评委；10-02 审查遗留项删掉了守被删迁移步骤与内存态订阅的测试），那 5 条要真实 PostgreSQL / S3 / 双进程，2026-09-30 起一次性容器真跑过，11 项全过。桌面 E2E 整套 19 项通过（2026-10-03 加选段就地修改后 19 / 19；审查遗留项处理完 18 / 18，屏幕解锁后「分栏调宽」补跑通过；审查清理后两轮 18 / 18；界面文字第二轮之后 17 / 18，「分栏调宽」卡在全屏一步——当时宿主屏幕锁定，macOS 锁屏时窗口进不了全屏，待解锁后补跑；加上检查结果页之后第一轮 17 / 18，又是「提示」，失败点与下文记的不同，单跑 3 次、整套重跑都过；F3–F5 之后那一轮 16 / 17，失败的是下文记着的「提示」；加上对账之后又是 17 / 17，藏起 host 接入目录之后整套 16 / 17，又是「提示」，单跑两次都过）；真实模型回归（`npm run regression:harness`，模型与产品一样解析：.env 覆盖 config.toml；.env 现在只留评委，所以跑的是默认的 GPT-6.1 Sol）现有八个任务，最近一次全套是 2026-10-03 换成 GPT-6.1 Sol 后的第一次（新基线，各 3 次，review 撞上后台一小时上限只跑完 2 次）：23 / 23，约一小时，按 API 价估算 $1.72，10-03 改的写作方法、委派说明与工具之后没有退化；DeepSeek V4.1 Flash 时期最后一次全套（2026-10-02）24 / 24、约 $0.22、10–15 分钟；六个任务时的基线是 16 / 17，最好 18 / 18（[记录](validation/2026-10-01-harness-regression/README.md)）；「连续对话」在 8 核占满时单跑 4 次也通过。此前一直被记成「凭据环境问题」的两条失败，一条是测试没跟上 2026-09-11 的产品改动，一条是真实的连按 Esc 缺陷；另有一条是 2026-09-16 引入的回归，都已修掉。

## 能力与证据

| 能力 | 实现 | 最高证据 |
| --- | --- | --- |
| Story Language、Checker、硬状态时间线、Contract 生命周期、Release 切分 | `packages/story` | 真实调用：真实运行中的模型产出由它检查与拒绝 |
| Open Story Directory / Package codec，路径是扫描得到的事实 | `packages/runtime/src/artifact` | 机制；eval-022 的 121 文件副本端到端 |
| Canon：作品目录的 git 仓 | `git-canon-store.ts` | 机制；eval-022 真实作品测试 |
| 自有 Harness：checkpoint、命令事务、文件 journal、恢复、阶段提交 | `packages/runtime/src/harness` | 机制：faux provider 加真实 SQLite 与进程退出 |
| 自主 Agent：读、写、检查、委派、独立 Review、提交 | `harness/agent.ts` | 真实调用：基线里一节正文、一次审稿与按审稿修订 |
| 正文 / 审稿时效、Source 覆盖率 | `artifact/derived.ts` | 真实调用：审稿时效在基线同一场景上验过 |
| AG-UI 事件、只读 attach、桌面 typed IPC | `sdk/run-event.ts`、`apps/desktop` | 机制与 Electron E2E |
| 桌面工作台：阅读编辑、比较、Review、故事轴、邻域图、状态查询、检查结果、模型设置 | `apps/web` | Electron E2E（faux）与 eval-022 上的人工验收 |
| CLI 与三个 host 接入（`init` / `update`） | `apps/cli`、`integrations/` | 编译产物实际调用；Codex host-native 真实创作（2026-09-05）；Claude Code host 真实运行：斗破前 120 章忠实抽取、提升与续写（2026-10-02，[host 对照记录](validation/2026-10-02-doupo-host/README.md)） |
| 模型凭据：API key 与 OAuth 登录向导 | `model/`、设置页 | API key 经桌面 E2E；OAuth 只到机制 |
| Cloud Canon 与显式同步 | `packages/cloud-*`、`apps/api` | 机制；真实 PostgreSQL 18.6 与 MinIO 上 11 项集成测试 2026-09-30 真跑通过 |
| 观测 | OpenTelemetry，Langfuse 可选 | 真实 Langfuse（2026-09-11） |
| 盲评 `suim rank` | `harness/rank-experiment.ts` | 机制；与作者判断的一致率未验证。两种口径：默认按本作宪法与写作准则评本作的几份候选；`--rubric reader` 不带本作准则、不看 Design，只给紧挨着的前文与作品选定的样章，对照原作或参照稿时用（2026-10-03 作者定，斗破留出评测上与默认口径结论相反，见变更记录） |
| 长篇 | — | 无 |

## 证据等级

| 等级 | 含义 |
| --- | --- |
| 机制 | faux provider 或内存 / 真实 store 上的确定性测试通过 |
| 真实调用 | 用真实模型 provider 在真实或样例作品上跑通 |
| 真实长篇 | 在不少于 3 卷 30 个 StoryBeat 的真实作品上跑通并有作者反馈 |

## 当前剩余边界

- 长篇：尚无 3 卷 30 Beat 的完整真实作品验收。2026-09-16 的[第一次真实对话](validation/2026-09-16-first-real-session/README.md)是一节正文加一次审稿，闭环与 Review 鉴别力成立，但那不是长篇证据。大型 checkpoint 的消息 / Context 对象去重、长列表和百万汉字性能还需规模数据测量。
- 作者体验：v7 工作台已在 2 Beat 样例上验收；Library 有最近作品列表与打开 / 新建，打开任意 Open Story Directory 会就地初始化 `.suiming`（已有作品文件成为第一个版本，空目录写最小 Design，既非空又无作品文件的目录拒绝；旧仓格式的作品目录不迁移，错误点名文件与字段，scaffold 补的文件与锁建出的 `.suiming` 都收回，文件夹保持原样）；上下文栏与右栏已支持拖拽调宽（[调宽验收](validation/2026-09-09-pane-resize/README.md)）；结构图只画 frontmatter 记录的一跳 / 两跳关系；Agent 的逐段建议稿与选项式决策卡未实现——不是做不了，缺的只是 CUSTOM 白名单里的一个事件名，详见下文；finding 的 Runtime 锚点仍只到文件，段落定位是窗口用审稿引文在 mdast 上对出来的，Reviewer 没引原文时退回到只锚文件。**「重叠 Run 候选的合并编辑器」这条已经不存在**：去 worktree 之后只有一份候选，没有两份要合。留下的是同一个文件被编辑器 buffer 与外部改动（作者、host agent、Agent）同时修改时的 CAS 比较，入口是「比较外部修改」——仍然不自动解决，也不覆盖任何一方。
- 发行与认证：当前是开发构建，未交付签名安装包或升级机制。设置页的登录向导已接通 pi-ai 全部 provider 的 API key / OAuth 登录流程（浏览器回调、设备码、手动粘贴授权码都能转述），API key 路径经桌面 E2E 验收；OpenAI Codex、Anthropic 等真实 OAuth 登录、token 刷新与失效恢复尚未在真实账号上验收，只算机制。**`openai-codex` 那次 403 是我们直连出去了，不是这个 provider 用不了**：2026-09-13 作者实测，OAuth 授权通过，换 token 时被 OpenAI 以 403 拒绝，当时据此记成「用不了、不要再试」。2026-10-02 作者指出同一台机器上 Codex 能用，查清：Codex 读系统代理，我们的桌面从 Finder 启动时既没有代理变量、Node 也不读系统代理，请求绕过了作者配置的代理。桌面现在用 Chromium 解析系统代理（环境变量优先），实测无变量启动时请求走上了系统代理；它是 pi-ai 里唯一只有 OAuth、没有 API key 路径的 provider。**OAuth 登录已到「真实调用」**：2026-10-02 作者在桌面用 Sign in with ChatGPT（pi-ai 的 `openai` provider，与 `openai-codex` 同源）登录成功，随后用 `gpt-6.1-sol`、思考 high 真实调用一次通过（7.8 秒）；作者把它定为默认模型（`~/.suiming/config.toml` 的 `main`，其余 profile 回落到它，评委仍是 DeepSeek）。订阅额度与作者自己的 Codex 共用，界面上的花费是按 API 价的估算，不是扣费。token 一小时过期：跨进程只刷新一次已修（凭据文件锁罩住整次刷新，见变更记录）。**真实账号上的刷新已经发生过**：凭据文件只在真的刷新时重写（pi-ai 在锁内复查、不需要刷新就不写），10-02 19:41 登录之后它在 10-03 17:19 又被重写过，当天 CLI 连跑多个一到两小时的运行，没有一次因凭据失败。没观察到的是失效恢复（refresh token 作废后提示重登）与桌面、CLI 同时刷新，这两项仍只算机制。
- 命令与 Cloud：本地 typed IPC 命令已有 SDK 目录与双向校验；命令目录**仍是三份**（`SUIM_CLI_COMMANDS` / `LOCAL_COMMANDS` / `DOMAIN_API_ROUTES`），三个传输的适配都是手写的，全量改名与自动生成刻意不做，理由见[收敛方案](consolidation-plan.md) 3.2。**Cloud 现在只剩 Canon 与同步**：执行 adapter、run-event store 与 SSE 已于 2026-09-13 随 Slice 1 删除（migration 004），解冻时的接口位置是 Runtime 的 `HarnessProjectPort`，不是 `packages/cloud-postgres`。Cloud Harness host 与同等原子事件验收保持冻结。
- 模型预检范围：启动只预检实际对话模型——`session.send` 在建 session 前 bind 一次 `main` profile，未配置的专用角色不挡住讨论（有意收窄）。代价是 Agent 委派到凭据或模型有问题的 writer / reviewer / source-extractor 时，失败发生在 turn 中途、token 已经花掉，而不是创建前。按实际会用到的 profile 预检需要先知道 Agent 会不会委派，未实现。
- 无人值守没有方向闸：创作路径没有预算，兜底只有 `run_no_progress` 与作者打断，**停不住「持续产出但方向错了」的 turn**，只能靠作者发现（完整说明见 [Harness 设计](harness-design.md)第 10 节）。带交付工具的子任务另有 `unsubmittedStops >= 3` 的收口，那不是方向闸。真正的结构性改善是让作者补充的意图能沉淀回作品，见[收敛方案](consolidation-plan.md)第 0 节。
- 执行对象没有任何生命周期管理：既没人回收，也没人发现丢失。2026-09-12 在 eval-022 的库上数过：1299 条执行对象里 1225 条的字节**早已不在磁盘上**（只剩 74 个对象文件，全是 2026-09-11 16:21 之后写的），这在未迁移的原库里就成立，不是 Canon 迁移造成的。那个库已随 SQLite schema v5 归档清空（2026-09-13 作者决定旧执行数据不迁），所以上面的数字描述的是归档前的现场；结论没跟着失效——产品代码里至今既没有删除路径也没有丢失检测，`collectObjects` 只有测试在调用。丢的是 harness checkpoint 与模型输入这类执行残骸，不含 Canon 或作者记录。回收机制在，接线未做——它要处理「put 完成到插入行之间的对象会被并发 GC 当孤儿删掉」这个竞态。
- **意图库从未生长过，而写回只靠 prompt。**`intent/**` 在 Story Language 里本来就是 wiki 形状（一个意图一个文件、frontmatter 只做路由、Context Compiler 按 `target / subjects` 投影、明写合并与删除纪律），但两个真实作品里它是 `suim init --intent-file` 种下去之后再没动过的单体：eval-022 是 `book.md` 8,378 字加 `story-text-style.md` 2,786 字，当时跑了 4 个 Run、480 条事件，`intent/` 一个字没改。
  两个原因叠在一起：①**没有写回路径**——作者在对话里说的长期事实留在执行数据里（当时是 `run_events`，现在是 Session 的消息列表与 `session_events`），不进 Canon、不跟作品走、换个 Session 就看不见、host agent 完全读不到（详见下一条）；②**没有拆分压力**——就算写回通了，默认动作也是往 `book.md` 追加，单体只会更大，没有任何规则告诉 Agent 什么时候该另起一页。
  **写回现在只有 `AGENT_PROMPT` 的一句指示。**问题不在「靠 prompt」本身——模型多半做得到，而且会越来越好；问题在**没做时没有任何人会发现**（跑了 4 个 Run 都没人察觉）。按 AGENTS.md「能力交给模型，可见性交给系统」，要补的是对账不是闸。方向定为**作者侧确定性对账**（一次对话里作者说了几条、其中几条真的改动了 `intent/**` 或 Design，是纯算术，零模型依赖），而不是让 Agent 自报；prompt 指示保留为质量手段。2026-09-16 的基线没有推动这一条：那两个 turn 里作者只给了写作任务，没有说出任何长期事实，动作清单里也没有 `intent/**` 的写入。漏报规模仍然要等一次有真实作者介入的长跑给出，用来定对账的呈现形态，不用来决定要不要做。**2026-10-01 起对账已在**：每个 turn 结束发一条 `suiming.turn` 事件（作者几条、意图 / Design / 正文 / 审稿各改了哪些文件、提交了几个版本、还剩几个未提交），对话里在最后一条回复下面显示一行，只讨论的 turn 不显示。它是第一版呈现，「作者说了长期事实却没写回」仍要作者自己从「意图未改动」看出来；拆分压力（原因②）没有动。
- **Session 的消息列表与 `intent/**` 构成不对称的双真源。**Slice 1 之后载体换了、形状没变：一个 Session 就是一份连续、持久的消息列表（checkpoint 片段加执行对象），模型不需要「翻回历史」——历史本来就全在列表里。上一版靠 `conversation-context.ts` 把之前所有 Run 的消息按 32,000 码点注入、靠 `read_conversation` 无界回翻，两者随 Conversation 一起删了；现在只有 `compact_context` 会压缩，而且原始消息仍然持久保存。所以对话依旧是一个持久、完整的长期事实存储——只是它自称不是：不过 Checker、无版本、**不进 Open Story Package**、换一个 Session 就看不见、host agent 完全读不到。危险的不是「有两份」，是两份耐久性不同而模型看不出差别：只活在对话里的事实在当前 Session 里工作得完美，失效发生在别处、以后、对别人。Context 头部那句「非作品事实」是标签，不是边界。
- **A / B 决策卡（针对一段给两个改法让作者选）没做，但不是做不了。**零件全在——`delegate` 派两个 writer profile 的子任务、Task 结果本就存成执行对象并由 `read_result` 回读、`anchors.ts` 的 `paragraphSpans` / `anchorParagraphs` 已能把引文锚到段落（审稿 finding 就这么定位）、比较视图的 `revertControls: "a-to-b"` 就是逐块采纳。**问答往返的形状换了**：`ask_author` 与 steering 命令随 Slice 1 删除，现在是模型在文本里问、停下、turn 结束，作者的回答是 inbox 里的下一条消息（模型停下时 inbox 已有新消息就在同一个 turn 接着跑）。**缺的仍然只有一个事件名**：`validateProductEvent` 的 CUSTOM 白名单只放行 `suiming.session`，那是我们自己设的闸。`bridge.ts` 不需要补成双向（问答走命令不走 attach），不变量 10 不动。
  未采纳的那一版留在执行对象里，不进 Canon——与 Skill 里「未选候选、transcript、开放问题留在 Canon 外」一致，候选本来就不是 Canon，只是从「一个候选」变成「两个候选二选一」。
  **它同时是我们最缺的证据的采集口**：「作者否决」是 A-SOTA 三类证据里唯一从未被记录过的，今天只能靠 rollback 或插话这类事后、粗粒度的动作产生；选 A 就等于在明确位置明确否决 B，是干净得多的偏好数据（M6 E1 要的正是这个）。
  **形状依据仍然缺**：2026-09-16 的第一次真实对话已经跑完，但作者没有介入正文（人名撞车与 Design 措辞两处都留给了作者，本人未答），所以「读到一段不满意」的真实场景还没发生。要由那个场景来定给几个改法、怎么呈现、什么时候该给而不是直接改，现在定就是凭空设计。
- 界面与 `suim session` 显示的花费是估算：token 数乘 pi-ai 目录里的单一美元单价，约等于 DeepSeek 的忙时价。DeepSeek 实际按人民币、分忙闲时计费（[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：忙时只在北京时间工作日 9–12、14–18 点，节假日全天闲时，闲时减半），所以闲时跑的运行实际花费约为显示值的一半到七成。2026-10-02 升级 pi-ai 之前，配置里的旧 id `deepseek-v4-flash` 已被 DeepSeek 路由到 V4.1（官方公告 V4 Flash 下线），那段时间按旧目录单价记的花费偏低，实际约为记账值的 1.5 倍（闲时）到 3 倍（忙时）。对账以服务商账单为准；要显示得准，得按 provider 接入分时与币种的计价，目前没做。
- 桌面 E2E 的「提示」用例偶发超时，2026-10-02 修掉：缩窗（`setSize` 到 960×640）后立刻数左栏按钮，拿的是回流前的快照，负载高时两种导航形态都数不到、或数到缩窗前的旧按钮。2026-09-13 只试过「先等三个入口之一出现再分支」，不够——旧布局也能满足那个等待；现在先等渲染进程看到新宽度、再等两帧让 ResizeObserver 与重渲染落地，然后才分支。单跑 5 次、整套连跑两遍 17 / 17。再出现时先看是不是另一个缩窗或 reload 之后直接 `count()` 的地方（「分栏调宽」那条同形）。同日晚整套里又超时一次，失败点不同（放宽到 2000×940 后屏上多挂一个朝上的提示），当天查清是另一个根因：**宿主机的真实光标**。窗口出现、拿到或失去焦点、reload、改大小让光标进出窗口时，macOS 按真实光标的位置给页面送指针事件，与 Playwright 注入的事件交错——光标恰好停在带提示的控件上就多弹一个提示，或抢走测试正在做的悬停（加压单跑时另一种失败「等不到『大纲』的提示」也是它）。实测：放宽后页面收到 (408, 661) 的事件，测试的鼠标在 (624, 58)，差值正是窗口在屏幕上的偏移；`setIgnoreMouseEvents` 挡不住。测试入口现在把窗口放到真实光标右侧（改大小后再查一遍），之后页面只收到 Playwright 的事件；加压单跑 12 次、整套连跑两遍 18 / 18。跑 E2E 时把鼠标移进测试窗口仍会干扰，那是真实操作。
- **2026-10-02 审查留下的较大项**（已核实、刻意另排，不是漏掉）：协议面当日已收——子任务、审稿、commit / rollback 的投影各只剩一份，作品文件读写只剩 `workspace.file.*`（按版本读只取一个 blob）；刻意不动、写明理由的三处：`suiming.task` / `suiming.session` 事件与增量事件上的 sessionId / taskId（`suim session send --events` 把事件流原样交给 host，仓库里没有消费者不等于没人用）、`LocalWorkspace` 每条命令的输出校验（斗破上 `workspace.show` 一次约 11ms，其中校验 2.5ms，留着守契约）、`session.send` / `resume` / `interrupt` 两侧形状不同（CLI 同步跑完一个 turn，桌面是异步回执，`domain-schema.test` 写明了）。审查另排的较大项到此全部处理完（见变更记录 2026-10-02「审查遗留项」）。
- 版本列表规模：版本页把全部 revision 平铺进一个下拉。一部长篇按阶段提交的节奏很快会到几百个，需要按对话、Beat 或日期分组筛选。这个问题先于任何分支需求到达；"试另一个方向"的产品形态是故事层的另一稿而不是 git 分支界面，判断与不做的理由见[作者工作台设计](web-product-design.md)第 4.4 节。
- **长会话的簿记开销**（[Harness 审查](validation/2026-10-01-harness-review/README.md) F1，2026-10-01 已修）：原来每条执行命令整份克隆、整份重读执行状态，成本随项目历史平方增长（faux 零延迟 100 轮后单轮 0.63 秒）。现在命令只写自己改动的行，只读查询不读命令回执，checkpoint 归档与事件流也不再为没变的部分重算：100 轮总耗时 36.5 → 4.0 秒，400 轮后单轮 117 ms。余下约 0.2 ms / 轮的增长跟着会话的消息与调用列表走，主要是每次请求组装完整上下文。仍未做的：命令回执从不清理，每个 turn 开始构造执行状态时整份读一次；一整部长篇的 Context payload 与主进程响应仍需真实负载验收。
- **上下文的生命周期只有窗口保护这一层**（审查 F3，2026-10-01 已修卡死）：请求接近窗口时清掉较早的工具结果、清不动请模型压缩、provider 报超限清理后重试一次、放不下报 `context_overflow`，会话不再卡死在同一个错误上。阈值是占位值，没在真实 provider 上验证过；设计里的按大小折叠、`recall` 与 commit 后 / turn 结束后的边界压缩都没做（切片 C）。

## 可以声明的能力与限制

可以声明：共享领域内核、Local / Cloud Canon 与显式同步、CLI 与三个 host adapter 成立；自有 Harness、自主 Agent、标准事件与 Electron 创作闭环已实现，经过机制、真实进程与 2026-09-16 真实对话的验证。

不能声明：完整长篇文学质量、不劣于 host 的文学效果、桌面产品全部视觉与性能目标、正式发行、生产多用户 Cloud 或 SOTA。2026-09-06 的作者盲读仍优先于更早的「效果不劣于」判断。

## 下一步

以[路线图](roadmap.md)第 6 节为准。最近三件：

1. **真实质量**（2026-10-02 作者改了评估方式）：开发期不靠作者通读正文，改用斗破前 120 章的忠实抽取作测试台——桌面 Agent 先按对比协议做一遍忠实抽取（`~/stories/doupo-agent-2026-10-02`），再做留出评测：前几节放原作，后几节让 Agent 按抽自原作的 Design 写，拿原作对应章节作参照，用确定性指标与盲读评委打分，作者只抽查。10-03 在前 12 / 24 章小样本上把抽取改成分段并行的新流程（[记录](validation/2026-10-03-doupo-mini/README.md)），当天在 120 章上全量跑通（[记录](validation/2026-10-03-doupo-segmented/README.md)）；留出评测跑了两组共 8 节；对照原作改用作者定的读者口径评委（`--rubric reader`），原作 48 轮胜 38 轮，加作品样章后同一组 6 节基本打平。读者评委本身与作者判断的一致率还没量过，用它做的决定都要靠作者抽查兜底。细节见[路线图](roadmap.md)第 6 节。「作者否决」这一维仍没有记录，改由评测中作者的抽查补。
2. **Harness 余下切片** C / E / F，见 [Harness 设计](harness-design.md)第 13 节；`write` / `edit` 带 `check` 2026-10-02 已做；折叠与边界压缩在 DeepSeek 的 1M 窗口上不急（斗破长会话占窗口三成、保护从未触发），但 2026-10-02 起默认的 GPT-6.1 Sol 窗口是 272k：10-03 斗破 120 章抽取的 Source 审稿每次请求平均约 18.5 万 token、占窗口 68%，离 80% 的清理线不远，是最先撞线的角色（同一次未触发清理）；E / F 排后。
3. **认证与发行**：`openai`（ChatGPT 订阅）的真实登录、调用与 token 刷新都已在真实账号上发生，余下失效恢复与桌面、CLI 同时刷新；再做 macOS 安装与升级。

「委托」这个概念 2026-09-12 已撤掉：产品以意图为核心，耐久的中心是 `intent/**`，不要把它加回规范、prompt 或界面，理由见[收敛方案](consolidation-plan.md) 3.7。

作品现场：R 的 checkout 在 `~/stories/eval-022-suiming`，2026-09-16 的基线跑在它的副本 `~/stories/eval-022-baseline-2026-09-16` 上，原作品未被触碰；盲读包在 `~/stories/blind-read-2026-09-06/`，作者选择已记录。C 题库 17 道，2026-09-06 补硬状态后的回归是 13 / 17，以 [C 题库](c-question-bank.md)与作者记录为准。旧仓 2026-09-06 起搁置，全局 `suim` 指向本仓。

## 真实运行记录（旧引擎时期，2026-09-05 / 06）

Session 模型之前、旧 RunEngine 与固定配方时期的真实运行（R0、B、P 对照、按作者意见重写、作者盲读 #1、R1）整节迁到了[旧引擎时期的真实运行记录](validation/2026-09-05-old-engine-runs/README.md)；它们只描述当时的机制与数字，保留是因为它们是 C 题库与作者判断的证据来源。

## 变更记录

新的在上。细节在链接的记录里，没有链接的当时看同日的提交信息——2026-10-03 开源时那之前的提交压成了一个基线提交，见 AGENTS.md「真源与阅读顺序」末条。

- **2026-10-03** 开源准备：MIT 许可证，开源前的 409 个提交压成一个基线提交（维护者本机留完整归档，见 AGENTS.md「真源与阅读顺序」末条），公开文档去掉地区表述与本机绝对路径。GPT-6.1 Sol 第一次全套回归 23 / 23，作为新基线（[记录](validation/2026-10-01-harness-regression/README.md)）。测试样例原是早期凑 Checker 字段的占位（李牧、皇档、密信），作者读不懂，真实回归里写正文也卡在它的前后矛盾上；改成《三国演义》的苦肉计与火烧赤壁（公有领域），依赖原文的替换与断言逐条改到新原文，提问改过的四项回归 4 / 4。

- **2026-10-03** 作者定：`suim rank` 另加读者口径的评委（`--rubric reader`，不带本作准则、不看 Design，只给紧挨着的前文与作品选定的样章，`c05d89f`）。对照斗破原作，8 节 48 轮里原作胜 38 轮、两个最干净的首节 12 轮全胜，与按本作准则评的 45 / 48 正好相反：Agent「更克制、更干净」却「像同人文而非续写」。文风改为先看作品选定的样章（`reference/style`），没有样章才看前文，前文首先负责接续，读者评委与写正文时的段长对照用同一依据（`0788a1a`）。同一组 6 节对照：方法里加一句「文风以前文为准」没有可测效果（Agent 胜 10 → 9 / 36），加三段原作样章后 17 / 36、基本打平——文风靠具体的例子推得动，抽象的要求推不动（[记录](validation/2026-10-03-doupo-mini/README.md)）。「声音」是 voice 的直译，Story Language、Skill 与提示里统一改成文风、说话口吻（`65e341a`）。桌面正文选段栏可以就地写修改要求、回车直接发给 Agent，走输入框同一条发送路径；输入框有未发出的内容、有待确认的发送或对话暂停时改为接进输入框，「要求修改」与「写正文」按钮原来会整段替换输入框里的草稿，一并修掉。

- **2026-10-03** 新流程第一次在斗破前 120 章上全量跑完（`~/stories/doupo-agent-gpt-2026-10-03c` r3，[记录](validation/2026-10-03-doupo-segmented/README.md)）：6 段分段与 6 段补全各在同一次回复里派出、各 15 分钟，全程 1 小时 53 分、387 次调用、估算 $14.99（上午先读后抽 3 小时、$10.77，大头是补全的 $6.5——每次请求带整份抽取约 15 万 token）。153 节、正文 65,797 字（与 host 版相当、上午的两倍），449 条 `refs.beat`、31 个秘密、37 个 World 文档，零按语节，Source 审稿一轮 0 major。补全补的是第一遍记不全的跨段依赖、秘密投影、数值与没被强调的伏笔。暴露两处，当天修：整合没有挪文件的工具，分卷沿用段界成了两卷（加 `move`，`ebddbbe`）；人物档里写给续写者的防误读提醒（`87fc59b`）。修完在前 24 章上验证：49 分钟、估算 $3.24，审稿一轮零意见，谜团在整合时就开成 Contract，分卷两次 `move`。同日在前 24 章的 Design 上留出 6 节（原作约九千字）：段长接上了（41–61 字对原作 45–66 字），篇幅普遍长二到七成（根 Agent 在 brief 里定的），评委 36 轮 35 轮判 Agent 胜——评委提示与 Writer 的写作方法是同一份准则，拿原作当参照时等于用 Writer 的考纲给原作阅卷；要量「像不像同一部书」得换评委口径，这是评测标准，留给作者定（[记录](validation/2026-10-03-doupo-mini/README.md)）。

- **2026-10-03** 用斗破前 12 / 24 章小样本快速迭代抽取与续写（GPT-6.1 Sol，一圈 30–80 分钟，[记录](validation/2026-10-03-doupo-mini/README.md)）。抽取改为**分段抽取 → 整合 → 补全 → 统一修 → 审稿一轮**（`b655e3c`，理由见 [Harness 设计](harness-design.md)第 9 节「Source 抽取的分工」）：先读后抽是同一件事做两遍，笔记要么丢因果、要么等于照抄（小样本第一圈 70%）。要模型自己规划分段时，GPT-6.1 Sol 两次都只先派第一段、串行交接，说明里写「一起派出」压不住；`source_coverage` 改为直接给出在章标题处切好的 `segments`（`e7fee2f`），之后分段与补全两步都在同一次回复里派出，前 24 章的分段从 26 分钟降到 13 分钟。`search` / `impact` 也查 Source 的抽取（`364f93f`）；分段阶段还没有 index 时 `impact` 掀掉了子任务与根 turn，当天改成拒绝（`dc7f320`）。Story Language 只加一句卷的定义，Agent 特有的写法留在方法里；抽取方法嵌入 Story Language 原文、不再转述，点名容易漏用的 `refs.beat`、Secret 与谜团的 Contract。前 24 章新流程第一次跑完：2 卷 32 节、81 条 `refs.beat`、12 个秘密，审稿 0 major，134 次调用、估算 $3.84。续写：写正文时结果附段落数与段长、排除项是边界不写进旁白（`10af73b`）；Agent 自己定情节的续写与原作比，评委因原作「不兑现本节 Design」扣分，改为**留出评测**（同一份 Design 两份稿子，`fe16a59`）：两节段长 59 / 44 字（原作 64 / 71），Design 里的边界句没进旁白，评委 12 轮里 10 轮判 Agent 胜——评委扣原作的理由是本作的写作准则，同时指出 Agent 那份嘴贫火力弱，这个胜率不能读成「比原作好」。Skill 写明评委与写正文同一个模型时名次只能当参考（只有 ChatGPT 订阅、没配 `judge` 时就是这样，`74fd1e1`）。

- **2026-10-03** 补齐续写这一路相对 host 的缺口（不花模型额度，下一次长运行一起验证）：AGENT_PROMPT 写明写或改正文前先取 `write_context` 或委派 writer、连续写几节时第一节写完先校准、不逐句 edit 凑篇幅；delegate 写明 writer 的 goal 就是 authorial brief；turn 对账加「没取写作依据就整篇写入的正文」，桌面对账行点名；委派的 writer 读不到 `source/`、也不给读原文的工具（`read_source` 等不经过读范围），design 层 Reviewer 限在 Target；`project_status` 与 `suim status` 加 `stale`，点名 Design 已变的正文与主体已变的审稿（Skill 一直说 status 会标出，实际没有；eval-022 上查出 5 篇）。桌面 E2E 18 / 18。
- **2026-10-03** 用补齐的方法重抽斗破前 120 章（GPT-6.1 Sol，`~/stories/doupo-agent-gpt-2026-10-03` r2，[记录](validation/2026-10-03-doupo-agent-gpt/README.md)）：6 卷 115 节、182 条 `refs.beat`、18 个秘密、中文 id、标题干净，上午补的都生效；Source 审稿三轮查出父子关系写反、知情与 `revealed` 投影越界等实在的错。还剩 Beat 偏短偏速记（初稿中位数 185 字，host 版 2135）与 16 处「出入」按语。同一次暴露的缺口当天修掉：抽取文风与按语、source 角色读写范围（目录本身、Source 审稿、extractor 不写笔记）、Source 审稿锚在要修的文件上可引原作、审稿修改的收尾规则、能并行的委派一起派出。3 小时、337 次调用。
- **2026-10-03** 按审查清单补齐 Agent 相对 host 的抽取缺口（两个只读子代理分别对照 Skill 与两份作品）：Story Language 语义原文生成进 `@suiming/story`，Agent 经 `story_guide` 的 `topic` 读、host 装进作品仓的是同一份（此前 Agent 只看得到字段形状，这是 Beat 写成速记、人物档写成编年、零个秘密、World 当流程档的总根因）；source-reader / source-extractor 与 host 同一份 Reader 标准，不带宪法与 Target 意图，读写限在这个 Source；抽取方法补齐因果完整、出处不进作品、秘密声明、World 只写设定、不提前引用、Contract 期限、自检；Source 审稿也查语义；原文按字检索（`search_source` / `search_material`）；硬状态打印带作用域（两条路的 Writer 都分得清读者知道与人物知道）；同一次回复里委派的多个 source-reader 并行。续写这一路（写正文前取 Write Context、brief 与校准方法、Writer 读不到 `source/`、正文与审稿时效）还没做。
- **2026-10-02** 作者看 GPT 版斗破抽取的故事轴：读者期待显示成英文（cave-treasure）、Beat 标题带「（原作1—4章）」、120 章只有一卷。根因是桌面 Agent 的抽取子任务没有任何抽取方法（host 版走 Skill，同一份材料抽成 6 卷、中文 id），加上 Story Language 只说 id「可以」用中文。现在委派的 source-extractor 带 `SOURCE_EXTRACTION_METHOD`（按情节分卷、中文 id、标题不带章节、Contract 成句），Story Language 与 `story_guide` 写明中文作品用中文 id、title 只写标题。r2 这份抽取没改，要用新方法重跑才能验证。
- **2026-10-02** 桌面 Agent 用 GPT-6.1 Sol（作者的 ChatGPT 订阅）完成斗破前 120 章忠实抽取并提交 r2（`~/stories/doupo-agent-gpt-2026-10-02`）：一卷 32 节、30 人物、14 地点、55 物品、29 个 Contract、15 份 World；独立审稿 revise、3 条 minor，已按意见修；最终 check PASSED；每节对应原作整章。约 2.5 小时、220 次调用、1,469 万 token（缓存读 1,340 万），按 API 价估算 $5.74，订阅不另计费。同日据此修掉两处：Source 版 `story_guide` 漏了硬状态规则（两个模型都把修为、位置写成自由文字塞进 `changes.character`，GPT 靠检查报错改了两百来处）；文件工具加 `copy`（「原样提升」让模型逐个重打 176 个文件、约 35 分钟，逐字节核对无误但费时）。
- **2026-10-02** 模型请求的瞬时失败（流中断、连接错误、429、5xx）在同一个 turn 里退避重发，最多 5 次：用 GPT-6.1 Sol 重跑斗破抽取时经代理连 ChatGPT 一小时内断了两次（`terminated`、`Connection error.`），每次都结束整轮、等作者说「继续」。
- **2026-10-02** 斗破忠实抽取（桌面 Agent 版，DeepSeek）跑了 35 分钟后整轮中断：Design 里一处人物作用域写了 `location`，委派的子任务随后 `read_source`，读原文连带解析了整个 Source Design，抛出的 Story 诊断工具没转成拒绝、`childOutcome` 也不认，turn 带着 `invalid_document` 结束，没有提升也没有提交。现在 loop 统一把 Story 诊断交还模型，读原文与查覆盖率不再依赖抽取是否合法；两条回归按原样复现。
- **2026-10-02** 凭据文件的读改写持跨进程锁跑完整次 OAuth 刷新：pi-ai 约定刷新在 `modify` 里、全局只刷一次，我们原先在锁外刷新、写回时比对，桌面与 CLI 同时用订阅时会拿同一个 refresh token 各刷一次，OpenAI 的 refresh token 用过即作废，后到的一方失败、作者只能重新登录。同日作者用 ChatGPT 订阅登录成功、`gpt-6.1-sol` 真实调用通过，默认模型改为它（思考 high）；开发用 `.env` 只留评委覆盖。
- **2026-10-02** Sign in with ChatGPT（pi-ai 的 `openai` 订阅登录）要宿主提供固定的安装 ID，我们没传，作者一点登录就报「requires a device ID (UUID) for this installation」；现在第一次登录时生成、存在凭据文件旁边的 `installation-id`，之后每次登录同一个。
- **2026-10-02** 桌面读取 macOS 系统代理：从 Finder 启动时拿不到 shell 的代理变量、Node 又不读系统代理，模型调用与登录一律直连、绕过了作者配置的代理。openai-codex 9 月那次 403 由此而来，「用不了、不要再试」是误判，已改正，等作者重新登录验收。
- **2026-10-02** 比较页不再一次拉全部改动正文：桌面的 `project.diff` / `revision.diff` 只回文件清单（路径与增删改，按版本缓存的 blob id 比对），选中哪个文件再用 `workspace.file.read` 读那一个的两侧。斗破上改前每次刷新约 70 ms（导出整个已提交版本加读整个目录，还没算解码与 IPC），改后清单 7 ms、选中文件两侧 1.5 ms；比较页开着时 turn 里每次刷新都跑它。`project.diff` 两侧形状不同的理由改为成本（CLI 要构建完整候选），`domain-schema.test` 写明。
- **2026-10-02** 重载或切换作品时不再闪欢迎页：加载分支其实 2026-09-13 就加了（夹在一个不相干的提交里，这里的缺陷记录一直没跟上），还漏了一个缝——作品读不出来、文件列表还在读时照样落到欢迎页；判定抽成 `workspaceScreen` 并补单测，桌面 E2E 在重载全程记录欢迎页是否出现过（去掉加载分支时它失败）。
- **2026-10-02** 桌面 E2E「提示」用例两周来的偶发超时查清：宿主机真实光标的位置在窗口出现、聚焦、改大小时变成页面的指针事件，与测试的悬停交错；测试窗口改放到光标右侧。
- **2026-10-02** 审查遗留项：`workspace.show` 在斗破 259 个文件上从 48ms 降到 11ms——目录按文件状态（inode、大小、mtime、ctime）复用上一次读到的字节，投影按字节对象记住解析结果；刚写过的文件不复用，检查与提交照旧整份重读。Agent 的 `read_source`、Reviewer 的 `read_material` 与 host 分段阅读共用一份按码点取区间的实现，两个工具输出同一种格式；`read_source` 读不存在的 Source 原来会掀掉整个 turn，现在交回模型改参数。码点计数与切片不再展开数组：斗破上读一次材料 68ms → 16ms，扫描 checkout 时校验 Source 也少了两次两百万元素的展开。「能不能重试」只剩一处判定（CLI 原来漏判模型调用失败）；模型 profile 的中文名只剩一张表，设置页与报错说同一个名字。「什么算 Design」只剩一处（Story Language 的 `TARGET_DESIGN_KINDS`）：Reviewer 原来另定一份、把整个 `reference/` 算进 Design 一起审，而审稿时效又不追踪它；现在 Design 审稿看到的就是 `context compile design` 的那一份，正文审稿另带 Intent 用 `style_refs` 选中的风格证据，与 Writer 拿到的是同一份，没被选中的资料与研究需要时自己读。（改完跑了 `review` 回归 1 次，1 / 1。）执行状态里只剩测试在用的整份快照写入、内存态订阅与 `persist` 删掉，「两个进程同时写」的回归改走产品的增量写入路径。本地执行库的 v1→v6 迁移链与每次打开时清理 `.suiming/worktrees` 删掉：删前查过 `~/stories` 下五个在用作品，`suiming-new-001` 还是 v4，先整份备份到 `~/stories/backups/` 再用当前版本打开一次升到 v6；现在旧库打开时直接说清楚怎么办、不动库。界面——故事轴工具条的五个裸 `<button>` 换成共用的 Button，「适应窗口」改成按下态（它是一种缩放状态，不是禁用的动作；做成禁用加提示时，它的提示会盖住相邻的「放大」）；按状态长期不可用的控件都写出原因：文字按钮新增 `ActionButton`（与 `ToolButton` 同一规则，aria-disabled 加悬停说明），菜单项直接在文字里写原因（比较页的差异导航、恢复历史版本、继续、保存模型配置、导出对话、引用当前文档、文件菜单、目录里缺文件的情节）；子任务的动作不再并进根对话的「已执行 N 项」，按执行者各自成组。
- **2026-10-02** 协议面收敛：子任务、审稿、commit / rollback 的对外投影各只剩一份（CLI 与桌面共用 runtime 的 taskSummaries / committedReviews / commitResult / rollbackResult，schema 在 domain-schema 定义一次）；`workspace.read` / `save` 删掉，读写只剩 `workspace.file.*`，按版本读从导出整个版本改成只取一个 blob；session 摘要去掉没人读、每次刷新要扫全部任务的 taskCount。
- **2026-10-02** 文档、代码与界面审查清理：四个只读子任务分别审文档、死代码、界面状态与协议面，逐条核实后改。文档——Skill 里已删的 `run_merge_conflict` / `design_not_frozen` / `context_stale` 与三方合并说法删掉，审稿时效按 subjects 摘要说，现行文档去掉 Run / worktree / 委托 / 预算等残留，路线图旧任务与旧引擎运行记录移出，同步点从四处减到两处。代码——约 900 行死代码（范围冻结的前缀绑定、design 配方遗留、没人构造的错误类、只剩测试在用的导出）；`suim session interrupt` 原来是空操作；`workspace.context` 静默退回错误内容；`workspace.show` 与 `session.list` 各算一遍对话列表、rank 实验混进桌面列表；计码点展开两百万元素的数组。模型看到的契约——Writer 契约要它调一个不存在的 `submit_story_text`，host 设计视图附带的是一份要 frame / submit_brief 的 brief 契约。界面——同一状态一屏只说一次，删死控件，删除对话先确认，作品对象与审稿状态统一成中文，「设计已变」与「正文未提交」画成两种标记。较大的重叠与重构另排，见「当前剩余边界」。
- **2026-10-02** Agent 的 `check` 不再对设计层错误说 PASSED：它只复用提交闸，Contract 没兑现这类不拦阶段提交的错误不进输出，同一份候选 CLI 与桌面说「未通过：设计」。结论改为 PASSED / ISSUES / FAILED，三处共用一个判定；Writer 契约改为只修自己这一节的问题；Skill 里「`passed` 表示没有阻塞提交的问题」与事实不符，改掉。真实模型回归的节奏放宽：日常只跑相关任务一次，全套只在节点上跑。
- **2026-10-02** 桌面「检查」不再只说「未通过：设计」：有诊断时提示带「查看详情」，打开按文件归类的检查结果页，作品绑不成设计时也列全部问题；结果是快照，作品改动后标「可能已过期」。顺带查出 preload 给 Error 挂的 `code` 从来没过 contextBridge（Electron 复制 Error 时丢自定义属性），命令失败改为过桥普通对象；Contract 没兑现的诊断原来是一句英文，改为中文并分清四种情况。
- **2026-10-02** index 可声明 `open_ended: true`：全书未完待续时已建立未回应的 book_end Contract 算进行中，写明 Beat 期限的与从未建立的照样报错；是作者的声明，不是让检查通过的开关（作者定，`7f9e04f`）。
- **2026-10-02** Claude Code host 真实运行：斗破前 120 章忠实抽取为 Source（27 Beat、29 人物、独立审稿 5 条小偏差），原样提升为 Target，续写两节——[host 对照记录](validation/2026-10-02-doupo-host/README.md)。它暴露的五个缺陷当日修掉：故事轴与属性面板不认裸写的秘密键；`suim check` 只给汇总不给逐条诊断；故事轴把 Source 里的同名人物与资源也画成泳道；没有抽取时 `review:source` 静默编出空输入（Skill 改为先提交再编审稿上下文）；正文时效按整份 `index.yaml` 比，末尾加一卷就让全书正文变黄。

- **2026-10-01** 作者的停止恰好落在请求记为已发出、实际还没发出时，下一句不再停在「模型请求结果待确认」，也不先补发停下前那次请求。「连续对话」E2E 的偶发失败就是停止与 1.5 秒计时器赛跑，查它时撞出这个缺陷；faux 回复改为等停止信号。[Harness 审查](validation/2026-10-01-harness-review/README.md)：对照业界做法与本仓原则，形状一致、恢复做得深，长会话的持久化成本与上下文生命周期是缺口，实测与复现了三个缺陷；turn 结束带对账（作者几条、意图改没改、改了什么、提交与未提交）。建了真实模型回归任务，第一次跑就抓到 `read` 一个目录时原始 `EISDIR` 掀掉整个 turn（已修）；加回只读的 `list`（审查 F6）。回归样例装上 Codex / Claude Code / Grok 接入文件后发现 Agent 会读 `AGENTS.md` 再读 host 的 Skill，并照 Skill 的做法改用委派，花费约 2.5 倍；模型的文件工具现在看不见 `.agents` / `.claude` / `.codex` / `.grok`（作者的文件视图照常），`.git` / `.suiming` 的拦截改为不分大小写（macOS 上 `.SUIMING/` 原本能写进私有目录）。`AGENTS.md` 的 Suiming 标记段原本叫所有读者先读 Skill，改为只点名给 host、告诉应用内的 Agent 不是写给它的，之后一轮 18 / 18、Agent 不再去读 Skill。[斗破真实运行](validation/2026-10-01-doupo-real-run/README.md)开跑（新 Harness 第一次让 Source 阶段碰真实模型）：读原作写 8 份笔记、做出 7 卷 83 个 Beat 的全书 Design、写出 beat-0001，账面约 $0.69（按 V4 单价记账；实际跑在 V4.1 上，按官方人民币价且国庆全天闲时约 7.17 元，约 $1.01）；途中修掉四处——Story 根下放错路径的一个文件让整部作品读不出来（改由 Checker 点名拒绝）、不带 `secret:` 前缀的秘密解析失败让 Agent 放弃了秘密硬状态、`list` 不收空路径、`write` / `edit` 不给字数让 Writer 把 6,745 码点报成「约一万字」；作者在桌面读稿时又发现两处：桌面把 head 缓存在内存里，CLI 提交到 r7 它还停在 r4、把已提交的文件标成未提交（改为每次需要时从 canon ref 重读），保存与提交状态在一屏里说三遍（改为只在需要作者动手处说一次，保留手动保存并写明理由）。审查列的 F1–F5 当日都修掉：簿记成本随项目历史平方增长（F1）、工具面升级后中途退出的会话恢复不了（F2）、上下文超限让会话卡死（F3）、开场快照与状态附注过期（F4）、没把会话 id 交给 provider（F5）。
- **2026-09-30** 错误信息按「是不是 bug」选语言：`apps/cli` 的帮助与错误、Runtime 里作者常撞到的 26 条、Checker 诊断改中文，程序错误保持英文。现行规范跟到 Session 模型，本文重排。浮层去掉退出动画，连按两下 Esc 能关掉设置框；三条桌面 E2E 失败查清修掉，其中两条曾被记成环境问题。
- **2026-09-22** CLI 收敛为 `init` / `update`，初始化失败不留文件，刷新接入保留作者的模型配置——[ADR-0013](adr/0013-cli-init-and-update.md)、[试用记录](validation/2026-09-22-cli-audit.md)。
- **2026-09-16** 重构后第一次真实对话存为基线；它暴露的审稿时效必然漏判当日修掉，改比 `subjects` 内容摘要——[记录](validation/2026-09-16-first-real-session/README.md)。`apps/web` 接入 `@shadcn/lint`，开 `no-raw-colors`。
- **2026-09-14** 版本身份瘦身：`ProjectRevision` 只剩 `{id, parentId}`（`history()` 234 → 5 ms）；路径改成扫描得到的事实，换卷是改 index 加 `mv` 两步；Cloud 加 migration 006。
- **2026-09-13** Session 取代 Run / Attempt / Conversation，删 Cloud 执行与 TUI，SQLite schema v5（Slice 1）；evidence 层改 Canon 历史派生，审稿与笔记成为普通作品文件（Slice G，[设计](derived-evidence-design.md)）；去掉 per-session worktree。Agent 可以删除作品文件，Checker 拒绝回到模型手里而不是掀掉 turn；模型调用遵守系统代理；当时误判 `openai-codex` 用不了（2026-10-02 查清是直连出去了）。
- **2026-09-12** 收敛七步：角色定义归位、意图写回指示、端口化、命令目录、git spike、Canon 迁到 git、规范定稿——[收敛方案](consolidation-plan.md)、[ADR-0010](adr/0010-git-as-canon-storage-engine.md)。`HarnessTool.replay` 改为必填。
- **2026-09-11** 模型配置与入口收敛——[设置审查](validation/2026-09-11-settings-audit/README.md)、[提供商管理](validation/2026-09-11-provider-controls/README.md)；桌面真实使用优化——[记录](validation/2026-09-11-product-audit/README.md)；Langfuse 接入——[记录](validation/2026-09-11-langfuse-audit.md)；项目审查修复——[记录](validation/2026-09-11-project-review/fixes.md)。
- **2026-09-10** 原生对话交互——[记录](validation/2026-09-10-agent-composer/README.md)；连续对话——[记录](validation/2026-09-10-conversation/README.md)；统一文档入口——[记录](validation/2026-09-10-document-navigation/README.md)；属性呈现与「读者期待」用语——[记录](validation/2026-09-10-property-review/README.md)；三栏布局、对话输入器与独立版本比较（规则见[作者工作台设计](web-product-design.md)）；工作台实现收敛——[记录](workbench-consolidation.md)。
- **2026-09-09** 内容组织与通用分屏——[记录](validation/2026-09-09-view-implementation/README.md)；状态查询取代隐式全局时点——[记录](validation/2026-09-09-story-state.md)；导航与文档交互——[记录](validation/2026-09-09-navigation/README.md)、[收纳](validation/2026-09-09-navigation-fit/README.md)、[调宽](validation/2026-09-09-pane-resize/README.md)；悬停提示——[记录](validation/2026-09-09-hover/README.md)；内容页宽度——[记录](validation/2026-09-09-content-width/README.md)；UI / UX 优化——[记录](validation/2026-09-09-ui-ux-optimization/README.md)；可视化——[记录](validation/2026-09-09-visualization.md)。
- **2026-09-08** 自有 Harness、自主 Agent、AG-UI 与 Electron 首个创作闭环；工作台按 workbench-v7 落地，控件换成 shadcn/ui + Tailwind v4——[记录](validation/2026-09-08-harness.md)。
- **2026-09-05 / 06** 新引擎首次真实闭环、host-native 对照、按作者意见重写与第一次作者盲读，见上文真实运行记录。
