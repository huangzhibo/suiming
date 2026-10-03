# 已确认方向：窄导航轨＋上下文栏

日期：2026-09-08。作者已确认导航方向。本轮使用内置 Image Gen，以失街亭 v3 和作者提供的树目录／导航轨截图为参考生成视觉稿；下方保存实际 prompt 与几何校正 prompt。静态图不代替可运行界面的像素、交互或可访问性验收。

## 生成

```text
Use case: ui-mockup edit. Create ONE finished Suiming desktop UI design, based on the attached prior 失街亭 concept. The USER HAS SELECTED ONE NAVIGATION MODEL: a fixed narrow icon rail + a contextual content sidebar. This is a refinement of that chosen direction, NOT three design options. Output one flat app screenshot, same 1488 x 1057 natural dimensions, no browser/device frame, marketing layout, exterior shadow or multiple screens.

Image1 is the previous Suiming screenshot: use as edit target for story workspace, preserve causal graph, source inspector, tables, selected node and paper/deep-green palette.
Image2 is the user's navigation reference: use ONLY its narrow left tool rail, indented tree, compact rows and pinned footer principles. Do not copy its filenames, account, branding, project names, extra feature icons or arbitrary card styles.

PRIMARY EDIT — REPLACE THE OLD SINGLE SIDEBAR WITH TWO DISTINCT NAVIGATION PARTS, BOTH WITHIN EXISTING ~266px LEFT AREA:
1. A 48px-wide ICON RAIL at x0..48.
2. A 216px-wide CONTEXT SIDEBAR at x48..264.
3. MAIN WORK SURFACE starts at x264, same approximate position as image1.
The entire app still has NO full-width project/title header. macOS traffic lights occupy one small top40px strip only above the left navigation pair. Icons and tree begin beneath that strip. Traffic lights are small native controls, never overlap toolbar icons. Divider between icon rail and context sidebar must be visible from y40 to bottom. This two-part navigation is the hero requested change and must be unmistakable.

ICON RAIL:
- Background #f0f1ed, no labels squeezed beneath icons, no second menu that requires going “back” to choose a module.
- 32x32px quiet icon buttons centered in48px track, 20px consistent simple Lucide-like line icons, vertical step44px beginning y74.
- Exactly SIX primary icons in fixed top-to-bottom order: message-square for 创作, open-book for 正文, connected-nodes for 故事结构(SELECTED), users for 人物与世界, archive/folder for 材料, clipboard-check for 审稿与版本.
- Only connected-nodes button is selected: neutral pale gray-green background, dark green icon, a short 3px left indicator. Do not use mysterious different bright colors per module. Small readable hover tooltip not required in this frame because context title explicitly says 故事结构. Actual design specifies focus labels; never shrink text to label all six icons.
- Bottom pinned icons: help at y969, settings gear at y1012. Settings is a normal same-system navigation item, NOT a popup alternate navigation scheme. No account/avatar/plan invented.

CONTEXT SIDEBAR:
- Background #f8f8f5, divider to main. 12px horizontal padding, typography SYSTEM CHINESE SANS-SERIF14px, group text12px, headings15px. Compact30–32px list row height, indentation16px, simple thin hierarchy guide line. Useful whitespace, no dense microtext.
- Project switcher at x60,y63: small book icon + 三国演义 with right dropdown chevron; muted 小说示例 in a small secondary line. UNBOXED, no large branding row or marketing logo.
- At y127 a clear module heading 故事结构, collapse-context-sidebar icon right. This heading does not have a back arrow or parent menu.
- At y165 compact in-module search row magnifying icon + 筛选情节…, unboxed or extremely subtle border. It filters this directory; global search can live in the project command menu and does not need a repeated prominent field here.
- At y215 small section 情节摘录. Immediately below the tree, beginning y245 rather than halfway down the app:
 v 第95回 · 失街亭
    王平劝阻
    拒谏屯山
    围山断水 (selected)
    街亭失守
    退回汉中
 > 第96回 · 斩马谡
- Selected 围山断水 row pale gray-green, dark text, small leading dot or short indicator. This is object selection; the separate rail selection is module selection. Both must agree with selected central node and inspector.
- No primary module label list inside this sidebar. Remove old 正文/故事结构/人物与世界/材料/审稿与版本 rows from it; those entries exist ONLY in icon rail. Remove the old 新建委托 action from structure context, no mixed conversation list or related people inventory.
- Footer at y1008..1057: small local-storage icon + 本地作品. Settings/help have moved to rail; do not duplicate them. Optional tiny 范围：第95—96回 beneath tree, not a new panel.

PRESERVE STORY CONTENT AND WORKSPACE:
- Center top scoped header 第95—96回 / 失街亭 and collapsed Agent on right. Do not repeat a huge app brand. Context module title already identifies 故事结构.
- Compact representation selector 因果 / 人物视角 / 承诺与回应 is allowed on MAIN WORK SURFACE only; it changes how selected story is visualized, not global navigation. Keep no such mode-switching menus in context sidebar.
- Main title 失街亭：选择如何变成败局, restrained22px semibold. Main UI and node text should be crisp modern Chinese SANS-SERIF, not calligraphy. Use serif only for source quotations. Body14–16px, node titles16–17px, no more than2 fonts.
- Four main graph nodes left→right: 拒谏屯山 (马谡 · 第95回), 围山断水 (魏军 · 第95回, green selected outline), 街亭失守 (蜀军 · 第95回), 退回汉中 (诸葛亮 · 第95回).
  Meaningful arrows: 暴露水路, 饥渴致乱, 进退失据.
  Upper branch 王平劝阻 → 拒谏屯山 labelled 未被采纳.
  Lower branch MUST connect FROM BOTTOM BORDER of 街亭失守 DIRECTLY TO TOP BORDER of 挥泪斩马谡, labelled 军法追责. NEVER connect punishment from 围山断水 or from an edge between nodes.
- Keep original small table 人物对同一风险的判断 with王平 (断水会使军心自乱 / 后续情节印证) and马谡 (绝水会激发士卒死战 / 与实际溃散相反), both第95回.
- Keep compact 承诺与后果 · 军令状, 立军令状95回 → 街亭失守95回 → 军法处置96回, without arbitrary numerical quality scores.
- Keep right evidence inspector ~320px wide x1164..1488: heading 原文依据, selected 围山断水, 第95回; quote exactly “又令申耽、申仪引两路兵围山，先断了汲水道路；待蜀兵自乱，然后乘势击之。”
  Caption 小说原文 · 简体转写. Summary 司马懿部署围山；张郃阻截王平. This is 三国演义 novel narrative, not documentary history. Primary button 定位原文, secondary 询问 Agent.
- Small design-sample label and graph legend retain. Six events are excerpted story events within chapters95–96, not6 chapters or automatic new canonical Beats.

Visual quality: precise familiar desktop writing instrument, warm neutral paper #fafaf7, dark charcoal #27362f, muted #646c62 and restrained deep-green #365747, no nested cards, gradients, decorative paintings, gauge charts or engineering metadata. Density comes from separating fixed module icons from scrollable object tree, not reducing legibility. Main canvas should remain as readable and spacious as source.
Current date2026-09-08; no temporal UI needed. One screenshot only.
```

