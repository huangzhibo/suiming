# ADR-0005：质量切片先于产品运行时

- 状态：Superseded；实施顺序由 [ADR-0006](0006-real-work-before-formal-eval.md) 调整
- 日期：2026-09-02
- 决策者：项目负责人

## 背景

ADR-0001 确定了 Cloud 根产品和架构完整的产品切片，但若先实现 PostgreSQL 持久任务、AG-UI 与 Web，项目可能在证明专属 Agent 能改善长篇创作之前，先完成一个可靠却没有质量优势的产品壳。Story Language 迁移、Artifact 正确性和真实创作收益是 durable runtime 的前置价值，而不是它的附属验收。

## 决定

研发按 Domain、Quality、Product 三条主线依次闭合：

1. Domain：迁移 Story Language、Checker 和高价值测试，以内存 Artifact Store 验证 Workspace、ChangeSet 与开放作品包 round-trip；
2. Quality：用 `pi-ai` 和 headless Agent 修改真实 Design，贯通 Context、Search 与 Review，并和 repository-native 基线做同模型、同输入、同预算的 paired eval；
3. Product：前两项不退化后，再实现 PostgreSQL、durable Run / Task / Attempt、AG-UI 和 Web。

这不是放弃 Cloud-first。Cloud 仍是唯一产品和代码根；headless 只是先验证领域与质量的开发入口，不形成第二套产品或长期 runtime。

## 后果

- 不会用基础设施完成度冒充 SOTA 进展；真实创作质量更早进入架构反馈。
- 内存 Store 只实现与未来 PostgreSQL 相同的领域接口和事务语义，不成为长期部署方案。
- 产品切片仍须验证恢复、幂等、事件重放和 revision diff，但不再阻塞首次质量对照。
- ADR-0001 中“先交付完整产品薄切片再评测”的实施顺序由本 ADR 收窄；其 Cloud 根产品、开放 artifact 和专属 Agent 决策继续有效。
