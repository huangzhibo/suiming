# 燧明界：需求与目标

本文只回答“要解决什么问题、产品最终必须成立什么”。文学价值见[故事创作宪法](../strategies/story-constitution.md)，实现边界见[系统架构](architecture.md)，技术选择见[技术栈](technology.md)。

本文定义目标，不代表能力已经实现；完成证据见[当前状态](current-status.md)。桌面核心产品与自有 Harness 的决策见 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md) 与 [ADR-0012](adr/0012-own-suiming-harness.md)。

## 1. 产品目标

燧明界以自然语言作品意图或已有材料为起点，自主生成可持续创作、验证和发布的高质量长篇小说，并让长程正确性、阅读质量和无人值守能力达到可验证的 SOTA。

> **专属 Suiming Agent + 版本化 Story Artifact + AI-native 故事语言 + 确定性 Checker + 开放模型与产品接口。**

产品要解决的不是单次生成一段文字，而是让 AI 在长篇尺度上持续理解同一部作品，完成研究、设计、写作、联动修订、审稿和发布，同时让作者始终能够读取、修改、验证、迁移和继续创作自己的作品。

最终交付是本地优先的桌面创作工作台：作者既能把一个目标交给 Agent 持续推进，也能连续阅读、直接编辑、比较修改并随时调整方向。作品可视化和交互与创作质量共同验收。产品保留选择不同 provider / 模型的能力，不要求作者使用某一个 coding-agent 产品、订阅或 Cloud account。

当前只以长篇小说作为正式验收对象。短篇可以自然支持，但不能削弱长篇能力；剧本、短剧和 Reader 属于未来独立产品目标。

## 2. 成功标准

| 层 | 目标 | 最低诚实证据 |
| --- | --- | --- |
| C-SOTA | 长篇后段仍保持人物、时间、关键资源、知情边界和故事因果一致 | 确定性长程题通过；相对直写显著减少硬错误 |
| R-SOTA | 人物、场面、节奏、情感和语言达到可追读水准 | 同模型、同输入、同预算的 paired blind eval 不劣于强基线，并争取显著胜出 |
| A-SOTA | 从作品意图到可发布成稿无需逐步人工接受 | 长运行可恢复；独立 Review 能暴露问题并促使 Agent 修复或明确裁决；完整过程可追溯 |

优先级为 C → 不伤 R → A。确定性一致不能以阅读质量为代价；自主运行也不能用 Checker 通过、跳过 Review 或模型自评冒充质量成立。

三条标准的证据来源必须先于评测存在：C 的确定性长程题从真实长篇创作暴露的失败中抽取，包括人物知情、资源持有、死亡不可逆、Contract 兑现与跨范围矛盾召回；R 的强基线是同模型、同 Intent 的整书或逐章直写；A 以真实作品中 Reviewer 非 pass 后的 Agent 裁决、作者否决，以及无需逐步人工接受就跑完的长运行为证据。没有题库和基线之前，任何 SOTA 声明都不成立。

桌面产品还必须通过一个完整的纵向验收（清单见[作者工作台设计](web-product-design.md)第 9 节）：作者在同一工作台里从提出目标走到修改、独立 Review、介入、比较和提交；中断、退出重开、更换 model profile 都不丢已完成的工作，也不重复提交；作者无需逐条执行 CLI，也无需理解内部运行 ID。该验收证明产品闭环，不能代替 3 卷 30 Beat 的长篇与盲评证据。

## 3. 产品入口

各入口属于同一个 Suiming 产品，共用 Story Language、Checker、版本事务和 Cloud 同步语义。**桌面端是最终核心产品和主要作者工作台。**Cloud 目前只提供可选的 Canon 存储与显式同步，远程运行、跨设备服务与 Cloud Web 是解冻后的扩展；CLI 与 coding-agent integrations 是开发者、自动化和 host-native 入口。执行模型见 [Harness 设计](harness-design.md)，交互规范见[作者工作台设计](web-product-design.md)。

