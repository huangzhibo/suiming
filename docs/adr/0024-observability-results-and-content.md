# ADR-0024：观测结果、调用关联与内容采集

- 日期：2026-10-14
- 状态：采用

## 问题与决定

Langfuse 已接收模型、工具、子任务与 Checker 的观测，但 Session 重构后整轮异常被业务层收口成正常返回，根 span 没有标记失败；模型调用缺少持久调用 ID，入口与构建不可区分。默认不导出内容也使观测只能回答耗时和用量问题，不能还原一次生成的上下文。

1. 每个 turn 一个 trace，同一 Session 分组。根 observation 的 `outcome` 区分 `completed`、`failed`、`stopped`；completed 只表示本轮正常结束，不代表作者目标完成。失败记录稳定分类和 ERROR，主动停止记 WARNING，不改 Session 的 idle / running 语义。捕获异常时先标记观测，再处理持久状态，持久化失败也不能掩盖结果。
2. generation 使用 loop 已有的 `model_call_id`，工具保留同一调用编号与自己的 `action_id`；不新增持久 ID 或第二份调用账本。会话、turn、Task、来源维度传播，局部动作、结果、用量和内容不传播。
3. composition root 明确 `desktop` / `cli` 来源，Runtime 直接使用者默认 `runtime`；环境默认 `local`，发布标识默认应用包版本。开发对比通过 `SUIMING_TELEMETRY_RELEASE` 指定构建或提交编号，环境通过 `SUIMING_TELEMETRY_ENVIRONMENT` 指定。不从作者作品仓读取 Git revision 当应用版本。
4. 内容采集默认关闭。只有进程启动配置 `SUIMING_TELEMETRY_CONTENT=true` 才启用，作用于此进程后续的新观测。开启后采集本轮作者输入和最终回复、模型的应用层请求与响应（包含可见推理和工具声明）、工具参数与可见结果；不承诺记录 provider 的最终 HTTP payload。
5. 采集在副本上做：排除认证配置、provider 签名、图片二进制和原始异常；对结构化凭据字段、常见 token 和已知环境凭据做尽力过滤。它不是匿名化，小说、个人信息与未知形式的秘密仍可能包含在正文中，开启即选择向已配置后端发送这些内容。每字段超过 64 KiB 时保存明确标记的预览和过滤后大小；不把截断数据呈现为完整上下文。采集失败只标记该字段，关闭时不构造内容副本。

## 边界与取舍

继续采用现有 OpenTelemetry 适配，不新增 Langfuse 专属执行层、全局 context manager、数据表或后台双写；Langfuse 故障不阻断创作。进程强杀可能丢失未结束或未导出的 span，调用是否发生仍以本地执行记录和服务商证据核对。

不以读取整个本机配置或凭据库来实现脱敏；认证从不作为采集对象。默认关闭比声称“自动脱敏后可任意上传”更诚实。已开启的内容可含作品原文，需要在目标后端按自身保留策略管理。默认包版本只能区分发行版本，开发者要比较不同代码构建时必须提供准确 release。

参考：[Langfuse 观测实践](https://langfuse.com/docs/observability/best-practices)、[OTEL 属性映射](https://langfuse.com/integrations/native/opentelemetry)。沿用现有 OTEL SDK，此次不引入 Langfuse SDK 或顺带升级依赖。
