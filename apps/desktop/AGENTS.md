# apps/desktop：Electron 主进程与桌面 E2E

改这个目录之前先读完本文。全仓通用的命令、提交与测试纪律见根目录的 [AGENTS.md](../../AGENTS.md)；主进程启动时解析系统代理、用 `shell.openExternal` 打开登录链接这两件事的来龙去脉见 [packages/runtime/AGENTS.md](../../packages/runtime/AGENTS.md)「模型与凭据」。

## 主进程与 IPC

- `workspace.show` 是 renderer 的根查询，turn 期间每 100ms 就会被刷一次：正文时效（`storyText`）由 `textCurrencies` 从 git 历史派生，`LocalWorkspace` 按 head 缓存一次 promise，`LocalProjectService.historyReader()` 再按 revision 缓存 `fileDigests`；派生失败只标 `derivedError`。目录读取走 `OpenStoryDirectoryCache`（按文件状态复用字节，投影按字节对象记住），斗破上 48ms → 11ms；**检查、提交与 turn 开场的扫描不要走这个缓存**——视图旧一拍下一次就纠正，提交读到旧字节就坏作品。不要在 show 里再 `openRuntimeSession()`，也不要让它因派生失败而整体失败。
- `LocalProjectService.init` 里锁先于校验建出 `.suiming`，校验失败时若这个目录原本不存在就整个删掉，否则作者的旧仓文件夹会留下一个空 `.suiming`（2026-09-09 打开一个旧仓作品时发生过）。同一处 catch 还会收回 scaffold 刚补的文件（`initWithStarter` 的 `written`，CLI 的 `suim init` 也走这条路），桌面主进程再把 `invalid_document` 的 diagnostics 翻成中文；旧仓格式不做 importer。`suiming:choose-project` / `open-project` 与 `suiming:command` 一样返回 `{ok, value|error}`，preload 统一 unwrap，否则 renderer 看到的是 Electron 的 "Error invoking remote method" 前缀。
- 桌面「打开作品」对没有 `.suiming` 的目录就地 init（scaffold 幂等，只补缺失的 index.yaml）；既非空又没有作品文件的目录拒绝，避免误选 `~/Documents` 时往里写东西。`openProject` 串成一条 promise 链，连续切换作品不会交错。
- **自定义属性过不了 contextBridge。**preload 抛给 renderer 的 Error 会被复制，只留 message 与 stack（2026-10-02 在 Electron 42 上实测：`code`、`diagnostics` 都丢）。preload 一直给 Error 挂 `code`，renderer 从来没拿到过，只是没人读所以没发现；做桌面检查诊断时撞上。所以 `suiming:command` 失败时 preload 抛的是普通对象 `DesktopCommandFailure`（普通对象按键复制，能过），`apps/workbench/src/bridge.ts` 的 `invoke` 再还原成带 `code` / `diagnostics` 的 `CommandError`。renderer 只经那个 `invoke` 调命令；E2E 里直接 `window.suiming.invoke` 时拒绝值不是 Error，按 `{code, message}` 读。其余几个 bridge 方法只需要 message，仍抛 Error。

## 桌面 E2E

