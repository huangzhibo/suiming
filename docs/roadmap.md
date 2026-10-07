# 实施路线图

本文决定实施顺序，不定义新的领域模型。目标与边界见[需求与目标](vision-and-requirements.md)、[系统架构](architecture.md)和[作者工作台设计](workbench-design.md)，执行模型见 [Harness 设计](harness-design.md)。

当前执行 S0–S5：桌面是核心产品（[ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md)），执行用自有 SuimingHarness + pi-ai（[ADR-0012](adr/0012-own-suiming-harness.md)）。不把规范更新记作源码完成。

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
| M4 Cloud Runtime | 收缩后冻结 | PostgreSQL / S3 Canon、Domain API 与显式同步；没有执行，解冻时的接口位置见[系统架构](architecture.md)第 9 节 |
| M5 Creative Loop | 领域能力完成，真实长篇未完成 | 已有局部真实创作与作者反馈；R / C 质量工作贯穿以下 S 阶段 |
| S0–S4 桌面工作台与自主 Agent | 完成，已收敛到 Session 模型 | 见第 4 节；现在的形状以 Harness 设计、系统架构与作者工作台设计为准 |
| S5 长篇、可视化与发行 | 进行中 | 2026-09-16 重构后第一次真实对话已存为基线；3 卷 30 Beat、作者选择、可视化深化与可安装桌面应用未完成 |
| M6 Quality Proof | 题库 / 作者记录已有，正式 paired eval 未完成 | 足够样本后进行同输入、同模型、同预算的消融与策略晋级 |
| M7 Cloud Web | 冻结 | 复用桌面工作台的后续远程入口，不重新竞争旗舰定位 |

无需等 S5 全部完成才让作者使用桌面，也不能以 UI 原型通过替代执行正确性。

## 3. M1–M5 历史任务（已移除）

旧任务定义写于 Run / Attempt / worktree、固定配方与 TUI 的时代，不再保留；仍然有效的 paired eval 协议与盲读评委在第 5 节 M6，当时的真实运行见[旧引擎时期的真实运行记录](validation/2026-09-05-old-engine-runs/README.md)。

## 4. S0–S5：桌面工作台与自主 Agent

S0–S4 已完成。原计划文本同第 3 节一样不再保留，这里只记交付了什么、现在的形状在哪里看：

| 阶段 | 交付了什么 | 现在的形状 |
| --- | --- | --- |
| S0 规格与视觉 | workbench-v7 导航，六类状态在真实内容上对齐 | [作者工作台设计](workbench-design.md) |
| S1 自有 Harness 与恢复 | 自有 loop、ModelCall / Action checkpoint、命令事务、文件 journal、持久父子交接 | [Harness 设计](harness-design.md)第 4–5 节，故障验收在第 14 节 |
| S2 自主 Agent | 一个持续的根 Agent、原子能力、按需委派与独立 Review、Context 压缩 | [Harness 设计](harness-design.md)第 2、6–7、9 节 |
| S3 统一交互契约 | AG-UI + 类型化扩展、持久消息、TanStack client、只读 attach、typed IPC | [系统架构](architecture.md) 6.5 |
| S4 桌面创作闭环 | 阅读 / 修改 / Review / 作者介入 / 比较 / 提交 / 退出重开与换模型，Electron E2E 覆盖 | [作者工作台设计](workbench-design.md)第 9 节 |

Harness 余下的切片（E：research 工具；F：`run_command`）见 [Harness 设计](harness-design.md)第 13 节；C（loop 与 Context）2026-10-05 做完。

### S5：长篇质量、可视化深化与发行（进行中）

- 持续 R / C 工作，推进 3 卷 30 Beat、作者修订与选择、同输入 / 模型 / 预算对照，不把当前局部调用当成长篇证明。
- 深化人物时点、知情差、因果 / Contract、资源与正文联动；所有结论回到 Artifact，执行视图与故事图分开。
- 长文本、列表、diff、键盘与可访问性按真实操作验收；先验证 macOS 打包与输入，再逐个平台声明支持。
- 验收可安装发行物、升级、备份 / 导出、凭据与迁移失败恢复。通用图引擎或更多 Agent 不是完成指标；若闭环迫使我们不断扩建通用平台，重新收敛领域能力与实现范围。

