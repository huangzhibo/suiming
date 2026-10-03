# Intent

Intent 保存作品当前有效、仍需后续创作遵循的创作意图。它可以从初始输入、讨论、灵感、StoryText 实现或 Review 中形成；这些只是来源，不是不同的 artifact 类型。Intent 只保留收敛后的当前认识，不保存讨论过程，也不重复已经由其它 artifact 表达的故事事实。

路径为 `intent/<id>.md`，Markdown 主体保存完整要求；frontmatter 只在需要路由时添加：

```markdown
---
applies_to: design
target: { from_beat_id: beat-0001, to_beat_id: beat-0002 }
subjects:
  character: [诸葛亮, 周瑜]
---
诸葛亮与周瑜的较量不能把周瑜写成心胸狭窄、只供衬托诸葛亮的人，也不能为了翻案抹去他几次设计除掉诸葛亮的事实。二人的可敬与可议应来自各自替主公谋划的同一套立场，并在军令状兑现时让受众重新理解这场较量，而不只是确认谁更聪明。
```

缺省值为 `applies_to: design`、`target: book`，`subjects / style_refs` 缺省为空。frontmatter 只负责路由；当前有效的要求、禁止项和取舍直接写在 Markdown 主体中，不另造来源、强度或状态字段。`subjects` 像 StoryBeat `refs` 一样按 kind 分组并只写本地 id；它只路由，不表达关系或状态。`style_refs` 选择 `reference/style/<id>.md` 作为表达证据。`design` Intent 是 Design 的一部分，并继续约束 StoryText；`text` Intent 只约束表达，不属于 Design。

Intent 主动约束故事，StoryBeat 写出重写正文时也要保持的因果设计，Review 回头检查是否兑现。Context 按 `target / subjects` 选出适用的 Intent，所以 StoryBeat 不保存 `intent_refs` 或来源引用。采用后的事件、选择、经历、关系变化和因果直接进入 StoryOutline；只有仍要约束后面多个 Beat、下次重写正文或改编时，才保留 Intent。已经完全写成故事事实的重复 Intent 应合并或删除，形成过程由 ProjectRevision 保存。

人物“人设”由带人物 `subjects` 的 Intent、Character 与 StoryBeat 分工承担，Intent 这一份写作者的塑造目标和希望受众形成的理解；分工与 Review 怎么判断，见 character 主题「人设与 Review」。

需要逐字保留的片段使用 info string 为 `exact` 的 Markdown fenced block：

````markdown
这句话由周瑜在临终前说出，是一个自认已经尽力的人对时运的不甘；它不是给他贴上「嫉妒」标签的口号，也不能脱离他此前的成败单独使用。

```exact
既生瑜，何生亮！
```
````

上例只演示改写任务要求逐字保留《三国演义》短句时的文件形状。Checker 只能匹配 `exact` block 内容，不证明语义已兑现。`exact` 之外必须由 StoryBeat 或同一 Intent 说清这句话出现时的人物处境、语用含义和预期受众效果，不能只留一句可能被按字面误解的文字。

## StoryText 风格 Intent

作品需要稳定的全书正文风格时，使用普通的 Intent 文件（如 `intent/正文风格.md`），设置 `applies_to: text`、`target: book`。它与其他 Intent 使用同一语义和验证机制，不是新 artifact 类型。

没有适用 Text Intent 时，Writer 不能只凭题材、爽感或发布平台猜测风格。局部偏离使用 `target` 更窄的 Text Intent；要求冲突时必须明确修订，不能按创建时间静默覆盖。

`style_refs` 指向的 style evidence 怎么写，见 artifacts 主题「Reference」。

全书或局部 StoryText 的目标篇幅也属于 `applies_to: text` 的 Intent，不写入 StoryBeat、项目配置或长度规划 artifact。它是媒介实现的软尺度，不是 Checker 硬门。
