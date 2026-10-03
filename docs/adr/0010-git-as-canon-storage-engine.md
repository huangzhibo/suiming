# ADR-0010：git 作为 Canon 存储引擎

- 状态：Accepted（2026-09-12：作者决定走这条路，spike 通过）。仍有效：作品目录是普通 git 仓，谁都可以 commit（那是候选），`refs/suiming/canon` 只由过 Checker 的提交推进，Checker 只在这一步跑（文末两节）。没有成为现实的：「提议的形状」中的 `.suiming/canon.git` bare repo、Cloud 改托管 git（Cloud 仍用 PostgreSQL 保存 Canon）、evidence 逐条存 SQLite（2026-09-13 改为从 Canon 历史派生，见 [派生状态设计](../derived-evidence-design.md)）与 Run worktree；文末「绑定 key 不换」的对象 StoryText lineage 已删除，`artifactVersionId` 现在只用于 Cloud 存储
- 日期：2026-09-06
- 决策者：项目负责人

## 背景

ProjectRevision 层（`packages/runtime/src/artifact`、`local/sqlite-local-store.ts` 的快照与历史部分、`sync/`、`cloud-postgres` 与 `cloud-s3` 里的 artifact 版本存储）实现了快照、线性历史、diff、rollback、每 Run 一个 worktree、Local 与 Cloud 之间的 push / pull 与三方合并。这些与 git 重叠，大约五六千行。2026-09-06 作者追问"ProjectRevision 和 git 是不是重复了"，评估如下。

git 给不了的只有四件事：Checker 门禁（只有通过确定性检查的快照才成为 Canon）；evidence 绑定 revision；Codex workspace-write 沙箱里 `.git` 只读，agent 跑不了 `git commit`，而 `.suiming/` 可写；终局的桌面端与 Cloud 面向不写代码的作者。当初自建的三条理由里，"作者不懂 git"只要求界面看不到 git，不要求底层不用；"Cloud 需要 PostgreSQL 存 artifact 版本"不成立，托管 git 仓库是成熟方案；"沙箱写不了 .git"成立，但只要 `suim commit` 写的是 `.suiming/` 里的 bare repo 而不是作品目录的 `.git`，就绕过去了。

## 提议的形状

- `.suiming/canon.git` 是一个 bare repo，保存 Story Artifact 快照与线性历史；作品目录仍是 checkout，作者自己的 `.git` 与它无关。
- `suim commit` 仍是唯一入口：扫描 diff → Checker → 写入 bare repo 的一个 commit。ProjectRevision id 就是 commit sha；`history` / `rollback` / `diff` / `export` 直接映射到 git 操作。
- evidence（DesignCommit、ContextSnapshot、ReviewReport、MaterialEvidence）继续逐条存 SQLite，绑定 commit sha；Run / Task / Attempt 不变。
- Run 的 worktree 用 `git worktree` 从 bare repo 物化，diff → ChangeSet 路径不变。
- Cloud 托管同一个 bare repo（自建 git server 或对象存储上的 git 对象），push / pull 走 git 协议，三方合并交给 git，合并结果再过 Checker；PostgreSQL 只保存运行状态与 evidence，不再保存 artifact 版本。
- 实现上不依赖系统 git 二进制：桌面端在 Electron 主进程内需要纯 JS 实现（isomorphic-git 一类），是这条路的主要技术风险。

## 收益与代价

- 删掉约五六千行自建版本代码；作者与开发者已有的 git 心智可以复用；host agent 可以直接读历史。
- 代价：一次性的迁移（开发期数据直接重写，不做 legacy codec）；对纯 JS git 实现的依赖；`.suiming/` 与作者 `.git` 并存时的解释成本。

## 触发条件

在 Cloud 解冻之前必须决定，因为 Cloud 持久层是这层里最贵的部分，按自建版本继续建 Cloud 就是把重复固化。本地 sync 出现第一个真实需求时也应回到本 ADR。在此之前不动：host-native 靠现有的 `.suiming/` 在沙箱里工作，切换的收益现在拿不到，风险和工期立刻要付。

## 后果

接受则 ADR-0007 的"本地 SQLite 与内容寻址对象目录保存同等语义"改为"git 保存快照，SQLite 保存 evidence 与运行状态"，AGENTS.md 工程边界同步修改；否决则在此记录理由，ProjectRevision 层按现状进入 Cloud 解冻。

## 2026-09-12 更新：作者决定改用 git，形状改变

作者拍板删除自定义版本层，理由是本 ADR 没有列出的一条：**除了 Story Language 与 artifact 语义，其他方面没必要和 coding agent 的现行模式故意制造概念差异——当前的大模型都是偏向 coding 训练的。**两套版本控制并存的心智成本，本 ADR 只记成了"解释成本"，实际上它同时是模型的理解成本。

据此改变两处：