## 5. 后续质量证明与 Cloud 扩展

### M6 Quality Proof

#### E0：评测协议

- 以真实失败和作者判断定义实验问题，预先固定输入、模型、预算、盲法与晋级条件；样本量和统计方法按目标确定，不把旧仓协议或模型自评分作为默认标准。host-native 可作为体验参照；模型与 Context 不同的结果不能直接归因于执行架构。Graph 的增量对照需包含具备相同能力与可靠交接的自主 loop。

#### R：真实长篇闭环、paired eval 协议与盲读评委（2026-09-06 定）

- 一部不少于 3 卷 30 Beat 的真实作品跑完 Design → 正文 → 独立审稿 → 作者修订，记录失败、Context 缺口、Checker 误报 / 漏报、Reviewer 命中 / 误报、作者选择、修改距离、成本与时间；取得 Reviewer 非 pass 后 revise / accept 与作者否决 Agent 的记录。
- 从失败中抽取不少于 20 道确定性长程题进入回归（登记在 [C 题库](c-question-bank.md)）；R 的强基线定为同模型、同 Intent 的整书或逐章直写；受约束 Agent 对 host-native 通用 agent 的对照列为固定实验。
- paired eval 协议（先定规则再跑）：同一份 Design（固定一个 ProjectRevision）、同一组 Beat（第一卷全部）、同一预算上限，两条路各出一版正文：Suiming Agent（`suim session send` 写这几节，委派届时选定的 writer profile）与 host-native（Codex 或 Claude Code 按 Skill 与隔离 Writer agent）；旧仓不再作为对照臂（2026-09-06 作者决定：只基于自己的结果优化）。每轮作者盲读后的修订意见作为下一轮发给 Agent 的消息与契约修改依据，在同一份 Design 上重跑再盲读，直到作者愿意把某版留在书里。评分三层：作者盲读（匿名编号，记排序与一句理由，`answer.md` 的形式）；Checker 与题库跑分（每版单 Beat check、硬状态、题库回归题命中）；独立 Reviewer 一轮（同一 Reviewer profile，finding 数与类别）。判定：作者盲读是主指标，其余两层解释差异；Suiming Agent 在盲读上不劣于 host-native 且 Checker / Reviewer 层不更差，验证门「受约束 Agent 不劣于通用 agent」成立；劣于则改进输入、方法与模型选择；不能据此宣称质量成立，桌面视觉仍按 S0–S5 与真实任务一起验证。成本与时间随每版记录，不作为质量指标。
- 盲读评委 `suim rank`（2026-09-06 作者提出并实现）：让开发循环不必每轮等作者盲读。形状：一个隔离的评委子任务（`suim rank <beat-id> --candidate <file>...`，`harness/rank-experiment.ts`，结果作为 rank session 的 Task 结果持久化，不新增存储），拿该 Beat 的 Design、Intent 与 style，以及匿名打乱的候选正文，按作者盲读记录里的口径（人物能否投入、场面张力、想不想读下一章；旁白认证释义、复述、条款化、改意无依据、提前总结后果算 AI 味）给出排序与每版一句理由。这是默认口径，评本作的几份候选；对照原作或参照稿时用读者口径 `--rubric reader`（2026-10-03 作者定）：不带本作宪法与写作准则、不看 Design，只给紧挨着的前文与作品选定的样章，理由见下文「斗破忠实抽取与留出评测」。护栏：评委用与 Writer 不同的模型（`judge` profile，缺省回落到 `main`，结果记下是否与 Writer 同模型；同一个模型时名次只能当参考）；同一批候选默认跑两个顺序（`--rounds`）取平均，压位置偏差；每次作者盲读后算评委与作者的一致率（top-1 命中与排序相关），写进 [author-choices](author-choices/README.md)，一致率不达标就不许它当预筛；评委只做预筛与回归（改 prompt / 换模型后先让它比），作者仍是最终的门，也是唯一能定评测标准的人。不做的：不把评委分数当 Reward 去自动改 prompt，不让评委改写 Intent 或宪法。**现状**：一致率还没量过。原定的 eval-022 第二轮盲读随 eval-022 暂停而搁置，两种口径的评委都还没有和作者判断对过；在那之前，用它做的决定都靠作者对分歧片段的抽查兜底。

