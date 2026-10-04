# 示例作品

`sanguo/` 是《三国演义》第一回到第五十回（桃园结义到华容道）的忠实结构化，给第一次打开燧明界的人看一部长篇在里面是什么样子。

- 设计（`outline/`、`world/`）由燧明界的 Agent 从原著抽取、整合后原样提升为本作的设计（补全与审稿这次没做，原因见验证记录），读者期待、秘密与物品用原著里的叫法。过程与数字见[验证记录](../docs/validation/2026-10-04-sanguo-example/README.md)。
- 正文（`text/`）是原著原文，按节切分，一字未改。
- 原著材料与抽取时的分段笔记在 `source/`：Project Gutenberg #23950，OpenCC 转成简体，公有领域。抽取得到的 Source Design 与本作的设计逐字相同，示例里没有重复放。

打开它不需要模型。打开作品时会在目录里建 git 仓库，所以先复制到仓库外，再在桌面工作台里点「打开作品」，选复制出来的目录：

```bash
cp -R examples/sanguo ~/Documents/sanguo
```

`npm run check` 会对这里的每部作品跑 Checker。Story Language 改了，示例要跟着改。
