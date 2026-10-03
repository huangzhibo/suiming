# Codex adapter

Codex 从作品仓的 `.agents/skills` 发现 project-scoped Skill，从 `.codex/agents` 发现项目级自定义 agent。两者都由 `suim` 安装，真源是 [`integrations/shared/suiming/SKILL.md`](../shared/suiming/SKILL.md) 与本目录的 [`agents/`](agents/)：

```sh
suim init ~/stories/my-book --intent-file intent.md --agent codex   # 新作品
suim update --agent codex                                              # 已初始化作品补接或刷新
```

在作品目录运行 `suim update` 会刷新全部已安装接入；未初始化目录先运行 `suim init`。

安装写入 `.agents/skills/suiming/SKILL.md`、`.codex/agents/*.toml`、`AGENTS.md` 里的 Suiming 标记段（只刷新标记之间的内容，其余保留）和 `.gitignore` 标记段。四个 agent 的 `model` 与 `model_reasoning_effort` 可按作品需要自行设置；刷新时保留这些作者配置，更新模板的角色名称、描述、权限与指示。TOML 的格式与注释可能重新排版；格式错误时拒绝更新，不覆盖原文件。

然后在作品目录打开 Codex，直接说明创作要求，例如：

> 请读取 AGENTS.md，按 suiming Skill 从现有作品意图开始，完成并审查完整 Story Design；在 Design 稳定前不要生成正文。

可以显式要求使用 `$suiming`，也可以在读写 Story Design、StoryText、Source、Review 或 Release 时让 Codex 按 description 自动选择。

验证：

```sh
test -f .agents/skills/suiming/SKILL.md
suim --json open
suim --json status
```

Codex 的 `AGENTS.md` 仍可保存作品仓自己的长期约束；Suiming 只维护标记段，不要把整份 workflow 复制进去。Skill 是 adapter，`suim --json` 是 machine contract，作品文件仍由 Codex 的本地 `rg`、read 和 edit 工具直接处理。

平台约定参考 Codex 官方的 [Agent Skills](https://learn.chatgpt.com/docs/build-skills) 与 [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) 文档。
