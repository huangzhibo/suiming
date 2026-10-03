# ADR-0004：采用 AG-UI 作为 Agent 交互边界

- 状态：Superseded by [ADR-0009](0009-redesign-after-code-audit.md)；Suiming RunEvent 成为所有界面的唯一事件契约，AG-UI 只在有第三方客户端时作为单向投影。先持久化再发送、单调序号、重放不重执行的做法保留
- 日期：2026-09-02

## 背景

Suiming 的 Web 需要展示长时间 Agent Run 中的消息、进度、Tool、Worker、interrupt 和最终 revision。自行定义这些事件会重复通用 Agent UI 协议；先定义 `SuimingRunEvent` 再转换为 AG-UI 又会形成两套语义。另一方面，AG-UI 不负责持久任务、事件存储、断线重放、ProjectRevision 或 Story Canon，且其通用 resumable wire contract 尚未稳定。

## 决定

1. Web、remote TUI 等远程交互客户端与 Agent 直接使用 AG-UI `RunAgentInput / BaseEvent`，不定义平行的 Suiming 消息、Tool 或运行事件联合类型。
2. `Conversation.id` 对应 `threadId`，`Run.id` 对应 `runId`。Suiming 专属通知使用命名空间化 `CUSTOM` event，只携带稳定引用和显示摘要。
3. PostgreSQL `RunEvent` 只是原生 `BaseEvent` 的持久信封，增加 `runId / sequence / protocolVersion`。公开事件必须先持久化再发送；重放只重新交付事件，不重新执行任何副作用。
4. 在 AG-UI 官方续传协议稳定前，Suiming 以 SSE `id` 和 `Last-Event-ID` 或 `afterSequence` 实现断线补发，不修改 `BaseEvent`，也不宣称支持尚未满足的标准 capability。
5. AG-UI 只存在于 Product 交互边界。Story Artifact、Workspace、ProjectRevision 和完整 diff 继续由 Domain API 提供，不进入 AG-UI state；`packages/story` 不依赖 AG-UI。
6. 首期直接使用 `@ag-ui/core` 与 `@ag-ui/client`，不引入 CopilotKit 或 A2UI。若默认 transport 不支持持久 Run 续接，只通过公开扩展点实现薄 connector，不 fork SDK。
7. Suiming 是 Conversation、Run、项目权限和作品版本的权威；客户端提交的 messages、state、tools 与 forwarded properties 不能覆盖服务端历史、授予额外能力或成为 Story Canon。

## 验证门

正式 Web 实现前，用固定假任务证明：

- SSE 断开后后台 Run 继续；
- 客户端按序号只收到缺失事件；
- 重放不重复消息、Tool 或副作用；
- 页面刷新可以恢复 Conversation 和活动 Run；
- `CUSTOM` revision 通知可以回到 Domain API 获取准确 diff；
- 协议升级后的历史事件仍可按记录的 `protocolVersion` 解码。

## 后果

- Web、未来 Desktop 和兼容客户端共享通用交互语义，Suiming 不维护自己的通用 Agent UI 协议。
- 持久执行仍由 Run、Task、Attempt、RunEvent 和 Worker lease 保证；AG-UI 不能被误当作 durable runtime。
- Story 领域和作品版本不受外部协议演进影响。
- 续传接缝需要由 Suiming 暂时维护，但官方规范稳定后可以局部替换，不迁移 Story Artifact 或 Agent Runtime。

## 参考

- [AG-UI Introduction](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/introduction.mdx)
- [AG-UI Events](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/js/core/events.mdx)
- [Resumable transport discussion](https://github.com/ag-ui-protocol/ag-ui/issues/2105)