| 入口 | 主要体验 | 模型与运行方式 |
| --- | --- | --- |
| 本地桌面端（核心产品） | 在一个工作台内阅读与编辑正文、查看 Design / 人物 / 知情 / Contract、与 Agent 协作、比较 revision 与 Review 证据 | Runtime 在 Electron 主进程运行，renderer 经 IPC 接入；使用本地 model profile，不依赖 Cloud 服务 |
| Codex / Claude Code / Grok integrations | 在用户已有 coding-agent 产品中直接读取和修改 repository-native 作品 | 使用 host 自己的模型、会话和文件工具，通过平台 instructions / Skills 与 `suim --json` 调用 Suiming 能力 |
| Cloud Web（可选扩展，当前不实施） | 跨设备进行 Agent 对话、创作和作品浏览；复用桌面工作台视图 | 解冻时由共享 Harness 接 Cloud host；今天的 Cloud 只有 Canon 与显式同步 |

必须满足：

- 桌面主进程直接持有 Runtime，renderer 经 typed IPC 接入，不 shell out 或解析 CLI，也不经 localhost HTTP。
- Codex / Claude Code / Grok integrations 是正式产品入口，不是“碰巧能编辑文件”；adapter 只是薄的 instructions / Skills 与命令契约，见[系统架构](architecture.md)第 8 节。
- host-native 模式复用 host 已配置的模型与凭据；在桌面里对话或显式执行 `suim session send` 才进入 Suiming Agent 并按 model profile 调模型；`suim rank` 的评委同样按 `judge` profile 调用。
- 本地模式不要求 Cloud account。Cloud 连接与作品同步都是可选能力。
- 自然语言是主要创作入口；作者不需要理解文件路径、hash、Task DAG、Context id 或模型路由才能完成作品。
- 桌面端必须把作品工作台与自然 AI 对话合为一个连续体验：正文有良好的阅读与编辑体验，对话与作品同屏联动，activity 渐进披露，revision 结果可以直接回到权威 diff 和原始 Artifact；不能退化成后台 dashboard、只读文件查看器或作品页面旁的聊天挂件。后续 Web 复用这一产品能力。
- 桌面工作台必须提供完整 StoryOutline、人物时点视图、Contract 生命周期、World 使用位置、StoryText、Review、运行进度和 revision diff；所有视图都能回到原始 Artifact。

## 4. 作品、目录与版本

### 4.1 一个作品模型

- **Story Artifact** 是按 Story Language identity 独立寻址的作品内容，也是作品长期记忆。
- **Open Story Directory** 是标准可编辑目录表示；桌面、CLI、本地 integrations、Cloud checkout 和 repository-native project 使用同一种格式。
- **Open Story Package** 是某个明确 ProjectRevision 的封闭、可验证快照，与目录使用相同逻辑路径。
- **repository-native project** 是 Open Story Directory（它本身就是 git 仓，见 4.3）加可选的 AGENTS.md、Skills 和说明文档，不是另一种 Story Language 或旧 Runtime 的同义词。

Story Artifact 与 Story Language 是作品语义真源；机器 schema 必须从同一语义边界实现，不能在 API、Prompt 或 UI 中另建字段定义。数据库、对象存储、工作目录、编辑器、Session 消息列表、trace、索引、模型摘要和 UI state 都不能形成第二套 Canon。

### 4.2 直接编辑与提交

人类和 host coding agent 可以直接修改 Open Story Directory，不需要使用 Workspace，也不需要理解或生成 ChangeSet：

```text
已提交的 Local ProjectRevision
→ 人类或 host agent 直接修改文件
→ dirty candidate
→ suim status / check / commit
→ Runtime 从实际 diff 内部构造原子 ChangeSet
→ 新 Local ProjectRevision
```

文件修改在 commit 前只是候选，过了 Checker、baseRevision 核对和原子提交才成为已提交作品；作者或 host 自己做的普通 git commit 也只是候选。存储形态见[系统架构](architecture.md) 4.3。

桌面编辑器与 AI 改的是同一份 checkout，界面要分清未保存 buffer、已保存候选与已提交版本。AI 运行不覆盖作者未保存的内容，也不抢走焦点与阅读位置；作者与 AI 改同一文件时，冲突在动作发生的当下报出、双方都保留，不攒到提交（规则见[作者工作台设计](web-product-design.md) 4.3）。一个持续的对话可以产生多个可回退 revision。

