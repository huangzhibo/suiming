# Codex adapter

Codex 从作品仓的 `.agents/skills` 发现 project-scoped Skill，从 `.codex/agents` 发现项目级自定义 agent。两者都由 `suim` 安装，真源是 [`integrations/shared/suiming/SKILL.md`](../shared/suiming/SKILL.md) 与本目录的 [`agents/`](agents/)：

```sh
suim init ~/stories/my-book --intent-file intent.md --agent codex   # 新作品
suim update --agent codex                                              # 已初始化作品补接或刷新
```

安装写入 `.agents/skills/suiming/SKILL.md`（连同同目录的 `story-language/`）、`.codex/agents/*.toml`、`AGENTS.md` 里的 Suiming 标记段和 `.gitignore` 标记段。三个 host 共同的用法与约定见 [integrations 说明](../README.md)。在 Codex 里可以用 `$suiming` 显式要求使用。

四个 agent 的 `model` 与 `model_reasoning_effort` 可按作品需要自行设置；刷新时保留这些作者配置，更新模板的角色名称、描述、权限与指示。TOML 的格式与注释可能重新排版；格式错误时拒绝更新，不覆盖原文件。

验证：

```sh
test -f .agents/skills/suiming/SKILL.md
suim --json open
suim --json status
```

平台约定参考 Codex 官方的 [Agent Skills](https://learn.chatgpt.com/docs/build-skills) 与 [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) 文档。
