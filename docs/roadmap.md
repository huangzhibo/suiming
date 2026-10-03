# 实施路线图

本文决定实施顺序，不定义新的领域模型。目标与边界见[需求与目标](vision-and-requirements.md)、[系统架构](architecture.md)和[作者工作台设计](web-product-design.md)，执行模型见 [Harness 设计](harness-design.md)。

2026-09-07 已按 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md) 确认桌面核心产品，并由 [ADR-0012](adr/0012-own-suiming-harness.md)收敛为自有 SuimingHarness + pi-ai：参考 pi 逻辑自行实现，不再比较其他执行路径。当前执行 S0–S5；M1–M5 的旧任务定义已移除（第 3 节），不把规范更新记作源码完成。

## 1. 排序原则

1. 真实创作与桌面产品是一条主线：作者修订、质量对照持续进行，视觉与交互从真实内容开始，不等待整部长篇全部验收。
2. 先把共享 Runtime 的恢复与事务接缝做正确，再接 renderer；Local / Cloud 不复制引擎，不在 UI 临时实现执行状态机。
3. 复用 pi-ai 模型协议，参考 pi-agent-core 逻辑自行实现唯一 Harness；执行状态、Context、交接与作品事务直接结合，不建设通用 Agent 平台或第二执行后端。
4. 每阶段交付一个可验证的纵向结果；真实作品、revision 和作者记录先备份，不能随执行数据迁移丢弃。
5. Dataset 来自真实创作；机制测试不能代替模型与作者证据。Cloud Web、生产 identity / 计费和全功能 MCP 保持冻结，已有 persistence / protocol adapter 随共享契约修正。

## 2. 里程碑总览

| 里程碑 | 状态 | 结果与边界 |
| --- | --- | --- |
| M1–M3 | 完成 | 共享领域 Runtime、目录 codec、SQLite、CLI 与三个 host 入口 |
| M4 Cloud Runtime | 收缩后冻结 | PostgreSQL / S3 Canon、Domain API 与显式同步；Cloud 执行、Worker 与事件流 2026-09-13 删除，解冻接口是 `HarnessProjectPort` |
| M5 Creative Loop | 领域能力完成，真实长篇未完成 | 已有局部真实创作与作者反馈；R / C 质量工作贯穿以下 S 阶段 |
| S0–S4 桌面工作台与自主 Agent | 完成，已收敛到 Session 模型 | 见第 4 节；现在的形状以 Harness 设计、系统架构与作者工作台设计为准 |
| S5 长篇、可视化与发行 | 进行中 | 2026-09-16 重构后第一次真实对话已存为基线；3 卷 30 Beat、作者选择、可视化深化与可安装桌面应用未完成 |
| M6 Quality Proof | 题库 / 作者记录已有，正式 paired eval 未完成 | 足够样本后进行同输入、同模型、同预算的消融与策略晋级 |
| M7 Cloud Web | 冻结 | 复用桌面工作台的后续远程入口，不重新竞争旗舰定位 |

无需等 S5 全部完成才让作者使用桌面，也不能以 UI 原型通过替代执行正确性。

## 3. M1–M5 历史任务（已移除）

M1–M5 的逐项任务定义与进度写于 Run / Attempt / worktree、固定配方与 TUI 的时代，交付的实现此后已收敛到 Session 模型，所以这里不再保留原计划文本（在开源前的提交历史里，没有公开），同第 4 节的处理。仍然有效的 R 节 paired eval 协议与盲读评委挪到了第 5 节 M6；当时的真实运行记录见[旧引擎时期的真实运行记录](validation/2026-09-05-old-engine-runs/README.md)。

## 4. S0–S5：桌面工作台与自主 Agent

S0–S4 已完成。它们的逐项计划写于 Run / Attempt / worktree 模型之下，2026-09-12 起的七步收敛与 2026-09-13 起的 Harness 切片又把交付的实现收敛到了 Session 模型，所以这里不再保留原计划文本（在开源前的提交历史里，没有公开），只记交付了什么、现在的形状在哪里看：

