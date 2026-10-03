# Agent 输入器样式核对（2026-09-10）

范围：参考用户提供的 Codex 输入框高度和中性色样式，调整现有 Electron 输入器；保留 Suiming 的文案、引用、发送和草稿行为。

## 参考与证据

- 参考：`/var/folders/zn/xjgtn2z96n7074qg4kd_br180000gn/T/codex-clipboard-71909f4c-228f-4814-8fd1-050ecd39ae32.png`，1054 × 364px。
- 参考中的输入框约 738 × 198px；按 2 倍屏幕密度估计为 369 × 99 CSS px。
- Electron 视口 1460 × 940 CSS px，deviceScaleFactor 2；将右栏临时调至 402px 后，实际输入框为 369 × 104 CSS px。截图中的引用条和外围留白不计入输入框高度。
- 同一比较输入同时查看参考图、`/tmp/suiming-composer-ref-after-empty.png`（802 × 336px）及 `/tmp/suiming-composer-ref-after-filled.png`（766 × 340px）。比较相同宽度、浅色主题和空输入状态；填写状态用于检查中文换行。
- 完整工作台：`/tmp/suiming-composer-ref-workbench.png`；局部检查：`/tmp/suiming-composer-ref-narrow.png`、`/tmp/suiming-composer-ref-expanded.png`、`/tmp/suiming-composer-ref-long.png`。

## 比较记录

原实现输入框高 146px、绿色发送按钮；修改后空输入高 104px，圆角 20px、浅灰描边、轻阴影，按钮为深色底和白色箭头，引用及焦点反馈均为中性色。

第一轮：空输入、普通草稿、窄栏和展开状态符合本次范围。长文本截图发现 [P2] 滚动后上方内边距随文字移走，文字贴近顶边；应将上方留白放到滚动区域外，再复查。

第二轮：将上方 14px 留白移到 textarea 外部，文字滚动区域始终距外框顶边 15px（含边框）。在同一比较输入中重新查看参考图、`/tmp/suiming-composer-ref-empty-final.png`（802 × 336px，空输入仍为 369 × 104 CSS px）、`/tmp/suiming-composer-ref-long-final.png` 和完整工作台 `/tmp/suiming-composer-ref-workbench-final.png`（2920 × 1880px）。长输入滚动区域高 266px，scrollHeight 1782px；短输入尺寸、灰色反馈和黑白发送按钮保持一致。第一轮 P2 已解决，没有剩余 P0/P1/P2 问题。

## 必查项

- 字体：沿用 macOS / 中文系统字体，15px / 22px；保留现有较清晰的灰色提示文字。
- 间距：短输入约 104px，高于参考估计值约 5px；发送按钮 32px，略大于参考估计值，保留可点击面积。属于有意的产品适配。
- 颜色：黑白与中性灰；不改变输入器外的产品主题色。
- 资产：复用已有 Lucide 箭头，没有新增图像资产，也不复制参考中的语音、模型和附件控件。
- 内容：保留 Suiming 的上下文提示、快捷键和引用内容；不复制 Codex 专属功能。

## 验证

构建、Web 类型检查和文档检查通过。已验证空输入、长输入内部滚动、窄侧栏、展开与收回，原草稿和 384px 右栏宽度已恢复，renderer 无 pageerror。没有发送委托。

final result: passed
