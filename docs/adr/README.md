# ADR

ADR 记录重要架构选择在当时的背景、理由和后果。当前规范以[需求与目标](../vision-and-requirements.md)、[系统架构](../architecture.md)和 [Harness 设计](../harness-design.md)为准；ADR 不是 Agent 日常指令或 Story Language 字段真源。下表的「现状」列出每份 ADR 仍然有效的部分与被谁取代，各 ADR 文件头的状态行按决定编号写得更细。

| ADR | 状态 | 决定与现状 |
| --- | --- | --- |
| [0001](0001-cloud-root-and-suiming-agent.md) | Amended | 新产品根、专属 Agent、版本化 Story Artifact、一次性迁移仍有效；「Cloud 为默认产品形态」由 0007 扩展为本地入口，再由 0011 改为桌面是核心产品 |
| [0002](0002-capability-first-modular-monolith.md) | Amended | Capability-first 与模块化单体仍有效；当时的 app / package 清单由 0007 改写，PostgreSQL 承载持久任务的部分随 2026-09-13 删除 Cloud 执行失效 |
| [0003](0003-pi-ai-model-boundary.md) | Amended | Model Gateway 直接使用 pi-ai 仍有效；0009 曾改用 pi-agent-core 内循环，0012 撤回，现在只依赖 pi-ai |
| [0004](0004-ag-ui-interaction-boundary.md) | Superseded | 0009 改为自定义 RunEvent，0011 又回到 AG-UI 标准事件加类型化 Suiming 扩展；先持久化再发送、单调序号、重放不重执行保留 |
| [0005](0005-quality-before-product-runtime.md) | Superseded | 曾决定先用 headless paired eval 证明质量，再扩展 durable runtime 与 Web；实施顺序由 0006 调整 |
| [0006](0006-real-work-before-formal-eval.md) | Accepted，部分过时 | 真实创作先于正式评测、按任务显式选模型仍有效；Attempt 冻结改为按 turn 冻结，Cloud durable Run 已删除 |
| [0007](0007-local-tui-and-explicit-cloud-sync.md) | Amended | 同进程 Runtime、统一目录与 codec、host integrations、显式 Cloud 同步仍有效；专属 TUI 先由 0008 收窄、2026-09-13 删除，本地 Canon 改为 git（0010） |
| [0008](0008-creative-loop-before-product-surface.md) | Amended | 验证门、Cloud 冻结、Frame、宪法进 prompt、C 题库仍有效；桌面条件启动由 0011 撤销；范围冻结、预算、TUI、worktree 已删除 |
| [0009](0009-redesign-after-code-audit.md) | Amended | Checker 累积诊断与确定性检查、唯一执行实现、exit code 派生、一个 Review / 合并 / 搜索实现仍有效；worktree、RunEvent、DesignCommit、MaterialEvidence、Worker loop 已删除或被替换；「生成的命令目录」刻意不做 |
| [0010](0010-git-as-canon-storage-engine.md) | Accepted | 作品目录是普通 git 仓，`refs/suiming/canon` 只由过 Checker 的提交推进；提议的 bare repo 形状作废 |
| [0011](0011-desktop-product-and-autonomous-runtime.md) | Amended，已实现 | 桌面是核心产品、原子能力、AG-UI 标准事件加扩展、host-native 仍有效；执行底座由 0012 修订，「一份 Run 完成完整委托」由 2026-09-13 的 Session 模型取代 |
| [0012](0012-own-suiming-harness.md) | Accepted，已实现 | 自建唯一的 SuimingHarness、只依赖 pi-ai 仍有效；Run / Task / Attempt 与同 Attempt 恢复由 Session / Task 取代 |
| [0013](0013-cli-init-and-update.md) | Accepted | CLI 用 init 开工作品、update 维护接入；保留作者模型配置，初始化失败撤回补写文件 |

2026-09-13 起的几项大改没有单独立 ADR：Session 取代 Conversation / Run / Attempt、去掉 per-session worktree、去掉预算、evidence 改为从 Canon 历史派生、删除 Cloud 执行与 TUI。决定与理由见 [Harness 设计](../harness-design.md)第 2、10、15、16 节与 [派生状态设计](../derived-evidence-design.md)。
