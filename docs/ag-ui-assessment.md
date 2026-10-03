# AG-UI 采用评估

> 执行选型已收敛：参考 pi 逻辑自行实现 SuimingHarness，见 [ADR-0012](adr/0012-own-suiming-harness.md)与[Harness 设计](harness-design.md)。本文保留此前取证，关于 pi 内循环、Attempt 重启或替代后端的建议不再作为当前规范。

日期：2026-09-07。评估基线：main / 262ee4d。

本文保留选型研究；结论已纳入 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md) 和目标规范，不代表已完成迁移。核对了仓库实现、官方规范和实际发布的 npm 包，并在仓库外执行了客户端兼容性探针。

> 综合决策与实施顺序见[桌面工作台与自主 Agent 重构方案](refactoring-plan.md)。桌面端已确定为核心产品；本评估保留协议与客户端取证，新方案补齐桌面 IPC、作者工作台和持续委托的接入边界。

## 结论

**建议采用 AG-UI 作为统一的界面事件契约，以标准事件加有明确 schema 的 Suiming 扩展替换现有 RunEvent 事件词汇；不长期并存两套事件协议和转换层。**

实施应形成一个完整的协议迁移任务，排在首个 React 作者界面之前。当前 M5 R 的正文质量与作者选择仍是主线；本次评估不启动 Web、Cloud host 或切换模型框架。

主要收益是复用通用消息、工具与交互状态的客户端实现。TanStack AI 已成为可验证的客户端选项，所以“只有第三方客户端才考虑标准”的旧限制不再是充分理由。AG-UI 不负责决定 Story Canon，也不要求替换 pi 的模型调用和 agent loop。

