# Evidence 改为 Canon 历史派生

2026-09-13 设计稿，对应 [Harness 设计](harness-design.md)第 13 节的切片 G。作者 2026-09-12 问过「可以去掉 DesignCommit 和血缘设计吗」，2026-09-13 定了「其他能删的都删」并确认 Story Language 可以改。本文回答三件事：现在的 evidence 层在证明什么、这些证明为什么都能从 Canon 历史算出来、改完之后作品目录和代码长什么样。

> 纪律同 [Harness 设计](harness-design.md)：每条属性指到代码或测试，新增的标「没有测试」。

> 2026-09-13：已按第 7 节切片全部落地（一个提交序列）。
> 2026-09-16：审稿时效改为比 `subjects` 的内容摘要，不再比版本——第一次真实对话证明按版本比必然漏判，见第 5 节与[验收记录](validation/2026-09-16-first-real-session/README.md)。

## 1. 现状：五种记录各自在回答什么

`evidence/` 目录由 Runtime 生成、随 Canon 提交，作者不手写。五种记录：

| 记录 | 回答的问题 | 怎么回答 | 谁在用 | eval-022 的 Canon 里 |
| --- | --- | --- | --- | --- |
| DesignCommit（`design-commits/dc_*.json`，`design-commit-store.ts` 386 行） | 「正文写的时候 Design 是什么样」；「Design 稳定了没有」 | 冻结一份 Design artifact 的内容 hash 表，带 `namespace`（Target / Source）与 `through`；正文提交必须有覆盖该 Beat 的 current DesignCommit，否则 `design_not_frozen` | `commitStoryChangeSet`、Release、StoryText Review 的 subject、桌面「当前 Design」徽标、host `design freeze` / `source freeze` | 4 个 |
| StoryText lineage（`story-text-lineage.ts` 183 行，随 DesignCommit 持久） | 「这份正文依据哪个 Design」 | 正文 artifactVersionId → DesignCommit id；投影出 `current` / `possibly-incompatible` / `unbound` | 桌面每个 Beat 的 lineage 标签、Release | 6 份正文各一条 |
| ContextSnapshot（`contexts/ctx_*.json` + payload，`context-snapshot.ts` 366 行） | 「模型这次调用到底看了什么」 | 每次模型调用记 artifact 内容 hash 与范围，payload 是整份 Context | ReviewReport 与 MaterialEvidence 的绑定、host `context show` | 0 |
| MaterialEvidence（`material/me_*.json`，`material-evidence.ts` 349 行） | 「Source 原文哪些范围真的读过」 | 读取范围 + handoff，绑定 ContextSnapshot；覆盖率 = 范围并集连续 | Source freeze、Source Review、`source_notes` 工具 | 0 |
| ReviewReport（`reviews/rr_*.json`，`review-report-store.ts` 433 行） | 「这份审稿对当前稿还算不算数」 | subject artifact hash 表 + ContextSnapshot + 上游 Review id；currency = 三者对候选都仍成立 | 桌面审稿页与故事轴、Release、host `review record` | 0 |

外加可移植层：`packages/story/src/portable-evidence.ts`（204 行，五种 schema）、`portable-story-package.ts` 里的 `#carryPortableEvidence`（整包 all-or-nothing 校验，ADR-0009 记过它「局部修改导致全部 lineage 丢失」）、`project-runtime-session.ts` 把四个内存 store 装在一起、harness 每个 Task 结果里的 `sessionEvidence` 导入导出。合计约 2900 行，以及 Checker 里的 `design_not_frozen` / `story_text_lineage_conflict` / `review_design_commit_mismatch` / `material_coverage_*` 五组错误码。

## 2. 判断：三个问题，历史都答得出来

这些记录归根到底只回答三个问题：

- **(a) X 做的时候 Design 是什么样？**——X 是一份正文、一份审稿、一次 Source 抽取。
- **(b) 那之后有没有变？变了哪些？**
- **(c) 模型 / Reviewer 当时读了什么？**

Canon 是 git（本地）或带 `history()` + `snapshotForProject()` 的 `CanonStore`（Cloud）。每个 revision 是一整棵树，祖先链是历史。于是：