| 阶段 | 交付了什么 | 现在的形状 |
| --- | --- | --- |
| S0 规格与视觉 | workbench-v7 导航，六类状态在真实内容上对齐 | [作者工作台设计](web-product-design.md) |
| S1 自有 Harness 与恢复 | 自有 loop、ModelCall / Action checkpoint、命令事务、文件 journal、持久父子交接 | [Harness 设计](harness-design.md)第 4–5 节，故障验收在第 14 节 |
| S2 自主 Agent | 一个持续的根 Agent、原子能力、按需委派与独立 Review、Context 压缩 | [Harness 设计](harness-design.md)第 2、6–7、9 节 |
| S3 统一交互契约 | AG-UI + 类型化扩展、持久消息、TanStack client、只读 attach、typed IPC | [系统架构](architecture.md) 6.5 |
| S4 桌面创作闭环 | 阅读 / 修改 / Review / 作者介入 / 比较 / 提交 / 退出重开与换模型，Electron E2E 覆盖 | [作者工作台设计](web-product-design.md)第 9 节 |

Harness 余下的切片（C：read 折叠与 turn 边界压缩；E：research 工具；F：`run_command`）见 [Harness 设计](harness-design.md)第 13 节。

### S5：长篇质量、可视化深化与发行（进行中）

- 持续 R / C 工作，推进 3 卷 30 Beat、作者修订与选择、同输入 / 模型 / 预算对照，不把当前局部调用当成长篇证明。
- 深化人物时点、知情差、因果 / Contract、资源与正文联动；所有结论回到 Artifact，执行视图与故事图分开。
- 长文本、列表、diff、键盘与可访问性按真实操作验收；先验证 macOS 打包与输入，再逐个平台声明支持。
- 验收可安装发行物、升级、备份 / 导出、凭据与迁移失败恢复。通用图引擎或更多 Agent 不是完成指标；若闭环迫使我们不断扩建通用平台，重新收敛领域能力与实现范围。

## 5. 后续质量证明与 Cloud 扩展

### M6 Quality Proof

#### E0：评测协议

- 以真实失败和作者判断定义实验问题，预先固定输入、模型、预算、盲法与晋级条件；样本量和统计方法按目标确定，不把旧仓协议或模型自评分作为默认标准。host-native 可作为体验参照；模型与 Context 不同的结果不能直接归因于执行架构。Graph 的增量对照需包含具备相同能力与可靠交接的自主 loop。

#### R：真实长篇闭环、paired eval 协议与盲读评委（原在第 3 节 M5，2026-09-06 定）

