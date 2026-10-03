# ADR-0001：Cloud 根产品与专属 Suiming Agent

- 状态：Amended；实施顺序由 [ADR-0005](0005-quality-before-product-runtime.md) 和 [ADR-0006](0006-real-work-before-formal-eval.md) 补充，产品形态由 [ADR-0007](0007-local-tui-and-explicit-cloud-sync.md) 扩展为专属本地 TUI、host coding-agent integrations 与 Cloud Web；Cloud Web 的实施时机由 [ADR-0008](0008-creative-loop-before-product-surface.md) 推迟到创作闭环验证之后
- 日期：2026-09-01
- 决策者：项目负责人

## 背景

`suiming-story` 证明了通用 coding agent 可以围绕 repository-native Story Artifact 完成故事抽取、设计、正文、审稿与发布，也暴露出根本边界：默认行为面向代码而非读者体验；阶段 Context、模型路由、长任务恢复和 trace 受外部 runtime 限制；人类难以审阅完整人物轨迹、长期承诺和语义 diff。

若 Cloud 继续依赖公开 Core release、包装旧 CLI 或只给文件仓增加 Web 外壳，它就无法围绕 Agent、Artifact、Context 和 Eval 做必要的原子重构，也无法验证专属系统是否真正达到 SOTA。

## 决定

1. 新 `suiming` 仓成为产品和代码根，Cloud 是默认产品形态。
2. 在线服务以版本化 Story Artifact 为唯一可写权威，并提供可无损交换的开放作品包。
3. 单一 Suiming Agent 负责作品决策；复杂任务使用有限动态 Task DAG；Worker task-local、无持久记忆且不能直接提交 Canon。
4. 第一阶段采用模块化单体。Web、Cloud CLI、SDK 与未来 MCP 共享 Domain API；内部 Agent 直接调用领域模块。
5. `suiming-story` 只作为一次性迁移来源、paired eval 基线和可能的 Community 发行。Cloud 不依赖其发布包，也不包装其 CLI。
6. 先交付架构完整、产品薄的垂直切片，再用真实长篇 paired blind eval 决定 Graph、语义检索、多模型路由和专用模型等复杂度。

## 后果

- 新仓可以同步演进 Story Core、Artifact、Agent、Context 和 Eval，不受旧产品兼容约束。
- 项目需要实现版本化 Artifact Store、Model Gateway、Run / Task / Attempt、Web 与 Cloud CLI。
- 开放源码与开放作品格式分开决策；即使 Cloud 闭源，作品仍必须可读、可导出、可验证和可迁移。
- 旧仓不会自动获得 Cloud 的新能力。未来 Community 维护必须证明实际用户价值，不能成为默认义务。
- 在新版通过 paired eval 前，旧版仍是重要质量基线，不能因为新架构更现代就宣称 SOTA。
