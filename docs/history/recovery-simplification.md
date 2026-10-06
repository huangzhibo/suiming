# 半途恢复简化

> 状态：2026-10-06 定稿并实施。现行规则见 [Harness 设计](../harness-design.md)第 3、5、10 节。

## 为什么改

Suiming 原来的恢复是「半途核对」：模型请求与每个动作都有一串持久状态（prepared → effect_pending → received / unknown），进程退出后逐个核对：
- 文件动作按 journal 的前后 hash 补做或补记；
- 提交按回执认领；
- 委派按父动作 id 找回子任务，自动从它的 checkpoint 续跑；
- 核对不了的就让 Session 停在 `paused` 等作者。

当初的理由是「我们一轮跑得长、子任务跑得久、作者不在旁边」。这几个理由都站不住：

- **Claude Code 与 Codex 一样长时间无人值守地跑**，被打断的工具调用只补一条「被打断」结果，不重跑、不核对，交给模型下一轮自己去看：
  - Claude Code 补的是 `[Request interrupted by user for tool use]`；
  - Codex 补的是 `aborted by user after 584.1s` 这一类（维护者本机 827 份 Codex 会话记录里有 234 次 `turn_aborted`，2026-10-06 查）。
- **子任务并不比它们的长。** 斗破 120 章那次对话 17 个子任务，中位数约 12 分钟、最长 35 分钟；Claude Code 在本仓的 147 个子代理，中位数 7 分钟，超过 30 分钟的有 18 个，最长 44 分钟。被打断的子代理可以带着原上下文接着做（SendMessage），做不做由父代理决定。

再按本仓自己的判据看（AGENTS.md「能力交给模型，可见性交给系统」）。必须结构性保证的，是「一旦失守直接坏作品」的行为；半途核对一项都不属于这一类：
- 写到一半的文件只是候选，提交前要过 Checker；
- 重复提交时第二次 diff 为空，不产生新版本；
- 没收到的回复里的工具调用根本不会执行。

它省的只是「不白做一遍」。这本该算优化，代价却实打实，下面这些缺陷都是这套机制直接惹出来的：

- 2026-10-04：动作停在 effect_pending 时撞上作者改同一个文件，每次续跑都撞同一个冲突，会话卡到文件被还原为止；
- 2026-10-01：作者的停止落在「请求记为已发出、实际没发出」的窗口里，下一句停在「模型请求结果待确认」；
- Harness 审查 F2：两轮之间升级了工具面，中途退出的会话恢复不了；
- 每个工具必须声明重放方式，漏写一个，会话每次续跑都停在同一点（`HarnessTool.replay` 因此改成必填）；
- 为了能从半途续上，模型与工具面要按 turn 冻结，换模型只能在 turn 边界，还要先核对掉未决副作用；
- 三种 `paused`、`session.resume`、`--retry-unknown` 与桌面的「重发」按钮，都只为这套核对存在。

## 新规则

1. **每一步照常保存 checkpoint**（这一点不变）：消息列表、模型回复、动作结果。
2. **恢复时不核对，补结果。**从 checkpoint 接着跑时：
   - 模型请求没收到完整回复：作废，回到 `ready`，用当前的消息列表（连同这期间作者说的话）重新组装、重新请求。发出过的请求照记一次「未确认的调用」，可能已经计费，作者在用量里看得见。
   - 一批动作里已有结果的照常交付；执行到一半的补一条「执行时被打断，不确定有没有生效」；还没开始的补一条「没有执行」。
   - 工具可以给自己的「被打断」结果补一句话（`interrupted` 钩子），只读不写：
     - `delegate` / `review` 说明子任务的 id、标题、做到第几次模型调用，以及怎么接着做；
     - `commit` 查回执，说清已经提交成哪个版本，还是没有提交。
   - 然后照常请求模型。重做、续做还是改做别的，由模型看着这些结果决定。
3. **子任务续做是模型的动作。**新工具 `resume_task { taskId }`：
   - 从子任务自己的 checkpoint 接着跑；已完成的直接交回保存的结果，不新建子任务。
   - 同一次回复里可以并行续多个，能不能并行沿用原委派的判定（读原文的 reader、分段抽取与补全）。
   - 父 Agent 的动作里保存着原委派的参数，续跑时按它重建子任务的工具与写范围，模型不用转抄。
4. **不再冻结模型与工具面。**恢复时一律用当前的模型、systemPrompt 与工具面；checkpoint 的 `binding`、`hasUnconfirmedEffects`、`binding_mismatch` 删掉。子任务的模型仍在创建时冻结，跑完为止（与作者换不换对话模型无关）。
5. **没有 `paused`**：Session 只剩 `idle` / `running`。
   - `session.resume`、CLI 的 `suim session resume [--retry-unknown]`、桌面的「继续 / 重发」按钮与「需要处理」的状态都删掉；
   - `interrupt` 在 paused 上「放弃核对」的分支一并删掉。
   - 2026-10-06 之前落盘的 paused session，打开作品时收敛成 idle，原因记进 `lastFailure`。