- 一部不少于 3 卷 30 Beat 的真实作品跑完 Design → 正文 → 独立审稿 → 作者修订，记录失败、Context 缺口、Checker 误报 / 漏报、Reviewer 命中 / 误报、作者选择、修改距离、成本与时间；取得 Reviewer 非 pass 后 revise / accept 与作者否决 Agent 的记录。
- 从失败中抽取不少于 20 道确定性长程题进入回归（登记在 [C 题库](c-question-bank.md)）；R 的强基线定为同模型、同 Intent 的整书或逐章直写；受约束 Agent 对 host-native 通用 agent 的对照列为固定实验。
- paired eval 协议（先定规则再跑）：同一份 Design（固定一个 ProjectRevision）、同一组 Beat（第一卷全部）、同一预算上限，两条路各出一版正文：Suiming Agent（`suim session send` 写这几节，委派届时选定的 writer profile）与 host-native（Codex 或 Claude Code 按 Skill 与隔离 Writer agent）；旧仓不再作为对照臂（2026-09-06 作者决定：只基于自己的结果优化）。每轮作者盲读后的修订意见作为下一轮发给 Agent 的消息与契约修改依据，在同一份 Design 上重跑再盲读，直到作者愿意把某版留在书里。评分三层：作者盲读（匿名编号，记排序与一句理由，`~/stories/blind-read-*/answer.md` 的形式）；Checker 与题库跑分（每版单 Beat check、硬状态、题库回归题命中）；独立 Reviewer 一轮（同一 Reviewer profile，finding 数与类别）。判定：作者盲读是主指标，其余两层解释差异；Suiming Agent 在盲读上不劣于 host-native 且 Checker / Reviewer 层不更差，验证门「受约束 Agent 不劣于通用 agent」成立；劣于则改进输入、方法与模型选择；不能据此宣称质量成立，桌面视觉仍按 S0–S5 与真实任务一起验证。成本与时间随每版记录，不作为质量指标。
- 盲读评委 `suim rank`（2026-09-06 作者提出并实现，一致率待第二轮盲读对照）：让开发循环不必每轮等作者盲读。形状：一个隔离的评委子任务（`suim rank <beat-id> --candidate <file>...`，`harness/rank-experiment.ts`，结果作为 rank session 的 Task 结果持久化，不新增存储），拿该 Beat 的 Design、Intent 与 style，以及匿名打乱的候选正文，按作者盲读记录里的口径（人物能否投入、场面张力、想不想读下一章；旁白认证释义、复述、条款化、改意无依据、提前总结后果算 AI 味）给出排序与每版一句理由。护栏：评委用与 Writer 不同的模型（`judge` profile，缺省回落到 `main`，结果记下是否与 Writer 同模型）；同一批候选默认跑两个顺序（`--rounds`）取平均，压位置偏差；每次作者盲读后算评委与作者的一致率（top-1 命中与排序相关），写进 [author-choices](author-choices/README.md)，一致率不达标就不许它当预筛；评委只做预筛与回归（改 prompt / 换模型后先让它比），作者仍是最终的门，也是唯一能定评测标准的人。不做的：不把评委分数当 Reward 去自动改 prompt，不让评委改写 Intent 或宪法。

#### E1：持续 Dataset

- 从首批真实运行开始持续保存被选择的失败、候选、作者修改、Review 命中 / 误报和精确 ProjectRevision；普通未采用输出仍服从 trace 保留策略。
- 每个用例绑定实际 Context、模型参数、策略版本、成本与可重放输入。

#### E2：策略评估与晋级

- 样本覆盖足够后，为 Context、Review 配合、模型 profile 或其它明确机制建立固定预算的消融与 paired blind eval。
- 旧仓只在具体实验有信息价值时作为一个候选，不是默认基线。
- 验收：晋级门槛、结果、失败分布和回退版本可审计；模型不能自行修改评价标准或裁决自身晋级。

### M7 Cloud Web：验证门之后的扩展

Cloud Web 复用桌面已完成的 React 工作台与同一事件契约，不再创建另一套 UI 或 Agent。解冻条件保留真实创作、质量与产品正确性证据；进入前明确远程作者编辑和候选持久化边界，复用现有 artifact / commit 语义，不预建 Cloud Draft 服务。

届时补齐共享 SuimingHarness 的 Cloud host、远程身份与权限、SSE attach 和远程编辑恢复；生产 identity / 计费、多人协作与全功能 MCP 独立按真实需求验收。现有 PostgreSQL / S3 / sync adapter 不因冻结而允许与共享契约脱节。

## 6. 立即执行队列

