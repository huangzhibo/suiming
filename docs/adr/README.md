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
| [0014](0014-runtime-read-write-and-collection-boundaries.md) | Accepted | 文件与领域查询共用角色读范围；按顺序组成不重叠的并行组；受控写入互斥；GC 复用实体版本验证扫描仍有效 |
| [0015](0015-desktop-send-rejection.md) | Accepted | 首次发送明确被模型预检拒绝时退回草稿；结果不明与确认重试仍保留原命令 ID |
| [0016](0016-page-information-hierarchy.md) | Amended；人物折叠由 0018 取代 | 按页面工作目的组织信息：版本核对、人物概览与情节设计保持各自顺序，共享基础控件 |
| [0017](0017-check-review-state-workflows.md) | Accepted | 检查按诊断筛选，审稿按意见核对，状态查询保留观察边界，设置精简重复说明 |
| [0018](0018-character-experience-visibility.md) | Accepted | 人物经历直接可读，情节与状态变化合并；以语义色和形状区分，密集人物增加真实全书分布，其他文档去重 |
| [0019](0019-preserve-visual-structure.md) | Accepted | 情节、地点、资源保留节点连线结构；各对象补充各自所需的阶段、分布与流转视图，验收同时核对图形结构 |
| [0020](0020-contract-response-without-deadlines.md) | Accepted | 期待保留实际回应记录；叙事期限与节奏要求留在正文，不作为精确 Beat 截止规则 |
| [0021](0021-contract-progressive-preview.md) | Accepted | 期待路径按内容宽度换向，阶段与标题常驻，原文共用按需预览 |
| [0022](0022-searchable-version-history.md) | Accepted | 三处版本入口共用检索，稳定编号、精确优先，侧栏只列最近版本而全部历史仍可达 |
| [0023](0023-long-editor-state-and-diff.md) | Accepted | 标签与文件保留临时撤销和滚动现场，内容变化不接旧栈；长文比较按计算时间控制精度 |
| [0024](0024-observability-results-and-content.md) | Accepted | 整轮结果、持久调用编号与来源标识；默认关闭、显式开启的有界内容采集 |
| [0025](0025-actionable-child-failure.md) | Accepted | 可续做的子任务失败反馈带真实任务编号与已有续做入口，不新建恢复状态 |
| [0026](0026-harness-context-lifecycle.md) | Accepted | 保留原始历史，请求投影按窗口摘要；复用现有 loop、checkpoint 与观测，反馈沿用 AG-UI |
| [0027](0027-repository-recovery-boundaries.md) | Accepted | 完整冷备份复用自含目录，Canon 历史显式传递；恢复先保全，对话不与作品快照混装 |
| [0028](0028-macos-preview-delivery.md) | Accepted | 自含 macOS 预览应用与真实安装测试；同格式替换和完整冷备份回退，启动失败必须可见 |
| [0029](0029-search-keyboard-continuity.md) | Accepted | 搜索到编辑保持焦点与返回条目，两个搜索入口共用键盘行为，更多结果完整可达 |
| [0030](0030-remove-frozen-cloud.md) | Accepted | 删除冻结 Cloud 实现与专属协议，保留本地核心和数据，未来按届时核心重建 |
| [0031](0031-external-file-draft-recovery.md) | Accepted | 草稿按原路径保留，外部删除后显式恢复复用空基线 CAS，重命名不自动搬移草稿 |
| [0032](0032-document-shell-feedback.md) | Accepted | 文档外壳只保留导航与工具行，文件异常按需展开，操作反馈回归状态栏 |
| [0033](0033-continuous-use-and-data-preservation.md) | Accepted | 顶层需求纳入持续使用、数据保全和验证分工；操作规则与完成证据各归原文档维护 |
| [0034](0034-local-architecture-consolidation.md) | Accepted | 草稿恢复失败保全原记录，移除测试专用版本实现，整理文档编辑与导航职责 |
| [0035](0035-shared-checkout-write-protection.md) | Accepted | 共享 checkout 的整篇覆盖与删除核对本轮读取版本；保留局部编辑、手动合并和原有草稿机制 |
| [0036](0036-agent-editor-sync.md) | Accepted | 普通消息直接发送；Agent 访问哪个文件就按原保存 CAS 同步哪个文件的草稿，冲突与恢复由 Agent 用 read / write 处理 |
| [0037](0037-agent-workbench-context.md) | Accepted | 发送时界面快照、根 Agent 展示能力；复用导航与比较，保护作者现场与取消边界 |
| [0038](0038-collaboration-modes-goal-and-slash-commands.md) | Accepted，协作模式与目标已实现 | 讨论 / 协作 / 自主三种协作模式按工具面保证；作者设定的目标自动续跑，用量检查点按作者开的那一轮计；`/` 命令只是现有能力的入口 |

2026-09-13 起的几项大改没有单独立 ADR：Session 取代 Conversation / Run / Attempt、去掉 per-session worktree、去掉预算、evidence 改为从 Canon 历史派生、删除 Cloud 执行与 TUI。决定与理由见 [Harness 设计](../harness-design.md)第 2、10、15、16 节与 [派生状态设计](../derived-evidence-design.md)。
