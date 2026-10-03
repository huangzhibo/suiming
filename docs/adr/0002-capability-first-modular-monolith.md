# ADR-0002：Capability-first 模块化单体

- 状态：Amended by [ADR-0007](0007-local-tui-and-explicit-cloud-sync.md)；PostgreSQL 与原 app/package 形态仅适用于当时的 Cloud 设计
- 日期：2026-09-01
- 决策者：项目负责人

## 背景

云端产品确定后，仍可能从页面、REST resource、模型 provider、Agent framework 或 Workflow Graph 出发组织系统。这会把创作能力拆成大量 CRUD，把内部编排暴露给作者，也容易让 Web、CLI、MCP 和 Agent 各自形成业务规则。

Langfuse 的源码证明持久 Run、事件流、后台 Worker、OpenTelemetry 和 Eval 版本化具有实际价值，也说明 ClickHouse、Redis/BullMQ、Mastra、MCP sandbox 等组件服务于其观测规模和通用 Agent 需求，不能因成熟就整体复制到燧明界。

## 决定

1. 采用 capability-first：先定义 Agent 为完成作品目标需要具备的能力及其效果边界，再映射为 Domain Service、API、工具和界面。
2. Capability 是静态应用契约，不进入 Story Language，也不建立可编辑数据库本体。外部 MCP 只暴露少量高价值能力，不机械包装 REST endpoint。
3. 第一阶段使用模块化单体：`apps/web|api|worker|cli` 与 `packages/story|server|sdk|eval`。服务端模块只有出现独立演化压力后才拆包或拆服务。
4. 使用 PostgreSQL 同时承载 Artifact 事务与首期持久任务；以 lease、heartbeat 和 Attempt 实现恢复，不先引入 Redis/BullMQ 或通用 workflow runtime。
5. 使用 OpenTelemetry 输出 Attempt 级详细 trace，Langfuse 作为可替换观测与辅助实验后端；PostgreSQL 保存持久执行真源，Suiming Eval 保存故事专属质量与策略晋级证据，三者不互相镜像完整数据。
6. 作者端使用独立 Domain API，不依赖 Next.js、TanStack Start、tRPC 或 Server Function 作为唯一业务边界。

## 后果

- UI、CLI、MCP 和模型 provider 可以替换，而不会改变作品或创作能力语义。
- 首个切片必须实现可恢复 RunEvent 和 ProjectRevision，不能以一次同步聊天调用冒充 Cloud Runtime。
- PostgreSQL 初期承担更多职责，但系统少一个 Redis 一致性边界；只有真实瓶颈才允许拆分。
- Agent Runtime 需要自有的能力 registry、Agent Loop 和有限 Task DAG，但不需要构建通用 Agent framework。
- Suiming 不建设通用 trace 平台，也不把 Langfuse Dataset、Experiment、Score 或 Prompt 当作故事 Eval 与策略配置真源。
- ClickHouse、CRDT、语义检索和通用 durable workflow 被明确后置，避免基础设施复杂度先于质量证据。