1. **真实质量工作**（2026-10-02 作者改了评估方式）：开发期不靠作者通读整节正文——时间成本太高。改用《斗破苍穹》前 120 章的**忠实抽取**作测试台：Design 抽自原作、在桌面可视化，前若干节正文直接放原作章节，续写效果对照原作评估。分三步：① 桌面 Agent 按 [host 记录](validation/2026-10-02-doupo-host/README.md)末尾的对比协议做一遍忠实抽取，对比抽取规模、审稿 finding、故事轴结构、调用与花费——2026-10-02 用 GPT-6.1 Sol 做完（`~/stories/doupo-agent-gpt-2026-10-02` r2，数字见[当前状态](current-status.md)变更记录；DeepSeek 那次中途撞上已修的缺陷停在半路，留作对照），故事轴结构的对比还没做；那次抽取暴露的缺口 2026-10-03 已补，当天重抽验证（`~/stories/doupo-agent-gpt-2026-10-03` r2，[记录](validation/2026-10-03-doupo-agent-gpt/README.md)）：结构问题都解决了，Beat 偏短偏速记与「出入」按语仍在，重抽暴露的缺口当天已修，下一次抽取看初稿的篇幅与文风；续写这一路（写正文前取写作依据、brief 与校准、Writer 读不到 Source、状态里的时效）同日补齐，与下一次长运行一起验证；同日又在前 12 / 24 章小样本上把抽取改成分段抽取 → 整合 → 补全 → 统一修 → 审稿一轮，`source_coverage` 给出现成分段后分段与补全都并行（[记录](validation/2026-10-03-doupo-mini/README.md)），当天用它重抽 120 章：1 小时 53 分、153 节、449 条 `refs.beat`、审稿一轮 0 major（`~/stories/doupo-agent-gpt-2026-10-03c` r3，[记录](validation/2026-10-03-doupo-segmented/README.md)），分卷偏粗与人物档按语当天修了方法与工具，下一次运行验证；② **留出评测**：前 N 节放原作，后几节让 Agent 按抽自原作的 Design 写，拿原作对应章节当参照答案，评测作品里去掉 `source/` 免得读到答案；信号是 `text check`、篇幅、与原作的 n-gram 重合（模型可能背过原作）、盲读评委（`suim rank`）的名次，改 Writer 后重跑同一组看差距，作者只抽查评委分歧大的片段——10-03 在前 12 章小样本上用同一份 Design 留出两节跑通（搭作品的脚本加了 `--holdout-from`），同日在前 24 章上再留出 6 节，段长接上了，篇幅长二到七成；评委提示与 Writer 的写作方法是同一份准则，对照原作时 36 轮 35 胜说明不了「像不像同一部书」——作者定了另加读者口径的评委（`--rubric reader`），对照原作 48 轮原作胜 38 轮；文风改为先看作品选定的样章，同一组 6 节加三段原作样章后基本打平（Agent 17 / 36），方法里多写一句要求没有效果；③ **接着第 120 章往下写**：抽取截在第 120 章，续写写进第 121 章以后，作者本地有更长的原文（连续到第 140 章，之后到第 532 章有缺章），原作后文就是参照——Agent 自己定情节时它不是唯一正确的写法，评委比高下、核对设定与人物是否走样。评测永远截在原文还有后文的地方，不排「写到材料末尾之后、没有参照」的评测。以原作为底本重新设计的 `~/stories/doupo-2026-10-01` 停在 beat-0001，不再推进。host 版（Claude Code 按 Skill 忠实抽取、原样提升并续写两节，`~/stories/doupo-host-2026-10-02`）暴露的五个缺陷已修，连载式 Target 可在 index 声明 `open_ended: true`。C 题库照旧；eval-022 暂不再推进。
2. **长篇运行与界面性能**：用标注的规模 fixture 测量 checkpoint、Context、列表与 diff；用真实作品验证阅读和写作负担，不把合成数据记作质量证据。斗破作品上 2026-10-02 量过桌面查询：`workspace.show` 从中位 75 ms 降到 11 ms（按版本缓存 blob id，再按文件状态复用未变文件的字节与解析结果），读一次原作材料 68 ms → 16 ms。比较页同日改为先给文件清单、选中再按路径读两侧。还没做的是数据量随长篇增长的几处：版本下拉平铺全部 revision、执行对象没有回收。执行状态的簿记与会话内的归档成本 2026-10-01 已按 [Harness 审查](validation/2026-10-01-harness-review/README.md) 改成与历史无关或近乎无关，测量脚本在那里；命令回执仍从不清理。
3. **Harness 余下切片**：C / E / F，见 [Harness 设计](harness-design.md)第 13 节。顺序按斗破运行的数据排：折叠与边界压缩在 DeepSeek 的 1M 窗口上不急——斗破前五轮 42 次根调用后请求约 30 万 token、占窗口三成，窗口保护从未触发，缓存命中 99.9%（[记录](validation/2026-10-01-doupo-real-run/README.md)）。默认模型换成 272k 窗口的 GPT-6.1 Sol 之后不再宽裕：10-03 120 章抽取的 Source 审稿平均每次约 18.5 万 token（68%），材料再长或笔记再细就会触发清理，阈值在下一次长运行里验。E（调研）与 F（`run_command`）这次用不上，排后。C 的各项彼此独立，可以分开提交；C 里只剩折叠与边界压缩（窗口保护与 turn 结束对账 2026-10-01、`write` / `edit` 带 `check` 2026-10-02、`submit_review` 引文校验 2026-09-13 都已做）。审查 3.3 的真实模型回归任务已建（`npm run regression:harness`，[记录](validation/2026-10-01-harness-regression/README.md)：现有八个任务，2026-10-03 换成 GPT-6.1 Sol 后的新基线 23 / 23、约一小时、估算 $1.72；DeepSeek 时期最后一次 24 / 24、约 $0.22；六个任务时的基线是 16 / 17），之后改 prompt、工具描述或 loop 时用 `--only` 跑相关任务一次，全套只在节点上跑（节奏见 CLAUDE.md）；它第一次跑就抓到 `read` 目录掀掉整个 turn 的缺陷。
4. **完整作者交互**：深化 Library、精细引用、人物时点 / 因果 / Contract；保持同一 Runtime 和既有 Canon。精细引用 2026-10-03 先做了正文选段的就地修改（选段栏写要求、回车直接发出，走输入框同一条发送路径）；修改记录不另建存储——作者原话与选段在会话消息里、Agent 的改动在动作日志里、最后留下什么在 git 历史里，需要拿来改进方法时从这三处派生导出，等就地修改有了真实使用再做。
5. **可视化**：故事轴、邻域图、承诺 / 人物轨迹已落地并在 eval-022 上做过脚本化验收（[记录](validation/2026-09-09-visualization.md)）；下一步是作者本人在自己的作品上操作并记录解释负担，再决定语义解释层。
6. **认证与发行**：登录向导已接通 pi-ai 的 provider 登录流程；`openai`（ChatGPT 订阅）2026-10-02 在作者真实账号上登录并调用通过，10-03 长运行中 token 刷新也在真实账号上发生过，尚缺失效恢复与桌面、CLI 同时刷新的验收；再验证 macOS 安装、升级、备份和恢复；未验证平台不标为支持。
7. **S5 / M6**：持续长篇与质量证明；复杂机制只有在相同预算对照中体现收益才晋级。

## 7. 提交与完成规则

- 一个提交只完成一个上述任务或一个明确子任务；机械重命名、行为变更和文档决策分开。
- 行为变更运行与风险相称的验收；恢复与事务使用故障注入，界面使用真实交互，文档修改检查链接与规范一致性。通过后更新[当前状态](current-status.md)，未通过真实验证的能力留在“尚未完成”。
- 设计原型不进入生产 `apps/web`，直到视觉方向被选择；生产代码不复制 mock domain model。
- 不提交 API key、Langfuse key、本地 `.env`、真实用户数据、Local SQLite、trace payload 或未脱敏作品。
- 任一任务若需要新增领域实体、持久协议或基础设施，先回到架构文档证明其终局必要性。
