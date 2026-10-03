# 历史方案与评估

这里的文档记录方案和评估当时怎么形成，不是现行规范，也不再维护。每份开头有一行状态，写明哪些落地了、哪些被推翻、现行规则在哪里。现行规范从 [AGENTS.md](../../AGENTS.md)「真源与阅读顺序」进入；历史决策见 [ADR](../adr/README.md)，验收与真实运行的记录见 [validation](../validation/README.md)。

| 文档 | 日期 | 是什么 | 现行规则见 |
| --- | --- | --- | --- |
| [重构方案](refactoring-plan.md) | 2026-09-07 | 桌面工作台与自主 Agent 的全局方案；执行部分被 2026-09-13 的 Session 模型推翻 | [系统架构](../architecture.md)、[Harness 设计](../harness-design.md) |
| [收敛方案](consolidation-plan.md) | 2026-09-12 | 概念层、命令目录、端口与 Canon 存储的七步收敛 | 同上 |
| [Graph Engineering 适配研究](graph-engineering-assessment.md) | 2026-09-07 | 不建 graph engine 与多 agent 网络的外部研究证据 | [ADR-0011](../adr/0011-desktop-product-and-autonomous-runtime.md)、[ADR-0012](../adr/0012-own-suiming-harness.md) |
| [AG-UI 采用评估](ag-ui-assessment.md) | 2026-09-07 | 改用 AG-UI 标准事件的选型研究与探针 | [技术栈](../technology.md)「AG-UI 与传输」 |
| [桌面 UI / UX 与可视化重审](desktop-ux-rethink.md) | 2026-09-08 | 六模块导航与 48 个视角的讨论稿，被 v7 布局取代 | [作者工作台设计](../web-product-design.md)、[可视化设计](../visualization-design.md) |
| [工作台导航与文档交互优化](workbench-navigation-optimization.md) | 2026-09-09 | 已实施 | 作者工作台设计 3.2–3.3 |
| [工作台视图、分屏与页面菜单](workbench-view-and-menu-proposal.md) | 2026-09-09 | 已实施 | 作者工作台设计 3.3、4.3 |
| [工作台审查与收敛](workbench-consolidation.md) | 2026-09-10 | 代码收敛记录 | 作者工作台设计第 7 节 |
| [Agent 输入能力方案](agent-input-capabilities.md) | 2026-09-10 | 引用与文本附件已实现；语音、图片与 PDF 未排期 | 作者工作台设计 4.1 |
| [assistant-ui 源码参考](assistant-ui-reference-review.md) | 2026-09-10 | 对话功能的源码研究笔记 | — |

已删除的「Agent 自主性评估」（2026-09-07）核心建议已被推翻，原文见基线提交 `7d50f37`。
