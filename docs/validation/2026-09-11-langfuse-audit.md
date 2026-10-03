# Langfuse 接入检查（2026-09-11）

以下为优化前检查记录；后续修复见文末。

初始结论：本机 Langfuse 服务、项目认证和 OTLP 接收可用；当前桌面产品尚未接入，现有 Runtime 埋点也未完整适配 Langfuse v4。不能把历史 CLI trace 或 exporter 单测通过当作桌面接入验收。

本次检查基于工作区当前源码，包含上一轮尚未提交的修复。没有修改业务实现、真实作品或账号配置。测试使用临时 SQLite 作品与 faux provider，不调用付费模型；测试记录保留在本机 Langfuse 的 suiming 项目中。

## 实际验证

- `http://localhost:3000/api/public/health` 返回 OK，版本 4.24.0；Web、Worker、PostgreSQL、ClickHouse、Redis、MinIO 容器运行。
- 使用现有环境配置进行 Basic Auth，`GET /api/public/projects` 返回 200。
- 使用现有 `langfuseExportOptions` 和 OTLP exporter，发送真实 Harness 的隔离委托：写入 → 独立 Review → 提交 → 完成。持久 Attempt 保存的 trace/span ID 与导出记录一致。
- `GET /api/public/v2/observations` 读回 3 个 trace、13 条 observation：完整委托 8 条、模型成功/失败探针 3 条、固定用量探针 2 条。
- 模型 span 被识别为 GENERATION；模拟失败显示 ERROR，状态信息为 `Model call ended with error`。
- 固定用量探针通过生产 `traceModelCall` 写入 input=100、output=20、cacheRead=40、cacheWrite=10、totalTokens=170、cost.total=0.0035；Langfuse 读回金额正确，但 totalUsage=120，缺少缓存用量。
- 现有 telemetry 与 Model Gateway 单测 16/16 通过。其中不可达后端测试约 9.18 秒：flush 有界，随后 shutdown 仍等待 exporter 收尾。
- 所有探针 observation 的 input/output 均为空。当前正常路径不导出 prompt、正文或凭据；通用异常路径仍直接记录 Error.message，不能据此宣称所有异常文本均已脱敏。

测试定位：

| 用途 | Trace ID |
| --- | --- |
| 完整 Harness 委托 | `c706b27aa1310d496bc8b05f307c0944` |
| Gateway 成功/失败 | `231f915e568e16426a87c66eb325ab3d` |
| 固定缓存用量与金额 | `928fda2af49590a14d0721d6da642b04` |

前两个探针的 faux provider 自动估算用量，因此其零费用不能证明非零金额映射正确；第三个探针专门绕过 faux 用量估算，直接验证生产埋点函数。

## 待修复问题

### P1：桌面 composition root 没有接线

`apps/desktop/src/main.ts` 没有创建 telemetry；Model Gateway 只接收 credentials。`packages/runtime/src/local/local-workspace.ts` 创建 LocalRunController 时没有传 telemetryContext，因此 Harness 默认 NOOP；loop 又将该 NOOP 显式传入模型调用，仅给 Gateway 接线也不够。桌面退出路径没有 telemetry flush/shutdown。

`dev:desktop` 与 desktop bin 也没有加载根目录 `.env`。即便在 `.env` 中写好了 Langfuse 配置，也不能假设启动的 Electron 已经继承它。CLI/TUI 则已有从进程环境创建 telemetry 的代码。

应由主进程持有单个 provider，贯通 Workspace → Controller → Harness → Gateway，并在现有退出时限内收尾；开发启动明确加载环境配置。凭据不进入 renderer。

### P2：session 和业务标识没有传播，v4 聚合遗漏模型调用

`SuimingHarness.finish` 只在根 span 设置 session、project、run 等上下文。桥传递了 OTEL 父子 Context，但不会继承属性。

实测按本次 conversation/session 筛选仅返回 1 条 Run observation，totalUsage=0；其余 7 条 observation 的 sessionId 都为空。按会话分析模型用量会漏掉所有 generation。Run / Task / Attempt 自定义属性也没有映射为明确的可筛选 metadata。

应显式传播允许的关联字段，并在需要筛选的 observation 上设置 metadata；不能仅依赖 traceId 或根 span 上的属性。

### P2：缓存 token 没进入标准用量

`model-call-telemetry.ts` 只将 input/output 作为 usage 导出，cacheRead/cacheWrite 仅为 `suiming.model.*` 元数据。实测 170 个 token 被呈现为 120 个，缓存 50 个未计入 usage。金额 `0.0035` 正确，说明不是整条记录丢失。

应按 pi-ai 的互斥 token 分类映射 Langfuse usage details，保留总数及缓存读写分类，避免漏算或重复计数。

### P2：观测树不完整

