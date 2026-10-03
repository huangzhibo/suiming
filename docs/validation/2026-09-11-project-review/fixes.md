# 审查修复验收 · 2026-09-11

对应[审查报告](README.md)的 R1–R5。本轮修改 Runtime、共享命令类型和相关回归，不改真实作品或本机账号配置。

## 修复结果

| 问题 | 实现 | 关键验收 |
| --- | --- | --- |
| R1：完成前遗漏补充要求 | 终止 checkpoint 与指令序号在同一 SQLite 写事务确认；有新指令则继续 loop；完成窗口关闭后的消息明确拒绝 | 请求期间及最终 checkpoint 写入前的竞争；关闭后的拒绝；暂停后原 Attempt 继续；消息发布故障恢复 |
| R2：恢复沿父目录软链接越界 | 同步、恢复与文件工具复用逐级路径检查，目标 / staging / journal 都拒绝根内 symlink | 新增、覆盖、删除三种 journal 恢复均拒绝越界；外部文件不变；恢复正常目录后可继续，重复恢复幂等 |
| R3：凭据并发覆盖 | proper-lockfile 4.1.2 协调实际路径的跨进程写入；远端刷新在锁外，保存时重新读取并校验同一 provider | 两个进程保存不同 provider 后都保留；断开阻止迟到刷新写回；过期锁回收；0600 权限回归 |
| R4：初始化失败残留 running | begin / resume 的初始化统一收尾，记录失败并释放 lease；清理失败也不能跳过状态收尾 | session 读取、worktree 物化、恢复时导出失败；同进程原 Run 重试；恢复前候选不丢失 |
| R5：checkpoint 反复复制历史 | 在现有 execution object 中共享不可变片段、按块保存数组；仅保留当前恢复所需的请求 Context，原始历史 Context 留在原对象中 | 完整往返、缺失片段报错、可变列表追加、32 轮体积门、100 / 300 轮测量，以及原有暂停 / 交接 / 换模型回归 |

新存储编码不增加执行真源，不删除历史恢复点、作品版本或 evidence。历史内联 checkpoint 继续可读；新的恢复点统一采用片段引用。对象保留规则仍是保留执行历史，本轮通过共享内容控制重复量，没有偷偷引入历史删除。

## 规模结果与限制

假模型每轮执行一次只读工具，返回不同的约 10 KB 文本。下表统计 archive 实际写入对象端口的去重字节数，包含 checkpoint 根对象和共享片段；恢复重新解码全部消息。模型、网络及物理磁盘不进入这组时间统计。

| 轮数 | checkpoint 数 | 对象字节数 | 编码与循环耗时 | 恢复耗时 | 恢复消息数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 | 257 | 1,410,892 | 237 ms | 7 ms | 65 |
| 100 | 801 | 4,589,047 | 2,108 ms | 14 ms | 201 |
| 300 | 2,401 | 15,781,820 | 19,465 ms | 47 ms | 601 |

同为 32 轮，修复前累计序列化约 569 MiB；修复后 checkpoint 对象合计约 1.35 MiB。前者是旧 loop 的累计 JSON，后者是新 archive 的对象总量，二者用于评估重复内容的减少，不能据此声称整次 Run 的磁盘用量下降相同比例。

另外运行了真正的 `LocalProjectService` / SQLite / 对象目录切片：32 轮、257 个 checkpoint，checkpoint 对象写入 1,419,118 字节，1,421 ms；完整恢复 65 条消息，27 ms。关闭数据库后，临时作品 `.suiming` 下普通文件总计 **2,406,254 字节**，包含样例初始版本、SQLite 元数据和 checkpoint 对象。这不是完整 Harness 长篇运行：没有把每轮真实 Context capture、Review 和创作 evidence 加入这项磁盘测量。

随机 id、时间戳及机器负载会造成小幅差异。300 轮编码仍有累计处理开销，本轮没有声称其为常数耗时；整次长篇、长期历史、UI 响应和真实模型质量仍按路线图验收。

## 自动化验证

回归覆盖分布在现有测试目录：

- [Agent](../../../packages/runtime/test/agent.test.ts)：结束竞争、终止后暂停、初始化与恢复失败。
- [路径恢复](../../../packages/runtime/test/checkout-recovery-boundary.test.ts)：三种变更及幂等恢复。
- [凭据并发](../../../packages/runtime/test/credential-concurrency.test.ts)：真实双进程、断开竞争、过期锁。
- [checkpoint](../../../packages/runtime/test/checkpoint-archive.test.ts)：编码往返、可变列表和规模门。
- [执行恢复](../../../packages/runtime/test/harness-recovery.test.ts)：消息补发与既有动作 / 子结果恢复。

执行命令：

```sh
npm run check
npm test
npm run test:desktop
node --import tsx docs/validation/2026-09-11-project-review/checkpoint-scale-fixed.ts
node --import tsx docs/validation/2026-09-11-project-review/checkpoint-scale-fixed.ts --disk
```

最终结果：

- `npm run check` 通过，包括全项目及测试类型检查；仅保留原有的一条 Biome info。
- `npm test` 共 312 项：**303 通过、0 失败、9 跳过**。相比审查基线新增 15 项针对性回归。
- 桌面 15 条流程均已验证：最后一次全套运行 14 条通过，比较流程暴露了旧断言对 CodeMirror 虚拟 DOM 的依赖；修正断言后该流程单独复跑通过。没有改动产品 UI。
- 比较测试现在检查真实已提交文件，并用正常编辑快捷键定位末段后检查呈现，不再假定全文始终存在于 DOM，也不假定已提交的干净文档仍保留草稿记录。
- 32 / 100 / 300 轮共享对象测量，以及真实 SQLite 的 32 轮切片完成；脚本使用临时数据并清理目录。

真实 PostgreSQL / S3 条件测试仍需外部临时服务，9 项跳过不能视作通过。未进行真实 OAuth 登录或真实小说生成。
