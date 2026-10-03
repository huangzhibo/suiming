# ADR-0006：真实创作先于正式评测，模型按任务显式路由

- 状态：Accepted
- 日期：2026-09-02
- 决策者：项目负责人

## 背景

ADR-0005 把与 repository-native 旧实现的 paired eval 放在 Product Runtime 之前，隐含了旧实现可以充当质量标准。但旧仓只完成了有限的真实创作实验，没有全书 StoryText 与 Release 证据，无法定义新产品的验收上限。此时过早做 paired eval，容易围绕历史实现优化，而不是从真实作者目标和失败中建立正确的评价对象。

同时，Agent、Review、Source 阅读和正文生成对推理、长 Context、语言质量、结构输出、成本与延迟的要求不同。终局需要按任务选模型，但首期没有证据支持智能 Router 或完整角色矩阵。

## 决定

1. 完成领域内核后，先用 `pi-ai` 打通多模型 headless 创作链路，以真实 Design 修改验证 Agent、Context、Search、Checker 与 Review。
2. 每类模型任务显式指定稳定的 `modelProfileId`。首期只建立 `agent` 与 `reviewer` 两个可独立配置的 profile；它们可以指向不同模型，也可以共享同一 provider、凭据和模型。
3. model profile 是可版本化的应用配置，映射到实际 pi `Model`、provider-specific 参数、凭据引用和成本边界；它不进入 Story Language，首期不建立数据库本体或自动 Router。
4. Attempt 冻结实际 provider、model、参数和路由配置版本。模型或 provider 切换创建新 Attempt，不作为透明重试；固定 Input View 由 Suiming 重新编译为新的 pi `Context`。
5. 先从真实创作失败、作者选择、修订和 Review 命中情况建立 Cloud 自有 Dataset；样本覆盖足够后，正式消融与 paired blind eval 才用于质量声明和策略晋级。
6. `suiming-story` 只作为一次性迁移来源和可选历史参照，不是标准答案、固定基线或 Product Runtime 的建设门槛。
7. headless 链路可用并暴露实际持久运行需求后即可建设 PostgreSQL durable Run、AG-UI 与最薄 Web，不等待正式 paired eval。Langfuse 始终是可关闭的观测后端，不是模型调用前置条件。

## 后果

- 研发先获得真实创作反馈，再决定 Dataset、评价维度和复杂策略，避免把历史实现的局限固化为目标。
- 不同任务可以选择合适模型，同时保持首期配置简单；Writer、Source Reader 等 profile 在相应任务真正实现时再增加。
- Product Runtime 仍以 headless 创作暴露的真实需求为输入，但不再被尚不可信的早期对照实验阻塞。
- paired blind eval 仍是正式质量声明和策略晋级的重要证据，只是从前置开发门槛调整为 Dataset 成熟后的验证阶段。
