# Claude Code adapter

Claude Code 从作品仓的 `.claude/skills` 发现 project-scoped Skill。它由 `suim` 安装，真源是 [`integrations/shared/suiming/SKILL.md`](../shared/suiming/SKILL.md)：

```sh
suim init ~/stories/my-book --intent-file intent.md --agent claude-code   # 新作品
suim update --agent claude-code                                              # 已初始化作品补接或刷新
```

安装写入 `.claude/skills/suiming/SKILL.md`（连同同目录的 `story-language/`）、`CLAUDE.md` 里的 Suiming 标记段和 `.gitignore` 标记段。三个 host 共同的用法与约定见 [integrations 说明](../README.md)。在 Claude Code 里可以用 `/suiming` 显式调用。

验证：

```sh
test -f .claude/skills/suiming/SKILL.md
suim --json open
suim --json status
```

平台约定参考 Claude Code 官方的 [Extend Claude with skills](https://code.claude.com/docs/en/skills) 文档。
