# 作品仓库迁移、备份与恢复

作品以仓库为中心，但作品版本、未提交文件和对话不是同一份数据。恢复先确认要保留哪些内容，不能把“重新打开了作品”当成完整恢复。长期保全责任见[需求与目标](vision-and-requirements.md)第 4.4 节；本文维护操作范围与前提，实现边界见[架构](architecture.md)，验证结果见[迁移验收](validation/2026-10-15-repository-recovery/README.md)。

## 三种范围

| 方式 | 已提交作品 | Canon 历史 | 未提交及辅助文件 | Suiming 对话与续做 |
| --- | --- | --- | --- | --- |
| 停止写入后完整复制作品目录 | 保留 | 保留，含 `.git` | 保留已落盘内容 | 保留，含整个 `.suiming` |
| 显式传递 `refs/suiming/canon` 的 git fetch / bundle | 保留 | 保留 | 不包含 | 不包含 |
| `suim export` / Open Story Package | 一个版本的快照 | 不包含 | 不包含 | 不包含 |

默认 `git clone` / push 不保证携带自定义 Canon ref；工作区文件存在也不能证明历史已经传走。`.suiming/local.sqlite` 保存执行索引和部分小对象，较大的消息、checkpoint 片段和任务结果在 `.suiming/objects`。只备份 SQLite 可能看得到会话列表，却读不全消息或无法继续。

表中的“对话”指已接收并持久化的消息与执行数据。桌面未保存的编辑、未发送的消息草稿和编辑位置在应用数据中，仅复制作品目录不会携带它们。迁移前应保存可保存的编辑，并另行保全应用数据；不能为备份而强行覆盖冲突文件或把未发送草稿发给 Agent。应用数据位置和回退方式见[安装与回退](macos-preview.md#数据位置与升级范围)。

## 完整备份与迁移

1. 核对并保全上述作品内容与应用草稿。等待 Agent 完成或正常停止，然后退出使用此作品的桌面、CLI 和其他编辑进程，再复制数据。只重载 renderer 不会停止 Agent。
2. 将**整个作品文件夹**复制到一个新的备份位置，包括隐藏的 `.git`、`.suiming`、所有未提交文件和辅助文件。Finder 复制文件夹会包含内部隐藏文件。不要只选择可见文件，也不要只拷 `local.sqlite`；如有 SQLite 的 `-wal` / `-shm` 文件一起保留。
3. 从备份再复制出一个新的恢复目录，用“打开作品”打开它；不要覆盖原目录或直接在唯一备份上继续写。Runtime 根据新位置更新登记，不需要改数据库里的路径，也不需要重建 Project 或对话。
4. 核对历史数量与 Canon 提交编号、当前作品和未提交差异，再打开原对话查看消息与工具结果。需要继续时沿原对话发送消息；打开或 attach 本身不应调用模型。
5. 核对通过后才处理旧目录。完整复制保留原 project / session identity 和远端绑定，用于恢复原作品；不把两份副本同时运行并期待自动合并。

该路径要求自含的普通目录：`.git` 是本目录内的完整仓库，执行对象也在 `.suiming` 内。linked worktree 的 `.git` 文件、Git alternates 或指向外部资料的符号链接不能只靠复制所在文件夹保证完整性；先建立自含副本或使用下面的 Git 历史传递方式。不把对正在写入的目录逐文件复制视为一致的热备份。

凭据、全局模型配置和桌面最近目录不在作品目录里。迁移后应重新选择作品、核对模型配置并登录；不把凭据自动打包进作品。host 自己的对话也不属于 Suiming 的执行库。备份已包含 Suiming 消息及工具输入输出，应按私人资料保存，不作为公开作品包上传。

## 只迁移 Canon 历史

以下命令在终端执行，目录应为新建、没有需要保留的文件的位置。这里传递的是已有 Canon，不会从普通分支猜测哪个提交是权威。

从原仓库迁移（把占位路径替换为实际路径）：

```sh
git clone /path/to/original /path/to/restored
cd /path/to/restored
git fetch origin refs/suiming/canon:refs/suiming/canon
git restore --source=refs/suiming/canon --worktree -- .
suim --json init
suim --json history
```

离线携带历史，先在原仓库执行：

```sh
git bundle create /path/to/canon.bundle refs/suiming/canon
git bundle verify /path/to/canon.bundle
```

再在全新的恢复目录执行：

```sh
git init
git fetch /path/to/canon.bundle refs/suiming/canon:refs/suiming/canon
git restore --source=refs/suiming/canon --worktree -- .
suim --json init
suim --json history
```

`init` 看到已有 Canon 就接回原版本链，不另造创世版本。Canon ref / 上述 bundle 本身不带旧对话、未提交文件、仓库辅助文件或其他 git 分支。clone 可能另外复制普通分支，但这不能替代完整目录备份；若要保留这些内容，优先使用完整目录备份。不要先 init 再强行覆盖一条新 Canon；缺少原 ref 和对象时，不能凭当前文件重建旧历史。

## 出错时保留什么

- **Canon ref 缺失**：保留完整目录，优先从备份恢复 `.git`，或从原仓库显式取回 Canon。不要移走执行库重新初始化来“恢复”旧历史。只有当前文件时，只能另建作品起点，不能宣称版本和对话关联已恢复。
- **执行库版本不兼容**：当前开发版不提供旧 schema 转换。先完整备份，再用兼容版本打开副本以保留原对话；不能让新版本强行解释旧结构。若明确只继续作品，可在另一个完整副本中移出整个 `.suiming`，重新打开或 init，保留 git 的 Canon 历史；旧对话不会自动迁入。
- **执行对象缺失**：从同一份完整备份恢复 `.suiming`，不要把不同时点的 SQLite 和 objects 拼在一起，也不要用 Langfuse 或导出的聊天文本冒充原 checkpoint。
- **已提交作品需要回退**：使用已有的版本恢复能力产生一个新版本；它是作品修改，不是备份恢复，也不会倒拨对话历史。

## 设计取舍

不新增备份 manifest、持久迁移任务、第二份版本索引或聊天导入格式。完整目录已经拥有恢复所需的数据，Git bundle 已解决 Canon 历史携带；Open Story Package 继续只表达作品快照。

Canon ref 与普通分支分开会增加 Git 搬运的一步，但它承担“候选不等于通过 Checker 的作品”的明确语义，不能为了省一步同步维护另一条影子分支。SQLite 与对象目录也不是重复 Canon，它们保存的是对话执行；把这部分塞进作品 git 会混合权限、隐私与历史生命周期。

当前提供的是可验证的冷备份路径和明确的失败提示，尚无桌面备份按钮、热备份或自动旧库升级。正式安装与升级交付前必须决定支持的版本跨度，并针对实际升级提供保全、转换或可回退路径；此要求不能以“执行数据可丢”代替，也不因此提前建设通用迁移平台。

macOS 同格式构建替换与完整回退已有[独立验收](validation/2026-10-15-macos-install/README.md)，日常操作见[安装、升级与回退](macos-preview.md)。其范围不包含跨 schema 转换。
