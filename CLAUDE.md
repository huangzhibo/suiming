# Suiming：Claude Code 工作约定

规范真源是 AGENTS.md：产品目标、核心不变量、工程边界、当前阶段都在那里，跨 agent 共用，本文件不复制它。这里放改代码时需要、AGENTS.md 又没写的东西：命令、检查脚本的隐含约束、提交规则、测试纪律和踩坑得来的决定。内容不只写给 Claude Code，AGENTS.md 链到这里，人和其他 coding agent 改代码前也读。

@AGENTS.md

## 开工前

- 队列只看[路线图](docs/roadmap.md)第 6 节「立即执行队列」。
- 动手前对照 [Harness 设计](docs/harness-design.md)第 16 节的拆除清单，避免重建已被推翻的层；TUI 也已删除，不要重建。ADR 是历史：ADR-0009「收敛」节里的 Worker claim、DesignCommit、MaterialEvidence、三方合并做 rebase、保留 TUI 都已被推翻，不要拿它当规范对照。

## 常用命令

```sh
npm run check        # docs 链接、生成文件对账、story 隔离、biome、tsc（含测试源码）、设计系统 lint、integrations 对账
npm test             # node --test 全部包；需要真实 PostgreSQL / S3 / 双进程的用例默认 skip
node --import tsx --test packages/runtime/test/agent.test.ts   # 单个测试文件
npm run build        # tsc -b --force
npm run format       # biome 自动修
npm link -w @suiming/cli   # 全局 suim 指向本仓；旧仓同名，只能有一个在 PATH 上
npm run dev:api      # Cloud 开发进程（只剩 Canon 与同步），读 .env
node --import tsx apps/cli/src/bin.ts --json status    # 从源码跑 suim
npm run test:desktop   # 构建 renderer + 真实 Electron E2E；只改测试时可直接 node --import tsx --test apps/desktop/test/desktop.test.ts
cd apps/web && npx shadcn@latest add <component>   # 生成 shadcn/ui 组件到 src/components/ui，之后跑 npm run format
npm run regression:harness -- --only check-issues --trials 1   # 真实模型回归，节奏见下
```

