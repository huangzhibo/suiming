# 派生状态：时效、覆盖率与可发布性

正文时效、审稿时效、Source 覆盖率与能不能发布，怎么从 Canon 历史派生。2026-09-13 起它取代原先由 Runtime 生成的 evidence 层（[Harness 设计](harness-design.md)第 13 节的切片 G）。审稿文件与 Source 笔记的字段归 [Story Language](../story-language/artifacts.md)，这里不复制。

> 纪律同 [Harness 设计](harness-design.md)：每条属性指到代码或测试。

## 1. 原先的 evidence 层

原先的 `evidence/` 目录由 Runtime 生成、随 Canon 提交，作者不手写，有五种记录：DesignCommit（冻结一份 Design 的 hash 表，正文提交必须有覆盖该 Beat 的 current DesignCommit）、StoryText lineage（正文 → DesignCommit）、ContextSnapshot（每次模型调用读了什么）、MaterialEvidence（Source 原文读过哪些范围）、ReviewReport（审稿对当前稿还算不算数）。连同可移植层、把四个内存 store 装在一起的 `project-runtime-session.ts`、harness 每个 Task 结果里的 `sessionEvidence` 导入导出，约 2900 行，Checker 里还有五组专用错误码。

改版时它的实际用量很说明问题：eval-022 的 Canon 里只有 4 个 design-commit 与 6 条 lineage，contexts / reviews / material 全是 0。可移植层整包搬 evidence（`#carryPortableEvidence`）还是 all-or-nothing，局部修改就丢掉全部 lineage（ADR-0009 记过）。作者 2026-09-12 问过「可以去掉 DesignCommit 和血缘设计吗」，2026-09-13 定了「其他能删的都删」并确认 Story Language 可以改。

## 2. 判断：三个问题，历史都答得出来

这些记录归根到底只回答三个问题：

- **(a) X 做的时候 Design 是什么样？**——X 是一份正文、一份审稿、一次 Source 抽取。
- **(b) 那之后有没有变？变了哪些？**
- **(c) 模型 / Reviewer 当时读了什么？**

Canon 是带历史的版本库：每个 revision 是一整棵树，祖先链是历史（本地是 git；Cloud 还没接上同一套契约，见第 3.2 节末）。于是：

- (a) = **X 最后一次变化所在的 revision**（`writtenAt(path)`），那个 revision 下的树就是当时的 Design。不需要另存一份 hash 表——树本身就是 hash 表。
- (b) = 两个 revision 之间**相关路径**的 diff。「相关」不是整个 Design（那样任何改动都让全书正文变黄，等于没有信号），而是 X 的 **Design 闭包**：Writer 写那份正文时拿到的 Design——这个 Beat 自己、它 refs 的人物 / 地点 / 资源 / World 文档、它碰到的 Contract、适用的 Intent、`world/core` 与 story index。这就是「Design 变了会不会影响这份正文」的边界。实现是 `designClosurePaths`，与 Write Context 同一套选择（2026-10-04 改；此前借用 Design Frame，Frame 会载入整卷的 Beat 与全部 Contract、Intent，同卷任何一节一改，整卷正文都被标成 design-changed）。别的 Beat 的 `changes` 会改变这一节进入时的硬状态，按文件比时不算进来；人物已死仍被引用这类由 Checker 报。story index 只按这个 Beat 的那一段算：所在卷的 id 与标题、故事顺序里的前一个与后一个 Beat；整份 `index.yaml` 变了而这一段没变，不算变化。不这样的话，斗破 host 运行在全书末尾加一卷续写，原作 27 篇正文全成了 design-changed，连载式写法每加一节都会这样。
- (c) = 一组路径加上它们当时的样子。Reviewer 审的是哪些文件、当时内容的摘要，记在审稿文件自己的 frontmatter 里（`subjects`；为什么记摘要而不是 revision，见第 5 节）。

所以 DesignCommit、lineage、ContextSnapshot 三种记录整个消失；审稿与 Source 笔记从「Runtime 生成的 evidence」降为**普通作品文件**；时效、覆盖率、可发布性全部是**按需计算的投影**，不落盘。

「冻结」这个动作随 DesignCommit 一起去掉。Codex / Claude Code 没有「先冻结再写」的仪式；Design 稳不稳是作者的判断，系统能做的是把「这份正文写完之后 Design 变过」如实标出来。

## 3. 形状

### 3.1 作品目录

`evidence/` 目录不存在。审稿是 `review/<id>.md`，Source 笔记是 `source/<id>/notes/<n>.md`，都和 `reference/**` 一样是零指令权、可手改、过 Checker schema 校验的普通 artifact，字段见 [Story Language](../story-language/artifacts.md)。审稿由 Reviewer 经 `submit_review`（校验 schema、范围与引文逐字存在后落盘）、host 经 `suim review record`（同一个校验器）或作者手写；笔记由 Source Reader 用 `write` 写。`<id>` 由写入方给，路径就是身份，没有 `dc_` / `ctx_` / `me_` / `rr_` 这类内容 hash id，也没有 `evidence/manifest.json`。