- **`.suiming/canon.git` bare repo 形状作废。**它本身就是一个刻意差异：作品目录是普通 git 仓库，谁都可以 commit（那是候选），`suim commit` 跑 Checker 后推进受保护的 canon ref。原形状把 Checker 门禁做成结构强制，代价是历史对 git 工具不可见。
- **「在此之前不动」的触发条件不再成立。**当时的理由是切换收益拿不到而风险立刻要付；现在的判断是继续按自建版本走会把重复固化进端口化与 Cloud，收敛期一起做反而更便宜。

仍待裁决的五条与执行顺序见[收敛方案](../history/consolidation-plan.md)第 3.5 节与第 4 节：git spike（用作品本体真实规模验证 isomorphic-git 的 commit / diff / 三方合并耗时与打包体积）通过后才迁移，结论写回本 ADR 并改状态。

## 2026-09-12 spike：isomorphic-git 在真实与终局规模上的实测

按[收敛方案](../history/consolidation-plan.md)第 4 节第 5 步执行，在 eval-022 的作品本体副本上跑（151 文件 / 776 KB，不含 `.suiming`）。isomorphic-git 1.42.2。

**结论：通过。**本 ADR 原本把「对纯 JS git 实现的依赖」列为主要技术风险，实测不成立。

| 操作 | 151 文件 | 69 Beat（3.9 MB） | 300 Beat（12 MB） | 1000 Beat（37 MB） |
| --- | --- | --- | --- | --- |
| 首次全量 `add` | 239 ms | 375 ms | 862 ms | 3097 ms |
| 首次 commit | 13 ms | 12 ms | 10 ms | 13 ms |
| **增量 commit（改 1 文件）** | **9 ms** | **9 ms** | **8 ms** | **8 ms** |
| **两版本 diff（全量 walk）** | **7 ms** | **10 ms** | **8 ms** | **14 ms** |
| `.git` 体积 | 900 KB | 780 KB | 800 KB | 856 KB |

关键在于**增量提交与 diff 不随作品规模增长**——8 到 14 毫秒，从 151 文件到 1145 文件几乎不变。这正是创作路径上反复发生的两个操作（阶段提交、比较版本）。只有首次全量 `add` 线性增长，而它是一次性的迁移动作；1000 Beat 的 3.1 秒可以接受，且可以并行化。

三方合并（`packages/runtime/src/sync/` 现在自建的那部分）：

| 场景 | 耗时 | 结果 |
| --- | --- | --- |
| 同一文件不同位置（作者改末尾，Run 改开头） | 22 ms | 自动合并，正确 |
| 同一行两侧都改 | 44 ms | `MergeConflictError`，如实报冲突 |

Run worktree 从一个 commit 全量物化到新目录：**39 ms**（151 文件）。比现在的文件复制物化不会更慢。

打包体积：`isomorphic-git` 安装占 4.8 MB、含依赖 8.8 MB，但**打进主进程 bundle 后只有 233 KB（esbuild minify）**。桌面当前 `main.js` 是 16 KB，Electron 运行时本身约 200 MB——233 KB 可忽略。

依赖面：11 个传递依赖（async-lock、clean-git-ref、crc-32、diff3、ignore、minimisted、pako、pify、readable-stream、sha.js、simple-get），都是小而稳定的包，没有原生扩展，不需要系统 git 二进制。

未测、留给第 6 步的：与 Checker 门禁结合后的 promote 路径耗时、Cloud 侧托管 git 仓库的 push / pull、以及百万汉字级单文件的 diff 表现（本次样本正文 34 KB / Beat）。这些都不改变「这条路可走」的结论。

## 2026-09-12：五条待裁决的结论

[收敛方案](../history/consolidation-plan.md)第 3.5 节原列「需要一起裁决的五条」，查证后只有两条是真的开放选择：

- **候选 commit 未过 Checker、提交语义改为 promote 校验后移 ref**——这两条是「作品目录是普通 git 仓库」这个形状的蕴含，没有第二种可能。
- **Canon 门禁仍然是结构性的**，不是「退为工具强制」：canon ref 只由 promote 移动，普通 commit 进不了 Canon，不变量 3 照旧成立。作者可以 `git update-ref` 手动搬 ref 绕过，但那与今天直接改 `.suiming` 里的 SQLite 同级，不是新增的弱化。
- **Checker 只在 promote 时跑。**候选 commit 按定义就是未检查的。要在候选时也跑就得往作者仓库装 git hook——第二套机制、可绕过、侵入作者的仓库；作者想提前知道结果时 `suim check` 就在。
- **绑定 key 不换。**`artifactVersionId` 看着像存储 id，实为内容寻址：`av_` + sha256(mediaType‖contentHash)（`artifact/version-storage.ts`），只由字节与 mediaType 决定。StoryText lineage 用它作 key 是对的。git blob sha 是 sha1 且不含 mediaType，会让两个 mediaType 不同、字节相同的 artifact 撞 key；`(commit sha, path)` 让同一份内容在两个 commit 里得到两个 key，且路径一改就断。
