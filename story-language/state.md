# 硬状态投影

StoryBeat 的自然语言正文承载完整因果设计。只有后文不能容忍模型误判、并且能够用简单对象属性准确表达的状态，才进入硬状态投影。它不是第二份细纲、完整认知图谱或视角模型，也不要求为每个 Beat、人物或物品建状态。

硬状态只有两个作者侧入口：identity 的 `initial` 保存开场已经成立的少量状态；StoryBeat 的 `changes` 保存本 Beat 结束时新成立、需要后续持续追踪的变化。工具按故事顺序重放 `initial + changes`，得到任意 Beat 前后的当前状态。

## 开场状态

Character、Place 或 Resource 文件可以在 frontmatter 写可选 `initial`。文件路径已经确定主体，因此这里只写属性和值。例如 `world/resources/青釭剑.md`：

```markdown
---
initial:
  holder: 夏侯恩
---
曹操的两口宝剑之一，由背剑的心腹夏侯恩随身佩带；剑柄错金刻着「青釭」二字，能与曹操自佩的倚天剑区分。
```

`initial` 表示故事开场状态，不是随情节更新的“当前状态”。若对象在故事中才出现或产生，不要虚构开场值；在产生它的 StoryBeat 写第一次 `changes`。只写后续一致性真正需要的已知值，不用 `dead: false`、`consumed: false` 等默认表把 unknown 填满。

## Beat 变化

StoryBeat 只写本 Beat 造成的稀疏硬状态增量：

```yaml
---
title: 长坂夺剑
refs:
  character: [赵云, 夏侯恩]
changes:
  world:
    青釭剑.holder: 赵云
---
```

`changes` 不是完整退出快照，也不是本 Beat 想完成的任务。只有自然语言故事已经使某项状态在 Beat 结束时成立，才能声明该变化；夺取失败时不能写 `holder: 赵云`。未改变的状态不重复，工具从 `initial` 和更早的 `changes` 推演。

同一 Beat 的 `changes` 是一个没有内部顺序的原子结果。只在 Beat 结尾短暂恢复、且不影响后文的中间状态留在自然语言中；若某个中间结果需要被后续故事单元独立依赖，应拆成两个 StoryBeat，而不是在 frontmatter 编写操作流程。

状态路径采用 `<对象>.<属性>`。中文作品优先使用已有 Character、Place、Resource 文件的本地中文 id；工具根据属性签名解析对象 kind。若同一个本地 id 在多个 kind 中有歧义，才写 `resource:<id>.holder` 等完整引用。`changes` 涉及的 identity 自动进入本 Beat 的 Context 路由；对象在本 Beat 被实质使用但状态没有变化时，仍须写入 `refs`。

Secret 不对应文件，只在某个 StoryBeat 的 `refs.secret` 里声明，之后才能在同一或更晚的 Beat 写 `revealed`。`revealed` 只属于 Secret，所以 `单福身份.revealed` 与 `secret:单福身份.revealed` 等价；与某个文件的本地 id 撞名时写带前缀的形式。

## 作用域

客观状态写在 `world`。读者或人物新获得的必要知情状态分别写在 `reader` 与 `character`：

```yaml
changes:
  reader:
    secret:单福身份.revealed: true
  character:
    刘备:
      secret:单福身份.revealed: true
```

`character` 下的键是人物本地 id。一个 Beat 可以同时改变客观状态和多个认知作用域；每项只陈述相应观察边界中在 Beat 结束时新成立的结果。Context 或 Character 对作者型 Agent 可见，不使其中的客观事实自动成为人物或读者知识。人物轨迹基底中已经知道的复杂事实写 Character 自然语言；此后知情变化写 StoryBeat，不为建立完整知识图谱扩张 `initial`。

`reader` 的 `secret.revealed: true` 表示故事已经让读者获得该秘密的真实答案，不表示读者只听到一个可能为假的说法。`world` 的同一属性只在秘密已经成为故事世界中的客观公开信息时使用，也不自动证明每个未接触传播途径的人物都已获知。怀疑、半知、误信、谎言和二阶认知继续由 StoryBeat 自然语言表达。

## 属性与值

P0 只支持以下稳定属性：

| 主体 | 属性 | 值 |
| --- | --- | --- |
| Character | `location` | Place 或 `none` |
| Character | `dead` | boolean；客观世界中只记录不可逆的 `true` |
| Character | `incapacitated`、`imprisoned` | boolean |
| Place | `accessible`、`secured` | boolean |
| Resource | `holder` | Character 或 `none` |
| Resource | `location` | Place 或 `none`；只用于没有 holder 时的自由位置 |
| Resource | `consumed`、`destroyed`、`sealed`、`installed` | boolean |
| Secret | `revealed` | boolean |

不写某项表示未被硬投影，不表示其反面。例如没有 `韩枫.dead: true` 只表示 Checker 不知道其生死，不能据此推断他活着。死亡确定且后文不得再以活人出现时才写 `dead: true`；假死、肉身死亡但神魂继续、计划复活等情况继续用 StoryBeat 自然语言表达，除非现有属性能无歧义表示真正需要的边界。

`holder` 表示当前实际控制，不表示法律所有权。一个 Resource 有非 `none` holder 时，工具把其自由 `location` 置为 `none`；写入非 `none` location 时，holder 置为 `none`。`consumed: true` 与 `destroyed: true` 是 world scope 的终止状态：它们清空 holder 和 location，之后不能恢复或重新持有。同一 `initial` 或 Beat 不能同时让 Resource 终止并拥有 holder / location，也不能同时赋予非空 holder 和自由 location；Checker 将其视为原子冲突，不受 YAML 字段顺序影响。

只为需要稳定追踪的特定资源建立 Resource identity。箭矢这类可重复生产、故事中成千上万的普通物品，不因为某次出现就建立“全局箭矢”状态；只有某一枚或某一组物品具有不可替代身份、会跨 Beat 转移或回收时才建文件并投影。

## 模型与 Checker 的分工

Agent 在 Design 与 Review 中审计 StoryBeat，判断哪些开场状态和变化值得投影、自然语言是否支持声明的结果、是否遗漏或过度硬化。工具把显式 `initial` 与 `changes` 编译成规范化 StateProjection，并按 StoryBeat 顺序检查引用、类型、原子冲突、死亡和资源终止规则。

Checker 不从自然语言自动发明 Canon，也不证明应该投影的状态没有遗漏。`changes` 不重复声明进入条件：当前状态已经可由重放得到，重复写前置条件不能证明故事语义成立。人物动机、关系变化、力量体系、主题、伏笔、复杂真假状态以及自然语言与投影是否一致，仍由完整 StoryOutline 和模型 Review 判断。
