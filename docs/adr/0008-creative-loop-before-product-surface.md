# ADR-0008：创作闭环先于产品表面

- 状态：Amended by [ADR-0009](0009-redesign-after-code-audit.md)；当时顺序与验证门保留，随后由 ADR-0011 前移桌面工作，决定 7 的分层 Review 改为整体删除、决定 8 的编排收敛改为单一 RunEngine、路线图任务重编号
- 日期：2026-09-04
- 决策者：项目负责人

> 2026-09-07：本文保留当时决策。桌面核心产品、持续 Agent、原子 Capability、事件与凭据边界的后续修订见 [ADR-0011](0011-desktop-product-and-autonomous-runtime.md)；当前规范以需求、架构和技术栈为准。

## 背景

2026-09-04 对需求、架构与代码做了一次审核。仓库在 4 天内完成 10 次提交、约 3.8 万行源码，M1 到 M4 已贯通，测试 219 通过、9 跳过。但与产品目标直接相关的证据只有 `fixtures/headless-design-smoke` 这个 2 个 StoryBeat 的 fixture 上两次真实 Design 提交成功；没有一部真实长篇，没有作者反馈。

ADR-0006 已决定"真实创作先于正式评测"，路线图第一条排序原则也写明"先证明真实创作，再扩展产品表面"，但实际执行顺序是 M2 → M3 → M4 先于 R4。审核发现的结构性问题如下：

1. **没有生成 StoryText 的能力。** 当前 task kind 只有 `design.*`、`source.read.*`、`source.extract.*`、`source.review.*` 与 `story-text.review.*`；系统能审正文，不能写正文。A-SOTA 在这个能力集下不可能成立。
2. **Design Agent 全量渲染 Target Design。** `compileDesignAuthoringContext` 把全部 Design artifact 塞进一次模型调用，Story Search 命中只用于排序；架构第 8 节定义的四维选择性 Context 没有进入 Design 路径。对几百个 StoryBeat 的长篇，这会超出上下文或成本失控。
3. **StoryCommit 是瀑布门。** 冻结要求全书 Design 完成且全部 StoryContract 结构闭合，冻结后才允许正文；这与逐卷迭代的长篇创作方式冲突。Checker 已有 `throughStoryBeatId`，说明范围冻结的基础存在。
4. **Local 与 Cloud 是两套编排。** 同一 capability 存在 `local/*-run-service` 与 `cloud/*-coordinator` 加 executors 两份实现，共享的只有 prompt、Tool schema 和操作翻译。每新增一个 capability 都要写两遍。
5. **分层 shard / merge Review 未经真实长篇验证。** 全书 StoryText Review 的单次调用上限为 20 万码点，百万字长篇必然分层；而 shard 内 observation 再 merge 的结构对跨 shard 的远距离矛盾没有召回保证，这正是 C-SOTA 关心的错误类型。
6. **没有 Run 级成本上限，观测未接线。** 模型调用 telemetry span 已存在，但没有 OpenTelemetry composition adapter，`traceId` 也未回写 Attempt。
7. **故事创作宪法没有进入任何 prompt。** 宪法被定义为质量价值真源，但 Agent 与 Reviewer 的 system prompt 各只有一句话，代码中没有引用宪法。
8. **SOTA 标准不可操作。** C 没有题库，R 没有定义强基线，A 的表述不可证伪。
9. **产品表面过大。** 需求文档把 Cloud Web 定为旗舰和默认入口，当前状态的下一步已指向 M5；对零用户、零真实作品的单人项目，这把资源投向离核心假设最远的地方。
10. **架构文档承载实现叙事并已漂移。** 架构写了 `apps/web` 与 `packages/eval`，README 写了 `integrations/claude/`，都不存在于仓库。

审核后作者提出两项需求：只有 Open Story Directory 而没有可视化不利于长篇写作；必须有能看到人物全局信息的人物塑造视图，并希望按"可切换视角的视频"组织时序与视角。这两项需求真实，但不能用 Cloud Web 回应，也不能照搬视频隐喻：系统里只有 StoryBeat 展示顺序，没有故事内年代；人物主观状态只能靠模型推断，不能做成看起来权威的"视角"。回应方式是把架构第 8 节已有的四维派生视图做成 Viewer 与 Context 共用的同一投影，先做确定性的部分。

