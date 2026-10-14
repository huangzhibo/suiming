# Harness 通用机制对齐

## 依赖升级

Runtime、CLI、desktop 共用 pi-ai 1.2.0，pi-telemetry 同步为 1.2.0；安装不执行依赖脚本，未引入 pi-durable。Google SDK 仍为 2.21.0，不需要修改脚本许可。上游 main 未发布的 upstream stream 错误修复不纳入本轮。

检查通过；Gateway / Agent / Context 70 项通过，持久循环 10 项通过。新增验收验证三种服务繁忙 / 上游故障在同一轮重试恢复，四次调用分别记账，未复制上游错误分类。此处是机制证据，真实模型与 Langfuse 对账在后续步骤补验。
