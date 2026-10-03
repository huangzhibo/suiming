# StoryOutline

## 全书与顺序

StoryOutline 用自然语言写出全书完整的因果设计。最后一个 StoryBeat 必须写清最终局面、主要代价和核心问题如何落地；不再维护独立结局摘要或 `book.yaml`。作者声明全书未完待续时例外，见下文 `open_ended`。

`outline/story/index.yaml` 只定义 Volume 与 Beat 顺序：

```yaml
schema_version: 2
volumes:
  - id: vol-0001
    title: 赤壁之战
    beat_ids: [beat-0001, beat-0002]
```

Volume 用来组织故事，也让 Context 能按卷逐步展开，不按发布字数预分章。一卷是故事的一个大阶段：主要人物的处境或舞台换了一次，容得下几场冲突；一场冲突不单独成卷。

作者边设计边连载、结局还没定时，在 index 写 `open_ended: true`，声明全书未完待续：最后一个 Beat 不是结局，不必写最终局面；Contract 在这种情况下怎样算进行中，见下文「StoryContract」。这是作者对作品状态的声明，不是让检查通过的开关：只有作者说过全书未完待续才写，Agent 不能为了消掉未兑现的诊断自己加；全书写完、结局落定后删掉这一行，Checker 就按全书结束检查所有期待。

Beat ID 是不可变身份，不是序号；故事顺序只由 `volumes` 与 `beat_ids` 的数组位置决定。插入 Beat 时分配未使用的新 ID 并放到目标位置，不重编号已有 Beat，也不用字母插号表达顺序。文件名排序没有故事语义。

Beat 文件必须放在 index 所说的那一卷的目录里。**换卷是两步：改 `index.yaml` 里的 `beat_ids`，再把文件 `mv` 到新卷目录。**只做一半，Checker 会从两头报出来：文件所在的卷在 index 里没有它，index 说的卷里又没有这个文件。顺序只有 index 能表达，位置只有文件本身能表达，两者都是事实。

## StoryBeat

StoryBeat 保证因果完整。写正文之前，它要讲清这段故事为什么发生，人物凭什么处境、欲望、矛盾和认知作出什么选择，遇到什么回应、得到或失去什么信息与资源、付出什么代价，事后人物的欲望、矛盾、认知、关系、能力、说话口吻，World 和后续期待各变成什么样。完整 StoryOutline 中的每个关键变化都应已有来源和结果；Writer 不该再临场补造会改变本 Beat 既定因果或后文理解的动机、知情、关系、状态、伏笔义务或解释。

StoryBeat 没有目标字数或压缩比。为了准确保留行动归属、事实先后、成立条件、人物认知与因果边界，它可以写得详细；通常省略的是完整对白、动作颗粒、感官、现场调度、语言风格和表演节奏，而不是故事信息。

路径为 `outline/story/<volume-id>/<beat-id>.md`：

```markdown
---
title: 立军令状
refs:
  character: [诸葛亮, 周瑜, 鲁肃]
  place: [江东中军帐]
  world: [长江水战]
contracts:
  open: [军令状]
---
周瑜以水战缺箭为由，当着众将请诸葛亮十日内督造十万支箭，意在借军法除掉这个日后的对手。诸葛亮看出其中的杀机，却不推辞，反说十日太久、只需三日，并当场立下军令状：误期甘受军法。鲁肃私下替他着急，诸葛亮只托鲁肃借二十只船、每船军士三十人，嘱咐他不要告诉周瑜。一场借公事设下的陷阱，由此变成双方都必须在三日后当众面对结果的公开约定。
```

frontmatter 只有可选 `title / refs / contracts / changes`，Markdown 主体必须非空。`title` 只写这一节的标题，不带原作章节范围、编号或括注。`changes` 只投影本 Beat 造成、且必须确定性重放的少量对象状态变化，语法见[硬状态投影](state.md)；变化中的 identity 会自动进入 Context 路由，不需要为了 Checker 在 `refs` 中重复声明。`refs` 是按 kind 分组的异构引用集合，每组值只写本地 id（写法见 readme 主题「本地 id」）：

- `refs.character / place / resource` 表示本 Beat 实质使用、且尚未由 `changes` 直接引入的 Character、Place 或 Resource。Character 可以在场，也可以因被谈论、回忆或持续影响当前选择而需要回看既有塑造；顺口提名且不影响当前实现时不必引用；
- `refs.world` 引用本 Beat 依赖的可复用世界文档；
- `refs.secret` 只用于硬状态与认知边界，不对应文件；
- `refs.beat` 表示当前 Beat 依赖更早 Beat 的承诺、选择、揭示或后果，值仍是完整稳定 Beat id，例如 `beat-0031`。

关系在故事中的建立、解除、承认、误解与情感变化写 StoryBeat，确实需要沿人物召回时写进 `refs.character`，不另建 Relationship artifact（人物与家族怎么写见 character 主题）。`refs.character` 不表示人物出场、行动或相关叙述为真。

`refs.beat` 只引用更早的 Beat，为长距离承诺、选择、揭示和后果建立稳定依赖；它不复制故事内容。普通相邻顺序和主题相似不连边。StoryBeat 主体只写故事内语义，不用 ID、文件路径或“依照某 Beat”等仓库信息代替时间与因果。

### 完整性与表达边界

StoryBeat 用无冗余的自然语言写上面这些内容。不变的状态不重复，不增加 `state_before / state_after`；少量确定性硬边界只写最终 `changes`，进入时的硬状态由 `initial` 和此前变化重放得到。

