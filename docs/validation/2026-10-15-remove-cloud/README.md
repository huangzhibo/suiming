# 删除旧 Cloud 与本地数据保全验收

日期：2026-10-15。决策见 [ADR-0030](../../adr/0030-remove-frozen-cloud.md)。

## 范围

删除 `apps/api`、`packages/cloud-postgres`、`packages/cloud-s3`、Runtime 的 Cloud / sync 实现、HTTP 专属 SDK、七条 `suim cloud` 命令、Cloud 配置解析和 remote binding 接口。对应测试、环境示例、构建引用和依赖一起移除。没有归档包、占位 API 或新的同步实现。

保留本地 Story Language、Checker、git Canon、Session / Task、作品包与目录 codec、CLI、host integrations、桌面 typed IPC。作品格式和执行库 schema v6 没有变化。作品包仍是快照，完整备份仍须包括 `.git` 和 `.suiming`。

## 数据保全

- 在删除前先调整验收：旧配置中带 `[cloud]` 时模型 profile、环境覆盖仍正常，加载不改写配置；删除后该段只被忽略。
- 按旧版建表语句在隔离 SQLite 中放入 remote_bindings 数据，重开后逐行相同；不删表、不升级清空数据库。新库不再创建此表。
- 核对既有执行对象的 `eo_` 内容寻址算法；重开后原 ID 仍能读到相同字节，再保存不会换 ID。
- 复跑完整目录冷备份组合：三次 Canon 提交、逐版快照、未提交候选、辅助文件、长对话、子任务结果、事件、checkpoint 和待处理 inbox 均保留。旧目录移开，在新位置恢复，沿原 Session 继续，只产生一次新模型请求，不重跑旧动作、不擅自提交候选。
- 操作仅针对仓库代码、构建产物和临时 fixture，没有删除真实作品、日常凭据、用户执行库或外部服务数据。

## 检查记录

| 检查 | 结果 |
| --- | --- |
| 删除前的数据边界回归 | 25 / 25 通过 |
| 清理 dist 后 `npm run check` | 通过；包括类型、示例 Checker、生成文件、设计系统和 host 命令对账 |
| `npm test` | 478 / 478 通过，0 skip |
| 最终存储 / codec / 配置 / 错误类别定向复验 | 56 / 56 通过 |
| 生产 CLI 入口 | 帮助不再列 Cloud；`--json cloud status` 返回 `invalid_cli_usage`，明确未知命令 |
| 依赖与构建产物 | lockfile 不再包含 Fastify、Kysely、pg、S3 client；本机 prune 移除 65 个包。已清理旧 dist 后重建，避免旧 Cloud JS 留进发行包 |
| 完整真实 Electron 回归 | 56 / 56 通过，0 skip；约 329 秒 |

全仓测试从此前 510 项减至 478 项，是删除 32 条 Cloud / HTTP / 同步专属测试的结果，其中包括原有 5 条外部集成 skip；不是修复 32 个问题，也不是覆盖率提升。内存作品包测试继续保护开放格式，删除的逐 artifact 版本清单断言仅服务于已移除的 Cloud 存储接口。

桌面覆盖编辑 CAS、正文与独立审稿、版本比较、窗口重载只 attach、主进程 SIGKILL 后原会话续做、跨作品草稿隔离、作品目录移动、认证恢复、键盘连续操作、百万字符编辑和 macOS 原生全屏。通过统一 launch helper 隔离作品、配置、凭据和观测环境。创作与恢复使用受控 provider，验证的是本地机制和真实 Electron 交互；本轮不新增真实模型质量、生产安装或正式签名证据。历史验收记录保留原样，不改写过去的 Cloud 结果。
