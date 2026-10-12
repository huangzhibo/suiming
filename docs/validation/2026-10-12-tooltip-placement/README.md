# 悬停提示的位置与方向检查

日期：2026-10-12。范围为桌面提示的锚点、方向、遮挡及边缘避让，不调整作品内容或既有可视化结构。使用公开三国示例；长路径用例另加临时辅助文件，不是作者数据。

## 发现与修正

1. 人物全书分布把整条控件当作锚点：即使选中最左端情节，提示仍在中央并挡住下方卷标题。改为锚定当前标记、优先向上；鼠标与键盘切换都同步位置，控件仍只有一个 Tab 入口。
2. 共享提示对左右箭头强制垂直居中，覆盖 Base UI 的避让坐标。移除该覆盖，仅设置箭头垂直于边的偏移；弹层避让后箭头仍指向触发对象。
3. 关系图节点向下弹出会遮住同列其他节点。改为左右节点分别向外侧显示，空间不足时自动翻转。人物序号重复的原生 title 移除，序号说明保留在情节入口的统一提示中。

## 方向与检查范围

| 场景 | 首选方向 / 锚点 | 验证 |
| --- | --- | --- |
| 顶部工具栏 | 下方 / 按钮 | 大纲提示，箭头对齐 |
| 左侧全局动作、大纲、文件树 | 右侧 / 完整条目 | 打开故事轴、设置、情节行、长路径 |
| 底部发送按钮 | 上方 / 按钮 | 输入测试文字后悬停，不发送 |
| 人物卷目录 | 左侧 / 当前卷 | 卷名、范围、计数及定位说明 |
| 人物全书分布 | 上方 / 当前标记 | Home、End、秘密节点鼠标预览；1460×940 与 960×640 |
| 关系图 | 左列向左、右列向右 / 当前节点 | 情节页两侧 SVG 节点 |
| 故事轴卷标题 | 下方 / 卷按钮 | 完整卷名和进入说明 |

几何回归要求：提示距窗口至少 8px（允许 1px 测量误差）、不覆盖触发对象、箭头沿边坐标误差小于 3px；长路径用例必须实际触发垂直偏移，避免只测居中常态。切换提示时等待目标自身打开，不能把前一个提示误认为新提示。保留现有 Escape、移入提示阅读、禁用原因与截断补全回归。

## 截图

- [修正前：首个标记的提示偏在中央](images/before-distribution.jpg)
- [修正后：首个标记](images/distribution-home.png)、[最后一个标记](images/distribution-end.png)、[秘密节点](images/distribution-secret.png)、[窄窗末端避让](images/narrow-distribution-end.png)
- [顶部向下](images/toolbar-bottom.png)、[左侧向右](images/actions-right.png)、[底部按钮向上](images/composer-top.png)、[人物目录向左](images/character-rail-left.png)
- [关系图修正前的向下遮挡](images/graph-node-bottom.png)、[左列向外](images/graph-node-left.png)、[右列向外](images/graph-node-right.png)、[窄窗自动翻转](images/graph-edge-flip.png)
- [故事轴卷标题](images/story-axis-volume.png)、[大纲条目](images/outline-right.png)、[长路径底部避让](images/long-path-bottom-edge.png)

## 验证结果

- `npm run check` 通过。
- 工作台单元测试 68 / 68 通过。
- 完整桌面 E2E 29 / 29 通过（含新增提示几何回归）。
- 当前桌面窗口刷新后复验 Home / End 对应的标记提示，见[当前窗口末端预览](images/current-desktop-end.jpg)。

修正前的构建在新增分布方向断言上失败（实际 bottom，要求 top）；修正后通过。方向逐场景设置，未把所有提示统一成同一方向，也未改动关系图、经历线和作品数据。