每个 Beat 只交代理解这次选择、行动和结果所必需的前情，不抄完整人物前史，也不维护当前状态快照。判断办法：删掉某段前情后这次选择就看不懂了，就把它当作本 Beat 的因果前提写清。这样 Writer 不必去别的 Beat 的细纲里检索、拼接历史，也不会因为看不到作者主会话而替作者重新决定关键因果。

判断一项信息是否属于 StoryBeat，只问一个问题：删掉它以后，Writer 是否必须重新决定故事。会改变人物选择、因果结果、知情、关系、资源、时空、承诺或后文理解的信息属于 Design；不改变这些事实的动作步骤、对白措辞、感官、现场调度和揭示节奏属于 StoryText。压力积累、胜利反馈、闲谈、笑点、停顿和余波通常是 StoryText 的体验实现，但它们若本身改变关系、认知、承诺或后文理解，也必须写入 StoryBeat。StoryText 自己能创造哪些局部事实、什么时候要先回写 Design，见 artifacts 主题「StoryText」。

StoryBeat 使用直接、准确的作者层叙述，不追求可直接粘贴进 StoryText 的文采或表演。Writer 必须实现其语义，不能把 Beat 逐句扩写或换词复述；StoryBeat 也不能为了防止 Writer 发挥而膨胀成动作清单。

### 事实、人物认知与读者披露

StoryOutline 是作者层的完整故事，不是无剧透简介。承担计谋、悬念、误导、身份隐藏或揭示的 StoryBeat，要分清三个时点：事实何时客观成立、各人物何时获知或形成误解、读者何时得到真实答案。作者和 Writer 可以知道尚未披露的真相，但 Context 里看得到不等于故事里有人知道：人物不能使用没有可信来源的信息，StoryText 也不能提前说破。

复杂认知直接写清观察、传播、理解与行动：谁实际看见什么，信息怎样到达，为什么相信、怀疑或误解，怎样影响选择，以及什么会使判断失败。部分知情、错误信念、谎言、知道对方不知道和不可靠叙述不建立固定字段；只有后文不能容忍误判的少量真实秘密揭示，才用 `changes.character / changes.reader` 投影。

后文揭示某项身份、关系、动机或旧事早在人物进入故事之前就已成立时，回头补全 Character、World 或真正受影响的更早 StoryBeat（见 character 主题「轨迹基底」）；揭示 Beat 仍保留人物与读者实际得知的时点，作者层提前写下的真相不等于已经公开。

### Beat 与 Scene

StoryBeat 是可独立寻址、修改、审查并写成正文的完整故事变化，不等于 Scene。一个 Beat 可以由一个场景完成，也可以包含不可分割的多场因果序列；一个连续场景也可以依次实现多个 Beat，StoryText 文件边界不要求制造转场。

实际设计时按以下情况处理：

- 普通对话、冲突、交易、战斗场景：通常一个 Scene 对应一个 Beat；
- 同一场景包含多个可独立改变的转折：拆成多个 Beat；
- 多个场景共同完成一个不可分割的结果：保留为一个 Beat；
- 蒙太奇、概述、书信传播、跨地连锁等非场景叙述：仍可直接成为 Beat。

这是作者层的软粒度建议，不是 schema、数量阈值或 Checker 规则。没有改变故事事实的寒暄、斗嘴、动作表演和情绪余波仍属于 StoryText。不要只因字数、时间、地点、视角、出场人物数量、发布章节、Context 大小或关系检索方便而切分，也不能为了让每个 Beat 的 `refs` 更少而拆散完整因果。只有过粗已经造成故事变化混杂、归属含混或无法独立修订时，Review 才应提出拆分。

## StoryContract

> StoryContract 是故事向受众建立的、需要跨多个 StoryBeat 追踪和回应的长期期待。它不是情节、线索或人物弧清单。

路径为 `outline/contracts/<id>.md`：

```markdown
---
subjects:
  character: [诸葛亮, 周瑜]
deadline: beat-0002
---
军令状当众建立了三日交出十万支箭的期待。兑现时，诸葛亮必须在期限内亲自交箭，周瑜必须当众验收、面对自己的算计落空；不能由旁人替诸葛亮凑数，也不能让军令状无故作废。
```

frontmatter 只有可选 `subjects / deadline`。`subjects` 与 StoryBeat `refs` 一样按 kind 分组；`deadline` 只写本地 Beat id 或 `book_end`，省略时就是 `book_end`。Markdown 主体说明故事向受众建立了什么长期期待，以及怎样才算兑现、转化或有意义地否定。Beat 用 `contracts.open / advance / resolve` 建立稀疏锚点：`open` 建立可感知的长期期待，`advance` 实质推进或改变理解，`resolve` 声明已经处理。Checker 只验证结构生命周期；语义兑现由模型判断，可记录的独立 Review 可以保存意见。

Checker 按下表判断 Contract 是否到期未兑现：

| 情况 | `deadline` 是 Beat id | `deadline` 是 `book_end` |
| --- | --- | --- |
| 普通 Target Design | 期限前必须 `resolve` | 全书结束前必须 `resolve` |
| index 写了 `open_ended: true` 的 Target，或 Source | 期限前必须 `resolve` | 已 `open`、未 `resolve` 算进行中 |

任何情况下，从未 `open` 的 Contract 都是错误。Source 可能只登记原作的一部分，也可能抽取未完本作品，所以它的 `book_end` 指当前登记材料的边界，不宣称原作已经完结；Source 不得为通过 Checker 伪造 `resolve`。

人物在故事里说出承诺，首先只是 StoryBeat 中发生的事件；只有它同时形成需要跨多个 Beat 独立追踪的受众期待时，才提升为 StoryContract。普通因果、主题、关系和完整人物弧不建 Contract。
