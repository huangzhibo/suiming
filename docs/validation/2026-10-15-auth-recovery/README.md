# 隔离认证失效与并发刷新验收

2026-10-15。目标是验证桌面 / CLI 共用凭据时的刷新、失效与重新登录，确认作品和原对话可继续。没有读取、复制、撤销或刷新日常账号凭据。

## 路径与边界

认证逻辑使用已安装的 pi-ai 1.2.0：`Models.getAuth` / `stream` / `login` → `JsonFileCredentialStore.modify`。远端替换为只监听 `127.0.0.1` 的 OAuth fixture，提供单次使用的 refresh token、令牌撤销、延迟响应和受控模型回复。凭据、配置、作品和 Electron user-data 全在临时目录；桌面与 CLI 子进程复用隔离环境，fixture 也禁止环境凭据回退。

这是**真实进程、真实桌面交互与真实持久化的受控故障验收**，不是 OpenAI、Anthropic 等真实账号的失效 / 登录认证。未请求外部 OAuth 或模型服务，没有产生真实模型调用；不向 Langfuse 输出这些合成登录与消息，也不把观测当作认证或恢复真源。

## 发现与修正

- 既有“两个进程只刷新一次”用例实际是同进程的两个存储实例，已更正名称，保留其并发读改写覆盖。新增独立 Node 进程的 pi-ai 刷新，以及 Electron 主进程与 CLI 命令进程的组合验收。用闸门确认第二个进程已请求刷新锁才放行第一方，不靠固定 sleep 制造并发。
- `invalid_grant` 发生时只显示底层英文错误，没有恢复办法。先补断言复现，再在共享 Gateway 的 error 事件中为 pi-ai 的 OAuth 刷新错误补上网络检查、授权失效时重新登录和回到原对话继续的指引；原始原因保留，瞬时错误判定不变。不修改凭据、不自动重登，不在桌面和 CLI 各写一套翻译。
- 桌面把所有模型失败都提示为“再发一条消息即可重试”，对失效授权有误导。改为先查看并处理原因，再发消息继续；详细原因沿用已有展开区域和设置入口。首次桌面脚本等待隐藏的详情超时，按实际“查看原因”交互修正后通过；未因此改成强制展开或增加入口。

没有新增刷新服务、凭据状态库、失效标记或 Session 恢复协议。原跨进程锁已覆盖完整刷新和写回；已进入刷新的请求由 pi-ai 在调用取消后继续落盘，以免丢失轮换令牌。保持现有实现，补证据而非重写。

## 验收结果

| 场景 | 断言 |
| --- | --- |
| 两个独立 Node 进程刷新 | 两方读到相同新 token；服务端只接受一次 refresh；磁盘保留新凭据 |
| Electron 与 CLI 并发刷新 | 两个入口共用同一隔离 auth 文件，在两个样例作品上同时执行；只刷新一次，两个调用都成功 |
| 刷新期间取消调用 | 调用方及时收到取消，后台刷新仍把轮换凭据写入；下一次读改写可取得新 token |
| 刷新响应迟到，同时重新登录 | 登录等待同一文件锁，新登录凭据最终保留，不被旧刷新结果覆盖 |
| 授权撤销 | 一次失败后回 idle，不循环刷新；旧凭据字节不变，错误保留 `invalid_grant` 和恢复指引 |
| 模拟刷新网络错误 | 原因保留，仍由 pi-ai 判为可重试；凭据不清空，网络恢复后原 Gateway 成功调用，无需登录 |
| 失效后的桌面连续使用 | 第二轮已写候选后令牌失效；重载、打开设置、按授权码提示登录、回到原对话继续第三轮；同一 Session 和历史消息保留 |
| 作品与输入保全 | Canon 版本链不变，差异只有指定的未提交 Intent 文件；文件字节一致，设置登录期间的输入草稿保留；没有重复写入或自动提交 |

桌面成功路径已截图目视核对，渲染异常为零。截图、临时凭据、执行库与原始输出不提交；fixture 中的固定 token 和授权码只用于回环服务。

全仓 `npm run check` 通过；`npm test` 共 502 项，497 通过、原有 5 条集成 skip，无失败。`npm run test:desktop` 完整 46 / 46 通过、0 skip，含 macOS 原生全屏；此次使用最终入口构建和恢复文案，认证组合用例也再次通过。

## 重跑

跨包测试使用 dist，先执行 `npm run check` 或构建，再运行：

```sh
node --import tsx --test packages/runtime/test/credential-concurrency.test.ts packages/runtime/test/oauth-recovery.test.ts
npm run test:desktop
```

定向桌面在准备好 renderer 和测试入口后运行：

```sh
node --import tsx --test apps/desktop/test/oauth-recovery.test.ts
```

测试真源：[隔离 provider](../../../packages/runtime/test/oauth-fixture.ts)、[回环认证服务](../../../packages/runtime/test/oauth-server.ts)、[机制回归](../../../packages/runtime/test/oauth-recovery.test.ts)、[独立 CLI 入口](../../../apps/cli/test/oauth-process.ts)、[桌面组合验收](../../../apps/desktop/test/oauth-recovery.test.ts)。Electron 测试入口仅打包测试 helper，产品 main 与第三方包仍外置，不改生产构建。

## 仍未验证

真实服务商的 refresh token 撤销、SSO / 多因素登录、设备码和浏览器回调各有自己的行为，不能由本次 fixture 推导支持范围。凭据刷新成功但进程在新令牌落盘前被强杀，外部令牌可能已经轮换，仍可能需要重新登录；不承诺跨服务商事务或 exactly-once。正式安装升级和旧执行库转换也不属于本次验收，后续队列见[路线图](../../roadmap.md#6-立即执行队列)。