- (a) = **X 最后一次变化所在的 revision**（`writtenAt(path)`），那个 revision 下的树就是当时的 Design。不需要另存一份 hash 表——树本身就是 hash 表。
- (b) = 两个 revision 之间**相关路径**的 diff。「相关」不是整个 Design（那样任何改动都让全书正文变黄，等于没有信号），而是 X 的 **Design 闭包**：`design-frame.ts` 给 Writer 的那一套——这个 Beat 自己、它 refs 的人物 / 地点 / 资源 / World 文档、全部 Contract、适用的 Intent、`world/core` 与 story index。这正是 Writer 写那份正文时拿到的 Context，也是「Design 变了会不会影响这份正文」的边界。story index 只按这个 Beat 的那一段算：所在卷的 id 与标题、故事顺序里的前一个与后一个 Beat；整份 `index.yaml` 变了而这一段没变，不算变化（2026-10-02 改：斗破 host 运行在全书末尾加一卷续写，原作 27 篇正文全成了 design-changed，连载式写法每加一节都会这样）。
- (c) = 一个 revision 加一组路径。Reviewer 审的是哪些文件、在哪个 revision——记在审稿文件自己的 frontmatter 里，两个字段。

所以 DesignCommit、lineage、ContextSnapshot 三种记录整个消失；ReviewReport 与 MaterialEvidence 从「Runtime 生成的 evidence」降为**普通作品文件**，各带一个 revision 字段；currency、覆盖率、可发布性全部是**按需计算的投影**，不落盘。

「冻结」这个动作随 DesignCommit 一起去掉。Codex / Claude Code 没有「先冻结再写」的仪式；Design 稳不稳是作者的判断，系统能做的是把「这份正文写完之后 Design 变过」如实标出来。

## 3. 目标形状

### 3.1 作品目录

`evidence/` 目录不再存在。新增两类普通 artifact，都和 `reference/**` 一样是零指令权、可手改、过 Checker 的 schema 校验：

| 路径 | 内容 | 谁写 |
| --- | --- | --- |
| `review/<id>.md` | frontmatter：`layer`（design / text / source）、`scope`（`book` / Beat id 列表 / `source:<id>`）、`revision`（审的是哪个 Canon revision，或 `candidate`——只是标签）、`subjects`（审的时候每个主体文件的内容摘要，**时效由它决定**）、`verdict`、`findings`（文件路径、逐字引文、说明）；正文是给作者看的摘要 | Reviewer 经 `submit_review`（校验 schema 与引文逐字存在后落盘），或 host 经 `suim review record`，或作者手写 |
| `source/<id>/notes/<n>.md` | frontmatter：`span: [start, end]`（原文码点区间）、`material_sha256`；正文是 handoff | Source Reader 经 `write`（`record_source` 删除） |

`<id>` 由写入方给，路径就是身份；不再有 `dc_` / `ctx_` / `me_` / `rr_` 内容 hash id，也不再有 `evidence/manifest.json`。codec 增加 `review` 与 `source-note` 两种 identity，`STORY_ROOTS` 加 `review`。

### 3.2 派生状态

都是纯函数，输入只有 Canon 历史（`RevisionHistoryReader`）与当前候选，在 `packages/runtime/src/artifact/derived.ts`，Local 与 Cloud 共用：

| 函数 | 定义 | 结果 |
| --- | --- | --- |
| `writtenAtMap(reader, head)` | 从 head 沿祖先链一次算出每个路径的 blob 最后一次变化的 revision，按 head 缓存 | 路径 → revision id |
| `designClosurePaths(candidate, beatId)` | `designFrame(candidate, seeds: [beat])` 选中的 artifact 路径集 | 路径集 |
| `textCurrency(reader, head, candidate, beatId)` | `D` = 正文文件的最后变化点；比较 `designClosurePaths` 在 D 与 head 下的内容 hash（闭包里新增或删除的文件也算变化；story index 只比这个 Beat 的那一段）；全书一次算用 `textCurrencies` | `{ storyBeatId, state: "current" \| "design-changed" \| "uncommitted" \| "missing", writtenAt?, changed }` |
| `reviewCurrency(reader, head, candidate, review)` | 拿 `review.subjects`（审的时候各主体文件的 sha256）与当前候选同一批路径的摘要比：摘要不同、文件没了、或出现了审稿时不存在的主体文件，都算变。不看历史 | `{ state: "current" \| "stale", changed, revision? }`（`revision` 只是展示标签） |
| `sourceCoverage(candidate, sourceId)` | 取 `material_sha256` 等于当前 `material.txt` sha 的笔记，span 并集 | `{ sourceId, materialCodePoints, materialSha256, covered, gaps }` |
| `releaseReadiness(reader, head, candidate)` | 每个 StoryBeat 都有正文；每份正文 `current`；存在一份 `scope: book` 的 text 层审稿且 `current` | `{ publishable, blockers, texts, review? }`；verdict 不参与，原样带出 |

