# ADR-0007：本地产品入口与显式 Cloud 同步

- 状态：Amended。仍有效：host integrations 是一等本地入口（1、8）、Runtime 同进程且 deployment-neutral（3、4）、checkout 是 dirty candidate、`suim commit` 扫 diff 过 Checker（5 的后半）、唯一目录形态与 codec（6）、`suim` CLI 与 machine contract（7）、显式 Cloud 同步与包外 remote binding（9–11）。已被取代：专属 TUI（1、2 与 7 中的无子命令进 TUI）先由 [ADR-0008](0008-creative-loop-before-product-surface.md) 收窄、2026-09-13 删除，作者界面改为 Electron 桌面（ADR-0008、[ADR-0011](0011-desktop-product-and-autonomous-runtime.md)）；5 中 SQLite 保存作品版本改为 git 保存 Canon、SQLite 只存执行数据（[ADR-0010](0010-git-as-canon-storage-engine.md)）；3 中「AG-UI 只作远程协议」由 ADR-0011 改为所有界面共用 AG-UI 事件；7 中的 `run` 现为 `session send`
- 日期：2026-09-02

## 背景

ADR-0001 把 Cloud 设为默认产品形态，ADR-0004 又让所有交互客户端直接使用 AG-UI。这个边界适合 Web 和跨网络的长运行，却不适合终端本地模式：成熟 coding agent 的 TUI 通常与本地 Agent Runtime 同进程，直接使用文件、`rg`、终端输入和本地凭据；强制经过 HTTP / SSE / AG-UI 会增加尚未被用户价值证明的适配、恢复和调试成本。

同时，开放 Story Artifact 天然允许 Codex、Claude Code、Grok 等 host coding agent 修改本地作品；它们应是正式兼容的本地入口，而不只是“碰巧能编辑文件”。如果本地 TUI 只是 Cloud 薄客户端，这部分能力会继续依赖旧 repository-native 产品，或形成 Cloud 之外没有版本事务的非正式工作流。另一方面，把任一 host agent fork 成故事产品会继承其 session、通用工具和私有状态，也会形成多套 Suiming Runtime。

本地作品提交 Cloud 还需要明确区分 artifact exchange 与 deployment sync。开放作品包不能携带 Cloud identity，但用户仍需要在本地和 Cloud 之间安全地 import、push 和 pull。

## 决定

1. 专属 `apps/tui` 与 Codex / Claude Code / Grok integrations 都是一等本地产品入口，并与 Cloud Web 留在同一 `suiming` monorepo。它们默认不要求 Cloud account 或 Cloud Runtime；远程连接 Cloud 是可选能力。
2. TUI 直接依赖 `@earendil-works/pi-tui`，参考 `pi-coding-agent` 的成熟交互与组件组织，但不 fork 整体，不依赖未公开内部模块，也不让 `pi-agent-core` 拥有 Suiming Agent Loop、Context、工具或持久状态。
3. 本地 TUI 与 Suiming Runtime 同进程，通过 TypeScript application service 和 subscription 交互，不启动 localhost server，也不强制使用 AG-UI。AG-UI 只作为 Web / remote TUI 与 Cloud Agent 的远程协议；Cloud `RunEvent` 继续持久化原生 `BaseEvent` 信封。
4. 当前 `packages/server` 在实现 TUI 前重命名为 deployment-neutral 的 `packages/runtime`。Local 与 Cloud 共享 Story、Artifact、Workspace、Agent、Capability、Checker、Review 和 Model Gateway 实现，只替换 store、任务领取与传输 adapter。
5. Local Store 使用 SQLite 与 `.suiming` 下的 content-addressed object directory。Open Story Directory 是可编辑 checkout；人类和 host agent 可以直接修改文件，修改先形成 dirty candidate。commit 扫描实际 diff、执行 check，并由 Runtime 内部构造基于当前 Local ProjectRevision 的 ChangeSet，成功后才成为本地 Canon。
6. 经开发期一次性整理的 repository-native 作品、TUI 新建作品、Cloud checkout 与 Open Story Package 共用唯一 Story Language 逻辑路径和 story package codec。repository-native 是继续支持的目录形态，不等于旧 Runtime；Git、AGENTS.md、Skills 等辅助文件可以共存但不进入 artifact snapshot。Runtime 只实现当前格式，不提供 legacy codec / importer。
7. `apps/cli` 拥有重写后的 `suim` executable、版本化 `--json` schema 和 exit code；无子命令进入 `apps/tui`，`run` 启动 headless Agent，其余 commands 为 host agent 提供 Project、Context / Search、Source / Design freeze、Review / Release 和 Cloud sync 能力。CLI 名称延续不代表旧命令树、参数或输出兼容。CLI 与 TUI 随同一本地发行物发布并调用同一 Runtime；TUI 文本不是机器协议。
8. Codex / Claude Code / Grok integrations 只包含 host-native instructions / Skills 与 command adapter，不复制 Runtime。host 可以直接修改 Open Story Directory，不需要构造 ChangeSet；文件先成为 dirty candidate，`suim commit` 才扫描 diff、运行 Checker，并由 Runtime 内部生成 ChangeSet。host-native 模式使用 host 的模型与凭据；显式 `suim run` 才进入 Suiming Agent 与 model profile。
9. Local 与 Cloud Project 具有独立 revision identity，不后台双写。Cloud `checkout` 从明确 revision 创建标准 Local Project；`import` 创建独立 Cloud Project；`link` 只在内容证据匹配时建立包外 remote binding；`push` / `pull` 基于共同 Cloud baseRevision 显式移动已提交内容；`status` 展示 local、remote 与 dirty checkout 的差异；`unlink` 不删除任一侧数据。
10. 同步通过 Cloud SDK 与 Domain API，不通过 AG-UI。无交叉影响的变化可以重新验证后 rebase；同一 artifact 冲突、引用失效或无法确定的语义冲突必须停止，不使用 last-write-wins。
11. Remote binding 保存在 `.suiming`，不进入 Story Language 或开放作品包。凭据保存在环境变量、用户级配置或 OS credential store；本地 SQLite、运行缓存、未选择的 trace 和 secret 不上传。

