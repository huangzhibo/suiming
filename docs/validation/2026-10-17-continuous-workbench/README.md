# 对话驱动连续创作与观测对账

## 范围与方式

两部从仓库公共样例生成的隔离作品，各有两份短正文和一份普通备忘文件；作品、执行库、应用状态、配置均隔离。真实模型沿当前 profile 调用，认证复用已有加锁凭据入口，不复制轮换令牌。没有接触日常作品，也没有新增保存、恢复、导航或执行机制。

[probe.mts](probe.mts) 经正式测试启动器运行真实 Electron，走作者实际使用的编辑器、发送、停止、作品切换和退出入口。系统文件选择框只替换返回目录，作品切换逻辑仍走生产入口。界面查询用于等待和断言，不替代界面操作。

```sh
node --env-file-if-exists=.env --import tsx docs/validation/2026-10-17-continuous-workbench/probe.mts
node --env-file-if-exists=.env --import tsx docs/validation/2026-10-17-continuous-workbench/reconcile.mts
```

需已有有效模型 profile 和 Langfuse 配置。先完成构建，真实运行期间不构建，不与其他桌面测试并行。内容采集关闭，透明转发只记录批次关联元数据，首批额外延迟 1800ms；应用关闭后再写批次记录，包含退出时 flush 的观测。失败保留隔离副本便于核查，成功自动清理。

## 验收场景

| 场景 | 核对内容 |
| --- | --- |
| 两份正文都有作者未保存编辑 | 一句话要求 Agent 修订两节并展示差异，指定原句逐字保留；不手动逐文件保存 |
| 第三份草稿仍在推敲 | 模型工作期间继续编辑备忘和输入下一条消息；未触及文件不落盘，也不进入 Canon |
| 展示结果 | 第一轮打开与 Canon 的差异；继续输入、焦点不丢；本轮未提交，Canon 不动 |
| 真正开始输出后停止 | 观察真实 TEXT_MESSAGE_CONTENT 再点停止，回到 idle；后续沿原 Session 继续，不重跑停止的讨论 |
| 跨作品同路径 | 乙作品有同名正文、独立草稿和对话；Agent 只查看作者草稿，不保存；返回甲后分别保留 |
| 显式退出并重新启动 | 原会话、未发送消息、未保存草稿、活动编辑器和光标恢复；继续输入与撤销有效 |
| 继续创作并提交 | 重新编辑甲第一节，模型保留新句、第二节不变；Checker 后只推进一次 Canon，再定位原文 |
| 再次返回乙 | 独立草稿和输入仍在，乙 Canon 没有被甲的提交推进 |

## 走查发现与迭代

首轮截图发现：Agent 自动定位正文时，虽然没有抢走对话框焦点，却弹出了“说明要怎么改”的选段操作条，增加了与当前意图无关的入口。

修复沿用 CodeMirror transaction annotation 和现有 `reveal` 状态：自动定位仍高亮、仍回传选区上下文；作者主动重新选段后才显示就地修改操作。没有新增持久状态或第二套选区。新增 Electron 用例先在旧实现失败，再在修复后通过；普通作者选段继续覆盖。

- [修复前定位截图](first-resumed-location.png)
- [最终差异展示](revised-diff.png)
- [最终定位与继续输入](resumed-location.png)

首轮探针自身遇到两处等待问题：页面尚未渲染时判断编辑按钮、作品切换期间轮询旧 workspace。修正等待后沿保留副本完成验证，没有重置作品与会话。首轮报告 [first-measurements.json](first-measurements.json) 的 `probeResumed: true`，总耗时只覆盖续跑段，不能当作完整耗时。

首轮 Langfuse 已收到全部 20 次模型调用、25 次工具和 4 个 turn，另含 Checker；但失败时探针先写记录再关应用，少记退出 flush 的 4 条乙作品观测。因此 [first-observations-summary.json](first-observations-summary.json) 的整体对账为 false，不能把它当成产品导出丢失。探针已改为关闭后记录；最终重新从空隔离作品完整跑一遍，不依赖续跑结果。

## 最终结果

最终从空隔离作品完整运行约 126 秒（不是首轮续跑耗时），所有场景断言通过，renderer 错误与导出失败诊断均为空。

| 项目 | 甲作品 | 乙作品 | 合计 |
| --- | --- | --- | --- |
| turn | 3（含实际停止的一轮） | 1 | 4 |
| 模型调用 | 16 | 3 | 19 |
| 工具调用 | 21 | 2 | 23 |
| Langfuse observations | 41 | 6 | 47（另含 1 条 Checker） |
| token 总量（含缓存读取） | 259748 | 19648 | 279396 |

本地执行用量与 Langfuse input / output / cache-read / total 一致，span ID 没有缺失或额外项，父子关联与 trace ID 对齐。14 个导出批次全部 HTTP 200，首批实际耗时 2116ms，覆盖了旧 1500ms 超时；停止的模型调用标为 ERROR、所在 turn 为 WARNING / stopped，属于本次预期中断，不误算正常完成。

第一轮两文件修订和展示约 71.5 秒；点击停止到 idle 为 138ms。这些是单次真实样本，不是性能分位数或服务承诺。

- 全仓 `npm run check` 通过；单测 498 / 498，0 skip。
- 最终定向 Electron 18 / 18，0 skip：Agent 界面 5、按需编辑同步 5、连续恢复 2、多草稿恢复 3、遥测 2、普通作者选段 1。未把这次定向测试写成完整桌面套件复跑。
- 新选段回归在修改前失败、修改后通过；最终截图确认自动定位只高亮，对话草稿仍在，没有多余的选段操作栏。

原始脱敏数值见 [measurements.json](measurements.json)，三方对账见 [observations-summary.json](observations-summary.json)。旧观测缺失、短超时复现与诊断修复单独见 [telemetry.md](telemetry.md)。

## 证据边界

这是少量正文、两部作品的真实连续操作，不代表完整长篇质量、数小时运行、真实服务商撤销认证或所有故障组合。停止的是实际流式请求；多文件并发、保存失败、迟到回执等确定时序仍由已有故障注入测试补足。当前历史缺失无法唯一归因，不以本次成功回填或抹掉旧问题。