### 4.3 开放与可移植

- 完整作品必须可读、可验证、可导入、可导出并可继续创作，不能依赖 Suiming Cloud 才能解释。
- 未修改 Artifact 经目录、Package 和 Cloud round-trip 后保持准确内容字节；修改时只重写实际变化的 Artifact。
- 本地作品目录就是 git 仓，历史随它走；审稿与笔记是普通作品文件，正文与审稿的时效从历史派生，不另存 evidence。部署 identity、凭据、session、cache、trace、remote binding 和本地私有状态不进入作品包。
- 仓库辅助文件可以与作品共存，但不能被误认或上传为 Story Artifact。
- 当前产品只接受当前格式。仍有价值的开发期旧数据直接一次性重写，不承担旧格式或旧 CLI 的兼容要求。

## 5. Agent 能力与行为

### 5.1 作者意图与对话

**作者意图是核心，不是「委托」**（2026-09-12 作者决定）。Codex、Claude Code 这类 coding agent 都没有「委托」这个概念：你说一句，它干活，报告，你再说一句；耐久的东西在仓库里，会话是一次性的。Suiming 取同一个形状——耐久的中心是 `intent/**`（Canon，过 Checker，有版本），作者在对话里说的话只要对以后仍然成立就要写回它。Session / Task 是机械边界（lease、checkpoint、按 turn 冻结的模型绑定），作者不需要知道它们存在。

一个 Session 只有一个根 Agent，负责理解这一轮要解决什么、选择动作、在 checkout 上修改并阶段提交。它可以直接执行，也可以把独立任务委派给 Worker；没有固定创作顺序，计划写在消息里而不是实体，作者不需要操作 DAG。Worker 只处理 task-local 输入，不能直接提交 Canon，所有候选由 Agent 收敛。子任务结果交付成功不代表判断正确或适用于新稿，采用前仍要核对输入与正文 / 审稿时效。Session、Task 与 Worker 的准确语义见 [Harness 设计](harness-design.md)。

turn 结束不表示作者的目标达成，达成与否由作者看作品定。未提交的候选留在 checkout，Agent 在回复里说明哪些改了还没提交，这一轮采用的长期结论写回作品或在回复里点名。只有结果未知、或续跑时模型与工具面和 checkpoint 对不上时才停下等作者，其余失败说明原因，作者再发一条消息就能继续。没有预算，只有每轮用量检查点：一轮估算花费到线就停下，作者说一句继续就接着做；理由与代价见 [Harness 设计](harness-design.md)第 10 节。

host-native coding agent 的私有会话不伪装成 Suiming Session。它直接形成文件候选并通过本地提交边界接纳，因此共享 Story 正确性与版本事务，但不伪造 Suiming 的 checkpoint、trace 或恢复能力。

### 5.2 必备能力

产品最终必须提供：

- 按表达意图读取和检索完整 Story Artifact，并回到原始 artifact 核实，不要求作者预先提供文件名、关键词或引用。
- 从明确任务编译选择性 Context，绑定实际读取内容；Context 和索引只是派生输入，不是长期记忆。作者看到的人物、知情、Contract 等派生视图与模型得到的 Context 来自同一投影，不各算一份。
- 研究与导入 Source，构建设计，按 StoryBeat 生成正文，联动修订、Review、Release 和影响分析。
- 对不同任务显式选择不同 model profile；Agent、Writer、Reviewer 等可以使用不同模型，也可以共享模型。
- 按 provider 实际支持的认证方式、额度与限制接入凭据，规则见 [AGENTS.md](../AGENTS.md)「工程边界」。
- 允许作者随时打断、补充 Intent、直接修改作品、要求重试或跳过 Review，并如实记录实际完成的检查。
- 在模型失败、进程退出、终端关闭、浏览器刷新或部署重启后保护已提交作品，并恢复承诺可恢复的运行。
- 把被采用的长期结论写回 Story Artifact；对话的消息列表、模型输出和摘要不能替代作品更新。

