# OTLP 首批缺失排查与导出修复

## 证据与结论

1. 再次按旧 Session 查询 observations，仍只得到 2 次模型调用、2 次工具和 1 条 turn；本地执行记录为 3 次模型、6 次工具。不是稍后入库后自然补齐，也没有为凑齐而补造 observation。
2. 在旧运行对应的服务端时间窗，Langfuse Web 于 `2026-10-16T18:12:37.279Z` 报 `Failed to read request body stream is not readable`。该行没有 trace ID，不能单凭它断言就是缺失的那一批；worker 同一时间窗没有对应错误。
3. 客户端代码把 OTLP 请求超时缩成 1500ms、BatchSpanProcessor 导出超时缩成 2000ms；上游 OTLP 默认请求超时为 10000ms。以真实本地 HTTP 接收端延迟 1800ms，旧实现稳定报 `langfuse_export_failed`，正常响应也被提前放弃。测试先失败，再修改实现后通过。
4. 已移除两处自定义短超时，沿用上游导出与重试；`flush` / `shutdown` 的有界等待继续保留，观测失败不影响创作。不新增重试队列、磁盘暂存或观测镜像。
5. 之前只在首次失败时输出一个码，无法知道缺失哪一批。现在每个失败批次记录原因类别、HTTP 状态（若有）、耗时、数量和 span / trace ID；恢复后输出恢复码。不会记录异常原文、响应正文、请求头或作品内容。

这是一个已复现并修复的导出可靠性问题；**旧首批缺失仍没有足够的客户端诊断完成唯一归因**。服务端请求体错误与客户端短超时相吻合，但不能把推测写成已证实的历史根因。

## 验证

- `npm run check` 通过。
- telemetry、content 与 export 定向测试 9 / 9：慢响应、连续 HTTP 400、恢复、内容脱敏及有界退出。
- 连续桌面创作使用真实 Langfuse，经仅保存批次元数据的透明转发端；首批额外延迟 1800ms。后续逐个 span ID 对账记录在本目录的连续创作验收中。

官方接入契约：[Langfuse OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry)。仍使用 OTLP HTTP 和 v4 ingestion header，逐个 observation 携带关联维度。
