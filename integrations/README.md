# Coding-agent integrations

Codex、Claude Code 和 Grok Build integrations 共用 [`shared/suiming/SKILL.md`](shared/suiming/SKILL.md)。这份 Skill 是 host-native 创作方法论：host 的主 agent 承担 Agent 职责，按设计、正文、审稿、Source 四个循环工作，隔离的 Writer / Reviewer 子 agent 用 `suim --json context compile` 拿到与 Suiming Agent 共用的 Context 与角色契约，结果经 `text check` / `review record` / `commit` 回到同一套 Checker 与 ProjectRevision。它不包含 Story Language 字段表、Runtime 实现或模型凭据。

按使用的 host 选择安装说明：

- [Codex](codex/README.md)
- [Claude Code](claude-code/README.md)
- [Grok Build](grok/README.md)

## 三个 host 共同的部分

安装由 `suim init --agent <host>`（新作品）或 `suim update --agent <host>`（已初始化作品补接或刷新）完成。在作品目录运行不带 `--agent` 的 `suim update` 会刷新全部已安装接入；未初始化的目录先运行 `suim init`。

安装写入 Skill、随 Skill 一起的 `story-language/` 文档、host 的 agent 文件（目前只有 Codex 有）、入口文件（`AGENTS.md` / `CLAUDE.md`）里的 Suiming 标记段和 `.gitignore` 标记段。标记段只刷新标记之间的内容，其余保留。写入的都是仓库辅助文件，不修改作品 artifact，也不登录 Cloud。

装好后在作品目录打开 host，直接说明创作要求，例如：

> 请读取 AGENTS.md（Claude Code 读 CLAUDE.md），按 suiming Skill 从现有作品意图开始，完成并审查完整 Story Design；在 Design 稳定前不要生成正文。

可以显式调用 Skill，也可以在读写 Story Design、StoryText、Source、Review 或 Release 时让 host 按 description 自动选择。

入口文件仍可保存作品仓自己的长期约束；Suiming 只维护标记段，不要把整份 workflow 复制进去。Skill 是 adapter，`suim --json` 是 machine contract，作品文件仍由 host 自己的 search、read 和 edit 工具直接处理。

host-native 模式继续使用 host 自己的模型和凭据；只有显式 `suim session send` 才读取 Suiming model profile。

## 维护

这些文件由 `scripts/generate-host-files.mjs` 从本目录生成进 `apps/cli/src/host-files.ts`，改了 Skill 或 agent 后运行 `npm run generate:host-files`。随 Skill 安装的 `story-language/` 文档取自仓库根目录的 [story-language](../story-language/README.md)，改了要运行 `npm run generate:story-language`。