- **启动一律经 `apps/desktop/test/launch.ts` 的 `launchDesktop`。**它把 `SUIMING_CONFIG_PATH` / `SUIMING_AUTH_PATH` 指到这次测试的临时目录，去掉开发 shell 里的 `SUIMING_*`、各家 API key 与 Langfuse / OTel 变量：2026-10-04 之前只有设置页这样做，其余用例读的是维护者本机的 `~/.suiming`，结果随本机配置变。渲染层报错用 `collectPageErrors` 收、结尾断言为空；断言「提示没出现」用 `assertNoTooltip`（等一会儿再数会在 Tooltip 的 400ms 延迟下空过）；等主进程状态用 `eventually` / `waitForSessionIdle`——**`page.waitForFunction` 不 await 异步谓词**，返回的 Promise 是真值，立刻放行，模型选择测试里两处等待因此一直是空等。
- **失败先查是不是测试没跟上产品，不要默认记成「环境问题」。**2026-09-11 的 `de3ee55` 让模型选择器只列已配置且启用的提供商、把「尚未连接」改成「未配置凭据」，「设置页」E2E 却还要在无凭据环境里先选一个 DeepSeek 模型——之后每次整套跑都失败，被记成「缺凭据、开发 shell 的环境变量漏进来」记了两周多。判别办法：单跑同一条，看失败点是断言文本 / 流程还是时序；稳定失败就是测试或产品真的不对。
- **选元素用语义属性（`data-beat`、`data-volume`、`data-axis-band` 这类），不要按样式值。**故事轴 E2E 曾用 `rect[fill="#fafafa"]` 找背景带，2026-09-16 开 `no-raw-colors` 把它换成 `var(--muted)` 后这条 E2E 就一直超时，而那次提交只跑了 check 与单测。改颜色、类名、尺寸这类样式后要跑 `npm run test:desktop`。
- **缩窗或 reload 之后不要立刻 `count()`。**「提示」用例曾在 `setSize` 到 960×640 后立刻数左栏按钮，拿到的是回流前的快照，负载高时两种导航形态都数不到、或数到缩窗前的旧按钮；「先等三个入口之一出现再分支」也不够，旧布局同样满足那个等待。要先等渲染进程看到新宽度、再等两帧让 ResizeObserver 与重渲染落地，然后才分支（2026-10-02，「分栏调宽」那条同形）。
- **会被宿主机的真实光标干扰。**窗口出现、拿到或失去焦点、reload、改大小让光标进出窗口时，macOS 按真实光标的位置给页面送 pointerover / pointerout / pointermove，与 Playwright 经 CDP 注入的事件交错：光标恰好停在带提示的控件上，就多弹一个提示或抢走测试的悬停。「提示」那条两周来的偶发超时就是它，单跑难复现、整套里偶发（2026-10-02 查清，放宽窗口后页面收到的事件坐标与测试鼠标差的正是窗口在屏幕上的偏移）。`setIgnoreMouseEvents` 挡不住；`apps/desktop/test/entry.ts` 把每个测试窗口放到真实光标右侧，测试只从左上角往右下改大小，光标就始终在窗口外。新写的 E2E 若调 `setPosition` / `setBounds` 把窗口挪回光标底下，这类偶发会回来。查悬停类偶发时先在页面上记一份 pointer 事件，看有没有不是测试发的坐标。跑 E2E 时把鼠标移进测试窗口仍会干扰，那是真实操作。
- 宿主屏幕锁定时 macOS 不让窗口进全屏，「分栏调宽」会卡在全屏那一步；解锁后补跑即可。
- **faux 回复不要用计时器和界面操作赛跑。**「连续对话」曾让被停下的那次回复先睡 1.5 秒、赌「停止」点击先到；负载高时点击晚到，停止落空，两条回复同文，strict mode 报错，被记成偶发失败两周多。它还藏住了一个产品缺陷：停止落在请求记为 `effect_pending`、实际还没发出时，下一句会停在「模型请求结果待确认」（2026-10-01 修掉，回归在 `agent.test.ts`）。要让操作落在请求进行中，faux 回复就等 `options.signal` 的 abort，或者等 `entry.ts` 里的测试闸门（`gate(name)`，测试用 `launch.ts` 的 `openGate` 放行；2026-10-04 把首条回复的 1200ms、对话框测试的 700ms 与 1800ms 三处 sleep 换成了闸门）；要验证停止落在某个确定时刻的结果，就去单测里用 `saveExecutionObject` 钩子把停止钉在那次 checkpoint 上。
- **交付界面改动时，要确认作者正开着的那个窗口真的更新了。**重新构建不会刷新已经打开的 renderer：先确认作者的输入已保留，再刷新 renderer，并看新分类、主题色与入口在窗口里实际可见；不能只拿隔离测试的截图说作者当前的窗口已经更新。
