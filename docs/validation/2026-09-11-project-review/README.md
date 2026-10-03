# 项目全面审查 · 2026-09-11

本文保留修复前的审查基线与发现。R1–R5 的后续实现和验证见[修复验收](fixes.md)。

审查基线：`main` / `f7e97b7`。开始时工作区干净。本轮只新增审查记录与复现脚本，没有修改产品实现、真实作品或本机模型配置。

结论：桌面创作闭环已有可用基础，Story / Checker、作品版本、共享 Harness 与 typed IPC 的主边界清楚。但运行结束、启动失败、凭据并发和文件恢复仍有可复现缺陷；现有回归通过不足以证明长篇持续运行可靠。当前应先修可靠性，再推进规模与真实创作验收，没有证据要求推翻自建 Harness 或改换执行框架。

## 1. 已复现缺陷

### R1 · P1：finish 会绕过尚未处理的作者补充要求

- 位置：[loop.ts](../../../packages/runtime/src/harness/loop.ts) 第 464–466 行；[agent.ts](../../../packages/runtime/src/harness/agent.ts) 的 `finish` 校验与 `completeRun`。
- 触发：一次模型请求正在进行时，作者成功发送补充要求；该请求随后返回 `finish`。
- 原因：带 `terminate` 的动作直接结束 loop，返回位置早于 `pullSteering()`；Agent 的完成条件也不检查待处理指令。
- 复现：假模型请求内排入“请分析李牧，而不是皇档”，随后交付关于皇档的旧回答。Run 变为 `completed`；SQLite 中保留 sequence 1，但持久消息事件没有这条补充要求。界面可继续显示“已发送，等待处理”，却没有运行继续消费它；后续 Conversation 历史又只从消息事件读取。
- 影响：系统确认接收了作者指令，却按旧目标结束；作者无法确信最后一条纠正是否生效。
- 修复方向：将完成判定与指令接收顺序统一到执行事务边界。完成前存在未应用指令时应继续处理；与完成同时到达的消息必须明确被当前 Run 接收，或进入可确认的新消息路径。只在 UI 补提示无法解决。
- 验收：覆盖请求进行中收到指令、finish 校验期间收到指令、应用后故障恢复，以及作者看到的接收 / 应用状态和后续历史。

### R2 · P1：checkout journal 恢复可以越过作品目录

- 位置：[checkout-synchronizer.ts](../../../packages/runtime/src/local/checkout-synchronizer.ts) 第 167–191 行；[local-project-service.ts](../../../packages/runtime/src/local/local-project-service.ts) 的 `#recoverCheckoutAfterManagedCommit`。
- 触发：已有待恢复 journal，恢复前某个作品父目录被替换成指向外部目录的 symlink。
- 原因：`fileHash` 只用 `lstat` 检查最终文件，父目录会被正常跟随；`mkdir`、`rename` 和删除也没有校验父路径。恢复先于通常会拒绝 symlink 的作品扫描。
- 复现：先制造 `checkout_write_conflict` 留下真实 journal，再将 `intent/` 换为指向临时外部目录的 symlink；外部同名文件与 before hash 匹配。调用 `recover` 成功，把外部文件从 `before` 写成 `after`。
- 影响：恢复不再受 checkout 边界限制；在匹配旧内容或新增文件的条件下，会改动作品目录外的文件。这里已验证文件越界写入，不涉及远程代码执行结论。
- 修复方向：同步与恢复共用受限路径检查，逐级验证目标和 staging 父目录；拒绝 symlink 越界，并保留可诊断的 journal，不静默丢弃恢复证据。可复用现有受限文件工具的边界规则。
- 验收：父目录 symlink、最终文件 symlink、新增 / 替换 / 删除、冲突后恢复，以及正常恢复的幂等性。

### R3 · P2：多个凭据存储实例会覆盖彼此的更新

- 位置：[json-file-credential-store.ts](../../../packages/runtime/src/model/json-file-credential-store.ts) 第 149–171 行；实例创建见 [desktop main.ts](../../../apps/desktop/src/main.ts) 与 [local-model-settings.ts](../../../packages/runtime/src/model/local-model-settings.ts)。
- 触发：运行中的模型 Gateway 更新凭据时，设置页或另一个 CLI 进程也更新同一个 `auth.json`。
- 原因：队列 `#chain` 只保护当前实例；`modify` 读取整个文件，等待异步回调后再覆盖整份文件。原子 rename 防止半份 JSON，不能防止丢失更新。桌面本身就为 Gateway 和设置服务分别创建 store。
- 复现：A 读取后等待，B 保存 provider-b，A 再保存 provider-a；最终列表只有 provider-a，B 已成功保存的记录消失。全部使用临时文件和假 key。
- 影响：作者刚连接的提供商可能消失；同类竞争也可能用旧快照覆盖更新后的 token 或断开操作。
- 修复方向：按实际文件路径协调跨实例 / 跨进程写入，保存时合并最新内容；同一 provider 的刷新与断开还需要冲突校验。只让设置页串行执行不够。
- 验收：不同 provider 并发保存、刷新与断开竞争、两个进程更新，以及异常退出后的锁恢复。