作者进一步问本地桌面端是否更合适。评估结论：ADR-0007 选择 pi-tui 是类比 coding agent 得来的，但 coding agent 的终端成立是因为输出是代码、用户本来就在编辑器里读；小说的输出是几千字正文、需要并排对照的 Beat 和人物横切视图，终端做不好。本地作者界面的正确形态是 Electron 桌面端：主进程就是 Node，`packages/runtime` 直接在其中运行，Agent、文件读写与 Checker 同进程，渲染层经 IPC 而不是 localhost HTTP；前端与未来 Cloud Web 是同一份 React 代码。Tauri 需要把 Node Runtime 做成 sidecar，会把进程边界加回来；Obsidian 插件最快但把产品绑在别人的平台上，与 ADR-0007 拒绝 fork coding agent 的理由相同。

作者随后追问为什么不给 Agent shell、为什么模型输出必须经结构化工具变成 ChangeSet、本地不是已经 checkout 到文件系统了吗。追问暴露了两件事。第一，Agent 的工具确实过薄：只有一个整文件替换的单次提交工具，没有按范围读取、搜索、patch 和自检，这是实现没跟上架构第 3 节"多个细粒度 Workspace 工具"的说法。第二，内存 Workspace 是多余的一层：本地已有磁盘 checkout，Cloud Worker 也是有磁盘的普通进程，"Cloud 没有 checkout"是设计选择而非物理约束。每个 Run 一个 materialize 出来的 worktree 能提供内存 overlay 想提供的一切，还让 Agent 与 host 共用同一条 diff → ChangeSet 提交路径。ChangeSet 本身不是限制，它只是原子提交的单位；shell 仍然不给，原因是 Suiming 按设计要读第三方文本、Cloud 需要同等行为、证据链和 Context 纪律，这些在真实长篇的 paired eval 证明无约束 agent 更好之前不推翻。

本 ADR 不新增产品目标，只把已经决定的顺序重新钉死，并补上让创作闭环成立所缺的最小能力。

## 决定

