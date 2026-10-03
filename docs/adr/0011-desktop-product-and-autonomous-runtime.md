# ADR-0011：桌面核心产品与自主创作 Runtime

- 状态：Amended，已实现。仍有效：桌面是核心产品（1）、Capability 是原子领域动作且 recipe 只是可选方法（3）、父子委派与结果依赖分开且已完成历史不重写（5 的后半）、AG-UI 标准事件加类型化 Suiming 扩展（6）、模型与入口开放（7）、不接第二执行后端（8 的前半）。已被取代：2 的 pi-agent-core 内循环与 8 的替代后端评估由 [ADR-0012](0012-own-suiming-harness.md) 修订；4「一份 Run 持续完成完整委托」、5 的计划实体与累计预算由 2026-09-13 的 Session 模型取代（[Harness 设计](../harness-design.md)第 2、10 节；撤掉「委托」概念的理由见[需求与目标](../vision-and-requirements.md) 5.1）
- 日期：2026-09-07
- 决策者：作者与项目负责人

## 背景

作者已明确最终核心产品为桌面应用，并在比较自建执行层与 Codex App Server 后确认：以 Suiming 自有领域 Runtime 为产品底座，复用 `pi-ai` 与 `pi-agent-core`，保留 Codex / Claude Code / Grok 为一等 host-native 入口。

Codex 能提供结构化交接、子线程、会话恢复与自定义桌面客户端接口；原 host Skill 要求父模型转录子 Agent JSON，是本项目 adapter 的接法，不能作为 Codex 能力不足的证据。选择 pi 的依据是当前实际需要的多 provider 原生协议覆盖、模型调用前的 Context 控制，以及创作执行与作品事务的直接接入。它不证明自建方案写得更好、恢复更可靠或总维护成本更低。

研究依据见 [AG-UI 评估](../ag-ui-assessment.md)、Agent 自主性评估（已删除，原文见基线提交 `7d50f37`）、[Graph Engineering 研究](../graph-engineering-assessment.md)；原方案及迁移分析见[重构方案](../refactoring-plan.md)。

## 决定

1. **桌面是核心产品。** Electron 主进程持有共享 Runtime、凭据和本地运行 owner，React renderer 经 typed IPC 接入；作品阅读、编辑、diff、人物与证据可视化、自然对话和委托控制共同验收。视觉设计与内核修正一起推进。Cloud 是可选扩展，Web 不再与桌面竞争旗舰定位。
2. **复用通用内循环，自建创作所需控制。** `pi-ai` 承担多 provider 调用，`pi-agent-core` 的 `Agent` 承担工具循环；Suiming 拥有领域能力、Context、结果采用、作品事务、预算与持久委托。只维护一个 RunEngine，不新增通用 Agent 平台、第二套 session 库或 per-capability 执行器。
3. **Capability 是原子领域动作。** recipe 是可选方法、示例或可修改的计划模板。Agent 可以直接执行或委派；固定 authoring / review / resolution、brief / writer 等顺序退出能力定义，独立 Review 的输入、版本与证据边界保留。
4. **一份 Run 持续完成完整委托。** 可阶段提交多个 ProjectRevision；Task 表达有目标的独立工作，Attempt 冻结实际模型与输入绑定。通过稳定动作、持久结果、receipt 和检查点处理父子交接、暂停、作者 steering、提交确认与恢复；累计预算不因重试清零。
5. **显式组织任务与依赖。** 允许预规划和执行中调整；父子委派与结果依赖分开，已完成历史不重写。输入有效性复用 Context、lineage 与 Review currency，故事影响召回不冒充硬依赖。不新增 graph 数据库或独立 graph engine，复杂协作与自动拓扑优化进入有预算的实验。
6. **统一界面事件。** 目标采用 AG-UI 标准事件与类型化 Suiming 扩展，替换旧 RunEvent 词汇，不长期保留双协议投影。事件先持久化再发布，IPC / subscription / SSE 只负责传输；完整作品与 diff 走领域查询。首个 React 交互切片采用 TanStack AI client 管理消息 view state，Runtime 决定持久生命周期，接缝必须通过真实 IPC 验收。
7. **保持模型与入口开放。** 显式 profile 选择模型；删除仅凭订阅标签拒绝 automation 的规则及无独立用途的配置。按实际 provider 认证、额度和返回限制工作，未验证方式不标为支持。host-native 使用 host 自己的模型与会话，经同一作品目录和 `suim` 领域能力交付，不伪造 managed 执行记录。
8. **控制自建范围。** 当前不接 Codex App Server 第二后端，不预建多引擎抽象。Codex 作为可行替代保留评估资格；桌面可视化、结构化交接和 Checker 都不能作为排除它的理由。若实际模型覆盖变化或接入实验证明总维护更低，重新选择执行层。

## 后果与验收

我们承担持久执行、上下文压缩策略、重试、调度与故障恢复的工程责任；优先复用现有执行存储、pi 类型、领域查询和工具，不以更强控制权为理由扩建基础设施。外部模型请求不承诺 exactly-once，作品副作用通过可查询 receipt 与 journal 防止重复或覆盖。

第一条完整产品验收是：一次真实委托在桌面内完成修改、独立 Review、作者介入、比较与提交，应用退出重开后继续同一委托，并能显式替换模型。该闭环不能代替真实 3 卷 30 Beat、作者选择和同预算盲评；当前作品质量改进持续进行，不等待桌面完成。

实施按[路线图](../roadmap.md) S0–S5 推进。规范更新只表示设计成立；运行代码仍处于固定 recipe、旧 RunEvent 等迁移前形态，准确差距见[当前状态](../current-status.md)。

## 对历史决策的修订

- ADR-0003 保留直接复用 pi 模型类型与 provider 能力，明确采用 `pi-agent-core Agent`；跨 Attempt 的恢复由现有执行存储承担。
- ADR-0008 保留真实作品与质量验证、Cloud 扩张冻结；撤销桌面条件启动、视觉整体冻结和旗舰形态待重审。
- ADR-0009 保留单一引擎、worktree、领域隔离与确定性 Checker；修订 Capability 等于固定 recipe、单 Run 单次提交、AG-UI 仅第三方投影与限制自主执行的条款。通用平台和未经验证的复杂机制仍不建设。
- ADR-0010 的 Git Canon 存储方案仍为 Proposed，不因本决策自动采用。
