# ADR-0013：CLI 开工与接入维护收敛为 init / update

- 状态：Accepted
- 日期：2026-09-22

## 决定

作者使用 `suim init [path] --agent <host>` 开始作品；使用 `suim update` 刷新当前作品已安装的接入文件，或用可重复的 `--agent <host>` 补接、指定刷新。删除 `host install` 命令组和 CLI 的 `--project-id`，不保留开发期别名。Runtime 的内部 ID 注入能力仍可供测试使用。

`update` 要求目录已初始化，不修改作品 artifact、不创建作品版本，也不升级 CLI 或 host 程序。未安装任何 host 时明确提示使用 `--agent`，不猜测默认 host、不新增安装登记表；已安装状态从 Skill 文件发现。

Codex 角色文件的 `name`、`description`、`sandbox_mode`、`developer_instructions` 由模板更新；其他 TOML 配置由作者拥有，刷新时保留其值。TOML 解析失败则拒绝更新，不覆盖原文件。重写可能调整格式与注释，不承诺保留它们。

初始化前拒绝已登记作品；补写最小结构与首次登记共用 Runtime 入口，失败时撤回本次补写的文件，不能留下“命令失败但作品已改”的副作用。显式 `init` 允许把含普通辅助文件的目录创建为作品，并保留原文件；桌面的“打开”继续拒绝误选的非作品非空目录。

## 依据与范围

[CLI 试用](../validation/2026-09-22-cli-audit.md)复现了初始化残留、接入刷新覆盖模型配置及过时指示。用户已确认优化这组问题。两个命令表达开工和后续维护，不增加持久实体或新的 Runtime 服务；CLI 与 SDK 命令边界、共享 Skill 和使用文档同步修改，历史验收记录保留原命令。