### R4 · P2：启动物化失败后留下无法正常恢复的 running Run

- 位置：[suiming-harness.ts](../../../packages/runtime/src/harness/suiming-harness.ts) 第 1081–1087 行；[agent.ts](../../../packages/runtime/src/harness/agent.ts) 的 `begin` 位于 `harness.finish` 错误处理之外。
- 触发：Run 已持久化为 running，但打开 session、导出基线或创建 worktree 失败。恢复入口也有先切换状态、再执行初始化 I/O 的同类结构。
- 原因：初始化阶段的异常没有收敛持久状态和 lease；正常执行阶段的错误处理尚未接管。
- 复现：在 `onStarted` 后注入 worktree 创建失败（同路径已有普通文件，抛出 `EEXIST`）。调用已失败，但记录仍为 `running`、保留 lease、没有 Task；立即 `resumeRun` 得到 `run_not_resumable`。
- 影响：桌面可能显示仍在执行，而控制器已移除活动句柄；普通恢复不能继续，需额外处理或重开进程收敛。这是初始化故障注入结果，不是声称正常目录必然失败。
- 修复方向：从领取 owner 到初始化完成纳入统一失败处理，保存失败 / 可恢复原因并释放执行所有权，覆盖 begin 与 resume。
- 验收：session 读取、导出、worktree 物化分别注入故障；失败后界面状态与存储一致，同进程可重试，重启不会重复创建 Run。

## 2. 已知风险的规模验证

### R5 · P2：checkpoint 重复保存累计上下文，持续运行成本增长过快

这是[当前状态](../../current-status.md)已承认的风险，本轮补充了测量，并非新发现的未记录功能。

[loop.ts](../../../packages/runtime/src/harness/loop.ts) 为每次请求保存完整 `context`，所有历史请求又留在 `calls` 中；每个恢复点再次克隆和序列化全部状态。[Harness](../../../packages/runtime/src/harness/suiming-harness.ts) 把每个 checkpoint 保存成 execution object；[SQLite 对象收集](../../../packages/runtime/src/local/sqlite-local-store.ts) 保留全部 execution object 引用，旧 checkpoint 不会因不再是最新恢复点而回收。

用真正的 `runTaskLoop`、假模型和每轮固定 10,000 字节的只读工具返回值测量：

| 模型轮数 | checkpoint 数 | 最后一份 JSON 字节数 | 累计 JSON 字节数 |
| --- | ---: | ---: | ---: |
| 8 | 65 | 551,037 | 15,534,150 |
| 16 | 129 | 1,777,787 | 91,322,771 |
| 32 | 257 | 6,259,597 | 596,753,935 |

32 轮累计约 569 MiB，末尾一份接近 6 MiB。该测量统计 loop checkpoint 的序列化体积，**不是磁盘实测、真实模型耗时或内存峰值**；真实 Harness 还保存外层 Context、读取记录和 evidence。内容寻址不能消除这些整体不同的 checkpoint 之间的重复片段。随着历史长度增长，单份状态约呈二次增长，累计序列化约呈三次增长；模型主动压缩会影响输入长度，但不会删除 `calls` 中已有历史。

建议在现有 execution object 边界内按引用保存不可变消息、Context 和结果，让恢复点只保存推进状态与引用，并定义历史保留 / 回收规则。不需要新增 graph engine 或另一套运行库。验收应测 100 / 300 轮、长工具输出、压缩前后、暂停重开、数据库 / 对象目录大小和主进程响应时间。

## 3. 审查覆盖与结论边界

