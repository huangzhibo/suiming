# Grok Build adapter

Grok Build 从作品仓的 `.grok/skills` 发现 project-scoped Skill。它由 `suim` 安装，真源是 [`integrations/shared/suiming/SKILL.md`](../shared/suiming/SKILL.md)：

```sh
suim init ~/stories/my-book --intent-file intent.md --agent grok   # 新作品
suim update --agent grok                                              # 已初始化作品补接或刷新
```

安装写入 `.grok/skills/suiming/SKILL.md`（连同同目录的 `story-language/`）、`AGENTS.md` 里的 Suiming 标记段和 `.gitignore` 标记段。三个 host 共同的用法与约定见 [integrations 说明](../README.md)。在 Grok 里可以用 `/suiming` 显式调用，用 `/skills suiming` 检查发现结果。

验证：

```sh
test -f .grok/skills/suiming/SKILL.md
suim --json open
suim --json status
```

平台约定参考 xAI 官方的 [Grok Build](https://docs.x.ai/build/overview) 文档。
