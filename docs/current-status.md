# 当前状态（2026-10-15）

本文只回答三件事：什么已经成立、证据到哪一级、还有哪些已知缺陷。形状以[系统架构](architecture.md)与 [Harness 设计](harness-design.md)为准；接下来做什么只在[路线图](roadmap.md)第 6 节维护，发生过什么见[变更记录](changelog.md)。

## 概览

桌面工作台与自主 Agent 的主路径已贯通，首轮桌面可用性验收完成。当前进入持续使用验证：短样例可以完成真实创作闭环，长篇副本可以浏览、搜索与核对修改，但还没有完整长篇质量、长期运行性能或正式发行的证据。

- **执行**：只有 Session（根 Agent，一份连续的消息列表，idle / running）与 Task（子智能体）。Agent 直接在作者的 checkout 上工作，与作者、host agent 共用一份候选和一条提交路径。创作路径没有预算，只有每轮用量检查点（[Harness 设计](harness-design.md)第 10 节）。
- **作品**：本地作品目录就是 git 仓，`refs/suiming/canon` 只由过 Checker 的提交推进；SQLite 只存执行数据。审稿与材料笔记是普通作品文件，正文 / 审稿时效与 Source 覆盖率从 git 历史派生。
- **入口**：Electron 桌面是核心产品；`suim` CLI 与 Codex / Claude Code / Grok 三个 host 共用同一 Runtime 与 Checker。Cloud 只剩 Canon 与显式同步，产品冻结。
- **证据边界**：最高到「真实调用」。真实写作、真实流中断恢复与大型作品浏览均有证据；抽取原作、合成规模测试和少量正文不等于 Agent 完成真实长篇，也不能代替作者对文学效果的判断。

## 最近有效验收

2026-10-15：模型依赖统一升至 pi-ai / pi-telemetry 1.2.0；检查与 80 项定向机制测试通过。读取字节边界、Source 按范围预载通过 37 项机制验收；摘要与运行反馈通过机制及桌面验收；三轮连续创作的 21 次调用（18 次真实、3 次受控模拟）与真实摘要恢复的 4 次调用分别和 Langfuse 对账通过，完整真实回归 21 / 21，见[分步记录](validation/2026-10-15-harness-alignment/README.md)。

| 范围 | 已验证结果 | 证据与限制 |
| --- | --- | --- |
| 真实桌面创作闭环 | 两节正文、长期偏好写回、独立审稿、手动修订、6 个 Canon 版本；同一对话 10 轮，流中断后可续做与重载 | [创作流程与收尾核对](validation/2026-10-13-creation-workflow/README.md)；45 次已确认模型调用，不是长篇质量验收 |
| 连续创作与组合恢复 | 六节、三轮真实创作，偏好改口与新对话复用，独立审稿、人工修订、5 个 Canon 版本；跨作品草稿与迟到结果隔离 | [组合验收](validation/2026-10-14-continuous-recovery/README.md)；38 次真实调用，另以真实主模型验证受控审稿失败后沿原任务续做；不代表长篇质量 |
| 大型作品导航 | 231 情节、408 人物、1117 文件的公开三国隔离副本；24 文件提交、历史选择、搜索与返回现场 | [长篇搜索与导航](validation/2026-10-14-search-navigation/README.md)；大量 revision 与合成长正文已另测，仍不等于真实长篇持续创作 |
| 大量版本与长对话 | 10 / 100 / 500 版本检索、键盘和文件保持；真实 1314 动作历史按需加载，侧栏 / 主工作面不溢出 | [规模操作验收](validation/2026-10-14-version-and-conversation/README.md)；不等于长篇持续运行性能验收 |
| 长正文编辑与比较 | 10 万 / 100 万字符全文编辑、撤销、跨页返回、逐块还原、单栏 / 双栏、重载与保存；修复撤销丢失和长文差异粗化 | [长正文验收](validation/2026-10-14-long-editor/README.md)；合成负载，百万字符首开阅读约 2.2 秒，输入仍有超过 100ms 的样本 |
| 可视化与交互 | 人物保留直接可读经历、全书分布和卷导航；情节 / 地点 / 资源保留关系图；期待按宽度与节点数量换向，预览渐进披露 | [人物分布](validation/2026-10-13-character-distribution/README.md)、[页面去重](validation/2026-10-13-page-polish/README.md)、[期待预览](validation/2026-10-13-contract-preview/README.md)、[提示定位](validation/2026-10-12-tooltip-placement/README.md)；各页按用途呈现，没有统一套成一种布局 |
| 自动检查 | 最近全仓检查通过；全仓测试 497 项中 492 通过、5 skip；工作台 75 / 75 | 外部集成的 skip 不记通过；此前一次性 PostgreSQL / MinIO 集成有独立通过记录。本轮故障组合修复后复跑全仓测试 |
| 桌面与窗口 | 完整桌面 45 / 45 通过、0 skip，含 macOS 原生全屏；最终运行收尾修复后恢复组合串行 3 / 3 | [对齐验收](validation/2026-10-15-harness-alignment/README.md)；工具开始、重载与沿原子任务恢复实际走查 |