1. **冻结 Cloud 产品表面与基础设施扩张。** 验证门通过前，不开始 Cloud Workbench、AG-UI 对话面板、Cloud Draft、非交叉 rebase、W0 / W1 视觉线、生产 identity / tenancy、计费、MCP，也不新增 Cloud-only 能力。Cloud Web 从"旗舰和默认入口"改为"终局旗舰入口，当前不实施"，在路线图中后移为 M7。已完成的 M4 保持测试覆盖，不再作为投入方向。
2. **补齐 Writer capability。** 新增 `story-text.write`：以 `writer` model profile（省略时复用 `agent`）按单个 StoryBeat 生成 StoryText，初始 Context 由 current StoryCommit 范围内的该 Beat、`refs` 闭包的人物证据、World、开放 Contract、硬状态、真实前文、text Intent 与风格证据组成，输出绑定 StoryCommit lineage。Writer 在决定 14 的 worktree 中用文件工具迭代，先只实现 headless 与 Local durable Run，不实现 Cloud coordinator / executor。
3. **Design 与 Writer 使用选择性 Context，派生投影是 Context 的基本单元。** Frame 决定每次模型调用的初始 Context，至少按目标 Volume、`refs` 闭包、`contracts` 与硬状态涉及的 identity 裁剪，不再默认全量渲染 Target Design；全量渲染只在 Design 规模低于明确阈值时作为退化路径。模型在调用中通过决定 14 的只读工具按需补读，补读结果进入同一 ContextSnapshot。Context 单元采用架构第 8 节的四维视图，形式化为 Frame(语义层, 观察入口, 时间边界, 证据边界)：时间边界只使用 StoryBeat 展示顺序，不新增年代字段；人物、读者、Contract、Resource 等观察入口只投影 refs、硬状态、知情与生命周期等确定性事实；人物主观状态是模型推断，只能作为标注为派生、可删除的值出现，不进入任何 Frame 的确定性字段。ContextSnapshot 继续只记录实际读入的 artifact。
4. **StoryCommit 支持范围冻结。** 允许冻结"到某个 StoryBeat 为止"的 Design：范围内 Contract 必须闭合或 deadline 落在范围外，范围外 Beat 可以缺失。范围 StoryCommit 服务正文写作与 StoryText Review lineage；全书 StoryCommit 仍是 Release 的前提。
5. **成本与观测前置。** Run 创建时绑定调用次数、token 与可计费金额上限，超限以 `budget_exceeded` 失败并保留 evidence；接通 OpenTelemetry composition adapter 与可选 Langfuse，并把 `traceId` 回写 Attempt。两者在第一次真实长篇 Run 前完成。
6. **宪法进入 prompt。** Agent authoring / resolution、Reviewer 与 Writer 的 system prompt 以稳定版本引用故事创作宪法的创作原则；宪法文本变化形成新的 prompt 版本并进入 Attempt binding。
7. **分层 Review 不再默认视为长程一致性保证。** shard / merge 保留为实现，但"跨 shard 远距离矛盾召回率"列为 C 题库的固定题目；在真实长篇消融证明之前，长程一致性只由 Checker、硬状态、Contract 生命周期与选择性 Context 承担，Review 报告不宣称覆盖。
8. **编排层收敛为一套。** 后续 capability 不再新增 `local/*-run-service`；Local 改为运行同一 coordinator 与进程内 executor，复用 `InMemoryExecutionState` 与 SQLite 持久化，不模拟 lease。现有五个 Local run service 在 Writer 落地时一并迁移，不单独立项重构。
9. **定义 C 题库与 R 基线。** 从真实长篇 Run 暴露的失败中抽取确定性长程题（人物知情、资源持有、死亡不可逆、Contract 兑现等）作为 C-SOTA 的最低证据；R 的强基线定为同模型、同 Intent 的整书或逐章直写，在题库形成后确定。
10. **本地桌面端作为作者界面与质量仪器，条件启动。** 本地作者界面采用 Electron 桌面端：`apps/desktop` 是壳，主进程直接运行 `packages/runtime`，Agent、文件读写、Checker 与本地 store 同进程，渲染层经 typed IPC；`apps/web` 是 React 前端，桌面端与未来 Cloud Web 共用同一份代码，只换 local IPC 或 Domain API / AG-UI 后端。不采用 Tauri，不采用浏览器加 localhost HTTP，不做 Obsidian 插件。第一版只读：渲染决定 3 的 Frame，与 Context Compiler 共用实现；人物视角是第一个视图，只包含确定性区块，即基底与家族、人物 Intent、在场 Beat 与硬状态变化、知情与知情差、Contract 生命周期、正文出场、缺口；编辑通过"在编辑器打开"回到拥有该事实的文件，内置编辑按真实需求逐步加入。桌面端在第一次真实长篇 Run 暴露出"文件与 TUI 读不过来"之后启动，不与 Writer 并行抢资源；模型推断的弧线摘要在有真实收益证据前不做；打包、签名与自动更新在有外部用户前不做。
11. **TUI 冻结为开发者与自动化入口。** `apps/tui` 保持现状，继续承担 `suim` 无子命令启动、Run 观察、interrupt 与远程终端模式，不再加入作品视图、diff 增强或编辑能力；作者面向的本地界面由桌面端承担。ADR-0007 中"专属 TUI 是一等本地产品入口"相应收窄为"一等开发者入口"。
12. **终局旗舰形态在验证门时重审。** 需求文档目前把 Cloud Web 定为终局旗舰。Cloud 不可替代的价值只有无人值守的长时间生成与跨设备访问，二者都可以由桌面端连接 Domain API 与 AG-UI 获得，不要求界面在浏览器里。桌面端优先加可选 Cloud，与 Web 优先，哪个是终局旗舰在验证门时与 M7 一起重新决定；在此之前不投入任何一方的专属工作，前端保持两者共用。
13. **文档瘦身。** architecture.md 只保留模块边界、数据流向、真源归属、刻意不做的事和决策 WHY；lease、SSE cursor、幂等键等实现叙事移入代码注释或删除。current-status 改为按 capability 的表格。README 与架构中的代码形态以实际目录为准。
14. **每个 Run 一个 worktree 取代内存 Workspace。** Workspace 保留为概念名，实现改为从 baseRevision materialize 的目录：本地在 `.suiming/worktrees/<runId>/`，Cloud 在 Worker 的临时目录，二者共用同一 scanner、排除规则与 path codec。Agent 与 Writer 只拥有限制在 worktree 根内的文件工具：按范围 `read`、`rg` / Story Search、`apply_patch`、`write`、`create / delete / rename`、按需 `check`、`frame`，不授予 shell；可以迭代多步，每步工具结果进入 ContextSnapshot，步数与成本有上限。Run 结束时扫描 worktree diff 构造唯一 ChangeSet，经完整 Checker 后原子提交，这与人类和 host agent 的 `suim commit` 是同一条路径，不再有第二种提交方式。作者的主 checkout 与 Agent 的 worktree 天然隔离，Agent 可以在 dirty checkout 上启动；提交时主 checkout 仍 dirty 则 Run 停在 candidate 状态并保留 worktree，作者处理后再提交。并行 Worker 各自拥有 worktree，Agent 以 diff 整合。中断后半改完的 worktree 保留，可续可弃。ContextSnapshot 与 Story Search 绑定 worktree 读取时的内容 hash，取代 `candidateVersion` 序号。`packages/runtime/src/artifact/workspace.ts`、内存 overlay 与 Design 操作翻译层随 Q1 删除，接受沉没成本。worktree 不是 Canon，revision 才是；不变量 3、6、7 不变。

