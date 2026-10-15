# macOS 预览安装、升级与回退

目前提供本机架构的 `.app` 与 zip 构建。它们用于隔离预览验收，**尚未完成 Developer ID 签名与 Apple 公证，不是面向普通作者的正式发行包**。本机解压运行不等于通过下载隔离、Gatekeeper 或另一台机器的首次启动验证。发行边界见 [ADR-0028](adr/0028-macos-preview-delivery.md)，实际范围见[安装验收](validation/2026-10-15-macos-install/README.md)。

## 构建与安装

在 macOS 上执行 `npm ci`、`npm run check`，然后运行：

```sh
npm run package:mac
```

输出在 `dist/macos/`：本机架构的 `Suiming.app` 和带版本、架构的 zip。脚本使用锁定的 Electron 与 npm 已安装的桌面生产依赖闭包，只复制构建产物、依赖和许可证，不携带仓库 `.env`、作品、凭据或测试入口。若已缓存官方 Electron zip，可将 `ELECTRON_ZIP_DIR` 指向它的所在目录；文件名必须与本次 Electron 版本及架构匹配。预览构建记录源码 commit 和工作区是否有修改，版本取桌面 package.json；每个正式发布版本必须单独标号。

解压 zip，将整个 `.app` 放入选择的应用目录后启动；隔离验证使用临时 `Applications`，不覆盖日常应用。不在 `.app` 内保存作品：首次启动选择空目录新建，或选择已有作品文件夹打开。应用内含 Electron / Node 与 SQLite 支持，不要求作者安装 Node、npm 或启动开发服务器。生产 Canon 使用 isomorphic-git，不要求系统 Git 才能打开作品。

