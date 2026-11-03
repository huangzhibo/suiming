# ADR-0040：Electron 安全升级以完整依赖和实际安装包验收

- 日期：2026-11-03
- 状态：Accepted

## 背景

Electron 的 eMudhra 中间证书安全更新产生了两份 Dependabot PR：一份只改桌面 manifest，另一份同时改根锁文件。Undici 也有同类重复。单个 PR 的 CI 通过只证明当时的依赖组合；现有 CI 跳过 Electron 二进制下载，也不运行桌面 E2E。

评估期间 Electron 45 已正式发布。作者授权由维护者判断升级目标、完成验证、合并更新并关闭重复 PR。

## 决定

- 本次直接升级到 Electron 45.2.1，不先合入 44.9.1 过渡版。两者都包含证书缓解措施，45 的破坏性变更需单独核对；不能把 44 的测试结果当作 45 的证据。
- manifest 与根锁文件一起更新，精确固定版本。独立安全依赖逐项合并，每次核对新主分支的 CI；本地组合回归补足独立 PR 无法证明的兼容性。
- 保留 renderer 的 sandbox、contextIsolation 和受限 preload，不通过降低隔离强度绕过升级问题。本次 preload 未依赖 45 移除的 Node 模块兼容层与全局变量。
- Electron 的 npm 包已不带 postinstall。二进制由首次运行或显式安装下载；移除失效的 Electron allowScripts 条目，升级以实际可执行文件版本为准。
- 继续使用现有桌面 E2E 与安装包验收入口。安装包验收额外断言实际 Electron 版本等于桌面 manifest，防止旧包冒充新版本；用新旧 ASAR 安装包验证启动、新建、替换安装、不兼容拒绝与整目录回退。
- Zod 的独立升级保留待修：SDK 的新版与 AG-UI 使用的旧版类型不兼容，且根依赖仍残留旧版。不以跳过类型检查或强制覆盖整棵依赖树换取合并。

## 后果与边界

不改变作品格式、执行数据、Runtime 分层或认证方式。本次本地未签名安装包验收不代表完成 Developer ID 签名、公证、独立机器首装或真实服务商联网验收；这些仍按发行队列处理。

验证结果记在[当前状态](../current-status.md)，剩余工作只在[路线图](../roadmap.md)第 6 节维护。

## 依据

- [Electron 45.2.1 发布说明](https://releases.electronjs.org/release/v45.2.1)
- [Electron 45 破坏性变更](https://github.com/electron/electron/blob/v45.2.1/docs/breaking-changes.md)
- [eMudhra 安全公告](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
- [Electron 二进制安装说明](https://www.electronjs.org/docs/latest/tutorial/installation)
