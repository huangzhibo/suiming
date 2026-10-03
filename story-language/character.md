# Character

Character 是第一等人物 identity，也是 Agent 以该人物为中心重读故事的稳定入口。Character 文件只保存 StoryOutline 开始记录人物变化前的轨迹基底；它不是首次提及或出场记录，也不是当前状态、未来传记、人物弧摘要或行为合同。

完整人物视图按任务派生：

> CharacterView = Character 轨迹基底 + 人物 Intent + 相关 StoryBeat + 必要 StoryContract + 硬状态 + 任务所需 StoryText

检验某个过去时点时，先组合有界证据：

> CharacterEvidenceAt(t) = Character 轨迹基底 + t 之前的相关 StoryBeat + 重放后的硬状态

工具只能确定性重放少量硬状态。人物当时的欲望、恐惧、误解、知识和可能选择，仍由模型根据证据推演。`t` 是进入目标 StoryBeat 前的展示顺序边界，不是严格世界年代；倒叙、插叙和后文披露仍必须在 StoryBeat 中说清事实何时成立、人物何时获知、读者何时得知。

## 文件与 identity

需要跨 Beat 稳定寻址、连续性、独立审查、家族关系、硬状态或后续回收的人物，保存为 `world/characters/<id>.md`。中文作品优先直接使用人名作本地 id；ASCII id 也合法。id 必须可作单个文件名，不含空白、`:`、`/`、`\`，并使用 Unicode NFC。

人物尚未揭示身份时，可用不泄露答案的稳定描述 id，如 `乌坦城黑袍人.md`；确认身份后填写 `name / aliases`，不必为显示名重命名 identity。若后文证明其与已有 Character 是同一人，应合并 identity 并同步 refs。

人名与文件 id 相同时省略 `name`；`aliases` 只保存需要跨 Beat 召回的固定别名、字、号或长期称谓。这些是作者层寻址信息，不表示故事内已经公开。

```markdown
---
family:
  - kind: parent
    character: 萧战
    role: 生父
---
萧炎曾是萧家最受瞩目的修炼天才，斗气却已连续三年倒退。他不知道原因。旁人的讥笑让他厌恶被实力高低决定尊严，父亲和少数亲近者始终没有放弃他，也使他没有把受挫变成对所有人的怨恨。

他平时能够忍住轻慢，把注意力留给恢复修炼；若有人依仗身份，当众替他或父亲决定该接受什么、放弃什么，忍耐便会与夺回选择的冲动发生冲突。此时他仍主要把恢复实力视为取回尊严的办法。
```

`name`、`aliases`、`family` 和 `initial` 都可省略，Markdown 主体不能为空。一次性或只在局部起作用的人物直接写进 StoryBeat，不为“所有出场者都一样”建立空薄文件。

`refs.character` 是召回边，不是人物在场、行动、传闻为真、首次提及或轨迹起点的证明。只有人物身份、选择或经历需要被独立追踪时才建 Character；只作社会记忆或文化符号的传说人物使用 World。

## 轨迹基底

Markdown 主体要使模型理解人物在轨迹开始建模时的身份、处境、欲望、恐惧、价值冲突、注意方式、能力边界、说话口吻、关键关系与自我误解。可以写该时点前已经成立、且确实形成这些结构的既往影响。

好的基底保留相互竞争的力量，说清哪些选择对这个人尤其困难，但不预测唯一反应。不要写成“遇到 X 就会 Y”的决策树，也不要把将来的选择、心路和结局归纳成从一开始就存在的永久人格。实际施压、选择、代价和变化写入 StoryBeat。

Character 的时间边界由“基底还是变化”决定，不由首次引用、首次现身或材料披露顺序决定。后文证据可以补全基底时点已客观成立的身世、旧关系、隐藏动机、能力和既往经历；揭示 Beat 仍保存实际获知和重新理解前文的时点。轨迹建模后才形成的变化只属于 StoryBeat。

Character 是作者层生成基线，不是 StoryText 语料库。可以直说心理机制和矛盾，但编译正文时它们只帮助选择可观察的行动、对白、注意和失误，不直接复制成旁白。

核心人物应使模型在面对一个未写过、但符合世界规则的新压力时，能理解其特有矛盾，并提出多个有辨识度、后果不同且都可解释的观察、语言和选择。次要人物可以更短；充分性由故事作用决定，不由统一模板或篇幅决定。

## 家族事实

`family` 只投影全书开场已成立、需要稳定寻址的家族事实。当前 Character 是关系主语：

| `kind` | `character` 的含义 | 可派生反向关系 |
| --- | --- | --- |
| `parent` | 父或母 | 子女 |
| `spouse` | 配偶 | 配偶 |
| `sibling` | 兄弟姐妹 | 兄弟姐妹 |
| `guardian` | 监护、抚养或实际家长 | 受监护者 |

`character` 只写被引用人物的本地 id。`role` 是可选中文说明，如“生父”“养母”“长兄”；`kind` 只负责确定性拓扑，`role` 说明具体名分与社会含义，不从中推导新的机器事实。

`spouse` 和 `sibling` 只在一边声明，反向边由工具派生；`child` 由 `parent` 反向得到。已知共同父母时，通常也不重复声明 `sibling`。关系的建立、解除、承认、隐瞒、误解和情感变化写 StoryBeat，不倒填 `family`，也不新建 RelationshipState。

`design:family:<id>` 从 Character 正向边和 StoryBeat 派生完整家族视图；`design:family:<id>:at:<beat-id>` 只读取进入目标 Beat 前的相关故事。模型必须区分客观血缘、礼法名分和人物相信的关系；证据不足时返回 `insufficient_context`。

## 人设与 Review

人设不只存在 Character：带人物 `subjects` 的 Intent 保存作者塑造目标，Character 提供轨迹起势，StoryBeat 用实际选择、表现、代价和变化使它成立。三者不复制同一段标签；只有需要跨多个 Beat 独立追踪的受众期待才使用 StoryContract。

Review 不拿 Character 逐句验收人物行为，而是从完整人物视图判断重要选择是否可理解、重大变化是否有经历和因果支持、人物 Intent 是否通过故事成立。人物显出基底未枚举的新侧面、作出多个合理选择之一、没有未来传记或 Character 较短，都不自动构成 finding。

完整人物生平、关系轨迹和某时点状态都从 Character、Intent、StoryBeat、必要 StoryContract、硬状态与 StoryText 派生，不新增 Biography、Knowledge 或 CharacterState Canon。
