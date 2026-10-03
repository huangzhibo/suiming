# Coding-agent integrations

Codex、Claude Code 和 Grok Build integrations 共用 [`shared/suiming/SKILL.md`](shared/suiming/SKILL.md)。这份 Skill 是 host-native 创作方法论：host 的主 agent 承担 Agent 职责，按设计、正文、审稿、Source 四个循环工作，隔离的 Writer / Reviewer 子 agent 用 `suim --json context compile` 拿到与 Suiming Agent 共用的 Context 与角色契约，结果经 `text check` / `review record` / `commit` 回到同一套 Checker 与 ProjectRevision。它不包含 Story Language 字段表、Runtime 实现或模型凭据。

按使用的 host 选择安装说明：

- [Codex](codex/README.md)
- [Claude Code](claude-code/README.md)
- [Grok Build](grok/README.md)

安装由 `suim init --agent <host>` 或 `suim update --agent <host>` 完成：写入 Skill、host 的 agent 文件、入口文件（`AGENTS.md` / `CLAUDE.md`）里的 Suiming 标记段和 `.gitignore` 标记段。写入的都是仓库辅助文件，不修改作品 artifact，也不登录 Cloud。这些文件由 `scripts/generate-host-files.mjs` 从本目录生成进 `apps/cli/src/host-files.ts`，改了 Skill 或 agent 后运行 `npm run generate:host-files`。host-native 模式继续使用 host 自己的模型和凭据；只有显式 `suim session send` 才读取 Suiming model profile。
