# assistant-ui 对话功能源码参考

2026-09-10。研究本地 `~/github/assistant-ui`，版本为 `0bea0fc504a169ccb699c4c9efd2d7a29651c186`（2026-09-09），其中 `@assistant-ui/react` 为 `0.15.18`。依据实现及相关测试用例阅读，不代表已运行其示例、测试或验收音频服务。本文件保留源码研究与设计依据；下列非音频交互已按 Suiming 自有边界实现，未引入 assistant-ui 依赖。

## 结论与复用边界

值得参考，重点是输入生命周期、附件状态、流式滚动与消息操作。建议保留 Suiming 的 React、shadcn/ui、TanStack client、typed IPC 与自有 Harness，按功能吸收源码中的交互规则和测试场景。

assistant-ui 有三层可供参考：

- `packages/ui`：组件源码，包含只接收 props 的展示组件和 `.aui.tsx` 的运行时绑定组件。适合参考结构、操作入口和状态呈现。
- `packages/react/src/primitives`：输入、滚动、附件拖放、消息操作等交互。可借鉴独立逻辑；其中依赖其 store/runtime 的 hook 需要改写绑定。
- `packages/core`：composer、消息树、队列、adapter 和运行时。适合研究状态转换与异常处理，不宜整体移植为 Suiming 的另一套执行状态。

它提供 external-store 和 AG-UI adapter，技术上能够对接已有后端。完整接入仍需映射消息、会话、取消、续跑与队列语义；当前 Suiming 已有同类客户端边界，单为增加输入功能不值得再增加一层运行时映射。

## 实施状态（2026-09-10）

已实现安全发送、多引用和文本附件、`＋` / `@` 共用作品搜索、消息复制 / 引用 / 导出、对话与动作排序、折叠执行组、阅读位置恢复及持久补充要求状态。保持现有 React、shadcn/ui、TanStack client、typed IPC；未复制 assistant-ui runtime、队列或消息树，也未新增依赖。

- 输入更新由根工作区的 [useComposerWorkspace](../apps/web/src/use-composer-workspace.ts) 接收，文档窗格关闭不影响会话回包；引用迁移只在恢复入口执行，具体见[工作台收敛记录](workbench-consolidation.md)。
- [composer-state](../apps/web/src/composer-state.ts) 保存一次未确认提交及独立后续草稿；命令发送前持久化内容和 ID。回包不确定时显式确认，续跑失败重试仅重发续跑；按附件 ID 与读取 ID 处理迟到结果。
- [AgentComposer](../apps/web/src/agent-composer.tsx) 负责现有控件组合和输入动作。作品引用冻结路径、版本、SHA-256、内容与草稿标识；本地 UTF-8 文本实际进入文字命令，支持选择、拖放、粘贴文件、预览、移除和重试，引用总量上限 256 KB。
- [ConversationViewport](../apps/web/src/conversation-viewport.tsx) 区分主动滚动和尺寸变化，按委托保留位置；[Transcript](../apps/web/src/agent-transcript.tsx) 根据持久事件顺序组织消息与动作，连接失败按游标只读重连。
- `run.steering` 是从现有 steering 与消息事件派生的查询。等待项和「已送入执行上下文」明确区分；后者不代表落实、提交，也不保证仅由 Agent 接收。

音频服务尚未选定和验证，因此未增加空麦克风按钮。图片、PDF、OCR、通用多模态、历史消息重写和执行分支没有伪装成已支持功能。当前附件只作为会话输入，不自动写入作品。验收见[原生对话交互](validation/2026-09-10-agent-composer/README.md)。

## 源码研究与设计依据