## 验证门

以下全部成立后，才重新评估 Cloud Web 与其它产品表面：

- 一部真实长篇作品（不少于 3 个 Volume、30 个 StoryBeat）完成 Design → 范围 StoryCommit → Writer → StoryText Review → 作者修订的完整闭环，且全程在 Run 预算内；
- 该作品至少一次出现 Reviewer 非 pass 后由 Agent revise / accept 的真实记录，以及至少一次作者否决 Agent 的记录；
- Design 与 Writer 的 ContextSnapshot 显示实际读入 artifact 少于全书 artifact；
- 从该作品的失败中形成不少于 20 道确定性长程题，并进入回归测试；
- Langfuse 或等价后端能按 `traceId` 定位任意 Attempt 的完整调用树；
- Writer capability 只有一套编排实现，Local 与 Cloud 共用；
- Agent 与 Writer 在 worktree 上迭代，提交走与 host 相同的 diff → ChangeSet 路径，内存 Workspace 代码已删除；
- 若桌面端已建设，其人物视角与 Writer / Reviewer 的 Context 引用同一 Frame 实现，且 Runtime 在 Electron 主进程内运行、不经 HTTP。

## 后果

- 短期内产品表面不会扩大；Cloud Runtime 已建成的部分保持测试覆盖但不继续投入。
- 需求与目标、系统架构、路线图、当前状态、AGENTS.md 与 README 已按本 ADR 同步：Web 定位、里程碑顺序、Writer、范围 StoryCommit、Frame 与 Context 同源、Viewer 条件。architecture.md 的实现叙事瘦身另行进行。
- 范围 StoryCommit 增加一个领域概念，代价是 StoryText lineage 与 Release 资格要区分范围与全书；这是长篇迭代创作的终局需要，不是 MVP 妥协。
- 编排收敛意味着一次性迁移现有 Local run service；在 Writer 之前不单独做，避免没有新需求驱动的重构。
- 首次真实长篇会暴露 Story Language、Checker 与 prompt 的实际问题；这些问题的修复优先级高于任何新入口。Story Language 在验证门之前保持不稳定，不给兼容承诺。
- 桌面端的启动条件由真实 Run 的阅读负担决定，而不是由路线图日期决定；这避免它变成另一个先于创作证据的产品表面。
- pi-tui 的投入停止增长；已建成的 TUI 保留为开发者入口，不删除也不扩展。这是接受沉没成本，不是把它算作收益。
- ADR-0007 关于 TUI 为一等本地产品入口的决定被本 ADR 收窄；ADR-0001 关于 Cloud 为默认产品形态的决定在验证门时重审。

## 参考

- [ADR-0001](0001-cloud-root-and-suiming-agent.md)、[ADR-0006](0006-real-work-before-formal-eval.md)、[ADR-0007](0007-local-tui-and-explicit-cloud-sync.md)
- [需求与目标](../vision-and-requirements.md)、[系统架构](../architecture.md)、[实施路线图](../roadmap.md)、[当前状态](../current-status.md)
