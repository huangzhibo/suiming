# ADR-0012：参考 pi 逻辑，自行实现 Suiming Harness

- 状态：Accepted（执行方向已确定，设计规格已同步，代码迁移未开始）
- 日期：2026-09-07
- 决策者：作者与项目负责人

## 决定

参考 pi-agent-core 的执行、持久状态与恢复逻辑，自行实现 Suiming Harness；不再评估依赖 AgentHarness、fork / vendor pi 内核或其他执行后端。继续依赖 `pi-ai` 的多 provider 调用与协议类型。现有 `RunEngine` 演进为唯一的 `SuimingHarness`，不在它外部叠加第二运行引擎。

Run 表示完整创作委托，Task 表示独立工作，Attempt 表示一份冻结执行绑定下的尝试。暂停、进程重启和网络重试沿用原 Attempt；显式切换绑定或重新尝试失败工作才新建 Attempt。动作身份、已确认结果与作品 receipt 跨恢复稳定，不增加 pi Session / Lane / Operation 的同义模型。

持久数据继续由现有 Local SQLite / Cloud PostgreSQL 与 execution object store 承担，Context、Checker、worktree、作品提交和 Cloud sync 复用现有领域边界。模型与工具循环、任务交接、恢复、取消、预算与对外事件由 Suiming 自行实现和维护。完整规格见 [Harness 设计](../harness-design.md)。

## 依据与代价

本次已检查 pi `0.85.1` / commit `7d8ab31a477ecc07b36f56ffcae58c79307a68be` 的源码。新版具有实际 Harness、持久工具批次与恢复实现，不能把旧安装版本 `0.84.4` 中的占位代码当作新版能力结论。选择自建是为了围绕作品事务、父子交接和桌面生命周期直接维护一套执行语义，不是因为上游做不到，也不宣称已证明更低成本或更高质量。

我们承担流式响应、请求未知、工具重放、Context 压缩、指令、取消与恢复的工程责任。参考上游机制和故障用例，用本项目的实现与真实存储验证。源码参考不是运行依赖，也不意味着跟随上游字段、目录与版本升级；不建设通用 Agent 平台。

## 对先前决策的修订

- 修订 ADR-0011 的第 2 项执行底座与第 8 项替代后端评估；桌面核心产品、原子能力、自主 Agent、事件契约与 host-native 保持。
- 修订 ADR-0009 第 10 项采用 pi-agent-core 内循环的要求；保留唯一执行实现、worktree 与领域服务边界。
- ADR-0003 的直接复用 pi-ai 模型协议保持；旧 RunEvent、固定 recipe 与凭据规则仍按既定重构清理。
- 先前关于取消 Attempt、映射 Session / Lane / Operation、接管最小源码的讨论不构成并行方案；以本 ADR 与 Harness 设计的明确语义为准。

## 验收

先验收副作用前落库、结果先保存、作品 receipt、父子交还、同 Attempt 恢复、显式换模型、预算与消息续传；再完成持续 Agent 与桌面真实委托。全过程只保留一套执行状态与运行路径。pi-agent-core 的 Agent、工具类型、文件工具与 NodeExecutionEnv 引用全部迁出后，才算移除该依赖。

本次只完成设计。源码、故障注入、实际模型与桌面产品的完成证据分别记录在[当前状态](../current-status.md)，不以文档替代测试。
