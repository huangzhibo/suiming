# ADR

ADR 记录重要架构选择在当时的背景、理由和后果。当前规范以[需求与目标](../vision-and-requirements.md)和[系统架构](../architecture.md)为准；ADR 不是 Agent 日常指令或 Story Language 字段真源。

| ADR | 状态 | 决定 |
| --- | --- | --- |
| [0013](0013-cli-init-and-update.md) | Accepted | CLI 用 init 开工作品、update 维护接入；保留作者模型配置，初始化失败撤回补写文件 |
| [0001](0001-cloud-root-and-suiming-agent.md) | Amended | 确立新产品根、专属 Agent、版本化 Story Artifact 和一次性迁移；产品形态由 0007 扩展 |
| [0002](0002-capability-first-modular-monolith.md) | Amended | Capability-first 与模块化单体保持；0007 增加 Local Store 和新 app/package 形态 |
| [0003](0003-pi-ai-model-boundary.md) | Amended | Model Gateway 直接使用 pi-ai；0012 改为参考 pi 逻辑自行实现 Harness |
| [0004](0004-ag-ui-interaction-boundary.md) | Superseded | 曾以 AG-UI 为远程交互边界；0009 改为 Suiming RunEvent |
| [0005](0005-quality-before-product-runtime.md) | Superseded | 曾决定先用 headless paired eval 证明质量，再扩展 durable runtime 与 Web |
| [0006](0006-real-work-before-formal-eval.md) | Accepted | 真实创作先建立 Dataset；按任务显式选模型；正式评测不阻塞 Product Runtime |
| [0007](0007-local-tui-and-explicit-cloud-sync.md) | Amended | 专属 TUI 与 Codex / Claude Code / Grok integrations；统一目录、共享 Runtime 与显式 Cloud 同步；TUI 定位由 0008 收窄 |
| [0008](0008-creative-loop-before-product-surface.md) | Amended | 保留真实创作、质量验证和 Cloud 扩张冻结；0009 修订实现，0011 明确桌面核心产品并前移视觉与交互 |
| [0009](0009-redesign-after-code-audit.md) | Amended | 单一执行实现、worktree 与领域修正保持；0011 修订配方和产品，0012 修订内循环为自有 Harness |
| [0010](0010-git-as-canon-storage-engine.md) | Proposed | git 作为 Canon 存储引擎：`.suiming/` 里的 bare repo 取代自建快照与历史，Checker 门禁与 evidence 绑定不变；Cloud 解冻前必须决定 |
| [0011](0011-desktop-product-and-autonomous-runtime.md) | Amended，待实现 | 桌面、自主 Agent、原子能力、任务结构、AG-UI 与 host-native 保持；执行底座由 0012 修订 |
| [0012](0012-own-suiming-harness.md) | Accepted，待实现 | 参考 pi 逻辑自行实现 SuimingHarness，继续依赖 pi-ai；不再比较其他执行路径，同 Attempt 暂停与恢复 |