上一版的 `unbound`（正文没有 lineage）不再存在：凡是提交过的正文都有 `writtenAt`；候选里未提交的正文标 `uncommitted`。

计算量：`writtenAt` 走一遍祖先链、逐 commit 做树 diff，一次算出全部路径的最后变化点，按 head 缓存（`workspace.show` 已经按 head 缓存 Design 投影，同一个位置）。git 的树 diff 是 O(变化文件数)，几百个 commit 几十个正文文件毫秒级；Cloud 的 `CanonStore` 用两个 snapshot 的 hash 表相减，同一条代码。

### 3.3 Story Language 的改动

- `README.md`：删 DesignCommit 条目；把「ContextSnapshot / MaterialEvidence / ReviewReport / Release」那组换成「`review/**` 与 `source/<id>/notes/**` 是普通 artifact；正文时效、审稿时效、Source 覆盖率、可发布性是从版本历史派生的投影，不存文件」。
- `artifacts.md`：「Evidence」一节整节替换为「历史与派生状态」，写 3.1 的两个路径与 3.2 的定义；「完整开放作品包在 `evidence/` 中保存…」与「Open Story Directory 同样以 `evidence/` materialize…」两段删除；StoryText 一节里「在线系统把每个 StoryText artifact version 绑定到其生成或修订时依据的 Target DesignCommit…`unbound`」一段改为「正文的 Design 时效由它最后一次提交时的 Design 闭包与当前 Design 的差异派生，不进正文内容」。
- `outline.md` 与 [需求](vision-and-requirements.md) 6.1：「Design 冻结为 DesignCommit 后才系统生成其范围内的 StoryText」改为「Design 何时稳定到可以写正文由作者判断；系统只标出正文写成之后 Design 闭包是否变过」。「必须先回写并重新冻结 Design」改为「先回写 Design 再改正文」。
- `source.md`：「系统以 Source namespace 的 DesignCommit 冻结…`sourceCommitIds`…」一段改为「Source 的抽取就是 `source/<id>/**` 的提交；读过哪些原文由 notes 的 span 派生」。「Target 任务默认不能读取 Source」这条保留，它是权限不是 evidence。
- 包布局：Open Story Package 不含 `evidence/`；Open Story Directory 就是 git 仓，历史随 clone / bundle 走。

### 3.4 工具、命令与 host

| 现在 | 改成 |
| --- | --- |
| `commit` 的 `freeze` 参数；`suim design freeze` / `suim source freeze` | 删。提交就是提交 |
| `submit_review` 记进内存 store，`commit` 时投影成 `evidence/reviews/*.json` | `submit_review` 校验 schema、范围、引文逐字在被审文件里，然后**写 `review/<id>.md`**（`revision: candidate`）；随下一次 `commit` 进版本 |
| `record_source` / `source_notes` / `read_source` | `record_source` / `source_notes` 删，笔记用 `write` 写成文件；`read_source` 保留，按码点区间读原文（笔记的 span 与它对齐）；覆盖率是 `sourceCoverage` 投影——Agent 用 `source_coverage` 工具，CLI 是 `suim source list` 的 `coverage`，桌面与 Reviewer 读同一份 |
| `suim context show` | 删（没有 ContextSnapshot 了；模型输入是执行对象，`session.show` 能看） |
| `suim review show` / `review record` | `review record` 走与 `submit_review` 同一个校验器写文件；`show` 就是读文件加 `reviewCurrency` |
| `suim release status` / `publish` | 用 `releaseReadiness`；`publish` 仍生成 `release/**`，条件不变（正文完整、全部 current、有 current 的全书审稿），只是条件改为派生 |
| host `context compile` 的 evidence 输出 | 删 evidence 字段，编译结果不变 |
| SKILL 方法论 | 「冻结」一步删；「Design 未冻结就不提交正文」删；「text check 通过后 commit 绑定 lineage」改为「commit」；Review 与 Source 段按上表改 |

