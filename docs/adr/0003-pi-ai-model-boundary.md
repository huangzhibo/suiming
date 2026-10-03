# 0003：采用 pi-ai 作为模型调用边界

- 状态：Amended。仍有效：Model Gateway 直接使用 pi-ai（1，现为 0.99.2）、Suiming 拥有 loop、工具、Context、持久化与重试决策（3）、新能力先走 pi 的 provider-specific 参数（5）、补充节里「pi 作为基础设施的部分用到底，作为真源的部分一律不用」的判断标准。已被取代：2 的「不引入 pi-agent-core」曾被 [ADR-0009](0009-redesign-after-code-audit.md) 决定 10 推翻，[ADR-0012](0012-own-suiming-harness.md) 改为参考 pi 逻辑自建 Harness 后重新成立；4 的「每次 Attempt」改为按 turn 冻结绑定（[Harness 设计](../harness-design.md)第 2 节）；补充节列出的 pi-agent-core、pi-tui、steering queue、Attempt、ContextSnapshot 均已删除
- 日期：2026-09-01

## 背景

Suiming Cloud 需要在同一 Runtime 中调用 OpenAI、Anthropic、Google、xAI、DeepSeek、MiniMax、Moonshot、Qwen、ZAI 及兼容 provider，同时保留 reasoning、prompt cache、严格 tool schema、streaming 和原始调用证据。为每个 provider 直接维护官方 SDK adapter 会重复实现消息转换、流事件、工具、用量、取消和兼容差异；采用完整 Agent framework 又会与专属 Agent、Context、Task DAG 和持久运行模型重叠。

`pi-ai` 提供 TypeBox 友好的低层多 provider API，并允许按 wire API 使用 provider-specific 参数。其能力边界比完整 Agent framework 更接近 Suiming 所需的模型传输层。

## 决定

1. Model Gateway 直接使用 `pi-ai`，不再复制一套 Suiming `ModelPort`、消息、工具、事件或 capability 协议。
2. 只采用 `pi-ai`；不引入 `pi-agent-core`，不把 pi Context、模型目录、凭据存储或自动跨 provider handoff 作为 Suiming 真源。
3. Suiming 继续拥有模型路由、Agent Loop、Task DAG、工具执行、Context Compiler、重试决策、持久化、权限、成本策略和 trace 语义。
4. 每次 Attempt 从固定 Input View 构造临时 pi Context；provider-specific 参数与原始响应证据必须可追溯。
5. 先用 pi 的 provider-specific API 与 custom provider 表达新能力；只有 paired capability test 证明仍有关键语义缺口时，才在 Model Gateway 内局部接入官方 SDK。两个完整实现确需长期互换之前不抽取新接口。

## 后果

- 首期无需重复建设多 provider 协议层，尤其可直接覆盖中国模型与 OpenAI-compatible endpoint。
- Suiming 的领域和运行语义不依赖 pi；依赖集中在 Model Gateway 模块，必要时可以升级、替换或局部绕过。
- 不能把 `streamSimple` 的统一选项或跨 provider handoff 当成高杠杆任务的默认路径。
- provider 新能力必须通过固定输入验证其参数、流事件、缓存、结构输出和可重放性，不能仅凭接口编译通过宣称支持。

## 2026-09-05 补充：复用 pi 的判断标准与不采用清单

标准不是"尽量复用"，而是按层判断：pi 作为基础设施的部分用到底，pi 作为真源的部分一律不用，因为它会与 Story Artifact、Run / Task / Attempt、ContextSnapshot 形成第二套真源。

已复用：pi-ai 的多 provider 调用、流式、`builtinModels` 目录与 usage / cost；pi-agent-core 的 loop、工具执行、abort；pi 原生 read / edit / write 工具套在受限执行环境内；pi-tui 渲染；pi-telemetry 的 span 契约。应继续复用：pi-agent-core 的 steering queue（P 步接成 `run steer`），pi-ai 的 `usage.cost` / `calculateCost`（B 步的 Run 级金额上限不自建价格表）。

pi-mono 2026-08 新增 `pi-protocol`、`pi-client`、`pi-server`、`session-backends`、`pi-evals`，连同 `pi-coding-agent` 一起评估后不采用：

| 组件 | 不采用的原因 |
| --- | --- |
| `pi-coding-agent` 作为宿主（Suiming 做成它的 extension） | pi 的 session 会成为 transcript 真源，bash 工具天然在场，compaction 会改模型看到的 Context；worktree、Checker、ContextSnapshot 三条纪律都得靠 hook 压回去。与 ADR-0007 拒绝 fork coding agent、ADR-0008 拒绝 Obsidian 插件同一理由：把产品绑在别人的平台上 |
| `pi-protocol` / `pi-client` / `pi-server` | 它是"远程 pi session"协议，session snapshot 是权威，词汇是 session、model、thinking level，没有 Run、revision、Task；用于 Cloud SSE 或桌面 IPC 会违反不变量 10 的"RunEvent 是唯一事件契约"，且标注 experimental |
| `pi-coding-agent` 的 auth-storage / model-registry / settings | Suiming 的 profile 按任务选模型、区分 interactive / automation 凭据、Attempt 冻结路由版本，pi 的用户级目录没有这些；配置简化只换 TOML 库 |
| compaction | 每个 Task 的 loop 有 turn 上限；长上下文靠 Frame 与 ContextSnapshot，这是 C 题库与验证门依赖的可引用证据，compaction 会抹掉"模型到底看了什么" |
| `pi-evals` | 对象是 pi 的 AgentSession；M6 的 paired blind eval 对象是 Story Artifact 与作者选择，可借 vitest-evals 的 harness 模式，不用 pi-evals 本身 |

pi 是单维护者、迭代快。ADR-0009 已接受这个风险，前提是引擎边界让 pi 可替换：版本钉死（当前 0.84.x），升级当成显式任务，不跟着 pi 的新包扩大耦合面。

另一条踩坑得来的边界：Suiming 把 model profile 的 options 直接透传给 pi-ai 的 API 级 `Models.stream`，键名跟 wire API 走（openai-completions 的思考档位是 `reasoningEffort`，不是 `streamSimple` 的 `reasoning`）；写错键名会被静默忽略。B 步给 options 做 schema 校验。