#### 斗破忠实抽取与留出评测（2026-10-02 作者定）

开发期的质量评估不靠作者通读整节正文，时间成本太高。改用《斗破苍穹》前 120 章的忠实抽取作测试台：Design 抽自原作、在桌面可视化，前若干节正文直接放原作章节，续写效果对照原作评估。作者只抽查。

- **对比抽取**：桌面 Agent 按 [host 记录](validation/2026-10-02-doupo-host/README.md)末尾的对比协议做忠实抽取，对比抽取规模、审稿 finding、故事轴结构、调用与花费。
- **留出评测**：前 N 节放原作，后几节让 Agent 按抽自原作的同一份 Design 写，拿原作对应章节当参照答案。固定 Design 是因为 Agent 自己定情节的续写拿去和原作比时，评委会因原作「不兑现本节 Design」扣分。评测作品里去掉 `source/`，免得读到答案。信号是 `text check`、篇幅、与原作的 n-gram 重合（模型可能背过原作）、盲读评委的名次；改 Writer 后重跑同一组看差距，作者只抽查评委分歧大的片段。
- **评委口径**：默认评委的提示与 Writer 的写作方法是同一份准则，拿原作当参照时等于用 Writer 的考纲给原作阅卷，说明不了「像不像同一部书」，所以对照原作用读者口径。
- **文风**：先看作品选定的样章（`reference/style`），没有样章才看前文，前文首先负责接续。同一组 6 节上，方法里多写一句要求没有可测效果，加三段原作样章后基本打平——文风靠具体的例子推得动，抽象的要求推不动。
- **接着往下写**：抽取截在第 120 章，续写写进第 121 章以后，原作后文就是参照（作者手上的原文连续到第 140 章，之后到第 532 章有缺章）。Agent 自己定情节时原作不是唯一正确的写法，评委比高下，并核对设定与人物是否走样。评测永远截在原文还有后文的地方，不排「写到材料末尾之后、没有参照」的评测。

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

每项只写目标、现状与下一个动作；过程与数字在链接的记录与[变更记录](changelog.md)里，能力与缺陷在[当前状态](current-status.md)。

近期顺序（2026-10-06 定）：先跑斗破续写的长运行（第 1 项，要作者批准额度；它同时检验边界压缩的阈值、真实打断后的 `resume_task` 与意图写回这几处只有 faux 测试的机制），并行做第 2 项里不需要构建的长篇规模问题（版本列表分组、执行对象回收与回执清理）；再做大 Source 的按卷整合（见当前状态「书一大，Source 补全就做不了」）；然后是第 6 项的 macOS 安装与升级。调研与 `run_command`（第 3 项的 E / F）、A / B 决策卡与 Cloud 往后放。

1. **真实质量：斗破前 120 章忠实抽取作测试台**（协议见第 5 节「斗破忠实抽取与留出评测」）。
   - 抽取：分段抽取 → 整合 → 补全 → 统一修 → 审稿一轮，已在 120 章上跑通（[记录](validation/2026-10-03-doupo-segmented/README.md)）。分卷偏粗与人物档按语当天修了方法与工具；10-04 三国前五十回用的就是修过的方法（9 卷 231 节），分卷是否合适没有专门对照；与 host 版的故事轴结构对比还没做。
   - 留出评测：前 12 / 24 章小样本上跑了两组共 8 节（[记录](validation/2026-10-03-doupo-mini/README.md)）。对照原作改用读者口径后，加作品样章的一组与原作基本打平。下一步看初稿的篇幅与文风，并量读者评委与作者判断的一致率。
   - 续写：接着第 120 章往下写。写正文前取写作依据、brief 与校准、Writer 读不到 Source 已于 2026-10-03 补齐，与下一次长运行一起验证。
   - 「作者否决」这一维仍没有记录，暂由评测中作者的抽查补。
   - 不再推进：以原作为底本重新设计的那一版（停在 beat-0001）与 eval-022。C 题库照旧。
