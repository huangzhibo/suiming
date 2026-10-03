# 从 suiming-story 迁移

一次性迁移已经完成，本文只留两件仍然有用的事：迁移钉住的是旧仓哪个版本，以及旧仓今后和本仓是什么关系。产品目标与实施顺序以 [ADR-0011](adr/0011-desktop-product-and-autonomous-runtime.md)、[ADR-0012](adr/0012-own-suiming-harness.md)和[路线图](roadmap.md)为准；迁移过程中的命令表、目录对照与步骤已经过时，不再保留。

## 1. 钉住的来源版本

`suiming-story` 提供了 repository-native Story Language、Checker、Context 与创作工具的历史实现。迁移钉住的版本是：

```text
repository: huangzhibo/suiming-story
commit: 5cc3bbd7c0dd07e4a646f36aead1af5f8311ebc7
date: 2026-09-01
subject: docs: define repository-native scope
```

该版本已贯通 Source、Design、StoryCommit、StoryText、Review 与 Release 的机制测试；当时的真实作品 `eval-022` 完成了史诗三国全书 Design 和几篇开篇正文校准，没有完成全书正文与 Release。所以它是可运行的历史参照，不是质量标准、固定基线或 SOTA 证明。旧仓后续提交不会自动替换这个来源；如需更新，必须重新记录 commit、eval 状态和行为差异。

从旧仓迁进来的是故事创作宪法、Story Language 语义与 TypeBox schema、Story Core / 硬状态重放 / Checker、Source / Review / StoryText / Release 中仍符合新边界的领域逻辑，以及真实长篇 eval 协议、关键回归与失败样本。旧 Skills、CLI 编排和文件系统 Context 交付没有搬进来，三个 host 的接入在本仓按当前 Story Language 与 `suim --json` 重写。

## 2. 不作为上游依赖的边界

旧仓的定位（一次性迁移来源、可选的历史参照、可能的 Community 发行，不是上游依赖或质量基线）见 AGENTS.md 不变量 1。2026-09-06 作者决定搁置旧仓：全局 `suim` 指向本仓，旧仓只在具体实验有信息价值时作为候选参照。落到操作上：

- 本仓不依赖旧仓的任何 release，不通过子模块、Git subtree 或定时同步消费旧仓；修复若两边都适用，各自实现、各自验证，不建隐藏的共享源码。
- `suim` 沿用旧名字，但实现与 command contract 都是重写的，不承诺旧参数或输出兼容，也不调用旧 CLI；两个 CLI 只能有一个在 PATH 上。
- Runtime 只认当前格式，不读旧 `.suim/`、`suiming.yaml` 或旧 schema，也不做 legacy importer；旧格式的作品打开时被拒绝并点名文件与字段，要用就一次性改写成当前格式。
- Story Language 的终局演进发生在本仓；Community 版若要发行，由产品决策选一个明确版本回迁，不反向约束本仓。
- 同一部作品不由旧仓和本仓双向写入：每次实验选一个权威，另一边只作固定快照。