Checker 对它们只查形状：`review/**` 与 `source/<id>/notes/**` 的 frontmatter schema，以及 `text/<beat>.md` 必须对应存在的 StoryBeat。时效不是 Checker 的事。

### 3.2 派生状态

都是纯函数，输入只有 Canon 历史（`RevisionHistoryReader`）与当前候选，在 `packages/runtime/src/artifact/derived.ts`：

| 函数 | 定义 | 结果 |
| --- | --- | --- |
| `writtenAtMap(reader, head)` | 从 head 沿祖先链一次算出每个路径的 blob 最后一次变化的 revision，按 head 缓存 | 路径 → revision id |
| `designClosurePaths(candidate, beatId)` | `designFrame(candidate, seeds: [beat])` 选中的 artifact 路径集 | 路径集 |
| `textCurrency(reader, head, candidate, beatId)` | `D` = 正文文件的最后变化点；比较 `designClosurePaths` 在 D 与 head 下的内容 hash（闭包里新增或删除的文件也算变化；story index 只比这个 Beat 的那一段）；全书一次算用 `textCurrencies` | `{ storyBeatId, state: "current" \| "design-changed" \| "uncommitted" \| "missing", writtenAt?, changed }` |
| `reviewCurrency(reader, head, candidate, review)` | 拿 `review.subjects`（审的时候各主体文件的 sha256）与当前候选同一批路径的摘要比：摘要不同、文件没了、或出现了审稿时不存在的主体文件，都算变。不看历史 | `{ state: "current" \| "stale", changed, revision? }`（`revision` 只是展示标签） |
| `sourceCoverage(candidate, sourceId)` | 取 `material_sha256` 等于当前 `material.txt` sha 的笔记，span 并集 | `{ sourceId, materialCodePoints, materialSha256, covered, gaps }` |
| `releaseReadiness(reader, head, candidate)` | 每个 StoryBeat 都有正文；每份正文 `current`；存在一份 `scope: book` 的 text 层审稿且 `current` | `{ publishable, blockers, texts, review? }`；verdict 不参与，原样带出 |

凡是提交过的正文都有 `writtenAt`；head 里还没有、只在候选里的正文标 `uncommitted`（已提交过的正文在候选里再改，仍按已提交的那一版算）。

计算量：`writtenAt` 走一遍祖先链，逐 commit 取整棵树的 blob id（`fileDigests`，只走 tree 不读内容）再与上一个 commit 比，一次算出全部路径的最后变化点；每个 commit 是 O(文件数)，不是只看变化子树的树 diff。摘要按 revision 缓存（`LocalProjectService.historyReader()`），桌面的正文时效投影按 head 缓存（`LocalWorkspace` 的 `#textProjectionFor`，`workspace.show` 每 100ms 一次也只算一遍）。

谁在用：Agent 查覆盖率用 `source_coverage` 工具，CLI 是 `suim source list` 的 `coverage`，Source 审稿与合并任务的输入（`renderSourceNotes`）读同一份，桌面还没有覆盖率视图；`suim review show` 是读文件加 `reviewCurrency`；`suim release status` / `publish` 用 `releaseReadiness`，`publish` 仍生成 `release/**`。桌面每个 Beat 显示「写于哪个版本 · 设计未变 / 设计已变：N 个文件」，只给个数，`changed` 的清单还没在界面上列出；审稿页与故事轴的审稿泳道读 `review/**` 加 `reviewCurrency`，finding 的段落锚点由 `anchors.ts` 从引文派生。

可移植与 Cloud：Open Story Directory 是 git 仓，`git clone` / `git bundle` 带走历史，派生状态在任何一处算出来都一样。Open Story Package 是快照，没有历史：导入即一次提交，所有正文的 `writtenAt` 就是导入 revision，全部 `current`。这是如实的——快照里本来就没有更早的信息；原先整包搬 evidence，局部改动就全丢，反而更脆。`RevisionHistoryReader` 目前只有 git 实现，Cloud PostgreSQL 还没接上 `CanonStore` 契约，也不算这些派生状态（AGENTS.md 不变量 3）；接上之后用两个 snapshot 的 hash 表相减就能跑同一份代码。

## 4. 拆掉的代码

