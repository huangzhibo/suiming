# 燧明界 Story Language

本目录只定义 artifact 的语义、开放目录 / 作品包形状和信息归属。创作、编译与审稿属于 Agent 的运行策略，不进入 Story Language。

各模块以《三国演义》赤壁之战前后的情节（公有领域）作为同一组格式示例。除明确标为 `exact` 的短句外，示例都是事实与设计的转述，不是原文引用或仿写要求。

## 制品形态

- **Story Artifact** 是按 Story Language identity 独立寻址的一份作品内容，例如 Intent、StoryBeat、Character、StoryText 或 Source material。
- **Open Story Directory** 是 Story Artifact 的标准可编辑目录表示；本地创建、repository-native project 和 Cloud checkout 都使用它。本地的 Open Story Directory 同时是一个 git 仓库，版本历史随它走。
- **Open Story Package** 是某个明确 ProjectRevision 的封闭、可验证快照，与 Open Story Directory 使用同一逻辑路径空间；它可以表现为目录、归档或上传流。
- **repository-native project** 是 Open Story Directory 加可选 Git、AGENTS.md、Skills、说明文档等仓库辅助文件。repository-native 是继续支持的作品形态，不等于旧 `suiming-story` Runtime。

Story Language 保留的路径可以进入作品包；`.git`、`.suiming`、模型凭据、会话、缓存、trace 和工具配置不属于开放作品格式。仓库辅助文件可以与作品共存，但不能被误认、导出或上传为 Story Artifact。目录和作品包必须共用一套 path codec，不维护 legacy / local / cloud 三种长期格式。

> StoryBeat 保证因果完整，StoryText 保证体验完整。

这是 Design 与 StoryText 的语义目标，不是 Checker 对自然语言质量的确定性证明。

## 语义层次

- **Design**：唯一跨实现因果设计候选。StoryOutline 是主表面，World、Character、Intent、StoryContract 与硬状态各补充一个明确边界。
- **StoryText**：受众最终看到的表达真源。它可以创造当前实现的局部事实，但不是跨重写或跨媒介的第二 Canon。
- **审稿与笔记**：`review/<id>.md` 与 `source/<id>/notes/<n>.md` 是普通 artifact，各记着它审过 / 读过的内容摘要；正文时效、审稿时效、Source 覆盖率与可发布性是按需算出来的投影，不存文件。
- **派生内容**：影响、人物轨迹和 Release 只保存投影，不拥有另一份故事状态。

## 派生视图

一个视图由四个边界确定：观察 Source、Design 还是 StoryText；从哪个稳定 artifact、identity 或故事范围进入；读取完整轨迹还是某个 Beat 之前；允许使用哪些原文、Design、硬状态或正文证据。

Character、StoryContract、World、Intent、StoryBeat、Volume 和 Book 都可以是观察入口。Source、Design、StoryText 是被观察的语义层，Review 是消费视图的动作，它们都不是“视角”。视图从当前作品即时派生，不生成 `*View` 文件、通用 View DSL、持久索引或批准状态。

## 模块

- [StoryOutline](outline.md)：全书顺序、Volume、StoryBeat 与 StoryContract。
- [Character](character.md)：人物 identity、轨迹基底、家族事实与人物中心视图。
- [World](world.md)：可独立寻址的世界知识与 Place / Resource identity。
- [Intent](intent.md)：作品当前有效的创作意图、style 与 `exact`。
- [硬状态投影](state.md)：identity 开场状态、StoryBeat 结果增量与确定性重放。
- [Source](source.md)：目标无关的输入材料、镜像 extraction 与独立 namespace。
- [StoryText、Reference、审稿与 Release](artifacts.md)：Design 之外的作品内容与工具产物。

Target Design 使用 `intent/**`、`outline/**` 与 `world/**`。Source 在 `source/<source-id>/` 下镜像 `outline/**` 与 `world/**`，不含 Target Intent、StoryText 或按 Beat 复制的原文。

## 信息归属

| 信息 | 唯一语义真源 |
| --- | --- |
| 当前仍需作品遵循的创作意图与表达要求 | `intent/<id>.md` |
| 全书普遍成立、大多数任务都需要的世界公理 | `world/core.md` |
| 需要跨 Beat 复用或独立引用的规则、历史、文化、制度或组织知识 | `world/<id>.md` |
| StoryOutline 开始记录人物变化前已成立的身份、处境、既往影响与核心矛盾 | Character 主体 |
| 实际发生的经历、选择、因果和人物、关系、知情、能力或读者披露变化 | StoryBeat |
| 少量需要独立追踪的跨 Beat 长期期待 | StoryContract |
| 开场已成立、后文不能误判的少量对象状态 | identity `initial` |
| Beat 造成、后文不能误判的稀疏状态变化 | StoryBeat `changes` |
| 已定因果的表达、表演与无需跨实现保持的局部事实 | StoryText |

判断一项内容应放哪里，先问它由谁拥有、需要在哪些实现或时点保持。真源不复制；路由字段可以引用真源，不能保存会独立漂移的摘要。

identity、Intent 与 StoryContract 的本地 id 在中文作品里用简洁稳定的中文——作者在文件与界面上看到的就是它（Contract 没有名字字段，故事轴的期待泳道直接显示 id）；`kind`、状态属性和 schema 枚举保持英文。已知 kind 的字段只写本地 id，单个异构机器接口才使用 `kind:id`。Volume / StoryBeat 使用 `vol-* / beat-*` 结构 id。

事实客观成立、人物获知和读者得知是三个边界。Context 对作者型 Agent 可见，不等于故事内已知；复杂认知用 StoryBeat 自然语言表达，只有少量不能误判的真实秘密揭示才进入硬状态投影。