| 范围 | 本轮核查 | 结论 |
| --- | --- | --- |
| Story / Checker / codec | 包边界、版本入口、格式与确定性验证回归 | 领域与存储分离成立；测试通过不能证明文学质量 |
| Harness | Agent / Worker、交接、finish、暂停恢复、冻结绑定、用量与 checkpoint | 主流程已贯通；R1、R4 和 R5 是后续重点 |
| 本地持久化 | SQLite、对象引用、checkout journal、锁、dirty candidate | R2 已复现；未进行整套断电 / 磁盘损坏测试 |
| 模型与凭据 | Gateway、配置、凭据存储、桌面组装 | R3 已复现；真实 OAuth 刷新尚未验收 |
| 桌面与前端 | IPC 信任边界、主进程生命周期、设置入口及 15 条 Electron 流程 | 功能回归通过；未把自动化成功当成作者体验或无障碍验收 |
| 事件与客户端 | durable event、消息快照、补充要求状态、重载 attach | 常规恢复通过；R1 暴露了已接收消息与终态之间的缺口 |
| SDK / CLI / host / Cloud | 命令契约检查、权限与同步入口、现有回归 | Cloud 真实集成环境未运行；Cloud Harness host 仍是已知冻结项 |
| 设计与质量文档 | 当前目标、架构、Harness 设计、状态与路线图 | 当前文档区分了历史基线与现状；不应把历史 RunEngine 表格当成现行设计 |

本轮是仓库级风险审查与定向复现，没有逐行证明所有代码正确，也没有重新进行完整视觉设计审查、屏幕阅读器测试、真实账号认证或长篇作者盲评。

## 4. 验证记录

- `npm run check`：通过。包含文档、宪法、host 文件、Story 隔离、Biome、全项目类型、Web 类型与 integration contract。只有原有 `host-context.test.ts` 的一条 Biome info，不影响通过。
- `npm test`：297 项中 288 通过、0 失败、9 跳过。
- `npm run test:desktop`：构建成功，15 项通过、0 失败。覆盖连续对话、SIGKILL 后恢复、IPC 编辑 / CAS / Review、模型设置、导航、分屏、差异与输入器。
- `npm audit --json`：注册表报告的已知漏洞数为 0；这不代替本项目逻辑审查。
- 定向故障与并发复现：R1–R4 全部出现预期缺陷；没有请求真实模型或使用真实凭据。
- 规模测量：R5 的三组运行完成。

9 项跳过均依赖一次性真实 PostgreSQL / S3 环境：双进程同步 1 项，API / Worker durable composition 2 项，PostgreSQL migration / project / execution object / events / execution store 5 项，S3 对象存储 1 项。不能把这 9 项描述为通过。

以下复现脚本针对 `f7e97b7` 基线，在该版本的仓库根执行；修复后请运行[修复验收](fixes.md)列出的回归测试：

```sh
node --import tsx docs/validation/2026-09-11-project-review/reproduce.ts
node --import tsx docs/validation/2026-09-11-project-review/checkpoint-scale.ts
```

[缺陷复现脚本](reproduce.ts)只创建临时目录，结束后清理；[规模脚本](checkpoint-scale.ts)统计 JSON 体积，不持久化作品。脚本输出用于观察基线缺陷，不是把错误行为定义为应长期通过的产品测试；修复时应把场景改写为正确行为断言并纳入现有测试目录。

## 5. 产品完成度与建议顺序

可以认定：具备版本化作品、确定性 Checker、自有 Agent 执行和桌面作者交互的可用开发版本。不能认定：稳定长篇生产工具、已通过完整多 provider 认证或可分发的成熟桌面产品。

以下都是已有明确记录的验收缺口，不计入上面的新缺陷：

- 尚无不少于 3 卷 30 Beat 的完整真实作品与作者反馈；2026-09-06 的作者盲读已指出阅读质量问题。结构检查、测试数量和框架选择不能证明写作质量达标。
- 真实 OAuth 登录、刷新、失效恢复仍未验收；界面已接通流程不等于账号能力已被验证。
- 长列表、百万汉字、持续运行存储，以及作者在长篇中的日常阅读 / 修订体验缺少规模证据。
- 当前为开发构建，签名安装包与升级机制未交付；这属于桌面核心产品的后续发行门。
- Reviewer 文件内定位仍依赖引文匹配；evidence-only 版本缺少相应差异展示。这些已有记录的 UX 差距仍然存在。
- Cloud Web、生产 identity / 计费、Cloud 引擎 host 按既定范围冻结，不因本轮审查扩张。

建议顺序：先修 R1–R4 并增加针对性故障回归；随后处理 R5、做长运行规模验收；再围绕真实长篇完成“生成—作者选择—修订—审稿—交付”的证据闭环，同时用真实内容检验工作台的信息密度、阅读与修订效率。保留现有 Story / Harness / IPC 主边界，优先修正已证明的问题。
