# ADR-0041：Zod 安全修复统一 AG-UI 与工具链依赖

- 日期：2026-11-03
- 状态：Accepted

## 背景

Zod 的 GHSA-mrhx-c7xc-m3w5 在 4.6.6 修复集合长度校验过晚造成的资源消耗问题。Dependabot PR #9 只把 SDK 从 3.25.76 升到 4.6.6，AG-UI schema 仍解析到 3.25.76 包附带的早期 `zod/v4`，与新版转换器的类型不兼容；旧版也仍留在锁文件中。

AG-UI core 1.0.3 的 peer 范围已支持 Zod 4，并非整个 AG-UI 不支持新版。client 1.0.3 的运行代码使用 `zod/v4`，但 client 与 proto 的依赖声明仍限定 `^3.25.76`。只升级 AG-UI 与 SDK 仍会复现类型错误。shadcn 4.21.3 与其 registry 也引入 Zod 3；shadcn 4.23.0、registry 0.2.1 已支持 Zod 4。

## 决定

- SDK 正常声明 Zod 4.6.7；core、client 及其 encoder、proto 统一为 AG-UI 1.0.3。升级 shadcn 到 4.23.0，沿正常依赖关系移除工具链中的旧 Zod。
- 仅在根 package.json 对 `@ag-ui/client@1.0.3` 与 `@ag-ui/proto@1.0.3` 定向覆盖 Zod 为 4.6.7。覆盖限定已核对的包版本，不扩大为全局 Zod override。
- 根目录不额外声明 Zod，core 不设 override；SDK 的直接依赖和根锁文件已经足以确定当前组合。用干净 `npm ci` 和 `npm ls` 验证，不能仅凭已有 node_modules 的提升布局判断兼容。
- 保留上游 schema 为真源和现有 TypeBox 传输边界，不复制标准字段、不以类型强转或跳过 peer / TypeScript 检查绕过冲突。使用现有事件回放、官方客户端校验和桌面 E2E 验证消息行为。
- 为 JSON Schema 转换补正反例，检查消息、工具、快照的必填与嵌套类型约束；用三个元素的数组验证超限时不访问元素，避免回归测试本身制造内存耗尽。该修复不意味着无长度约束的任意大输入都安全。
- shadcn 只更新工具包，不重新生成组件。当前代码未消费其变更的 MCP / schema 导出；升级前后 `shadcn/tailwind.css` 内容一致。

## 覆盖的删除条件

每次升级 AG-UI 时重新核对 client、proto 的发布包依赖声明和实际导入。当上游正式允许安全版本的 Zod 4 后，删除相应 override，重新生成锁文件，并通过干净安装、依赖树、schema 转换、消息回放和桌面验收。不能只改 override 的父版本来自动延续例外，也不能在上游已修复后永久保留覆盖。

2026-11-07 解除覆盖。AG-UI 1.0.4 的 client、encoder、proto 声明 Zod peer 范围 `^3.25.18 || ^4.0.0`，core 发布包保留同范围的可选 peer。四包统一升到 1.0.4，根目录删除两条定向 override，SDK 的直接依赖继续提供唯一的 Zod 4.6.7。工作台沿用默认的单事件校验预算和原有动作展示路径。验收记录见[当前状态](../current-status.md)。

## 后果与边界

不改变作品格式、执行数据库或消息协议；用新的完整更新替代 PR #9。Zod 告警消除与整个仓库审计清零是不同结论；剩余依赖问题仍按实际路径评估。验证证据见[当前状态](../current-status.md)，后续队列见[路线图](../roadmap.md)第 6 节。

## 依据

- [Zod 安全公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- [AG-UI 1.0.3 发布](https://github.com/ag-ui-protocol/ag-ui/releases/tag/release%2F2026-10-16)
- [AG-UI 1.0.4 发布](https://github.com/ag-ui-protocol/ag-ui/releases/tag/release/2026-11-05)
- [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)
- [Zod 库作者建议](https://zod.dev/library-authors)
- [shadcn 变更记录](https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/CHANGELOG.md)
