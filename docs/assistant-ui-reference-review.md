# assistant-ui 对话功能源码参考

状态：2026-09-10 的源码研究笔记，不再维护。研究对象是 [assistant-ui](https://github.com/assistant-ui/assistant-ui) 的 `0bea0fc504a169ccb699c4c9efd2d7a29651c186` 提交（2026-09-09，`@assistant-ui/react` 0.15.18），只读了实现和测试，没有运行示例、测试或音频服务。其中的非音频交互已按 Suiming 自己的边界实现、没有引入依赖（[验收](validation/2026-09-10-agent-composer/README.md)），现行规则见[作者工作台设计](web-product-design.md) 4.1；语音未排期，待做边界见 [Agent 输入能力方案](agent-input-capabilities.md)。文中的 `run.launch` / `run.steer` / `run.steering` 与「委托」是当时的名字，现在分别对应 `session.send`、`session.inbox` 与「对话」。

## 结论与复用边界

值得参考，重点是输入生命周期、附件状态、流式滚动与消息操作。建议保留 Suiming 的 React、shadcn/ui、TanStack client、typed IPC 与自有 Harness，按功能吸收源码中的交互规则和测试场景。

assistant-ui 有三层可供参考：

- `packages/ui`：组件源码，包含只接收 props 的展示组件和 `.aui.tsx` 的运行时绑定组件。适合参考结构、操作入口和状态呈现。
- `packages/react/src/primitives`：输入、滚动、附件拖放、消息操作等交互。可借鉴独立逻辑；其中依赖其 store/runtime 的 hook 需要改写绑定。
- `packages/core`：composer、消息树、队列、adapter 和运行时。适合研究状态转换与异常处理，不宜整体移植为 Suiming 的另一套执行状态。

它提供 external-store 和 AG-UI adapter，技术上能够对接已有后端。完整接入仍需映射消息、会话、取消、续跑与队列语义；当前 Suiming 已有同类客户端边界，单为增加输入功能不值得再增加一层运行时映射。

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

## 源码索引

以下链接固定到本次阅读的 commit，避免后来源码变化影响研究结论。

- [安全发送与草稿恢复](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/runtime/base/base-composer-runtime-core.ts)、[发送测试](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/tests/base-composer-runtime-core-send.test.ts)、[附件并发测试](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/tests/base-composer-runtime-core-addAttachment.test.ts)。
- [输入与 IME](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react/src/primitives/composer/ComposerInput.tsx)、[滚动跟随](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts)。
- [对话及消息操作模板](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx)、[props 展示组件与简化示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/ui/src/components/react/assistant-ui/elements/composer.tsx)。
- [附件 adapter](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/adapters/attachment.ts)、[语音接口及 Web Speech adapter](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/adapters/speech.ts)。
- [AG-UI 适配](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/react-ag-ui/src/useAgUiRuntime.ts)、[队列与 steer](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/packages/core/src/runtime/queue/external-thread-queue-adapter.ts)。
- [Scribe 听写示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/examples/with-elevenlabs-scribe/lib/elevenlabs-scribe-adapter.ts)、[LiveKit 实时语音示例](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/examples/with-livekit/lib/livekit-voice-adapter.ts)。

仓库采用 [MIT License](https://github.com/assistant-ui/assistant-ui/blob/0bea0fc504a169ccb699c4c9efd2d7a29651c186/LICENSE)。若实际复制实质性代码，保留相应版权及许可声明；仅研究交互并自行实现无需引入整个项目。