## 几何与密度校正

首次生成的图标轨约 104 像素宽，偏离已确认的 48px 逻辑宽度，也把主面向右挤压。校正同时明确原生窗口按钮可跨左侧导航整体顶部，不能为容纳窗口按钮而把图标轨放宽。

```text
Edit the attached Suiming screenshot to CORRECT NAVIGATION GEOMETRY and density. One final flat desktop app screenshot, 1488 x 1057, no external frame. Keep the approved ONE navigation model fixed icon rail + context sidebar. Current image is WRONG because icon rail is about104px wide and icons vertically90px apart. We need a genuinely NARROW desktop rail, not a tablet rail.

Precisely reflow the screenshot:
- Top-left native macOS traffic lights may span the combined264px navigation area, occupying only y0..44. A very thin separator beneath y44 is optional.
- BELOW y44, icon rail spans x0..48 ONLY (3.2% of whole image width). Its vertical divider begins at (48,44) and ends at(48,1057), never at the top edge. The native buttons are allowed to extend beyond48px ABOVE this divider; do not widen the rail to fit all three native buttons.
- Icons are20px line icons in32x32px buttons, center x24. Six main buttons centered at y78,122,166,210,254,298. Icon shapes in order conversation bubble, open book, connected nodes (selected), users, folder, clipboard check. Selected surface rectangle x8..40 with subtle radius; short3px green marker at left border. No icons larger than20px, no huge90px vertical gaps.
- Help and settings are pinned near bottom, center x24 at y979 and1023. No duplicate controls.
- Context sidebar begins x48 and ends x264, exactly216px wide. Project heading and content left edge x60. Module title 故事结构 at y125. Search 筛选情节 at y161. 情节摘录 section y212. Tree begins y240, 32px rows: 第95回 · 失街亭 expanded, children 王平劝阻、拒谏屯山、围山断水(selected)、街亭失守、退回汉中; 第96回 · 斩马谡 collapsed. The entire tree should fit by y496, leaving room for long works. Smaller but readable14px sans serif labels; no wrap for short event names. Selected row x76..252. Footer 本地作品 anchored near bottom of this216px column.
- The MAIN CONTENT STARTS at x264 rather than the currentx343. Use the recovered79px for graph/content width, not a blank vertical gutter. Right source inspector stays about320px wide starting nearx1164. Main area width900px.
- Main four graph nodes with comfortable width162px approx, can be at x294,526,758,990 with clear labelled arrows. Upper 王平劝阻 sits above first main node. Lower 挥泪斩马谡 stays under 街亭失守. Ensure the arrow 军法追责 starts at BOTTOM of 街亭失守 and ends at TOP of 挥泪斩马谡.
- Keep all existing main story content, compact table, military pledge track, main viewport header and selected node. No full-width project header. Keep whitespace purposeful.
- Right source inspector preserve true quoted source and summary. Distinguish summary from original quote, and do not duplicate the exact same 司马懿部署围山；张郃阻截王平 sentence in two sections. Use relation explanation under 这条关系说明什么: 马谡弃道屯山，魏军围山断水，山上军队因饥渴而混乱。 Keep 参与行动 summary: 司马懿部署围山；张郃阻截王平。 Source quote remains unchanged.
Do not alter novel facts or selected objects. The correct geometry48+216 is essential; do not give another100px rail. Clean modern14–16px sans-serif UI, serif only quoted source, lightneutralpaper and deepgreen accent. One screenshot.
```