6. **模型流抛出的异常**（pi-ai 通常把错误转成回复，抛出很少见）：这次请求作废，turn 以 `model_call_failed` 回 idle，作者说一句就重新请求。原来它是 `model_call_unknown`，会让 Session 进 paused。
7. **作者停下正在跑的子任务**不再单独处理（原来的 `task_stopped_by_author` 删掉）。它和应用退出、用量检查点走同一条路：父 Agent 下一轮看到「子任务被打断」与作者的新话，决定续做还是改方向。

## 留下的

- **文件写入的前后 hash。** 它在同一次执行里核对「准备写入时的内容」与「落盘前一刻的内容」：作者与 Agent 同时改一个文件时报 `file_write_conflict`，交给模型重读再改，与崩溃无关。不再持久化的只是 journal：准备与落盘之间不再先存一次 checkpoint。
- **提交回执**（`Suiming-Command-Id` trailer）：被打断的 `commit` 靠它告诉模型提交了没有。
- **按 key 找已有子任务**：`resume_task` 与 `suim rank` 都用。
- **每轮用量检查点、进展型兜底、瞬时失败退避重发、上下文清理与压缩**：都不变。
- **边界折叠**原来按 `replay: "read"` 认可折叠的工具，改为工具声明 `rereadable: true`：同样的参数再调一次能拿回当前内容。

## 测试：删、留、改

先写新的验收测试，再改代码。

| 测试 | 处理 | 理由 |
| --- | --- | --- |
| harness-recovery「作者消息已存入 checkpoint 而消息发布失败时，恢复补齐同一条消息」 | 留 | 与动作恢复无关 |
| harness-recovery「进程在文件已改、结果未保存时退出：原动作 journal 续接，不重复相对修改」 | 改 | 新断言：被打断的动作得到「被打断」结果，不再执行第二次；没开始的得到「没有执行」 |
| harness-recovery「准备写入之后作者改了同一个文件：写冲突作为工具错误交给模型」 | 留 | 同一次执行里的冲突仍然存在 |
| harness-recovery「动作已落 journal 时进程退出、重启前作者改了同一个文件」 | 删 | 没有 journal 续接，被打断的动作不再重做，撞不上冲突；由上面「被打断」那条覆盖 |
| harness-recovery「已保存的终止结果可在新闭包中交付，不重复执行提交工具」 | 留 | 已有结果的动作照常交付 |
| harness-recovery「未知模型结果默认停下；显式重试保留旧调用记录与同一 loop」 | 改 | 新断言：发出后没收到回复的请求作废，下一句重新组装并带上新消息，记一次未确认调用，不停下 |
| harness-recovery「换绑只在没有未决副作用的边界发生」 | 改 | 新断言：停在一批动作中间时换了模型与工具面，照样续上 |
| harness-recovery「子任务完成后父 checkpoint 确认丢失：重启续跑只交还保存的结果」 | 改 | 新断言：父动作的「被打断」结果说子任务已完成；`resume_task` 交回保存的结果，不新建子任务 |
| harness-recovery「同一 turn 两次阶段提交；第一次 revision 已确认但动作结果丢失时」 | 改 | 新断言：被打断的提交按回执告诉模型已提交成哪个版本，不重复提交 |
| agent「模型结果未知才 paused；…」 | 删 | 没有 paused；作废重发由 harness-recovery 那条改过的测试守 |
| agent「半途恢复按这一轮冻结的工具声明…binding_mismatch」 | 删 | 不再冻结；由「换绑」那条改过的测试守 |
| agent「作者停下正在跑的子任务再说一句」 | 改 | 根 Agent 先看到「子任务被打断」与新的话，`resume_task` 能接着做 |
| agent「应用退出打断的子任务不算作者停下」 | 改 | 与作者停下走同一条路，下一句根 Agent 看到被打断的子任务，`resume_task` 从它自己的 checkpoint 接着跑完 |
| agent「用量检查点…落在子任务里不算失败，继续时从它自己的 checkpoint 接着跑」 | 改 | 继续时由根 Agent 调 `resume_task` |
| agent「子任务按 AG-UI 的 subagent 发事件：开始、完成、挂起与续跑…」 | 改 | 续跑经 `resume_task`，事件形状不变 |
| agent「interrupt：停止落在请求记为已发出、实际还没发出时…」 | 留 | 行为不变（原来靠退回 prepared，现在作废重发同样成立） |
| execution-state「session 只有 idle / running / paused」「paused 只能显式 resume…」 | 改 | 只剩 idle / running；lastFailure 在下一个 turn 开始时清掉 |
| execution-persistence「inbox：paused 拒绝，idle 与 running 都排队…」 | 改 | idle 与 running 都排队 |
| workspace「…保留 paused 的结构化原因」「paused 的 session：interrupt 放弃核对…」 | 改 | 失败原因以 `lastFailure` 保留；只留删除带走执行记录 |
| cli、desktop E2E、composer-state、run-presentation、domain-schema、error-category 里的 paused / resume 断言 | 改或删 | 跟着命令与状态删掉 |
| 新增：`resume_task` 一次回复里同时续两个被打断的 reader；不存在的 taskId 是工具错误 | 新 | 新工具的边界；把并行判定改成「不并行」时这条会失败 |
| 新增：2026-10-06 之前落盘的 paused session 打开后是 idle，原因在 `lastFailure` | 新 | 旧数据收敛 |