- workspace 包的 exports 指向 dist。测试和 CLI 里 `@suiming/*` 的跨包 import 走 dist，改了 packages/* 之后先 `npm run check`（其中 `tsc -b` 会重新 emit）或 `npm run build` 再 `npm test`，否则测的是旧代码。包内测试用 `../src` 相对路径，不受影响。
- 跑被 skip 的集成测试：按 .env.example 设 `SUIMING_TEST_POSTGRES_URL`、`SUIMING_TEST_S3_*`、`SUIMING_TEST_DURABLE_PROCESS=1`，需要一次性的 PostgreSQL 与 MinIO。
- 真实模型调用：`~/.suiming/config.toml` 是作者的配置，.env 里的 `SUIMING_*_MODEL_*` 覆盖它（桌面开发启动、CLI、回归都读 .env）。2026-10-02 起作者默认用 `openai/gpt-6.1-sol`（ChatGPT 订阅，思考 high），.env 只留评委覆盖（DeepSeek，不让 GPT 给自己的稿子打分）；在那之前的回归记录与留出评测都是 DeepSeek 跑的，换模型后第一轮是新基线。订阅额度与作者自己的 Codex 共用，全套回归、长抽取别无谓地跑。.env 已 gitignore。
- `regression:harness` 在样例作品的副本上从外面驱动 `suim session send`，只用确定性信号判分（turn 结束对账、版本、Checker、审稿引文锚定），报通过率不报红绿。**跑的过程中不要 `npm run build` / `check` / `test:desktop`**：每个任务起新的 `suim` 进程读当时的 dist，2026-10-01 第一次跑就因为中途 `tsc -b` 混进了两种构建，结果作废；脚本现在记下 commit 与 dist 指纹，变了就停。**节奏（2026-10-02 作者嫌拖慢开发后定）**：不先跑基线，上一次记录的结果就是基线；改 prompt、工具描述或 loop 之后只用 `--only` 跑相关任务、`--trials 1`，放后台，不需要构建的活照常做；全套 `--trials 3` 只在节点上跑——真实长篇运行之前、发版之前、改 loop 或上下文管理之后。全套一轮在 DeepSeek 上 10–15 分钟，在 GPT-6.1 Sol（思考 high）上一个多小时（2026-10-03 实测），期间不能构建；放后台时把超时设到两小时，默认一小时会在最后几项被停掉。

## 检查脚本的隐含约束

`npm run check` 的十道闸里，六个脚本在 scripts/ 下，任一失败都让整条链失败：

- check-docs：全仓所有 .md 的相对链接必须指向存在的文件，本文件也在内。
- check-constitution：`packages/story/src/constitution.ts` 是从 `strategies/story-constitution.md` 生成的，改了宪法要跑 `npm run generate:constitution`，不要手改生成文件。
- check-story-language：`packages/story/src/story-language-docs.ts` 是从 story-language/*.md 生成的，改了 Story Language 文档要跑 `npm run generate:story-language`。Agent 经 `story_guide` 的 `topic` 读它，`suim init --agent` 把同一份写进作品仓给 host 读——2026-10-02 之前只有 CLI 的 host-files 嵌了一份，Agent 只看得到字段形状，抽斗破时 Beat 写成速记、人物档写成编年、一个秘密都没声明。
- check-host-files：`apps/cli/src/host-files.ts` 是从 integrations/shared/suiming/SKILL.md 与 integrations/codex/agents/*.toml 生成的，改了 Skill 或 agent 要跑 `npm run generate:host-files`，不要手改生成文件；`suim init --agent` 与 `suim update --agent` 写进作品仓的就是它加上 Story Language 文档。
- check-story-isolation：packages/story/src 禁止 import node:fs / sqlite / child_process / net / http、fastify、pg、kysely、commander、pi-ai。
- check-host-integrations：要核对的命令片段由脚本从 `SUIM_CLI_COMMANDS` 生成（`cloud.*` 除外），增删 `suim` 子命令时只需让 integrations/shared/suiming/SKILL.md 写出对应的 `suim --json <命令>`，不用改脚本；三个 host README 也要含安装路径与 smoke check。
- check:design-system 不是 scripts/ 下的脚本，是 `apps/web` 的 ESLint（`eslint.config.mjs`），只跑 `@shadcn/lint` 的设计系统规则。**两个 linter 分工固定**：通用 lint 与格式全归 biome，ESLint 只管 Tailwind / shadcn 的设计系统面，规则面不重叠。不要往 `apps/web/eslint.config.mjs` 里加 `@typescript-eslint` 或 `react` 的 preset——那才会变成第二套通用 linter。目前只开了 `no-raw-colors`（2026-09-16），其余规则开不开由作者定，可用规则见 <https://github.com/shadcn-ui/lint/blob/main/docs/rules.md>。组件与主题由插件自己从 `apps/web/components.json` 发现，所以没有 `settings.shadcn`。
- biome 只覆盖 apps/*/{src,test}、packages/*/{src,test}、scripts/*.mjs；tab 缩进，行宽 120。`apps/web/eslint.config.mjs` 在这个范围之外，biome 不管它的格式，手写时照 tab / 120 列来。tsconfig 开了 exactOptionalPropertyTypes、noUncheckedIndexedAccess、verbatimModuleSyntax：NodeNext 相对 import 写 `.js` 后缀，类型用 `import type`，可选属性不能显式赋 undefined。

## 提交与完成规则

- 一个提交只做一个任务或明确子任务；机械重命名、行为变更、文档决策分开提交。
- 每个任务先补验收测试，再更新当前状态；未经真实模型验证的能力留在「机制」等级，不写成已完成。验收与风险相称：恢复与事务用故障注入，界面用真实交互，文档修改查链接与规范一致性。
- 完成一步后各更新一处，三份各管一样：docs/current-status.md 管能力、已知缺陷与测试数；docs/roadmap.md 第 6 节管队列；docs/changelog.md 管发生了什么。AGENTS.md「当前阶段」与 README 顶部「当前状态」引用块只写阶段级摘要并链接，只在阶段变化时改——以前要求同步四处，四份副本照样漂移了。
- 提交信息用 `type(scope): 中文摘要`，Harness 切片字母或 ADR 编号放在结尾括号，如 `（C）`、`（ADR-0013）`。正文写为什么；删除测试时写明它守的是什么、为什么不再需要。
- 设计原型不进生产 `apps/web`，直到视觉方向被选定；生产代码不复制 mock domain model。
- 不提交 .env、API key、Langfuse key、Local SQLite、trace payload、真实用户数据或未脱敏作品。
- 仓库是公开的：文档不写作者所在地区、代理出口与本机路径；作品副本放在哪个目录这类维护者本机信息不进仓库。

## 测试纪律（本仓特有）

- 测试 helper 是 test/ 目录下的普通文件，按相对路径引用：story 层 fixture 在 packages/story/test/fixture.ts，唯一的样例作品在 packages/runtime/test/sample-work.ts（2 个 StoryBeat）。曾做过独立 `@suiming/testing` 包和 `@suiming/runtime/testing` 子路径导出，都因为是第二套机制或污染产品导出面被删，不要再建。
- 被删模块的测试随模块删除，不留空壳。不加只测 in-memory 假对象、或断言临时空洞（如「Worker 零 executor」）的测试；冻结面只保留能发现真问题的测试。
- 真实 provider 暴露的每种 malformed output 都要有等价回归，由 Checker 或 tool contract 拒绝，不靠改 prompt 兜底。
- **`packages/cloud-postgres` 与 `apps/api` 的集成测试默认 skip，改 Cloud schema 后要真跑一遍**：起一次性容器（`docker run --rm -e POSTGRES_PASSWORD=... -p 127.0.0.1:54329:5432 postgres:18.6-alpine`），设 `SUIMING_TEST_POSTGRES_URL` 跑 `packages/cloud-postgres/test/migrator.test.ts`，跑完停掉容器。2026-09-14 这么做才发现 `migrator.test.ts` 从 2026-09-13 的 `004_drop_execution` 起就在断言早已删除的 `tasks` / `task_leases` / `run_events`——skip 掉的测试不会告诉你它坏了。
- YAML 把 64 位纯数字的 sha 解析成数字，`material_sha256: 000…0` 会被 schema 拒绝；测试里造假 sha 用 `"f".repeat(64)`。

### 桌面 E2E

- **失败先查是不是测试没跟上产品，不要默认记成「环境问题」。**2026-09-11 的 `de3ee55` 让模型选择器只列已配置且启用的提供商、把「尚未连接」改成「未配置凭据」，「设置页」E2E 却还要在无凭据环境里先选一个 DeepSeek 模型——之后每次整套跑都失败，被记成「缺凭据、开发 shell 的环境变量漏进来」记了两周多。判别办法：单跑同一条，看失败点是断言文本 / 流程还是时序；稳定失败就是测试或产品真的不对。
- **选元素用语义属性（`data-beat`、`data-volume`、`data-axis-band` 这类），不要按样式值。**故事轴 E2E 曾用 `rect[fill="#fafafa"]` 找背景带，2026-09-16 开 `no-raw-colors` 把它换成 `var(--muted)` 后这条 E2E 就一直超时，而那次提交只跑了 check 与单测。改颜色、类名、尺寸这类样式后要跑 `npm run test:desktop`。
- **缩窗或 reload 之后不要立刻 `count()`。**「提示」用例曾在 `setSize` 到 960×640 后立刻数左栏按钮，拿到的是回流前的快照，负载高时两种导航形态都数不到、或数到缩窗前的旧按钮；「先等三个入口之一出现再分支」也不够，旧布局同样满足那个等待。要先等渲染进程看到新宽度、再等两帧让 ResizeObserver 与重渲染落地，然后才分支（2026-10-02，「分栏调宽」那条同形）。
- **会被宿主机的真实光标干扰。**窗口出现、拿到或失去焦点、reload、改大小让光标进出窗口时，macOS 按真实光标的位置给页面送 pointerover / pointerout / pointermove，与 Playwright 经 CDP 注入的事件交错：光标恰好停在带提示的控件上，就多弹一个提示或抢走测试的悬停。「提示」那条两周来的偶发超时就是它，单跑难复现、整套里偶发（2026-10-02 查清，放宽窗口后页面收到的事件坐标与测试鼠标差的正是窗口在屏幕上的偏移）。`setIgnoreMouseEvents` 挡不住；`apps/desktop/test/entry.ts` 把每个测试窗口放到真实光标右侧，测试只从左上角往右下改大小，光标就始终在窗口外。新写的 E2E 若调 `setPosition` / `setBounds` 把窗口挪回光标底下，这类偶发会回来。查悬停类偶发时先在页面上记一份 pointer 事件，看有没有不是测试发的坐标。跑 E2E 时把鼠标移进测试窗口仍会干扰，那是真实操作。
- 宿主屏幕锁定时 macOS 不让窗口进全屏，「分栏调宽」会卡在全屏那一步；解锁后补跑即可。
- **faux 回复不要用计时器和界面操作赛跑。**「连续对话」曾让被停下的那次回复先睡 1.5 秒、赌「停止」点击先到；负载高时点击晚到，停止落空，两条回复同文，strict mode 报错，被记成偶发失败两周多。它还藏住了一个产品缺陷：停止落在请求记为 `effect_pending`、实际还没发出时，下一句会停在「模型请求结果待确认」（2026-10-01 修掉，回归在 `agent.test.ts`）。要让操作落在请求进行中，faux 回复就等 `options.signal` 的 abort；要验证停止落在某个确定时刻的结果，就去单测里用 `saveExecutionObject` 钩子把停止钉在那次 checkpoint 上。
- **交付界面改动时，要确认作者正开着的那个窗口真的更新了。**重新构建不会刷新已经打开的 renderer：先确认作者的输入已保留，再刷新 renderer，并看新分类、主题色与入口在窗口里实际可见；不能只拿隔离测试的截图说作者当前的窗口已经更新。

## 踩坑得来的决定

AGENTS.md 与设计文档没有写、改代码时会撞上的。来龙去脉已写进设计文档的，这里只留「不要做什么」、守它的测试与链接。

### 界面（apps/web）

- `apps/web` 用 shadcn/ui + Tailwind v4（2026-09-08 作者决定，替代手写 CSS）。CLI 生成的组件把 `cn` 写成 `from "cn"` 并装了同名 npm 包，要改回 `@/lib/utils`；生成文件是双引号两空格，提交前跑 `npm run format`。
- `exactOptionalPropertyTypes` 下 radix 可选 prop 需要 `?? false` 之类兜底。tsconfig 不能再写 `baseUrl`（TS 6 报废弃错误），`paths` 直接相对 tsconfig。
- `-webkit-app-region` 的 `drag` / `no-drag` 必须用 `@utility` 声明，`@layer components` 里的自定义类不能被 `@apply`。
- 根字号必须保持 16px（正文字号在 body 上单独设 13px）：Tailwind / shadcn 的 `size-8`、`w-12` 都是 rem，改了根字号所有标称尺寸都会缩水，2026-09-08 曾因此把「32px 按钮」实际渲染成 26px 而不自知。
- 按钮里的 lucide 图标用 `className` 的 `size-*`（如 `size-[17px]`）指定尺寸，不要用 `size={…}` 属性：shadcn 的 Button / Toggle 基类带 `[&_svg:not([class*='size-'])]:size-4`，属性给的尺寸会被这条 CSS 压成 16px（2026-09-08 同一天踩了两次）。
- **会叠在别的层上的浮层组件（`popover`、`select`、`dropdown-menu`、`context-menu`）刻意去掉了退出动画**，只留打开动画：Radix 只让层栈最上面那层响应 Esc，而浮层在退出动画里仍挂在层栈顶，于是在设置框里连按两下 Esc（先关浮层、再关设置）时第二下被正在关闭的浮层吃掉，设置框关不掉（2026-09-30 查清，回归在 `model-picker.test.ts`）。重新 `shadcn add` 这几个组件会把 `data-[state=closed]:animate-out` 一组类带回来，要再删掉；顶层 Dialog 下面没有别的层，保留它的退出动画。
- `@layer components` 里的行样式**带死高度**：`.tree-row` 与 `.beat-row` 都是 `h-7`（28px），只给单行用。拿它们渲染两行内容（标题 + 路径）时高度压不住，相邻行会直接叠上——`empty-page.tsx` 的「最近访问」就这么坏了很久，三套测试全绿，是作者截图发现的。复用这两个类渲染多行时要加 `h-auto`（utilities 层压得过 `@layer components` 的 `@apply`），交互样式照旧复用。这类缺陷只能靠**几何断言**守住：E2E 里量包围盒（行高、相邻行是否重叠），按 role / 文本选元素永远发现不了。
- **全仓改名必须带上 `*.css`。**类名不过类型检查，E2E 按 role / 文本选元素也照样通过，所以 TSX 里的 `className` 改了而 `style.css` 没改时，`npm run check`、`npm test`、`npm run test:desktop` **全绿**，样式却整块失效。2026-09-13 把 `.director-composer` 改成 `agent-composer` 时漏了 CSS，输入框的 20px 圆角、边框、阴影和 `padding: 12px 16px 16px` 一起没了，看上去就是「贴着面板边」——是作者发现的，不是测试。改名脚本的文件表要列全（`*.css` / `*.json` / `*.html` 都算），改完 grep 一遍旧名确认归零。历史验收记录（如 `docs/validation/**/measurements.json` 里的 span 名）是当时的事实，不跟着改。
- Renderer 的反向链接、身份计数、谱与邻域图都从 `workspace.show` 透传的 frontmatter 派生（`apps/web/src/model.ts` 的 `deriveLinks`，键名决定目标种类），没有复制 Story Language 字段表；新增 frontmatter 引用键时在 `KEY_KINDS` 补一行即可。
- 逐段建议稿与 A / B 决策卡还没做，**但不是做不了**（以前写成「没有 Runtime 通道」，被读成了「不能做」），零件清单见[作者工作台设计](docs/web-product-design.md) 4.4 节「A / B 决策卡」。要做就从 Runtime 做通，**不要在 renderer 里用客户端状态伪造**。
- Markdown 渲染只有 `apps/web/src/markdown.tsx` 一处（Streamdown 2.x）：static 模式给阅读态与设计文档，streaming 模式只给正在流入的最后一条 Agent 消息。Streamdown 的元素自带 Tailwind utility 类，必须在 style.css 用 `@source "../../../node_modules/streamdown/dist/*.js"` 让 Tailwind 扫到（monorepo 提升到根 node_modules），否则列表 / 代码块 / 表格无样式；同时 p / h1–h3 / strong / em / a 用 `components` 换成裸元素，否则它的 utility 会压过我们 `@layer components` 里的字号行距。段号 `data-index` 在 `useLayoutEffect` 里按渲染出的 `<p>` 顺序打，不能用解析器位置：Streamdown 按块缓存，块内 position 不是全文位置。链接渲染成 span，renderer 打不开外部窗口。代码高亮 / mermaid / 数学是可选插件包（`@streamdown/code` 等），刻意没装。
- TanStack AI 客户端在本仓只做消息装配：`useChat` 的 `isLoading` **恒为 false**，它只在 `connection.joinRun` 与 `send()` 路径置位，而 `apps/web/src/bridge.ts` 的只读 attach 两者都没有（`send` 直接 throw）。流式状态一律取 `sessionGenerating`（由 RUN_STARTED / RUN_FINISHED / RUN_ERROR 派生）。2026-09-12 之前 `streaming` 一直传的是 `isLoading`，Streamdown 的流式开关从未生效。
- 两份 `@ag-ui/core` 并存：`@suiming/sdk` 用 0.0.59，`@tanstack/ai` 内嵌 0.1.1-canary.beta.0。我们实际发的 9 种事件类型在两版里一致，`bridge.ts` 里 yield 的类型转换靠这个成立；升级任一侧都要重新核对。`metadata.tanstack` 是上游保留命名空间，我们的扩展一律走 `metadata.suiming`。
- `validateProductEvent` 的白名单只约束 `suiming.*` 扩展面：CUSTOM 只放行 `suiming.session`，ACTIVITY_SNAPSHOT 的检查以 `activityType.startsWith("suiming.")` 为前提。标准 AG-UI 事件（含 `TOOL_CALL_*`）只过上游 `EventSchemas.parse`，不会被拦——别把这道闸当成「不会混进第二套协议」的防线。
- 编辑器是 CodeMirror 6（`apps/web/src/code-editor.tsx`），Monaco 已删：源码即真源，只做语法着色不隐藏标记。比较用 `@codemirror/merge` 的 MergeView：给了 onChange 时右侧可编辑并带 `revertControls: "a-to-b"`，这就是"逐块采纳 / 放弃改动"，不要另做 accept / reject 通道；版本页两侧只读。@codemirror/* 各包对 `@codemirror/state` 的要求会漂，出现 `commands/node_modules/@codemirror/state` 这种嵌套副本时 tsc 报 SelectionRange 类型不兼容、运行期整个编辑器崩成 "Something went wrong"，用 `npm ls @codemirror/state` 查并把 state 升到被要求的版本。E2E 选择器是 `.cm-editor .cm-content` 与 `.cm-mergeView`。
- finding 的段落锚点是 renderer 派生的（`apps/web/src/anchors.ts`）：取 evidence 里引号内的原文，在 remark 解析出的 paragraph 节点里找，段号 = paragraph 节点的文档顺序，与 Streamdown 渲染出的 `<p>` 顺序一致。Review schema 的 anchor 仍只到文件，不要为了段号去改 Reviewer 契约或 Story Language。审稿页的 finding 卡片不能整体做成 `<button>`：里面还有按钮，外层的可访问名称会包含内层文字，Playwright 的 `getByRole("button", { name: /在正文中打开/ })` 会点到外层（2026-09-09 踩过）。
- 故事轴（`apps/web/src/axis/`）：`layout.ts` 是纯函数，坐标一律是 index.yaml 的 ordinal，不是 id 数字（eval-022 第一卷顺序是 1 68 2 3 4 5 69 6 7）。审稿只锚一个 Beat 的画三角、覆盖多个 Beat 的画区间线，否则一份全书设计审稿会在每一列出现。列头是点击设时点、双击打开：dblclick 前必先触发两次 click，反过来放会先跳页。SVG 图元当按钮用统一走 `press()`，但 biome 看不见 spread 里的 role，列头 rect 要显式写 `role="button"` 并加 useSemanticElements 豁免；拖动处理放在 `setPointerCapture` 的把手上而不是 svg 上，否则 noStaticElementInteractions 报错。
- macOS 文件系统不分大小写：`axis/neighborhood.ts`（数据）与 `axis/Neighborhood.tsx`（组件）同时存在时 tsc 报 "differs only in casing"，组件文件叫 `NeighborhoodView.tsx`。根 `check:types` 会类型检查 apps/web/test，测试文件不能 import `.tsx`（没开 jsx），纯数据要拆成 `.ts` 再测。

### 桌面主进程与 IPC

- `workspace.show` 是 renderer 的根查询，turn 期间每 100ms 就会被刷一次：正文时效（`storyText`）由 `textCurrencies` 从 git 历史派生，`LocalWorkspace` 按 head 缓存一次 promise，`LocalProjectService.historyReader()` 再按 revision 缓存 `fileDigests`；派生失败只标 `derivedError`。目录读取走 `OpenStoryDirectoryCache`（按文件状态复用字节，投影按字节对象记住），斗破上 48ms → 11ms；**检查、提交与 turn 开场的扫描不要走这个缓存**——视图旧一拍下一次就纠正，提交读到旧字节就坏作品。不要在 show 里再 `openRuntimeSession()`，也不要让它因派生失败而整体失败。
- `LocalProjectService.init` 里锁先于校验建出 `.suiming`，校验失败时若这个目录原本不存在就整个删掉，否则作者的旧仓文件夹会留下一个空 `.suiming`（2026-09-09 打开一个旧仓作品时发生过）。桌面主进程在 init 失败时还会收回 scaffold 刚补的文件，并把 `invalid_document` 的 diagnostics 翻成中文；旧仓格式不做 importer。`suiming:choose-project` / `open-project` 与 `suiming:command` 一样返回 `{ok, value|error}`，preload 统一 unwrap，否则 renderer 看到的是 Electron 的 "Error invoking remote method" 前缀。
- 桌面「打开作品」对没有 `.suiming` 的目录就地 init（scaffold 幂等，只补缺失的 index.yaml）；既非空又没有作品文件的目录拒绝，避免误选 `~/Documents` 时往里写东西。`openProject` 串成一条 promise 链，连续切换作品不会交错。
- **自定义属性过不了 contextBridge。**preload 抛给 renderer 的 Error 会被复制，只留 message 与 stack（2026-10-02 在 Electron 42 上实测：`code`、`diagnostics` 都丢）。preload 一直给 Error 挂 `code`，renderer 从来没拿到过，只是没人读所以没发现；做桌面检查诊断时撞上。所以 `suiming:command` 失败时 preload 抛的是普通对象 `DesktopCommandFailure`（普通对象按键复制，能过），`apps/web/src/bridge.ts` 的 `invoke` 再还原成带 `code` / `diagnostics` 的 `CommandError`。renderer 只经那个 `invoke` 调命令；E2E 里直接 `window.suiming.invoke` 时拒绝值不是 Error，按 `{code, message}` 读。其余几个 bridge 方法只需要 message，仍抛 Error。

### 模型与凭据

- **模型调用要遵守系统代理，Node 的 `fetch` 默认不读那些环境变量。**`NODE_USE_ENV_PROXY=1` 只在 bootstrap 生效，进程内 `process.env` 设它无效。所以进程入口（`apps/cli/src/bin.ts`、Electron 主进程）各调一次 `useEnvironmentProxy()`（`model/proxy.ts`，装 undici 的 `EnvHttpProxyAgent` 作全局 dispatcher，没配代理时什么都不做）。**不要装进库或 gateway**——`setGlobalDispatcher` 是进程级副作用，测试反复导入时不该改全局网络行为。配了 `HTTPS_PROXY` 但没装 dispatcher 时请求根本不走代理，界面只看到一句 `fetch failed`，完全看不出代理没被用上（2026-09-13 实测）。
- **环境变量之外还有 macOS 系统代理**：从 Finder / 程序坞启动的桌面拿不到 shell 的变量，Node 也不读系统代理，于是直连。桌面主进程在 ready 之后第一步用 `session.defaultSession.resolveProxy` 问 Chromium 解析出的系统代理，`proxyFromPacResult` 取第一个 HTTP(S) 代理交给 `useEnvironmentProxy(system)`，环境变量优先；SOCKS 不接（undici 不支持）。实测从 Finder 无变量启动时请求走上了系统代理。`openai-codex` 2026-09-13 登录时被 403 拒绝就是因为直连：当时记成「这个 provider 用不了、不要再试」是误判，同一台机器上读系统代理的客户端一直能用（2026-10-02 查清）。登录或调用的网络失败，先查请求有没有走上作者的代理。产品只遵守作者自己的代理设置，不内置任何代理。
- **pi-ai 升级会改模型目录，配置里的模型 id 可能就此失效**（2026-10-02 从 0.84.4 升到 0.99.2）。DeepSeek 官方的 V4.1 Flash 在目录里叫 `deepseek-flash`，`deepseek-v4-flash` 从官方 provider 的目录里消失。产品显示的花费只是估算，**别拿它对账**，计价口径与旧 id 期间的记账偏差见[当前状态](docs/current-status.md)「花费是估算」那条。作者 `config.toml`、`.env` 与桌面 E2E 的配置里写着旧 id 的，升级后都是「找不到模型」，桌面「设置页」E2E 就因此等不到「还没有可用凭据」超时。这不加迁移层：目录本来会变，产品给出明确提示让作者重选即可；升级时 grep 一遍配置与测试里的模型 id。同一次升级还有两处形状变化：provider 与 faux 拿到的是折好的 transcript（系统提示与工具声明在开头那条 `system` 消息里，没有 `context.systemPrompt`），工具结果的 `details` 必须是 JSON 值；`openai` provider 多了 ChatGPT 订阅 OAuth，与 `openai-codex` 同源。
- 模型凭据只走 pi-ai 的 `Models.login`（[系统架构](docs/architecture.md)第 10 节），`LocalModelSettings` 把 prompt / notify 摊成可轮询的登录会话（`models.login.*`），窗口只转述。曾有一个直接写 key 的 `models.connect`，因为是第二套机制且绕过 provider 自己的多步 login（Cloudflare 要 account id）而删掉，不要再加。
- **凭据文件的 `modify` 持跨进程锁跑完整次 OAuth 刷新**（`json-file-credential-store.ts`）：pi-ai 约定刷新在 `modify` 里、全局只刷一次，OpenAI 的 refresh token 用过即作废，锁外刷新会让桌面与 CLI 各刷一次、后到的一方失败、作者被迫重登。不要为了「别占着锁等网络」把远端请求挪出锁——登录时浏览器里的等待本来就不在 `modify` 里。Codex 自己只在进程内单飞、刷新前重读磁盘，跨进程撞上时靠「refresh token was already used」报错与重读兜底，不是更好的参照。实测到哪一步见[当前状态](docs/current-status.md)「发行与认证」。
- pi-ai 自己不开浏览器：`auth_url` / `device_code` 的链接由主进程 `shell.openExternal` 打开（`LocalModelSettings({ openUrl })`），renderer 打不开外部窗口。`openai` / `openai-codex` 的 OAuth 回调固定监听本机 1455 端口，与 Codex CLI 共用，被占时退回手动粘贴回调地址。
- `SUIMING_AUTH_PATH` 与 `SUIMING_CONFIG_PATH` 对称，桌面 E2E 用它们把设置指到临时目录，并要从 launch env 里剔掉开发 shell 的 `*_API_KEY`（开发 shell 导出了某个 provider 的 key 时，「缺少凭据」永远不出现）。
- `session.send` 的启动预检用的是 `#controller()` 那一次初始化的 gateway，不要再调一次 `models()` 工厂，幂等测试数着初始化次数。
- 模型输出的 wire schema 保持平面 `Type.Object`，不用顶层 object union：qwen3.8-max 会把 union 下的数组序列化成字符串。字面量枚举可以用 union；verdict 与 findings 这类跨字段约束放在 parser 里查，不放在 schema 里。