约 2900 行：五个 evidence store、可移植层的 evidence 部分、harness 里的 `#captureContext` / `sessionEvidence` / 临时 session / `record_source` / `source_notes` / `commit` 的 freeze 分支、CLI 的 `design freeze` / `source freeze` / `context show`，以及 Checker 的 `design_not_frozen`、`story_text_lineage_conflict`、`review_design_commit_mismatch`、`design_commit_*`、`material_coverage_*`、`material_evidence_mismatch`、`review_report_mismatch`。新增的派生函数、两种 identity 与 `submit_review` 落盘约 370 行，净减约 2600 行。这些名字都不要重建。现在的 `material_coverage_incomplete` 不是旧的 Checker 码：它是 Runtime 在合并抽取与 Source 审稿前，从派生的覆盖率得出的 ArtifactError（`harness/material.ts`），与本文的设计一致。

## 5. 代价与放弃

- **不再证明「模型看了什么」。**作者的原话：不是医疗系统。模型输入仍作为执行对象保存，调试用；不再是作品的一部分。
- **没有部分冻结（`through`）。**每份正文有自己的 `writtenAt`，天然是「到这个 Beat 为止」的粒度，比 `through` 更细。
- **快照包导入后历史归零。**上面 3.2 说明了为什么这是更诚实的选择。
- **「Design 已变」是闭包级信号，不是语义判断。**闭包外的改动不报，闭包内改一个错别字也报；这和原先 DesignCommit 的 hash 比对同样粗，只是不再需要作者先冻结一次。
- **同名审稿覆盖。**`review/<id>.md` 路径就是身份，写同名文件就是覆盖；原先内容 hash id 保证「同样内容同一个 id」，现在不保证，也不需要。
- **审稿时效比内容摘要，不比时间。**最初的设计把「审的是哪一版」编码成时间（审稿文件何时进版本）。Agent 的自然循环「审 → 按意见改 → 一次提交」让审稿与改过的正文落在同一个 revision，比较区间为空——这不是「可能漏判」而是必然：第一次真实对话就撞上了，一份引文已不在正文里的审稿被判成 `current`（[记录](validation/2026-09-16-first-real-session/README.md)）。所以 `submit_review` 把审的时候各主体文件的 sha256 写进 `subjects`，`reviewCurrency` 比内容不比时间，`revision`（可为 `candidate`）降为展示标签。写审稿和判时效共用 `reviewSubjectPaths`，改主体范围时改一处。不要为此把 ContextSnapshot 加回来——摘要是审稿文件自己的一个字段，不是第二套记录。

## 6. 迁移

已完成：当时只有 `eval-022-suiming` 与 `suiming-new-001` 两部当前格式的作品，各用一次 Checker 通过的 Canon 提交删掉 `evidence/`，正文的 `writtenAt` 从历史算出。旧仓格式照旧不做 importer。

## 7. 验收

| 故障或操作 | 必须得到的结果 | 测试 |
| --- | --- | --- |
| 正文提交后改了它闭包里的一个人物文件 | 该 Beat `design-changed`，`changed` 列出该文件；闭包外的 Beat 仍 `current` | `derived.test.ts`「正文时效从历史派生…」、`local-project-service.test.ts`「host 提交 StoryText 后正文时效从 git 历史派生…」（样例作品两个 Beat 的闭包都是整套 Design，闭包外的情形由 `derived.test.ts` 的 r4 一步覆盖） |
| 改了闭包外的文件 | 全部正文仍 `current` | `derived.test.ts` Release 一节：加审稿与 Release 文件不改变正文时效 |
| 正文写了、还从没提交过（head 里没有） | 该 Beat `uncommitted` | `derived.test.ts`「候选里有正文、head 里没有」 |
| 审稿之后主体文件改了（哪怕和审稿落在同一次提交），或出现了审稿时不存在的主体文件 | `stale`，`changed` 列出这些路径 | `derived.test.ts`「审稿时效比的是审的时候主体文件的摘要，不是审稿进版本的时间」 |
| `submit_review` / `review record` 引文不在被审文件里、锚到不存在的路径 | 拒绝（`review_quote_not_found` / `review_anchor_not_found`），文件不落盘；Source 审稿的引文也可以出自原作 | `host-context.test.ts`「context compile 给 host 的输入…」、`cli.test.ts` host 领域命令 |
| Source notes 的 `material_sha256` 与当前原文不符 | 不计入覆盖率 | `host-context.test.ts`「host 自己读材料…」 |
| 快照包导入 | 全部正文 `current`，`writtenAt` = 导入 revision | `derived.test.ts` r2：一次提交带上全部正文即全部 `current`；没有单独的导入测试 |
| Release publish 条件 | 正文完整、全部 `current`，由派生给出；全书审稿不是必需，但 `--review` 指定的那份必须是 `current` 的全书正文审稿；有 `design-changed` 正文时拒绝并列出 | `derived.test.ts`「Release 从完整且 current 的正文派生…」、`local-project-regressions.test.ts`、`cli.test.ts` 主流程 |