### 3.5 桌面

- 每个 Beat 的 lineage 标签：「绑定 Design dc_xxx · current / Design 已变化，可能不兼容 / 未绑定」→「写于 <revision 短 id> · Design 未变 / Design 已变：3 个文件」，点开列出 `changed`。
- 右栏「当前 Design dc_xxx · 冻结 N 个 Beat」徽标删除。
- 审稿页与故事轴的审稿泳道读 `review/**` 文件加 `reviewCurrency`；finding 锚点仍由 `anchors.ts` 从引文派生，引文现在由 `submit_review` 保证逐字存在（[Harness 设计](harness-design.md)第 6 节）。
- 比较视图的「Design 已变的文件」直接用 `textCurrency.changed`。

### 3.6 Checker

删：`design_not_frozen`、`story_text_lineage_conflict`、`review_design_commit_mismatch`、`design_commit_*`、`material_coverage_*`、`material_evidence_mismatch`、`review_report_mismatch`。

留：全部 schema / refs / 顺序 / 硬状态 / Contract 生命周期规则；`text/<beat>.md` 必须对应存在的 StoryBeat；新增 `review/**` 与 `source/<id>/notes/**` 的 frontmatter schema 校验（Checker 只查形状；审稿时效只看 `subjects` 摘要，见 3.2，与 `revision` 在不在历史里无关）。

### 3.7 可移植与 Cloud

- Open Story Directory 是 git 仓，`git clone` / `git bundle` 带走历史，派生状态在任何一处算出来都一样。
- Open Story Package 是快照，没有历史：导入即一次提交，所有正文的 `writtenAt` 就是导入 revision，全部 `current`。这是如实的——快照里本来就没有更早的信息；上一版靠 `#carryPortableEvidence` 整包搬 evidence，局部改动就全丢，反而更脆。
- Cloud Canon（PostgreSQL）实现同一个 `CanonStore`，`history()` + `snapshotForProject()` 足够跑 3.2 的派生函数；PG 里的 evidence 存储随 Cloud 执行 adapter 一起删（[Harness 设计](harness-design.md)第 12 节）。

## 4. 拆掉的代码

| 位置 | 行数 |
| --- | --- |
| `artifact/design-commit-store.ts`、`artifact/story-text-lineage.ts` | 569 |
| `evidence/context-snapshot.ts`、`material-evidence.ts`、`review-report-store.ts`、`currency.ts` | 1165 |
| `evidence/release-service.ts` 里的 DesignCommit / lineage 依赖（约一半） | ~130 |
| `artifact/project-runtime-session.ts`、`portable-story-package.ts` 的 evidence 部分、`open-story-directory.ts` 的 `EVIDENCE_PATHS` | ~350 |
| `packages/story/src/portable-evidence.ts` | 204 |
| harness：`#captureContext`、`sessionEvidence`、`prepareStageCommit` 的临时 session、`source-tools.ts` 的 `record_source` / `source_notes`、`commit` 的 freeze 分支、`review-task.ts` 的 store 绑定 | ~400 |
| CLI：`design freeze`、`source freeze`、`context show`、`review show` 的 store 路径 | ~250 |
| SQLite：无（v4 已删 Canon 五张表）；Cloud PG：evidence 表随执行 adapter 删 | — |

新增：`artifact/derived.ts` 的派生函数约 250 行（落地前的估算），codec 两种 identity 约 40 行，`submit_review` 落盘与校验约 80 行。净减约 2600 行。

## 5. 代价与放弃