### 5.3 Checker 与 Review

Checker 只守确定性边界，不判断文学质量；Review 帮 Agent 和作者发现问题，但不拥有作品接受权。分工见 [AGENTS.md](../AGENTS.md) 不变量 7。

## 6. 故事要求

### 6.1 Design

StoryOutline 是跨重写和改编仍需保持的完整故事因果，不是章节摘要或正文压缩稿。读完它应能理解重要人物为何选择、事情如何发生、代价与后果如何延续、长期期待怎样兑现以及故事如何结束。

Design 何时稳定到可以写正文由作者判断，系统只标出正文写成之后它的 Design 闭包是否变过；第一卷设计完成即可写第一卷正文。Design 不是永远不能修改的定稿；正文发现需要跨不连续重写、后续依赖或其它媒介保持的新事实时，必须先回写 Design 再改正文。

Markdown 表达开放故事语义；小型可执行 IR 只投影没有模型也必须准确重放的少量硬状态。系统不能把整部小说预先压成穷尽关系的知识图谱。

### 6.2 StoryText

> **StoryBeat 保证因果完整，StoryText 保证体验完整。**

StoryText 必须把既定变化实现为读者能够经历的行动、对白、压力、反馈、停顿、幽默、关系感受和世界体验，不能退化为 StoryOutline 的逐句扩写。

每个 StoryText 的 Design 时效由它最后一次提交时的 Design 闭包与当前 Design 的差异派生。Design 重开不会删除已有正文，但会让受影响正文的时效、审稿与 Release 资格过期；系统只复核或修订实际受影响的正文。

### 6.3 信息归属

- 一个事实只有一个真源；人物轨迹、关系反向边、影响、Context 和 UI 视图按任务派生。
- Character 保存人物 identity 和聚合入口；World 保存本作实际采用的开放世界知识；Intent 保存当前有效的创作意图。
- StoryContract 只追踪少量跨 StoryBeat 的长期承诺；硬状态只表达后文不能容忍误判的边界。
- Source 忠实表达材料实际写了什么；Target Intent 决定如何使用。Reference 本身没有作品指令权，只有被选择并写入 Design 的结论才形成约束。
- Release 只从完整 StoryText 派生，分章和媒介包装不能反向改变 Design。

## 7. Local 与 Cloud

Local Project 与 Cloud Project 拥有独立 revision identity，不共享可写数据库，也不后台双写。同步必须由作者显式发起、结果可核对，冲突必须报告，不能用时间戳或 last-write-wins 静默覆盖；凭据、Local Store、运行缓存和未选择的 trace 不上传。同步动词与语义见[系统架构](architecture.md)第 9 节。

## 8. 质量学习与验证

先通过真实创作、作者选择、实际修订和失败建立可信 Dataset，再使用固定输入、模型、预算和评价标准进行消融与 paired blind eval。旧 repository-native 实现可以在具体实验中作为候选参照，但不是标准答案、固定基线或产品建设门槛。

复杂 graph 协作策略、更多 Agent、更长 Context、语义检索、更强模型、Ranker 和 Reward Model 都必须证明对质量、成本、恢复或人类体验有实际收益后才能进入默认路径。

自主运行不靠显式任务图：计划写在消息里，子智能体只在真有独立工作时委派；自由 Agent 网络、自动拓扑优化与通用 graph engine 不属于基础要求。比较 graph 的增量收益时，基线也必须具备自主 loop、相同领域能力和可靠交接，不能把更好的 prompt、更多预算或基本恢复能力误算成 graph 的收益。

系统可以根据真实证据提出和验证策略改进，但不能自行修改故事创作宪法、作者 Intent 或评价标准；生成模型也不能单独裁决自己的晋级。

## 9. 当前非目标

当前不建设完整权限计费、多人实时协作、公开 Reader、短剧、多模型蜂巢、固定 World 本体、知识图谱 Canon、持久角色 Agent、无界审稿循环、通用 Workflow DSL、通用 Agent 平台、全功能 MCP 或无真实操作支撑的界面。

这些能力只有终局确有需要且现有边界无法表达，并经过真实作品或负载验证后才进入。