2. **长篇运行与界面性能**：用标注的规模 fixture 测量 checkpoint、Context、列表与 diff；用真实作品验证阅读和写作负担，不把合成数据记作质量证据。斗破作品上的桌面查询 2026-10-02 已压下来（`workspace.show` 约 11 ms，比较页先给文件清单、选中再读两侧）。还没做的是随长篇增长的几处：版本下拉平铺全部 revision、执行对象没有回收、命令回执从不清理、子任务跑着时点开动作要整份解码它的 checkpoint（见当前状态的已知缺陷）。执行状态簿记的测量脚本在 [Harness 审查](validation/2026-10-01-harness-review/README.md)。
3. **Harness 余下切片** E / F（[Harness 设计](harness-design.md)第 13 节）。C 已于 2026-10-05 做完：边界折叠与边界压缩（与原设计不同的三处，理由在第 7 节）。折叠当天在桌面走查里真实触发过，边界压缩还只有 faux 测试，下一次长运行看它是否如期压缩、占位阈值要不要调。当时先做 C 是因为默认的 GPT-6.1 Sol 窗口只有 272k：2026-10-03 斗破 120 章抽取的 Source 审稿每次请求平均约 18.5 万 token、占 68%，10-04 三国补全子任务的开场消息就超过 70% 的压缩线（补全本身要按卷做，见当前状态）；DeepSeek 的 1M 窗口上保护从未触发（[记录](validation/2026-10-01-doupo-real-run/README.md)）。E（调研）与 F（`run_command`）这次用不上，排后。改 prompt、工具描述或 loop 之后跑相关的真实模型回归（[记录](validation/2026-10-01-harness-regression/README.md)，节奏见 [packages/runtime/AGENTS.md](../packages/runtime/AGENTS.md)「真实模型调用与回归」）。
4. **完整作者交互**：深化 Library、精细引用、人物时点 / 因果 / Contract；保持同一 Runtime 和既有 Canon。精细引用先做了正文选段的就地修改（2026-10-03，选段栏写要求、回车直接发出，走输入框同一条发送路径）。修改记录不另建存储：作者原话与选段在会话消息里，Agent 的改动在动作日志里，最后留下什么在 git 历史里；需要拿来改进方法时从这三处派生导出，等就地修改有了真实使用再做。
5. **可视化**：故事轴、邻域图、承诺 / 人物轨迹已落地并在 eval-022 上做过脚本化验收（[记录](validation/2026-09-09-visualization.md)）；下一步是作者本人在自己的作品上操作并记录解释负担，再决定语义解释层。
6. **认证与发行**：`openai`（ChatGPT 订阅）的登录、调用与 token 刷新已在真实账号上发生，余下失效恢复与桌面、CLI 同时刷新的验收；再验证 macOS 安装、升级、备份和恢复；未验证平台不标为支持。依赖已于 2026-10-07 升到 Electron 44、pi-ai 1.0.4，其余升到各自大版本内的最新；跨大版本的 TypeScript 7、undici 8、zod 4 没升：TypeScript 7 等 7.1 正式版与 typescript-eslint 跟上再换，测量与触发条件在[技术栈](technology.md)「暂不引入」；另两个的理由见[变更记录](changelog.md)当天的条目，出安装包前再判断。
7. **S5 / M6**：持续长篇与质量证明；复杂机制只有在相同预算对照中体现收益才晋级。

## 7. 提交与完成规则

见 [AGENTS.md](../AGENTS.md)「提交与完成规则」；新增领域实体、持久协议或基础设施前的终局论证见 [AGENTS.md](../AGENTS.md)「工程边界」。