- **不再证明「模型看了什么」。**作者的原话：不是医疗系统。模型输入仍作为执行对象保存，调试用；不再是作品的一部分。
- **没有部分冻结（`through`）。**每份正文有自己的 `writtenAt`，天然是「到这个 Beat 为止」的粒度，比 `through` 更细。
- **快照包导入后历史归零。**上面 3.7 说明了为什么这是更诚实的选择。
- **「Design 已变」是闭包级信号，不是语义判断。**闭包外的改动不报，闭包内改一个错别字也报；这和上一版 DesignCommit 的 hash 比对同样粗，只是不再需要作者先冻结一次。
- **同名审稿覆盖。**`review/<id>.md` 路径就是身份，写同名文件就是覆盖；上一版内容 hash id 保证「同样内容同一个 id」，现在不保证，也不需要。
- ~~同一次提交里审稿之后再改主体不会被判 stale。~~ **2026-09-16 已修**。原设计把「审的是哪一版」编码成时间（审稿文件何时进版本），于是 Agent 的自然循环「审 → 按意见改 → 一次提交」让审稿与改过的正文落在同一个 revision，比较区间为空——第一次真实对话就撞上了，一份引文已不在正文里的审稿被判成 `current`（[记录](validation/2026-09-16-first-real-session/README.md)）。现在 `submit_review` 把审的时候各主体文件的 sha256 写进 `subjects`，`reviewCurrency` 比内容不比时间；`CANDIDATE_REVISION` 降为标签。仍然不把 ContextSnapshot 加回来——摘要是审稿文件自己的一个字段，不是第二套记录。

## 6. 迁移

已有作品只有 `eval-022-suiming` 与 `suiming-new-001`。一次 Checker 通过的 Canon 提交：删 `evidence/` 目录（eval-022 是 4 个 design-commit 文件）。六份正文的 `writtenAt` 从历史算出，`review/` 与 `source/*/notes/` 为空。旧仓格式照旧不做 importer。

## 7. 切片与验收

| 切片 | 内容 |
| --- | --- |
| G1 | Story Language 三个文件改到 3.3；codec 加两种 identity；`EVIDENCE_PATHS` 删 |
| G2 | `artifact/derived.ts` 的派生函数与测试（用 git canon 造真实历史） |
| G3 | 删第 4 节的 store 与 Checker 错误码；`release-service` 改用派生 |
| G4 | harness：`submit_review` 落盘、`commit` 去 freeze、`record_source` / `source_notes` 删；`review-task.ts` 去 store |
| G5 | CLI、桌面、SKILL 按 3.4 / 3.5 |
| G6 | 两个作品的 `evidence/` 删除提交 |

| 故障或操作 | 必须得到的结果 | 测试 |
| --- | --- | --- |
| 正文提交后改了它闭包里的一个人物文件 | 该 Beat `design-changed`，`changed` 列出该文件；闭包外的 Beat 仍 `current` | `derived.test.ts`「正文时效从历史派生…」、`local-project-service.test.ts`「host 提交 StoryText 后正文时效从 git 历史派生…」（样例作品两个 Beat 的闭包都是整套 Design，闭包外的情形由 `derived.test.ts` 的 r4 一步覆盖） |
| 改了闭包外的文件 | 全部正文仍 `current` | `derived.test.ts` Release 一节：加审稿与 Release 文件不改变正文时效 |
| 正文改了但未提交 | 该 Beat `uncommitted` | `derived.test.ts`「候选里有正文、head 里没有」 |
| 审稿之后主体文件改了（哪怕和审稿落在同一次提交），或出现了审稿时不存在的主体文件 | `stale`，`changed` 列出这些路径 | `derived.test.ts`「审稿时效比的是审的时候主体文件的摘要，不是审稿进版本的时间」 |
| `submit_review` / `review record` 引文不在被审文件里、锚到不存在的路径 | 拒绝（`review_quote_not_found` / `review_anchor_not_found`），文件不落盘；Source 审稿的引文也可以出自原作 | `host-context.test.ts`「context compile 给 host 的输入…」、`cli.test.ts` host 领域命令 |
| Source notes 的 `material_sha256` 与当前原文不符 | 不计入覆盖率 | `host-context.test.ts`「host 自己读材料…」 |
| 快照包导入 | 全部正文 `current`，`writtenAt` = 导入 revision | `derived.test.ts` r2：一次提交带上全部正文即全部 current；没有单独的导入测试 |
| Release publish 条件 | 与上一版相同的三条，由派生给出；有 `design-changed` 正文时拒绝并列出 | `derived.test.ts`「Release 从完整且 current 的正文派生…」、`local-project-regressions.test.ts`、`cli.test.ts` 主流程 |
