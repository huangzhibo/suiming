# macOS 签名准备与隔离演练（2026-10-15）

## 范围与身份边界

本机 macOS 26.6.2 / arm64，Electron 44.6.0、Xcode 工具与 notarytool 1.1.2 (41) 可用。只读取签名身份摘要：有效身份中 **Developer ID Application 为 0**，未指定公证 profile。未读取密码、修改钥匙串、创建证书或向 Apple 上传。真正的 Developer ID 签名、公证 Accepted、staple 成功、下载隔离放行与独立机器首次启动均未完成。

沿用[上一轮生产安装构建](../2026-10-15-macos-install/README.md)，应用内版本 0.1.0，构建标识为当时 `67ce426` 加 dirty（包含随后提交的安装 / 启动恢复修复），没有重新构建或替换业务实现。所有签名、安装、故障和数据验证都在独立临时目录，使用公共 fixture；没有打开日常作品或凭据。

## 实际发现与修正

- 签名完整性通过不代表能启动。首次仅 `allow-jit` 的 ad-hoc 包在启动前崩溃；系统 DYLD 报告 Electron Framework 与主程序没有可用于同团队验证的 Team ID。重复诊断确认同一原因，也触发了系统崩溃提示，不能记为安装成功。
- 本地演练单独加入 `disable-library-validation`；正式 Developer ID 模式仍只申请 `allow-jit`，不能用演练成功证明正式配置可用。不修改全局安全设置、不移除 quarantine。
- 原安装 smoke 的“首次启动”实际启动的是旧包，已改为先验证本次包首次新建，再安装旧包准备升级，最后验证本次包替换与回退。这避免新包冷启动缺陷被旧包掩盖。
- 公证采用先提交并保存编号、再等待结果；失败不会自动重新提交或生成最终交付 zip。Accepted 后日志获取、staple、票据验证、严格签名验证与 Gatekeeper 任一步失败都停止。

## 验证结果

| 检查 | 结果与边界 |
| --- | --- |
| `check:mac-release` | 正确拒绝：没有已选择的 Developer ID 身份，不生成发行目录，也不发公证请求 |
| 签名演练 | 严格嵌套签名验证通过，主程序为 `adhoc,runtime`；修正后权限仅为 JIT 与演练专用库校验例外 |
| 真实安装包 smoke | 1 / 1 通过，约 33 秒；本次包首次启动与新建、未签名旧包到本次包的替换、重载、不兼容库拒绝及完整冷备份回退通过 |
| 数据保全 | 3 版 Canon、1 份 Session、1 个 Task、候选内容与 127 个外置执行对象逐项一致；无渲染异常 |
| 缺公证票据 | disposable 副本添加 quarantine 后，签名验证仍通过；Gatekeeper exit 3 拒绝，stapler validate exit 65 无票据。修正后的演练包 Gatekeeper 也明确拒绝 |
| 资源篡改 | 只修改故障副本的 app.asar，codesign exit 1，报告 sealed resource invalid |
| 公证故障契约 | 8 / 8：错误证书类型 / 缺配置、Invalid、In Progress、Accepted，以及等待 / staple / validate / Gatekeeper 失败。机制验证，不是 Apple 真实调用 |
| 全仓 | `npm run check` 通过；`npm test` 510 项，505 通过、5 项原有外部集成 skip。最终指纹大小写归一化后定向契约复验 8 / 8 |

修正后 zip 的 SHA-256：`c9f4c3f6158effb17af8abe80467627e4a6395140615af091c07f3da2bc619a6`。演练包只用于本地测试；首次欢迎页、升级后与回退后截图均由生产包测试保存；欢迎页与升级后的界面已走查。没有重跑无关的完整桌面 48 项；此前通过记录仍保留在上一轮，不写成本轮结果。

## 复验与余下操作

命令和所需身份集中在[签名与公证准备](../../macos-preview.md#签名与公证准备)。下一轮拿到本机已安装的 Developer ID Application（含私钥）及已保存的公证 profile 后，重新构建明确版本、执行正式签名和 Apple 公证，再对最终 zip 重跑安装保全及独立环境下载首次打开。此处的故障注入不等同于 Apple 实际接受或拒绝。