### Harness 与执行

- 不要凭直觉给写作定按次的小上限：DeepSeek V4 Flash 每次只吐两三千字，一万多字的正文要 write 四五次、每次后跟一个 check（2026-09-06 按作者意见重写 beat-0004 时，当时 Writer 的 8 次上限在 submit 前耗尽，$0.037 白花）。契约里已写明可以多次 write 覆盖、check 只跑一次；也不要在工具层禁止多次 write。创作路径本来就没有预算，见 [Harness 设计](docs/harness-design.md)第 10 节。
- 会话开场与非 writer 子任务的初始 Context 是 `packages/runtime/src/artifact/design-frame.ts` 的 Frame（ADR-0008 决定 3，种子为空；设计视图与 rank 按 Beat 播种）：Design 超过 `DESIGN_FRAME_FULL_RENDER_CODE_POINTS`（2.4 万码点，占位值，真实长篇上实测调）才裁剪，否则全量。委派的 writer 拿的是 Write Context，不是 Frame。全书 Design Review 与 host 的 `context compile design` 仍是完整 Design，不要为了省 token 再去裁它。全书 Intent 与 world/core 作 seed 不扩散；非 Beat seed 涉及的 Beat 受 `DESIGN_FRAME_EXTRA_BEAT_CODE_POINTS` 预算，也是占位值。以后若要拿检索命中作 seeds，先滤掉常用词：长目标里的常用词会命中全书，eval-022 实测未过滤时 Frame 比全量还大（当时的过滤函数 `subjectsForSearchHits` 随固定配方失去调用点，代码随后删除）。
- 上下文清理只改请求投影，不改 `state.messages` 与 checkpoint，阈值与步骤见 [Harness 设计](docs/harness-design.md)第 7 节「窗口保护」。不要把它改成直接删消息；改之前会话会卡死在同一次溢出上，`context-window.test.ts` 四条守着。
- 没有 per-session worktree，理由与三个后果见 [Harness 设计](docs/harness-design.md)第 2 节，host 接入目录对模型不可见见第 6 节。改这一带时：不要为了「干净」给 `commit` 的 `ignored` 加白名单；新加 host 时 `ConfinedExecutionEnv` 的 `HOST_ADAPTER_ROOTS` 要跟上，`cli.test.ts` 核对；要并行就给 session 配可选工作目录，接口位置是 `HarnessSession.checkoutPath`。
- `HarnessSession.base` 是**已提交基线**（turn 开始时 head 的快照，阶段提交后推进），`session.scan()` 才是 checkout 里的当前候选。turn 开场的「权威作品状态」用 scan（`uncommittedChanges` 要真实），Design Frame 用 base（不能让未提交的候选冒充已提交作品）——这两处过去都读 worktree 基线，`uncommittedChanges` 因此恒为 0。
- running 的 Session 持有进程 lease，`LocalProjectService.open` 只收敛持有者已死的 Session（[Harness 设计](docs/harness-design.md)第 3 节）。测试里用 `execution.startTurn` 给一个 `hostname: "elsewhere"` 的 lease 模拟崩溃遗留；不要为了「同进程重开」再加时间过期或心跳。
- 作者消息走持久 inbox（[Harness 设计](docs/harness-design.md)第 3 节）。重发的 `session.send` 只拿回原回执，不再开一个什么都不做的 turn；命令的幂等指纹包含 `model`，同一 commandId 换模型是 `command_conflict`。
- 提交型工具的失败一律回到模型手里：Checker 拒绝是 `ToolRejection`，不是 turn 崩溃；只有持久化故障与三种 paused 原因往上抛。**Story 诊断由 loop 统一转**（2026-10-02）：任何工具里冒出的 `SuimError`（含 `StoryParseError`）在 `runTaskLoop` 收工具异常时经 `rejectionForToolError` 变成拒绝，工具不必自己记得转——之前 `read_source` / `source_coverage` 漏了，斗破抽取时 Design 里一处作用域写错就掀掉了 35 分钟的根 turn（子任务崩了，`childOutcome` 又不认这个码）。`ArtifactError` 刻意不在 loop 里一刀切：里面有 `session_owner_lost`、`local_project_closed` 这类执行状态故障，交给模型就成了在别人的 session 上接着跑，哪些能放行由工具自己判断（`requireDomain`）。读原文、查覆盖率只认原文与笔记，不连带校验整个 Source，抽取写到一半也能读。
- `dirty_checkout` 只剩要求干净 checkout 的几条路：managed ChangeSet（`suim release publish`、`source ingest`）与 `rollback`；Agent 的 `commit` 就是 `commitCheckout`，脏 checkout 正是它要提交的东西。Cloud 的 link / pull 另有自己的 `cloud_sync_dirty_checkout`。
- checkpoint 里停在 error / aborted / length 的模型响应在下一次续跑时撤回重发，不能把后面的每个 turn 都钉死在同一个错误上（2026-09-13 踩过）。
- 子任务的结果只能经持久化的 `TaskOutcome.result` 交回父 Agent，不能读工具闭包：续跑复用已完成的 Task 时没有闭包，只有结果对象。新增的 Task 输出要能从 `result()` 的 JSON 读回。
- Reviewer 子任务的读范围（`compileReviewContext` 的 `readable`）必须放行 `review/`：`submit_review` 经 `env.writeFile` 落盘，写也要过读权限，source 层曾因此报 `permission_denied` 且被 `ToolRejection` 吞成「未交付」，循环到 faux 响应耗尽。改 readable 时连同 `review/` 一起想。
- **执行命令只写自己的写集合**（2026-10-01）。`InMemoryExecutionState` 的 `commit` 收的是 `ExecutionStateDelta`：这条命令碰过的实体（取自回滚用的 `#undo`，每处修改都先 `#remember`）、删掉的 session 与它自己的回执，`SqliteLocalStore.applyExecutionDelta` 只核对并写这几行。原来每条命令整份 `exportSnapshot()`、整份重读两遍，faux 零延迟实测 100 轮后单轮簿记 0.63 秒、73% CPU 在这里。**不要回到整份快照**——整份写入 `saveExecutionState` 与 `InMemoryExecutionState` 自己的订阅 / `persist` 于 2026-10-02 删掉（只剩测试在用，「两个进程同时写」那条回归走的竟是它而不是产品路径）；测试造状态就给 `InMemoryExecutionState` 传 `commit: (delta) => store.applyExecutionDelta(delta)`，变更通知只有 `LocalProjectService.subscribeExecutionState` 一处；只读查询（`workspace.show` 每 100ms、session 列表、CLI）用 `loadExecutionEntities()`，不读回执。`agent.test.ts` 数着一个 turn 里整份导出与整份重读的次数，与工具轮数无关是它的闸。checkpoint 归档按 JSON 记住小节点的引用、事件流按 id 查索引，也是同一次量出来的；单轮耗时用 `docs/validation/2026-10-01-harness-review/bench.mts` 量。

