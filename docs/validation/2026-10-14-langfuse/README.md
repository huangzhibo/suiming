# Langfuse 结果、关联与内容采集验收（2026-10-14）

## 范围与修复前证据

本轮检查发现：失败 turn 被业务层捕获后返回，OTEL 根 observation 仍是 DEFAULT，只记录 `idle`；停止也一样。实际注入 `turn_failed`，Langfuse 读回 trace `bda5bf4e562e5c6619a89b124dc1bef2` 为 DEFAULT，状态信息为空。新增回归在修复前失败，随后再补实现。

上一轮真实创作的 115 条 observation、45 次已确认 generation 仍可查。它们全部带 session，但输入输出为空，缺少环境、入口、构建和 generation 的本地调用编号。11 次错误调用没有首 token 时间符合未产生内容的事实，不当作缺陷；强杀留下的孤立子 span 也不补造为完整执行。

实现提交 `f55669a`。实现与边界见 [ADR-0024](../../adr/0024-observability-results-and-content.md)。没有升级依赖、改变模型输入或增加持久执行状态。

## 实际后台读回

本机健康检查 OK，版本 4.24.0；使用 `langfuse-cli api observations list` 查询 v2 observations。合成场景均使用临时样例作品及 faux provider；只把[最终核对摘要](measurements.json)保存到仓库，不提交完整内容 payload。

| 采集 | 场景 | 读回条数 | 根级别 | Trace ID |
| --- | --- | ---: | --- | --- |
| 关闭 | 正常结束、读取与子审稿 | 10 | DEFAULT | `eae9cf70fa9c0c698671af31255d50d7` |
| 关闭 | 失败 | 1 | ERROR | `0c24416447a1d7b7fbcdc681d319fdb3` |
| 关闭 | 主动停止 | 1 | WARNING | `64ff7f768218db2d4e4bf3656c25973f` |
| 开启 | 正常结束、读取与子审稿 | 10 | DEFAULT | `f1668fa5d7d7114da6252d7ff3a38b4d` |
| 开启 | 失败 | 1 | ERROR | `7698f33ca05be1733ff540523e111dc2` |
| 开启 | 主动停止 | 1 | WARNING | `a7f14e99e7bb0ef0658b005bc96de89e` |

每组正常场景包含 4 次模型调用、工具、子 Agent、turn，以及另一个内容边界探针 trace。逐条核对：

- outcome 为 completed / failed / stopped；失败保留 `turn_failed` 分类而没有原始异常；停止不记业务故障。
- 环境 validation、来源 audit、release `langfuse-audit-20261014` 落到全部 observation；session 不缺失。
- 工具的 `model_call_id` 均能找到对应 generation；根与子 Agent 内的调用分别归属正确父级。局部动作与 outcome 不向后继承。
- 关闭时所有 input / output 均为空；开启时模型输入输出、工具内容和根输入输出均可读。
- 人造 Bearer、已知环境凭据、结构化 apiKey / password 未出现在读回内容；长字段有 `truncated` 与过滤后字节数，不伪装完整。

复跑合成证据：

```sh
node --env-file-if-exists=.env --import tsx docs/validation/2026-10-14-langfuse/probe.mts
npx langfuse-cli api observations list --session-id <上一步输出的 sessionId> --fields core,basic,metadata,io,model,usage,trace_context --json
```

CLI 查询需要 `LANGFUSE_HOST` 指向同一个显式配置的 `LANGFUSE_BASE_URL`，并在环境中提供项目凭据。脚本输出新 session ID，历史表中的 ID 不会复用。脚本主动产生合成内容观测，不应作为只读健康检查。

## 自动回归与真实调用

- 全仓 `npm run check` 通过。
- `npm test`：488 项，483 通过，5 项外部集成按原环境门跳过；没有新增 skip。
- Electron OTLP 2/2：内容开启 / 关闭分别真实启动桌面，经 IPC 完成一轮，正常退出后核对最后一批 span、v4 header、共同 session、来源、release、结果及内容开关；renderer 错误为零。本轮没有界面样式变化，不重复此前整套视觉走查。
- 真实模型 smoke `discuss` 1/1，通过「没有改动作品、没有提交、有回答」三项核对。GPT-6.1 Sol 调用一次，Langfuse 读回 2 条 observation：trace `40cf443f44243476c85d1b658ba77c0e`，来源 cli，结果 completed；generation 的持久调用编号、父级与 session 一致，输入输出存在，输入 23,943 bytes、未截断。5685 input + 900 output = 6585 token，首个内容增量 11.025 秒，目录估算费用 $0.02037，与回归记录一致。这只是短讨论的实际调用验证，不是长篇质量或长时可靠性证明。

真实 smoke 执行时构建基于 `dbcdcdb` 加本轮未提交修改，dist 指纹 `43bf475516edbff8`；运行期间未重建。随后仅收紧停止观测的字段，最终源码再次通过全仓测试、Electron 观测与合成后台读回。

## 仍然存在的边界

这是可丢失的观测，不是恢复真源。强杀、后端不可达或退出超时仍可能丢 span；没有伪造成功导出保证。启动日志报告启用及内容状态，半套凭据或无效采集值报告固定诊断，后端失败 / 恢复继续用固定诊断码；桌面尚无观测管理界面，Finder 启动不自动读取开发仓库的 `.env`。

内容采集保持默认关闭，未修改作者的 `.env` 或日常启动设置。开启时过滤不等于匿名化，未知格式的秘密和作品原文仍可能被发送；图片与 provider 签名被省略，大内容有界截断，因此不能宣称每次都保留了完整模型上下文。版本默认应用包版本，比较开发代码需显式设置构建 release。

迭代中额外修正：停止的根观测只记 `stop_reason=interrupted`，不带 `failure_code`；否则合成停止的异常包装可能把它标成 `turn_failed`，与非故障语义矛盾。正常失败仍保留稳定失败码。
