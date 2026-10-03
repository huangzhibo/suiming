# StoryText、Reference、审稿与 Release

本页定义 Design 之外的作品内容。Reference 是参考资料，里面的话不当作指令；StoryText 保存最终表达；审稿文件记录可反驳的判断及其对应版本；Release 提供发布视图；它们都不维护一份与 Design 竞争的故事事实 Canon。

## Reference

`reference/materials/**` 保存必要的原始资料；`reference/research/**` 保存按稳定主题维护的研究认识。二者都不是作品事实，只有被选择并写入 Design 的结论才能约束后续任务。

它们虽然不是 Canon，仍是作品目录里可移植的 Reference，和 `reference/style/**` 一样随目录、作品包与 Cloud checkout 完整保存，不因当前 Agent 没有读取就被丢掉。

`reference/style/<id>.md` 只保存被 Intent 经 `style_refs` 选择的表达证据。它的 id 必须是 `style_` 开头的 ASCII（如 `style_opening`），是本地 id 用中文的例外。它可以保存足以说明人物说话口吻、叙述距离或场景写法的原创对照例，或作者明确采用的 StoryText 短片段；片段中的故事内容不具有 Canon 权威，也不约束其它 Beat。不复制整章，也不保存 approved 状态。

## StoryText

`text/<beat-id>.md` 是 StoryText，不属于 Design：Design 变了，正文的时效从 git 历史派生为 `design-changed`，正文本身不跟着改。StoryText 保证体验完整。合格 StoryText 应在不静默改写既定因果的前提下，让关键选择、冲突、揭示、胜负和后果以读者能够跟随、感受并获得反馈的过程发生。

一段文字可以不推进事件，却推进读者体验：

- 蓄积期待和压力；
- 让胜利获得足够反馈；
- 展示旁人对主角地位变化的反应；
- 让人物闲谈、斗嘴并建立陪伴感；
- 让读者享受能力、资源、身份或世界细节；
- 给高潮留下停顿和余波；
- 制造笑点、熟悉感和人物的说话口吻；
- 在高压情节之间提供呼吸和反差。

> 情节暂时不动，读者的期待、情绪、关系感受和世界体验仍然可以变化。

体验完整不要求把所有动作场景化，也不为凑篇幅保留重复内容。删除后既不损失故事事实，也不损失期待、情绪、关系感受、人物亲近感、爽感反馈、幽默、沉浸、节奏或回响的内容，才属于应压缩的注水。

StoryText 可以创造措辞、动作颗粒、对白、感官、氛围、表演和节奏，也可以创造不改变既定因果、不成为后续故事依赖的局部人物、物件、环境与互动事实。下一节正文接着紧挨的前一节写时可以延续这些内容，但删除 StoryText 后不保证在重新生成或改编时复现。

若实现产生新的关键动机、因果、知情、关系、状态、承诺或后文解释，或者某项局部发现将成为后续故事依赖、需要跨不连续重写或其它媒介继续保持，必须先回写 Design 并提交，再处理真正受影响的正文。StoryText 因而不是第二 Canon，但也不是只能换词执行 Design 的无创作权产物。

每个 `text/<beat-id>.md` 实现同 ID 的 StoryBeat。文件内容就是最终故事文本，不保存版本号、Design 摘要、生成参数或工作流状态；`text/` 也不保存未绑定的序章、附录或分章目录。正文层审稿可以记录 Reviewer 对正文是否仍符合当前 Design 的独立判断。作者提供但尚未成为完整 StoryText 的局部片段使用 Intent 保存。

Workspace 或 ProjectRevision 可以只包含部分 StoryText，也可以保留尚待校准的完整候选。路径存在和确定性检查通过只说明文件覆盖与机器边界，不是语义接受或审稿结论；文件覆盖与审稿时效都从明确版本派生，不回填正文 frontmatter。

正文的 Design 时效由它最后一次提交时的 Design 闭包（这个 Beat、它引用的人物 / 地点 / 资源 / World 文档、Contract、适用的 Intent，以及 story index 里它所在的卷与前后相邻的 Beat）与当前 Design 的差异派生：闭包没变是 `current`，变了是 `design-changed` 并列出变过的文件，等待影响分析、修订或复核，不自动删除；候选里未提交的正文是 `uncommitted`。这个状态不证明正文已经符合当前 text Intent 或通过 Review；它是版本派生值，不进入 StoryText 内容。

## 审稿与历史派生状态

审稿与读材料的笔记是普通作品文件，只记录判断和它对应的版本，不维护故事事实：

- ReviewDraft 是 Reviewer 的结构化模型输出，只含 verdict、摘要、可定位 finding、未覆盖范围和不确定性，不让模型手写版本号、hash 或运行元数据。
- `review/<id>.md` 是一份审稿，由审稿工具写出、不手写，正文是给作者看的摘要。frontmatter 记：
  - `layer`：design、text 或 source；
  - `scope`：`book`、Beat id 列表或 `source:<id>`；
  - `revision`：审的是哪个 ProjectRevision，审提交前的候选时写 `candidate`。**这只是标签**，不参与时效判定；
  - `subjects`：审的时候每个主体文件的内容摘要，路径 → `sha256:<hex>`。**时效由它决定**；
  - `verdict` 与 `findings`：finding 的 wire 字段用 snake_case（`repair_layer`、`source_id`）。每条 `evidence` 必须逐字出自被审文件，写入时校验；Source 审稿锚在抽取文件上时也可以引原作。
- `source/<id>/notes/<n>.md` 是读过一段原文后留下的交接笔记，格式见 source 主题「笔记与覆盖率」。

时效与覆盖率不存文件，按需派生：审稿的主体（design 层是整套 Design，text 层是范围内正文及各 Beat 的 Design 闭包，source 层是该 Source 的材料与 extraction）在当前候选里的摘要与 `subjects` 一致就是 `current`；有主体变了、或审稿之后才成为主体的文件，就是 `stale` 并列出这些路径；Source 的覆盖率由笔记派生。这些派生值只能说明对象是否已经变化，不能证明模型理解正确，也不拥有作品接受权。写作过程中的探索性意见通常只留在运行 trace 里；不要增加 waiver、override、批准 DAG 或面向作者的 hash 工作流。

本地的 Open Story Directory 是 git 仓库，历史随 clone / bundle 走；Open Story Package 是没有历史的快照，导入即一次提交，此后的时效从导入版本起算。本地数据库、临时 Context、cache 和 remote binding 进入 `.suiming/` 或被丢弃。

## Release

`release/**` 只能从完整且 Design 时效 `current` 的 StoryText 派生。`release/manifest.yaml` 记录发布依据的 ProjectRevision、每个 StoryText 内容 hash、可选的 current 全书正文审稿 id，以及章节到 StoryBeat 正文码点范围的无损映射。正文或 Design 变化后旧 Release 变为 stale，不阻断作品继续修改。

默认质量路径先完成全书语义审稿；用户要求跳过，或 Agent 不同意 Reviewer 时，Release 仍可继续。绑定的审稿不要求 `pass`，没有审稿时也不伪造一份。发布章节只按大致篇幅优先在段落或句子边界切分，可以跨 Beat 或切在 Beat 内，不能反向改变 StoryBeat 或 StoryText。