### Canon、目录与存储

- **`LocalProjectService` 的 head 不是真源，canon ref 才是**（2026-10-01）。桌面、CLI 与 host 的 `suim commit` 是不同进程里的不同实例，作品锁只锁 open 与 commit，谁都会推进 `refs/suiming/canon`。原先注释假设「本服务是 canon ref 的唯一写入者」只缓存不重读，斗破运行时 CLI 提交到 r7、开着的桌面停在 r4，已提交的文件标成「候选未提交」，桌面里提交会因基线过期被拒、直到重开。现在需要准确 head 的异步操作都先 `refreshHead()`（服务内部、桌面每条作品命令、harness 每个 turn 开场与 `readProjectStatus`）；同步的 `project()` 只返回最后读到的值。不要为了省一次小文件读取把缓存改回去。
- `ProjectRevision` 只有 `{id, parentId}`，理由与实测见[系统架构](docs/architecture.md) 4.2。**不要往版本身份上加字段**——加一个就是加一次全树读取；`git-canon-real-work.test.ts` 断言 `Object.keys` 恰好是这两个。`history()` 仍按 head 缓存（与 `historyReader()` 同一份），因为它是每秒十次的查询。
- artifact 的 identity 与 path 都是扫描得到的事实，换卷是改 `index.yaml` 加 `mv` 文件两步，理由见[系统架构](docs/architecture.md) 4.1。手写 ChangeSet 的 create / replace 要自己填 `path`，`applyChangeOperations` 用 `identityForPath`（不看 index，所以不是自证）比对，拼错报 `path_identity_mismatch`。三个错误码（`noncanonical_story_path` / `path_projection_mismatch` / `story_beat_not_indexed`）与 `storyBeatVolumeById` 已删，不要重建。
- 按 identity 存 artifact 的 store 必须自己存路径：`InMemoryArtifactStore` 存在内部记录里，Cloud PostgreSQL 是 `revision_artifacts.path`（migration 006）。git 不用，tree 天然带路径。
- 审稿时效比 `subjects` 内容摘要，不比版本，理由见 [派生状态设计](docs/derived-evidence-design.md)。写审稿和判时效共用 `reviewSubjectPaths`，改主体范围时改一处；不要为了这个把 ContextSnapshot 加回来——摘要是审稿文件自己的字段，不是第二套记录。
- `source/<id>/notes/*.md` 不算 extraction：`inspectSource` 只把 story-index 等 extraction 种类当抽取，笔记单独按形状校验；否则只写了笔记的 Source 会报 `source_story_index_missing`。渲染给 Reviewer 的 extraction（`renderSourceExtraction`）也排除笔记，笔记在输入前半段按顺序单独渲染。
- 目录投影解码文本时要包含 `application/yaml` / json：`outline/story/index.yaml` 的 mediaType 不是 `text/*`，漏掉就会解析不到卷顺序（谱页显示 0 卷）。
- 目录扫描把根目录下非保留名的条目整个记为 `repository-auxiliary`（`scripts` 而不是 `scripts/count.py`），commit 结果里的 `ignored` 因此是目录名。
- TypeBox 1.x 对 `Type.Union(values.map(Type.Literal))`（数组而不是元组）推出的静态类型是 `never`，`review.ts` / `review-file.ts` 的 `literals()` 用 `Type.Unsafe<T>` 包一层保住联合类型；不要照着写新的裸 `Type.Union(array)`。