此阶段不要关闭系统安全检查来把本机预览当成正式发行。正式下载与首次启动必须在签名、公证完成后另验，依据 [Electron 发行说明](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)与[签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。

## 数据位置与升级范围

- 作品目录：作品文件、未提交候选、`.git` 中的 Canon 历史、整个 `.suiming` 中的对话与执行对象。
- 用户配置：默认 `~/.suiming/config.toml` 与 `auth.json`，或显式配置的 `SUIMING_CONFIG_PATH` / `SUIMING_AUTH_PATH`。不能随安装包分发。
- 应用数据：Electron 的 `userData`（默认 macOS Application Support 下的 Suiming 目录），含最近作品、标签与尚未落到作品文件的编辑现场。安装包名称与 bundle ID 固定，升级不能借改名改变这些位置。

当前只验证同为执行库 v6、相同 Story Language 的两个构建之间完整替换 `.app`。它们不是历史正式发行版本；不据此承诺任意旧版可升级。没有自动更新器，也不做执行库自动降级。Story Language、执行库、checkpoint 或事件解释有不兼容变更时，发布前须给出具体版本范围、保全与转换验证；不能靠版本号相同推断兼容。

## 替换安装

1. 保存编辑内容，等待或停止运行中的 Agent，退出使用这些作品的桌面和 CLI。
2. 保留旧 `.app` / zip；按[完整冷备份](repository-recovery.md#完整备份与迁移)备份整个作品目录。另行备份应用数据与全局配置；凭据只在可信的本地私有位置保存。
3. 先在作品副本验证新构建，再完整替换 `.app`，不要把新旧包的内部文件叠加。
4. 打开后核对 Canon 历史、未提交内容、原对话与工具结果；重载不应新增模型调用或版本。需要继续创作时，沿原对话发送消息，不重新建立作品来修复升级。

## 失败回退

- **应用打不开 / 资源损坏**：退出新构建，恢复完整旧 `.app`。若新构建没有改动数据，兼容旧版可以直接重开原作品；保留失败包和日志供排查，不删除作品或配置来“重装”。
- **启动时作品打不开**：界面显示原始原因，包括不兼容执行库的完整保全提示；仍可打开其他作品。最近作品记录不被失败覆盖。不要将欢迎页视为作品丢失，更不能在原目录重新初始化以掩盖失败。
- **新构建已改变数据格式，旧版无法读取**：保留当前完整目录，用升级前冷备份复制出恢复目录，再用兼容旧构建打开。必要时恢复升级前应用数据；不要只倒回数据库或拼接不同时点的 objects。升级后的新创作仍留在原目录，另行核对转移，不能静默覆盖。

删除 / 替换 `.app` 不会主动删除作品、Canon 或对话。完整冷备份是回退依据；快照导出只有一个作品版本，不能替代它。自动更新、通用迁移平台与热备份均未新增。

## 签名与公证准备

2026-10-15 按作者要求暂缓正式签名、公证及后续下载首次安装验证；以下步骤保留给恢复对外发行时使用，当前无需购买会员或提供凭据，不阻塞本机功能验证。

同一份预览 `.app` 可交给 `scripts/macos-release.mjs` 处理。脚本只复制到**尚不存在的新目录**，不覆盖输入、日常应用或作品；复用 `@electron/osx-sign` 与 Apple 命令，不引入发行服务。当前已完成本地签名演练与故障检查，正式 Developer ID / Apple 公证仍待身份就绪后实测，见[签名验收](validation/2026-10-15-macos-signing/README.md)。

维护者需要一次性在本机准备：

1. 具有相应权限的 Apple Developer Program 团队；安装 **Developer ID Application 证书及其私钥**，建议使用专用钥匙串。Apple Development 或 Developer ID Installer 不能替代。用 `security find-identity -v -p codesigning` 获取证书 SHA-1 指纹，只提供指纹和必要的钥匙串路径，不在聊天、仓库或日志中发送私钥。
2. 在终端交互运行 `xcrun notarytool store-credentials suiming-notary`，按提示输入获授权的 Apple ID、Team ID 和 app-specific password；可附 `--keychain <专用钥匙串路径>`。密码只存本机钥匙串，只需向执行者提供 profile 名和钥匙串路径。不要把密码放到命令行、`.env` 或提交记录。
3. 正式包完成后，准备可供验证的独立 arm64 Mac 或干净 macOS 虚拟机。通过浏览器下载保留 quarantine 的包，在默认安全设置下首次打开；这一步不能由本机直接执行二进制代替。

```sh
export SUIMING_MAC_SIGN_IDENTITY='<40 位证书 SHA-1 指纹>'
export SUIMING_MAC_NOTARY_PROFILE='suiming-notary'
# 使用专用钥匙串时另设 SUIMING_MAC_KEYCHAIN；脚本不修改系统搜索列表。
npm run check:mac-release
npm run release:mac -- dist/macos/Suiming-darwin-arm64/Suiming.app dist/macos-release
```

检查会验证可用 Developer ID 身份及 profile 的 Apple 认证；缺项即停止，不自动选其他身份或降级。正式模式启用 Hardened Runtime，只申请 Electron V8 所需的 `allow-jit`，要求安全时间戳；不启用 `get-task-allow`、任意未签名代码或库校验例外。该最小配置仍须用真实 Developer ID 包验收，不能由 ad-hoc 演练推定支持。

流程依次签署所有嵌套代码、严格验证、上传公证、保存编号、等待 Accepted、获取日志、向 `.app` staple 票据，再验证票据、签名和 Gatekeeper。全部通过后才重新压缩成 `Suiming-notarized.zip` 并生成 SHA-256 校验文件；`submission.zip` 是公证输入，不能作为最终发行包。每次发布独立目录，文件名不替代应用内的正式版本号和源码标识。

公证等待超时 / 断网时保留 `notary-result.json` 中的编号；不要重跑 release 来重复上传。用 `notarytool wait <编号> --keychain-profile <profile>` 继续查询（专用钥匙串继续传 `--keychain`），Accepted 后取 `notarytool log`、执行 `stapler staple` / `validate`、`codesign --verify --deep --strict` 与 `spctl --assess --type execute`，全部通过才用 `ditto -c -k --sequesterRsrc --keepParent` 重新归档并生成校验和。Invalid 则先看公证日志、修正原因，重新签名后作为新提交。若上传结果本身丢失，先用 `notarytool history` 找回，不能假设没上传成功。

无开发者身份时只运行本地演练：

```sh
npm run rehearse:mac -- dist/macos/Suiming-darwin-arm64/Suiming.app dist/macos-adhoc
```

输出明确命名为 `Suiming-local-adhoc.zip`，不调用公证、不用现有证书。ad-hoc 没有 Team ID，同团队动态库校验会导致 Electron 在启动前退出，因此**只有演练模式**增加 `disable-library-validation`；没有关闭 Gatekeeper 或移除 quarantine。该包不能正式分发，运行成功也不等于正式签名成功。

依据：[Apple 公证工作流](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)、[Electron 签名工具](https://github.com/electron/osx-sign)、[Electron 公证说明](https://github.com/electron/notarize)。