较早的布局迭代、失败与修复过程保留在[变更记录](changelog.md)及各次验收记录中；下面的能力与缺陷以当前实现为准。

## 能力与证据

| 能力 | 实现 | 最高证据 |
| --- | --- | --- |
| Story Language、Checker、硬状态时间线、Contract 生命周期、Release 切分 | `packages/story` | 真实调用：真实运行中的模型产出由它检查与拒绝 |
| Open Story Directory / Package codec，路径是扫描得到的事实 | `packages/runtime/src/artifact` | 机制；eval-022 的 121 文件副本端到端 |
| Canon：作品目录的 git 仓 | `git-canon-store.ts` | 机制、真实创作中的 6 个版本与大型副本 24 文件提交；不代表所有并发故障都经真实模型验证 |
| 自有 Harness：checkpoint、命令事务、写入冲突检测、被打断之后补结果续跑（不做半途核对）、阶段提交、进展型兜底与每轮用量检查点 | `packages/runtime/src/harness` | 机制与有限真实调用：事务边界有故障注入；真实模型流被强杀后的续做与消息收尾已验证，不能推及所有恢复与压缩场景 |
| 自主 Agent：读、写、检查、委派、独立 Review、提交 | `harness/agent.ts` | 真实调用：[桌面两节创作闭环](validation/2026-10-13-creation-workflow/README.md)；斗破前 120 章分段忠实抽取（并行委派、Source 审稿，[记录](validation/2026-10-03-doupo-segmented/README.md)）与留出评测的正文（[记录](validation/2026-10-03-doupo-mini/README.md)）；《三国演义》前五十回抽取到整合（[记录](validation/2026-10-04-sanguo-example/README.md)） |
| 正文 / 审稿时效、Source 覆盖率 | `artifact/derived.ts` | 真实调用：审稿时效在桌面手动修订后再次验证；Source 覆盖率有抽取记录 |
| AG-UI 事件、只读 attach、桌面 typed IPC | `sdk/run-event.ts`、`apps/desktop` | 机制、Electron E2E 与真实模型中断 / 重连 |
| 桌面工作台：阅读编辑、比较、Review、故事轴、邻域图、状态查询、检查结果、模型设置 | `apps/workbench` | Electron E2E、真实模型创作闭环与 231 情节隔离副本走查 |
| CLI 与三个 host 接入（`init` / `update`） | `apps/cli`、`integrations/` | 编译产物实际调用；Codex host-native 真实创作（2026-09-05）；Claude Code host 真实运行：斗破前 120 章忠实抽取、提升与续写（2026-10-02，[host 对照记录](validation/2026-10-02-doupo-host/README.md)） |
| 模型凭据：API key 与 OAuth 登录向导 | `model/`、设置页 | API key 经桌面 E2E；`openai`（Sign in with ChatGPT）的登录、调用与 token 刷新到真实调用；其余 OAuth 只到机制 |
| Cloud Canon 与显式同步 | `packages/cloud-*`、`apps/api` | 机制；真实 PostgreSQL 18.6 与 MinIO 上 11 项集成测试 2026-09-30 真跑通过 |
| 观测 | OpenTelemetry，Langfuse 可选 | 真实 Langfuse；整轮结果、调用编号、来源与内容开关已读回核对；Electron 观测 2/2，见[验收](validation/2026-10-14-langfuse/README.md) |
| 盲评 `suim rank` | `harness/rank-experiment.ts` | 机制；与作者判断的一致率还没量过。两种口径见[路线图](roadmap.md)第 5 节 |
| 长篇 | — | 无 |

