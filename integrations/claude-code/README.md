# Claude Code adapter

Claude Code 从作品仓的 `.claude/skills` 发现 project-scoped Skill。它由 `suim` 安装，真源是 [`integrations/shared/suiming/SKILL.md`](../shared/suiming/SKILL.md)：

```sh
suim init ~/stories/my-book --intent-file intent.md --agent claude-code   # 新作品
suim update --agent claude-code                                              # 已初始化作品补接或刷新
```

在作品目录运行 `suim update` 会刷新全部已安装接入；未初始化目录先运行 `suim init`。

安装写入 `.claude/skills/suiming/SKILL.md`、`CLAUDE.md` 里的 Suiming 标记段（只刷新标记之间的内容，其余保留）和 `.gitignore` 标记段。

然后在作品目录打开 Claude Code，直接说明创作要求，例如：

> 请读取 CLAUDE.md，按 suiming Skill 从现有作品意图开始，完成并审查完整 Story Design；在 Design 稳定前不要生成正文。

可以显式调用 `/suiming`，也可以在读写 Story Design、StoryText、Source、Review 或 Release 时让 Claude Code 按 description 自动选择。

验证：

```sh
test -f .claude/skills/suiming/SKILL.md
suim --json open
suim --json status
```

Claude Code 的 `CLAUDE.md` 仍可保存作品仓自己的长期约束；Suiming 只维护标记段，不要把整份 workflow 复制进去。Skill 是 adapter，`suim --json` 是 machine contract，作品文件仍由 Claude Code 的本地 search、read 和 edit 工具直接处理。

平台约定参考 Claude Code 官方的 [Extend Claude with skills](https://code.claude.com/docs/en/skills) 文档。
