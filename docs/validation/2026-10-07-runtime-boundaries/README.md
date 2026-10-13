# Runtime 边界审查与回归（2026-10-07）

作者要求验证项目审查问题并优化。此次沿用工作区已有的执行对象回收改动，修复四处边界并补充 checkpoint 节点读取缓存；决策见 [ADR-0014](../../adr/0014-runtime-read-write-and-collection-boundaries.md)。只在临时作品和测试 fixture 上注入故障，没有修改真实作品。

## 复现

| 问题 | 修复前的实际结果 | 验收 |
| --- | --- | --- |
| 同一响应先 write 再两个 delegate | 两个子任务开场均读不到先前的写入，turn 结束才有文件 | 串行动作先完成；并行仍成立；结果按原顺序交付 |
| Writer 读取 Source | read 被拒，search 指定 source-material 却返回原文片段 | 文件、搜索、Source 查询共用角色读范围；另测 Source 读不到 Target 与其它 Source |
| 同一文件的并发写入 | 30 次双写试验有 6 次双方都报告成功；16 个同时覆盖的回归里有 13 个报告成功 | 一个成功，其余 file_write_conflict；锁释放后能继续写；重叠 Beat 号段串行，Reader 不能写别人的笔记 |
| GC 过期引用集合 | 扫描期间另一 turn 开始又结束，新 checkpoint 仍在、引用节点却被删 | 两个 SQLite 连接注入同一交错，GC 返回 busy 并保留对象；重扫可完成 |
| 相邻 checkpoint 重复读节点 | 每次 read 都重新加载共享节点 | 缓存范围内共享节点只读一次，解码结果互不影响，读取失败后可重试 |

## 验证范围

本次运行环境为 macOS、Node 26.5.0；项目的目标技术栈仍是 Node 24。本次没有另跑 Node 24。

确定性回归覆盖动作顺序、角色工具读取、委派输出隔离、写入临界区、跨连接 GC 交错、引用丢失时停止删除与维护诊断、checkpoint 缓存。`npm run check` 通过；`npm test` 469 项，464 通过、5 skip（需要独立基础设施的既有集成测试）。最后将 Reader 文件名改为动作 ID 的摘要后，另跑 `agent-source.test.ts` 26 / 26 通过；文档链接与 diff 空白检查通过。随后复查补了「只有 Source 的根候选仍报告 Target 缺失」测试，检查范围改为显式参数；这条测试已通过，最终完整检查结果见下。

没有验证任意外部程序参与的原子 CAS，也没有把这些机制测试视为长篇质量证明。GC 的诊断当前输出到进程日志，独立桌面呈现仍未实现。

## checkpoint 合成规模对照

fixture 为 1,314 个动作，每个结果带 3,500 个重复中文字符并带独立编号；相邻 checkpoint 追加一个动作。对象使用临时目录真实文件读取；先读旧 checkpoint，再测同一个 Archive 实例读取新 checkpoint。对比开工时 HEAD 的实现与本次实现，三轮交替运行，输出均恢复出 1,315 个动作。

| 实现 | 新 checkpoint 节点读取次数 | 三次读取与解码耗时 |
| --- | --- | --- |
| 改前 | 1,398 | 51 / 47 / 68 ms |
| 改后 | 2 | 6 / 7 / 5 ms |

这只衡量共享节点在缓存容量内的相邻读取，不含 SQLite、桌面 IPC、冷启动，也不代表真实作品的 0.7–1 秒详情延迟已经消除。跨 checkpoint 仍需遍历解码，真实长篇规模验收留在路线图。

## Source Reader 真实调用

另在临时样例作品导入一段 80 码点的合成材料，让根 Agent 在同一次回复中派两个 source-reader，分别读 `[0, 33)`、`[33, 80)`。两个 Task 均 completed，产生两份符合指定摘要路径的独立笔记，frontmatter 的 span 分别为 `[0, 33]`、`[33, 80]`，均含材料 SHA；Session 没有 lastFailure。没有整合、审稿、提交或修改真实作品。此项验证输出隔离可用，不评价笔记文学质量。

## 真实模型回归

沿用六项 Harness 回归任务，各跑三次，并行度 6；构建基于 `05a3da1` 加工作区改动，dist 指纹 `798ac130e4e7e380`。首轮 17 / 17 有效样本通过，1 次 `delegate-writer-issues` 因 `model_call_failed: Unable to verify model access right now. Please retry.` 作废：写作已进行，但未提交版本。此项的服务故障与约 $0.0976 估算调用成本保留，不计入通过率；只补跑这一项，结果 1 / 1 通过（260 秒、估算 $0.1448）。合计六类各三个有效样本，18 / 18 通过，另保留一个服务故障作废样本。

全套回归之后另收紧了检查范围的显式传递。最终 dist 指纹 `924ab9469e04a8f8`：`npm run check` 通过；完整 `npm test` 470 项，465 通过、5 skip；`check-issues --trials 1` 通过（37 秒、估算 $0.0369），双 Source Reader 场景再次通过。两次真实回归期间均未重建 dist；没有用后一次构建冒充前一次全套结果。本次未重跑桌面 E2E 或需要 PostgreSQL / S3 / 双进程的五条集成测试。

| 任务 | 有效样本通过 |
| --- | --- |
| discuss | 3 / 3 |
| design-edit | 3 / 3 |
| check-issues | 3 / 3 |
| write-text | 3 / 3 |
| delegate-writer-issues | 3 / 3（含补跑） |
| review | 3 / 3 |

## 提交前复验（2026-10-13）

清理工作区待提交改动时再次运行 `npm run check` 与 `npm test`：检查通过，480 项测试中 475 通过、5 项依赖外部基础设施的既有集成测试跳过。本次未新增实现，也未重跑真实模型；上文的真实调用数据仍只对应当时记录的构建。此前同一工作区已完成最新期待界面的完整桌面回归 32 / 32，见[期待预览走查](../2026-10-13-contract-preview/README.md)。