“AG-UI 无法表达 Task、blocked、停止和 revision”不能继续作为否决依据。Step / Activity、metadata 和 CUSTOM 可以承载应用语义；等待输入也已有标准 interrupt / resume。业务扩展仍需我们定义，但不需要再造一套文本、工具和交互生命周期协议。[事件规范](https://docs.ag-ui.com/concepts/events)、[Interrupts](https://docs.ag-ui.com/concepts/interrupts)

## 方法与证据边界

已发布版本通过 npm registry 核对，并在临时目录精确安装：

| 包 | 版本 |
| --- | --- |
| @ag-ui/core | 0.0.59 |
| @tanstack/ai-client | 0.31.0 |
| @tanstack/ai | 0.53.0 |

另核对 @tanstack/ai-react 当前发布版本为 0.24.0；没有启动 React 界面。实验使用它底下的真实 ChatClient。

临时实验目录：/tmp/suiming-agui-eval.XKyEMb。保存 probe.test.ts、package.json、package-lock.json；运行命令为 node --test probe.test.ts。现状缺陷复现项依赖本机仓库绝对路径。实验目录不进入项目依赖或正式测试集，临时目录清理后需重新取得脚本。

结果：**10 项探针通过，0 失败**。其中包含对不支持行为和当前缺陷的确认；不能解释为所有产品验收已通过。

实验使用合成事件、真实协议校验器和真实客户端；SSE 使用可控的 fetch / Response fixture。没有真实 provider 调用、浏览器 E2E、SQLite / PostgreSQL 故障恢复或全链路迁移验收。

| 探针 | 实际观察 |
| --- | --- |
| 标准 schema 与扩展 | metadata 和 CUSTOM 数据保留；outcome: cancelled 被拒绝；interrupt outcome 被接受 |
| 文本、工具、Step、CUSTOM | ChatClient 正确组装文本与工具状态，并把业务事件交给回调 |
| SSE 中途结束、重连和重叠重放 | 默认 adapter 再次 POST，带 Last-Event-ID；重复事件不重复追加文本。fixture 按请求 runId 去重，模拟启动计数为 1 |
| 快照恢复 | 新客户端用 MESSAGES_SNAPSHOT 加后续事件恢复会话文本 |
| 摘要日志的限制 | 只有生命周期事件时，新客户端无法恢复此前文本 |
| 等待作者输入及 resume | 客户端识别 interrupt；恢复使用同一 thread、新的协议 runId；metadata 可关联同一 Suiming Run |
| 失败后重试 | 新交互保留前次消息、清除客户端错误并关联同一持久 Run |
| 主动停止 | stop() 触发 connection 的 AbortSignal；Runtime 中断命令仍需应用接入 |
| 服务端确认停止 | 业务状态通知加 RUN_FINISHED 结束 loading 且不产生模型错误；后台 interrupted 状态由应用显示 |
| 当前 RunEventStream 失败路径 | 持久化订阅者抛错后，界面订阅者仍收到事件，复现“发送前持久化”保证的缺口 |

客户端依据见 [Connection Adapters](https://tanstack.com/ai/latest/docs/chat/connection-adapters) 和 [ChatClient](https://tanstack.com/ai/latest/docs/api/ai-client)。默认重连重复 POST 是具体版本的实测结果，服务端不能把每次 POST 都当成新的创作。

## 当前代码意味着什么

[RunEventSchema](../packages/sdk/src/run-event.ts) 定义 12 种事件，但还不是完整的交互消息流：

1. text.delta 没有消息级 ID、消息开始和结束边界，且不持久化。
2. tool.called 在工具结束后才发出，保存摘要，没有对外工具调用开始及参数流。
3. 文档提到的 revision.created、run.blocked、run.awaiting_input 并未单独出现在当前 schema 中。revision 可由完成结果引用表达；不能把文档中的事件清单当成已有实现。

[pi loop 接入](../packages/runtime/src/harness/loop.ts) 已能观察 message 与 tool execution 事件，可以在现有接入点补消息边界，无须修改 pi 源码。无论选哪套协议，这部分产品交互信息都要补。

[RunEngine 恢复](../packages/runtime/src/harness/suiming-harness.ts) 读取 Run / Task / Attempt 状态、任务结果和 worktree，不靠重放 UI 事件恢复执行。因此，改事件格式不要求把持久状态机改成 AG-UI 模型。

源码和测试中有 27 个 TypeScript 文件引用 RunEvent 相关类型。迁移跨 SDK、engine、store、CLI、TUI、API 和测试，不能按“改几个事件名字”估计。本次没有给出未经实测的工期或节省行数。

## 采用后的边界

保留事件总线和持久日志职责，把事件正文改为 AG-UI 标准事件与受校验的 Suiming CUSTOM。从引擎生成之后，各端消费同一份事件；不先生成旧 RunEvent 再转译。

    pi 调用和工具事件 + Runtime 状态变更
                        ↓
            一份 AG-UI + Suiming 扩展事件流
                        ↓
          持久日志 / subscription / IPC / SSE
                        ↓
              TUI / React 作者界面

pi → 产品事件的接入逻辑仍存在，因为模型层和产品交互层职责不同；它归入现有 loop / engine 接入点，不新增中间协议、独立服务或第二份日志。

- 标准事件 schema 和类型复用上游。当前 TypeBox 命令目录需要同上游 Zod schema 对接，这项工作尚未验证；不得手抄标准字段表维持两份定义。
- Suiming 维护业务扩展 payload、持久信封、客户端业务展示及升级验证。
- Run / Task / Attempt、作品版本、Checker、DesignCommit、lineage、Review 与提交仍属于 Runtime / Story。
- 作品读取、提交、diff、steer、interrupt 继续调用已有领域能力。AG-UI 请求入口是传输接入，不能再定义一套业务命令。
- TanStack AI 客户端可单独使用；服务端是否替换 pi 是另一项选型，本评估没有证明替换收益。

## 四个必须明确的接缝

### 持久 Run 与协议交互

Suiming 的同一 Run 会在失败或中断后继续。AG-UI 的一次交互有明确终点；标准等待输入的恢复使用后续交互。

建议协议 runId 表示一次启动或续跑的执行区间，通过 metadata 关联持久 Suiming Run；threadId 对应 Conversation。关联记录在已有事件中，不新建 Run 表，也不滥用表示分支的 parentRunId。

这需要明确命名及可重放的 ID 生成规则，不能只靠客户端碰巧接受复用 ID。本次证明两种粒度可关联，未完成其持久化实现。[恢复约定](https://docs.ag-ui.com/concepts/interrupts)

### 停止、等待输入、断线

- 等待作者回答：标准 interrupt / resume。
- 作者主动停止：调用 Runtime 中断，服务端确认后报告后台状态并结束当前交互；不能报成模型失败或伪造待回答问题。
- 关闭窗口、网络断开：解除订阅，后台 Run 继续。

core 0.0.59 没有单独的 cancelled outcome。“已处理停止请求”可以结束当前交互，同时在 result / metadata 或业务通知中明确后台 Run 是 interrupted。自有 UI 按该状态显示“已停止”，不能把任何 RUN_FINISHED 都解释为作品成功提交。通用客户端对该业务状态的默认展示有限，这是保留下来的实际成本。

### 续传与刷新恢复

现有 SSE 序号、Last-Event-ID、afterSequence 和编码方式可复用，但默认 TanStack adapter 的 POST、GET join、hydrate 约定与当前 GET-only 事件路由不同，需要明确接入方式。标准事件不会消除所有传输接入工作。

必须分别证明：重连不重新调用模型或提交作品；读取已有 Run 是只读操作；刷新恢复已完成及正在生成的对外消息；快照与游标对应同一位置；持久化失败不能被当成已成功交付。

本次证明 SDK 的去重与快照消费能力。服务端启动幂等、消息持久化和游标一致性仍需实现并验收。对外消息属于执行数据，无须新增 Story Artifact，也不等于长期保存所有模型内部消息。[TanStack 持久化范围](https://tanstack.com/ai/latest/docs/persistence/overview)

### 工具展示与作品数据边界

write / edit 参数可能含整篇正文或 Design 文件。不能因为标准支持 TOOL_CALL_ARGS，就把完整 worktree 内容发送和持久化到交互事件里。

允许展示的真实参数可用工具调用事件；大内容操作可显示 Activity 的路径、状态和摘要，完整内容经已有领域能力读取。不能把删改后的摘要伪装成模型实际调用参数。AG-UI 不替项目决定输出策略。

## 维护取舍

| 路线 | 当前改动 | 长期维护 | 判断 |
| --- | --- | --- | --- |
| 继续自定义 RunEvent，自己做交互客户端 | 最少 | 自定义通用协议、消息状态处理、界面集成 | 不推荐为目标形态；缺消息边界且已有可复用客户端 |
| 保留 RunEvent，另建 AG-UI 投影 | 中等 | 两套事件词汇、映射、快照及生命周期关联 | 不作为默认终局；未证明第二份协议有独立价值 |
| 原生 AG-UI 加受校验扩展 | 一次性迁移较多 | 业务扩展、传输接入、标准升级、应用状态展示 | 推荐；复用通用客户端并维持一份界面事件契约 |

采用标准不消除业务定制，本次探针也不能证明总成本必然低于所有自研方案。推荐依据是项目明确需要 React 作者界面与持续对话、标准客户端实测可用、内部执行状态与事件格式可分离，而且尚无已发布界面需要长期兼容。

## 实施和验收建议

先确认事件和 ID 规则，再迁移代码；不直接恢复 ADR-0004 的旧实现或沿用其全部假设。

1. 用现有合成 provider 跑真实 engine → AG-UI → ChatClient，验证消息边界、工具展示、扩展 schema 和 TypeBox 对接。
2. 在真实 SQLite 上验证失败续跑、主动停止、离开后重连、刷新、重叠重放和持久化失败；核对模型调用计数、提交次数和 ProjectRevision。
3. 统一 SDK、CLI、TUI、Local / Cloud event store 的格式和终态处理；通过后删除旧事件定义及转换代码。Cloud host 按原里程碑启动。
4. 开发期执行日志按数据价值选择一次性转换或保留只读档案，不提供长期 legacy codec；迁移不能损坏作者选择、作品与 revision。
5. 修订架构、技术选择和状态文档，纠正“语义表达不足”“仅第三方适配”的结论；历史 ADR 保留历史身份。

建议现在接受目标方向，在桌面端或 Web 首个交互切片前完成迁移，避免先建设新的自定义聊天客户端。整个协议迁移不插到当前 R 的正文质量修订之前。

## 独立发现：持久化失败后仍发布

[RunEventStream.emit](../packages/runtime/src/harness/events.ts) 对所有订阅者异常一律吞掉，而 [RunEngine](../packages/runtime/src/harness/suiming-harness.ts) 把 appendRunEvents 注册成第一个订阅者。

探针复现了存储订阅者抛错后，界面订阅者仍收到事件。这与“持久事件先保存再发送”要求不符。它是现有实现缺陷，不能用来支持或否决 AG-UI；修复应把持久化成功作为发布前置条件，并单独处理可丢失增量。本次评估未修改该行为。