## 验证门

- 无 Cloud account 时可以创建或导入本地作品、调用自选模型、检索、检查、提交、查看 diff 并恢复中断的本地 Run；
- TUI 同进程 streaming、tool / activity、interrupt、中文输入和 terminal restore 在真实终端可用；
- project-scoped `rg` 与文件读取不经过网络，通用写工具不能绕过 ChangeSet 修改 Canon；
- 三类 host integration 都能安装并读取同一 Story Language；host 修改多个 artifact 后，dirty 状态、Checker 失败、Runtime 内部生成的原子 ChangeSet、commit 和 TUI 刷新行为可重放；
- 旧 repository-native fixture、TUI 新建目录、作品包解包目录和 Cloud checkout 通过同一 codec / Checker contract test；
- `reference/materials/**`、`reference/research/**` 与其它保留路径均能无损 round-trip，未知保留路径会失败而非被忽略；
- 当前 Runtime 和测试不依赖 `.suim` 或旧 schema；需要保留的开发 fixture 必须直接重写为当前格式；
- 同一开放作品包可以一次性导入 Cloud，且部署 identity、凭据和本地运行数据不会泄漏；
- link / push / pull 能处理 fast-forward、无交叉 rebase、dirty checkout 和同 artifact conflict，不静默丢失任一侧修改；
- remote TUI 使用 AG-UI 时与 Web 通过同一兼容测试，本地模式不依赖该测试通过才能工作。

## 后果

- Suiming 从单一 Cloud 作者端扩展为专属 Local TUI、Codex / Claude Code / Grok integrations 与 Cloud Web；Cloud 仍是托管与跨设备产品，但不再是本地创作的前置条件。
- AG-UI 的适用范围更清楚：它解决远程 Agent 交互，不承担本地函数调用、作品同步或 Story Canon。
- 本地 ProjectRevision 与 Cloud ProjectRevision 不共享 identity；显式 remote binding 和共同内容证据承担同步基线。
- 项目需要维护 SQLite / local object store 与 PostgreSQL / S3 两组基础设施 adapter，但不维护两套领域行为。
- host coding agent 获得正式、开放、可验证的本地产品入口；adapter 与重写后的 `suim --json` command contract 属于本仓，旧 `suiming-story` CLI 实现不会因此重新成为依赖。
- repository-native 从“旧实现标签”回归为当前正式支持的开放目录形态；只维护一个当前 codec，不承担开发期旧格式兼容成本。

## 参考

- [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui)
- [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [ADR-0001](0001-cloud-root-and-suiming-agent.md)
- [ADR-0004](0004-ag-ui-interaction-boundary.md)