本次实际树为 Run 下并列 Agent Task 和 Review Task，各自下挂模型调用。`executeChild` 回到 Run 上的 telemetry 创建 span，没有以父 Task/委派动作为父 span。持久父子关系存在，但没有表达到观测树中。

当前 Runtime 只有 Run、Task、Model 三处业务 span 入口；文件工具、Context 构造与 Checker 没有独立 span。发生慢调用或校验失败时，Langfuse 无法准确定位这些阶段。应补足关键阶段的耗时、结果及关联 ID，继续让 execution store 保存执行真源。

### P2：导出失败与退出边界不足

`telemetry.ts` 的 flush 吞掉失败和超时并返回 void；应用没有接入可见的导出状态，因此“调用 flush 成功返回”不能证明 Langfuse 已接收。shutdown 直接返回 provider.shutdown，没有沿用整体时间上限。CLI 在 finally 中 await shutdown，后端故障仍可能拉长退出时间。

应维持观测故障不阻断创作，同时提供脱敏的失败诊断，并为 flush + shutdown 设总时间预算。

## v4 与能力边界

导出器尚未发送 `x-langfuse-ingestion-version: 4`。本机本次已能及时读到数据，不能把缺失 header 误报为“接收失败”；但官方迁移契约要求 header 与属性传播一起完成。旧 `GET /api/public/traces` 在本机返回 404，查询工具应使用 v2 observations。

当前输入、输出、详细 provider 错误、首 token 时间和模型参数的观测不完整。正常路径不记录正文有明确的隐私价值；如要用 Langfuse 诊断生成质量，应另行确定显式的内容采集与脱敏策略，不自动上传真实小说。

本次没有验证真实 provider 调用、桌面端到端导出、重开后的 trace 关联、长时间运行或真实模型账单。Cloud engine host 仍未实现，本次不扩张 Cloud 范围。

依据：[Langfuse v4 自定义 OTEL 迁移](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4)、[OTEL 属性映射](https://langfuse.com/integrations/native/opentelemetry)、[Observations API](https://langfuse.com/docs/api-and-data-platform/features/observations-api)。


## 同日优化与验收

上述五类问题已落实：桌面持有共享 provider 并贯通执行链；开发启动加载根 `.env`；v4 header、会话与业务 ID 传播到子 observation；缓存按互斥 token 类别上报；Review 挂到父 Task，工具、Context 捕获、阶段提交 Checker 新增 span。模型记录允许的参数与首个内容增量时间。普通工具执行或恢复仍沿用原动作与 checkpoint；没有复制运行真源。

CLI / TUI 统一通过有界 shutdown 导出并关闭，桌面沿用 5 秒整体退出窗口，先给保存进度最多 3.5 秒，再用剩余时间关闭观测。HTTP 导出超时 1.5 秒，导出失败 / 恢复报告固定诊断码，通用异常不再导出原始 Error.message；模型和工具错误保留安全分类。未启用正文采集，也没有更改真实账号设置。

验收证据：

- Live Runtime 探针：4 个 trace、32 条 observation，按同一 session 查询完整返回，父 span ID 与本地导出一一匹配，无重复 observation；暂停恢复保留原 Attempt。
- 精确费用探针：Langfuse 返回 input=100、output=20、input_cache_read=40、input_cache_write=10、total=170，费用 0.0035。
- Electron IPC 合成委托通过主进程环境配置，退出时导出 Run / Task / Model / Context / Tool；本地 HTTP 接收器回归检查 v4 header、共同 session 和 trace。
- 观测、模型、Agent、CLI 回归覆盖字段继承与覆盖、子 Task 归属、成本 / 缓存、正常和失败退出、超时不阻断。正常业务测试继续验证提交与恢复语义。
- Live 验证均使用 faux provider 和临时作品；没有真实模型费用、正文质量或生产长时间负载结论。现有应用需重启才能加载新代码和环境。

Live Runtime 的 session 为 `conversation_211a571b-e15f-4998-970d-e5d53fbb56c8`，可在本地 Langfuse 中定位。可重复运行的合成检查脚本：

```sh
node --env-file=.env --import tsx docs/validation/langfuse-probe.ts
```

该命令会向显式配置的 Langfuse 项目写入合成观测，只输出关联 ID 和核对结果，不输出密钥、Prompt 或作品内容。


最终验证：`npm run check` 通过；常规测试 316 项，其中 307 通过、9 项按 PostgreSQL / S3 环境门跳过、0 失败。新增 Electron OTLP 回归通过。Electron 直接连接本机 Langfuse 的完整 IPC 实测读回 5 条 observation，trace 为 `22e5e0cdda72086a9de54db4ebb4d62f`，包含 Run、Task、Model、Context、Tool。测试在读取持久 Run 完成状态后才退出；不把异步查询返回的 Promise 或 Task 完成当作整次委托完成。