### 错误与 CLI

- CLI 的 exit code 从错误类别派生，不是手抄表：`errorCategory()`（`packages/sdk/src/error-category.ts`，正则规则加少量 overrides）定类别，`EXIT_BY_CATEGORY` 映射到退出码。新增 Runtime 错误码通常不需要动 CLI；只有当它落进错误的类别时才加一条 override。
- **错误信息的语言按「是不是 bug」分，不按包分**（2026-09-30 作者定）。作者正常操作就会撞到、原因在作者输入或环境的信息写中文；不变量被破坏的程序错误保持英文——作者不需要懂，看得懂英文的人也多。新增错误时按这两问判：作者正常操作会不会撞到？原因在不在作者输入或环境？都是就写中文。保持英文的是执行状态机、存储与 journal 损坏、内部契约校验、Cloud 运维、release 完整性校验、NFC 规范化与 API 参数校验，以及第三方原文（TypeBox 的 schema 错误、pi-ai）；commander 的内置错误由 `localizeCommanderError` 按模板翻，没命中的原样露出英文。**错误码永远不译**——`code` 是机器契约，`message` 是给人看的那半。改在源头而不是显示层按 code 映射：诊断带参数，`suim` 的 JSON 信封与 host agent 也要看到同一句话；这些诊断同时是模型的 `ToolRejection` 反馈，与中文的 Agent prompt / Skill 一致。排版：中文人名前不留空格（`提到了${character.name}`、`找不到人物：${id}`，人物 id 就是中文名），id、路径、字段名这类拉丁变量前后留空格。有 7 条测试断言诊断原文，改文案时一起改，断言里的标识符不能少。