## 证据等级

| 等级 | 含义 |
| --- | --- |
| 机制 | faux provider 或内存 / 真实 store 上的确定性测试通过 |
| 真实调用 | 用真实模型 provider 在真实或样例作品上跑通 |
| 真实长篇 | 在不少于 3 卷 30 个 StoryBeat 的真实作品上跑通并有作者反馈 |

## 已知缺陷

- **持续使用的验收边界**：页面与短创作闭环已通过上述走查；单项测试已有多标签、外部修改冲突、迟到回包、重载和恢复覆盖，但跨作品、多轮修订与长对话叠加的持续使用场景还未系统验收。尚无完整无障碍验收。缺少这些证据不能靠要求作者反复排障来补，也不意味着已经验证的单项能力未实现。

- **长篇**：尚无 3 卷 30 Beat 的完整真实作品验收。最大的真实运行是 Agent 对《三国演义》前五十回的忠实抽取（231 节，只做到整合）与斗破前 120 章的抽取和两组共 8 节的留出评测，都不是 Agent 自己写成的长篇。大型 checkpoint 的消息 / Context 对象去重、长列表和持续运行性能仍需规模数据测量；百万字符单文件已有合成编辑证据，不能代替真实长篇。[C 题库](c-question-bank.md) 17 道（目标不少于 20），2026-09-06 补硬状态后的回归是 13 / 17。
- **作者体验**：v7 工作台已在 2 Beat 样例上验收。Library 有最近作品列表与打开 / 新建，打开任意 Open Story Directory 会就地初始化；旧仓格式不迁移，初始化失败时文件夹保持原样。上下文栏与右栏可以拖拽调宽（[调宽验收](validation/2026-09-09-pane-resize/README.md)）。邻域图只画 frontmatter 声明的引用，看二跳就再点一次，不推断隐含关系。finding 的 Runtime 锚点仍只到文件，段落定位是窗口用审稿引文在 mdast 上对出来的，Reviewer 没引原文时退回到只锚文件。同一个文件被编辑器 buffer 与外部改动（作者、host agent、Agent）同时修改时只做 CAS 比较，入口是「比较外部修改」，不自动解决，也不覆盖任何一方。
- **A / B 决策卡**（针对一段给两个改法让作者选）还没做，但不是做不了：零件都在，缺的只是 `validateProductEvent` 的 CUSTOM 白名单里的一个事件名，以及一次「作者读到一段不满意」的真实场景来定给几个改法、怎么呈现。它也是「作者否决」这类证据最干净的采集口。零件清单见[作者工作台设计](workbench-design.md) 4.4 节「A / B 决策卡」。
- **发行与认证**：当前是开发构建，没有签名安装包或升级机制。设置页的登录向导接通了 pi-ai 全部 provider 的 API key / OAuth 流程（浏览器回调、设备码、手动粘贴授权码都能转述）。到「真实调用」的：API key（另经桌面 E2E）；`openai` 的 Sign in with ChatGPT——2026-10-02 登录并真实调用，10-03 凭据文件在一次真实刷新中被重写，当天 CLI 连跑多个一到两小时的运行没有一次因凭据失败。只到机制的：refresh token 作废后的失效恢复、桌面与 CLI 同时刷新，以及 `openai-codex`、Anthropic 等其余 provider 的 OAuth。订阅额度与作者自己的 Codex 共用，界面上的花费是按 API 价的估算，不是扣费。本地执行库（`.suiming/local.sqlite`）不做跨版本迁移：以后哪一版改了它的结构，打开作品会提示挪走旧库，之前的对话记录就看不到了；作品版本在作品目录的 git 仓里，不受影响。开发预览阶段刻意如此（执行数据按设计可丢），有安装包与升级机制之前要重新判断。
- **命令与 Cloud**：本地 typed IPC 命令有 SDK 目录与双向校验，但命令目录仍是三份，三个传输的适配都是手写的，理由见[系统架构](architecture.md)。Cloud 只剩 Canon 与同步，Cloud Harness host 与同等原子事件验收保持冻结；`CanonStore` 契约测试目前只有 git 一个实现在跑，Cloud 走的是自己的 store 接口与自己的测试。
- **模型预检范围**：启动只预检这次对话用的模型。没单独配置的角色从 2026-10-05 起跟随对话的模型，预检查过的就是它们要用的；单独配置过的 writer / reviewer / source-extractor 不在预检里，凭据或模型有问题时失败发生在 turn 中途、token 已经花掉。可续做的调用失败现会给父模型真实 Task ID 和已有 `resume_task` 入口，独立模型失败、重载与原任务续做已定向验证；这不等于所有角色都做过提前预检。按实际会用到的 profile 预检需要先知道 Agent 会不会委派，未实现。
- **无人值守没有方向闸**：创作路径没有预算，兜底有 `run_no_progress`、每轮用量检查点与作者打断。检查点保证没人看着时一轮最多用掉约一次整本抽取的量（GPT-6.1 Sol 上约 $12），但它只封住用量、不判断方向，**停不住「持续产出但方向错了」的 turn**，只能靠作者发现（完整说明见 [Harness 设计](harness-design.md)第 10 节）。检查点的阈值作者在设置页或 config.toml 的 `session.usage_checkpoint` 调。带交付工具的子任务另有 `unsubmittedStops >= 3` 的收口，那不是方向闸。真正的结构性改善是让作者补充的意图能沉淀回作品，见 [AGENTS.md](../AGENTS.md) 不变量 5。
- **长期意图已验证短场景的持续维护，尚非全面覆盖**：六节三轮真实创作已验证首次写回、后续改口替换同一意图文件、保留未撤销偏好和新对话仅读复用，见[组合验收](validation/2026-10-14-continuous-recovery/README.md)。写回仍由 prompt 指导；每轮确定性对账只显示哪些文件改变，不判断全部要求是否正确保存。脚本偏好不冒充作者判断，多来源矛盾消解、长期组织和大上下文压缩后保持仍无充分证据。
- **书一大，Source 补全就做不了**：补全子任务要带整份抽取回头查漏，《三国演义》前五十回抽成 231 节、408 个人物之后，光开场消息就超过 GPT-6.1 Sol 窗口的七成。2026-10-04 修掉了由此引起的无限压缩，10-05 起这种委派开场就过压缩线时不发请求、以 `delegation_too_large` 交回根 Agent（不再空转，也不掀掉整轮），但补全本身仍然放不下；[Harness 设计](harness-design.md)第 9 节写的「先按卷整合、再整书整合」还没做，补全也要跟着按卷做。
- **`refs.beat` 的新写法只在前 24 章上验证过**：抽取方法原来要「每节依赖的更早那一节写进 refs.beat」，与 Story Language 不一致，Agent 抽出的作品大量连上一节：示例三国 231 节 403 条、一半只跨一节；斗破前 120 章 153 节 449 条、28% 只跨一节。依赖闭包沿这条链传下去，`impact` 改前半本任何一节都召回后文的近九成。2026-10-04 两处措辞对齐为「紧挨着的上一节不用连」，闭包对上一节的依赖只算一跳、改 Beat 时总带上下一节（示例三国的召回降到后文的 3%）。同日斗破前 24 章重抽：只连上一节的从 22 条（33%）降到 0，跨节的依赖 44 → 42（[第七圈](validation/2026-10-03-doupo-mini/README.md)）；120 章与示例三国的数据没有重抽，旧数据里的相邻连线由闭包与故事轴兜住。
- **只活在对话里的事实，在别处看不见**：Session 的消息列表持久、完整，但不过 Checker、没有版本、不进 Open Story Package，换一个 Session 或换 host agent 就看不见；Context 头部那句「非作品事实」只是标签，不是边界。风险判断见 [Harness 设计](harness-design.md)第 2 节。
- **执行对象回收已接线，诊断还只在进程日志**：turn 结束后最多每天做一次，保留最近一小时对象；沿现存 Session / Task 的引用回收不可达节点与孤儿文件。删除事务核对活跃 turn 与扫描开始时的实体版本，跨连接启动又结束的 turn 也会使回收停止；可达对象丢失时停止删除并报警，不再静默忽略。历史旧库曾有大量字节丢失（2026-09-12），本次没有修复那些旧数据，也未提供桌面维护面板。故障注入已通过，见[边界回归](validation/2026-10-07-runtime-boundaries/README.md)。
- **命令回执从不清理**：每条执行命令留一条，三国作品一次长运行后 9,108 条、库里约 12 MB。2026-10-07 起构造执行状态不再读它们，只在命令撞上没见过的 commandId 时按 id 查一条（原来整份读，每次约 160 ms，现在 0.2 ms），所以它只占磁盘、不再拖慢 turn。簿记成本随历史平方增长的问题 2026-10-01 已修（[Harness 审查](validation/2026-10-01-harness-review/README.md) F1，数字在那里）；一整部长篇的 Context payload 与主进程响应仍需真实负载验收。
- **摘要已实测，长篇持续运行仍待验收**：2026-10-15 已替换旧的清空工具结果与 50% / 70% 压缩附注。真实模型在合成历史压力下分三批摘要，摘要结果落盘后受控退出再恢复，最新改口、已废止要求与原历史均保留；4 次调用与 Langfuse 的 purpose / ID / 用量对账一致。阈值仍需长篇负载调优，这不等于整部长篇持续运行验收，见[对齐记录](validation/2026-10-15-harness-alignment/README.md)。
- **长对话历史浏览已复测，持续运行仍待验证**：详情按动作键逐块读取，不再解开完整 checkpoint；保留 10,000 节点 / 32 MiB 编码字节缓存上限，完整恢复与格式不变。真实 1314 动作历史的首项 / 末项冷读在独立 Node 中分别为 2–6 / 85–90ms；桌面 IPC 的末项首次读取为 275–369ms，切换历史为 454–494ms，三轮未见渲染异常或详情横向溢出（[测量边界与逐次数据](validation/2026-10-14-version-and-conversation/README.md)）。查找仍按序扫描；这不是运行中流式输出、全部 checkpoint 恢复或长期内存的性能结论。
- **版本查找的语义范围**：版本页、比较基准和材料侧栏已经共用搜索，可按 rN / 数字 / 提交编号查找；10 / 100 / 500 版本完整结果、窄窗和跨版本文件保持已验收。revision 投影目前缺少有意义的修改摘要与日期，尚不能凭故事内容找到未知版本；不虚构对话归属或日期分组，不把「另一稿」做成 git 分支界面，见[作者工作台设计](workbench-design.md)第 4.4 节。
- **花费是估算**：界面与 `suim session` 显示的花费是 token 数乘 pi-ai 目录里的单一美元单价，约等于 DeepSeek 的忙时价。DeepSeek 实际分忙闲时计费（[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：忙时只在北京时间工作日 9–12、14–18 点，节假日全天闲时，闲时减半），所以闲时跑的运行实际花费约为显示值的一半到七成。2026-10-02 升级 pi-ai 之前，配置里的旧 id `deepseek-v4-flash` 已被 DeepSeek 路由到 V4.1（官方公告 V4 Flash 下线），那段时间按旧目录单价记的花费偏低，实际约为记账值的 1.5 倍（闲时）到 3 倍（忙时）。对账以服务商账单为准；要显示得准，得按 provider 接入分时与币种的计价，目前没做。

## 可以声明的能力与限制

可以声明：共享领域内核、Local / Cloud Canon 与显式同步、CLI 与三个 host adapter 成立；自有 Harness、自主 Agent、标准事件与 Electron 创作闭环已实现，经过机制、真实进程与真实调用的验证。

不能声明：完整长篇文学质量、不劣于 host 的文学效果、桌面产品全部视觉与性能目标、正式发行、生产多用户 Cloud 或 SOTA。2026-09-06 的作者盲读仍优先于更早的「效果不劣于」判断。

## 下一步

只在[路线图](roadmap.md)第 6 节维护。