| 功能 | 源码中值得借鉴的处理 | Suiming 建议 |
| --- | --- | --- |
| 安全发送 | 发送前冻结草稿；按 ID 移除已发送附件；失败恢复不覆盖新输入；旧异步操作失效 | 优先补齐草稿快照、操作身份和回执处理 |
| 附件 | 明确读取、上传、可发送、失败状态；选择、拖放、粘贴共用添加链路 | 「＋」统一作品引用、当前选段和本地文件；支持预览、移除、失败重试 |
| 滚动 | 区分用户上滑与内容尺寸变化；跟随新消息可退出、可恢复 | 在底部时跟随；上滑后保持阅读位置，提供「回到最新」 |
| 消息操作 | 最新回复保留操作，历史回复按需出现；复制成功反馈；更多菜单 | 优先复制、引用、导出；历史更正使用补充要求 |
| 执行呈现 | 按消息 part 渲染文本、工具和附件；工具活动分组折叠 | 保留消息与活动的先后关系；展示动作、状态、结果及可打开的作品入口 |
| 运行中输入 | 队列与 steer 各有明确状态和派发时机 | 展示 Runtime 已接收的补充要求与处理状态，不另建前端执行队列 |
| 语音 | 听写与实时对话独立 adapter；部分/最终转写、取消、清理有明确生命周期 | 优先规划可编辑的语音输入；实时语音另定义连接、播放和打断语义 |
| 中文输入 | IME 合成期间屏蔽发送与光标插件；发送快捷键可配置 | 保持 Enter 换行、⌘/Ctrl+Enter 发送；支持中文作品搜索和光标位置插入 |

### 1. 先解决发送与草稿的并发边界

研究时的 Agent 输入处理在 `run.launch` 或 `run.steer` 返回后无条件执行 `setGoal("")` 和清除引用。等待期间文本框仍可编辑，因此存在后输入的文字或引用被清掉的源码风险；此次实现用故障注入桌面测试验证了回包丢失和继续输入场景。

[工作台](../apps/web/src/workspace.tsx) 已按委托保存草稿，可以直接补强：

- 一次发送绑定作品、原委托、草稿版本与命令 ID；冻结本次文字及引用，后续输入形成新的草稿状态。
- 成功只确认本次提交，不清空后来加入的内容。失败只恢复未派发内容，不覆盖新草稿。
- 同一次命令结果未知时复用命令 ID 并确认回执，避免把不确定结果当成未发送再次提交。
- 上传、转写、复制反馈绑定发起时的对象与操作身份；切换委托后迟到的回调不修改当前委托。
- 「补充已接收」和「继续委托失败」分开反馈，避免已经排队的要求因续跑失败而被重复发送。

assistant-ui 的 composer 及测试对这些边界处理较细。应借鉴规则和故障用例，保持 Suiming 的实现简短，不移植整个基类。

### 2. 「＋」、附件与引用共用一套输入结构

沿用[Agent 输入能力方案](agent-input-capabilities.md)。作品引用不能只有文件名：要能回到实际文档、版本及选段，区分未保存草稿。外部文件作为会话输入，不因上传自动成为作品 Artifact 或 evidence。

「＋」是可发现的入口，`@` 是快捷入口，两者使用同一个作品对象选择器。支持标题、类型、路径和中文搜索；插入结构化引用，不只是替换成一段名字。

assistant-ui 默认附件 adapter 包含图片与部分文本文件处理。附件卡片不等于已经支持 PDF 解析、OCR 或模型多模态。当前 [SDK 命令](../packages/sdk/src/workspace-commands.ts) 的 `run.launch` / `run.steer` 只接收文字，需同时打通实际内容传递和恢复能力。

### 3. 让长对话可读、可回看

研究时的 Transcript 只提取消息的 text parts，执行记录另集中展示在底部。建议按消息与活动的真实关联和顺序渲染：文字保持主阅读层级，连续工具动作折叠为简短执行组，错误和需要作者回应的事项就近提供操作。无需展示原始 JSON，也不要求新增模型隐藏推理数据。

滚动默认跟随底部；作者向上阅读后停止跟随，新内容到来时显示「回到最新」。图片加载、输入框增高、窗口缩放不应误判为作者主动滚动。切换委托恢复各自阅读位置。是否按新一轮消息顶部锚定另做体验验证，不直接带入示例为锚定预留的大块底部空白。

最新完整回复显示复制、引用及更多；历史回复在悬停或键盘聚焦时显示，操作出现不挤动正文。复制成功后再展示勾选反馈。会话加载、空会话、断线重连分别呈现，避免历史尚未加载就显示新建引导。

### 4. 保留长委托的控制语义

assistant-ui 默认 Thread 模板在生成时以取消按钮替代发送；其 queue/steer 能力可另行配置。Suiming 应始终允许运行中补充要求，并独立提供「暂停委托」。

现有 Runtime 已持久保存 steering，Harness 在循环中接收补充并记录 `steeringSequence`。UI 可以基于回执、查询与事件呈现「已接收，等待处理」和「已送入执行上下文」；后者不等于要求已经落实或作品已经提交。重载后也应从 Runtime 恢复，不能只靠页面内存。若要编辑、撤回或重排已排队要求，应先补齐领域命令及验收，不能只实现列表操作。

「取消委托」放入更多菜单并明确其结果。消息的「重新生成」、修改历史消息及分支切换不直接照搬：Suiming 一次执行可能已经修改文件、提交版本、产生 Worker 结果。更正通过新补充表达；执行重试复用已有恢复和换绑边界，不能把改一条聊天记录当作回滚作品。

### 5. 语音和中文适配

听写状态至少包括准备、录音、转写、完成、失败和取消。转写只填入原草稿，由作者编辑后发送；会话切换、结束与异常都清理麦克风和回调。需要验证所选服务在 Electron、macOS 与中文场景的实际表现。

实时语音还需处理连接、静音、语音播放、用户打断及 Agent 后台执行的关系。仓库中的 LiveKit 示例可参考完整设备与连接生命周期，ElevenLabs Scribe 示例可参考转写 adapter；采用哪家服务尚未决定。

发现两个容易误抄的细节：

- `elements/composer.tsx` 的简化 `useMentionMatches` / `applyMention` 使用 `\w`，只匹配末尾的 ASCII 单词，不能直接用于中文人物或作品标题。运行时另有 trigger popover 机制，不应将这个示例的限制泛化为整个库。
- 同文件 `ComposerVoice` 的波形来自 `Math.sin` 演示函数；它不是实际麦克风音量。听写核心在片段间补空格的策略也需要按中文标点重新处理。

## 建议的界面组织与实施顺序

保留现有白底、中性灰反馈、约 104px 默认输入框，以及既定图标和点击区域规范。输入器保持在侧栏底部，支持随内容增高；不照搬示例的主题色、尺寸与空会话居中跳转。

- 顶部：委托切换、新建、展开及更多菜单。低频操作收进菜单，避免堆成一排按钮。
- 对话区：作者要求、Agent 回复、折叠执行组；可展开计划。需要作者处理的问题就近给出操作。
- 输入区：多引用/附件条、文本、底部「＋／语音／发送」。运行中发送表示补充要求，暂停独立可达。
- 更多菜单：导出对话、查看完整执行记录、取消委托等与当前委托有关的操作。避免加入没有实际行为支持的菜单项。

原实施顺序如下，前两步已落实，第三步仍需音频服务与设备验收：

1. 交互可靠性：发送快照及幂等回执、滚动跟随、加载状态、复制和引用、IME 与键盘操作。
2. 输入与信息组织：多引用、「＋」及附件真实通路、活动分组、持久补充要求状态。`@` 复用作品选择器。
3. 音频：验证服务后接入听写；实时语音按已明确的通话与执行边界实现。

重点验收：发送期间继续输入、失败后输入新草稿、切换委托时上传/转写完成、移除后附件迟到、命令已接收但回包失败、上滑期间持续输出、图片加载及窗口缩放、中文输入法确认候选词。优先参考上游测试覆盖的场景，使用 Suiming 自己的命令和真实状态验证。

## 源码索引

以下链接固定到本次阅读的 commit，避免后来源码变化影响研究结论。

- [安全发送与草稿恢复](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/runtime/base/base-composer-runtime-core.ts)、[发送测试](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/tests/base-composer-runtime-core-send.test.ts)、[附件并发测试](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/tests/base-composer-runtime-core-addAttachment.test.ts)。
- [输入与 IME](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react/src/primitives/composer/ComposerInput.tsx)、[滚动跟随](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts)。
- [对话及消息操作模板](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx)、[props 展示组件与简化示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/composer.tsx)。
- [附件 adapter](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/adapters/attachment.ts)、[语音接口及 Web Speech adapter](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/adapters/speech.ts)。
- [AG-UI 适配](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react-ag-ui/src/useAgUiRuntime.ts)、[队列与 steer](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/runtime/queue/external-thread-queue-adapter.ts)。
- [Scribe 听写示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/examples/with-elevenlabs-scribe/lib/elevenlabs-scribe-adapter.ts)、[LiveKit 实时语音示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/examples/with-livekit/lib/livekit-voice-adapter.ts)。

仓库采用 [MIT License](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/LICENSE)。若实际复制实质性代码，保留相应版权及许可声明；仅研究交互并自行实现无需引入整个项目。
