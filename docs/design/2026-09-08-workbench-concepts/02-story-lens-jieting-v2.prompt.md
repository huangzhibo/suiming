# 故事透镜修订：失街亭

日期：2026-09-08。使用内置 Image Gen，以上一轮第 2 张为编辑参考。此文件保存实际生成 prompt；图片是静态设计探索，尚未实现。

```text
Use case: ui-mockup / edit existing concept.
Create ONE revised production-quality desktop UI mockup for Suiming 燧明. The attached image is the previous "story lens" concept to revise. Keep its restrained warm-white/deep-green brand and project sidebar + story workspace + contextual evidence inspector architecture. SUBSTANTIALLY improve useful information density and graph comprehensibility. Replace all fictional 长夜来信/李牧 content with the familiar public-domain NOVEL 三国演义, selected episode 失街亭. This is the user's explicit refinement of that single concept; do not generate multiple options or a presentation.

Target 1440 × 1024 desktop viewport, natural ratio, app content fills frame, no outer device frame/browser chrome/shadows. Clear modern Chinese sans-serif UI (14-16 px body, 17px node titles, 23px page heading max). A serif font only for quoted novel text. No calligraphy logo or faux aged parchment. At most 2 fonts. Precise lucide-like icons and shadcn/ui-inspired compact controls. Crisp high contrast text #27362f, secondary #60685f; background #fafaf7, sidebar #f0f1eb, accent #365747. Green selection does not mean a positive plot outcome; negative outcomes use a restrained rust dot with text status. Minimal borders except graph nodes, no card-inside-card.
No full-width global project header: sidebar, workspace, inspector have their own tops. Agent stays collapsed to a top action, not a chat panel. No photos, portraits, maps, charts with arbitrary numbers, quality scores, Run/Task/Attempt, raw IDs, code/file paths, or full-book node hairball. No giant poetic hero title, decorative subtitle or enormous empty margin.

Factual framing: Show 三国演义 · 小说示例 and 第95—96回. This is a hand-organized visual example of the novel, NOT literal history and NOT proof the app automatically extracted a complete graph. Use all content below; do not mix historical 三国志 with novel. Do not invent a Character/Beat schema field or committed real project. The graph nodes are excerpted STORY EVENTS within two chapters; they are not 6 chapters nor guaranteed 6 canonical Beats. Small persistent note 图中事件按原文整理 · 非完整情节 / 设计样例.

ONE HERO TASK: Understand how Ma Su's choice led to defeat, and click a particular relationship to inspect textual evidence. Hero headline "失街亭：选择如何变成败局". Default selected node "围山断水". Every arrow must describe the concrete relationship, never generic 前置情节. Reading order left → right for the main chain, restrained vertical side branches for warning and personal consequence.

EXACT COMPOSITION:
- Left sidebar 184px wide. Own small macOS window control area at top, quiet 燧明 text/logo. Project selector 三国演义, muted 小说示例. Small search row 搜索作品… . Compact plain icon-text navigation: 创作, 故事结构(selected), 人物与世界, 材料, 审稿与版本. At y350 a scoped outline section 当前范围 with rows 第95回 · 失街亭 (selected) and 第96回 · 斩马谡. At y495 optional compact related-person list 马谡, 王平, 诸葛亮, 司马懿, visually subordinate, not person profile cards. Settings anchored bottom.
- Workspace x184 to1104, 920px width. Independent top header 56px tall: 故事结构 on left, context 第95—96回 and collapsed Agent icon/text far right. Under it one compact 40px toolbar with tabs 因果(active), 人物视角, 承诺与回应; small scope dropdown 失街亭 on right. No redundant third header.
- At y125 main heading 失街亭：选择如何变成败局, 23px semibold, with small scope caption 关键事件 · 按小说叙事整理. All title region ends by y182.
- MAIN GRAPH occupies x216..1072 and y205..590. Four evenly spaced columns, nodes about 177px wide and 94px high, gaps about48px. Exactly FOUR main nodes in one readable left-to-right row at y345:
  col1 title 拒谏屯山, small meta 马谡 · 第95回, summary 放弃当道设营，坚持上山
  col2 title 围山断水 (SELECTED green outline), meta 魏军 · 第95回, summary 围住山寨，截断汲水道路
  col3 title 街亭失守, meta 蜀军 · 第95回, summary 缺水断粮，军心大乱
  col4 title 退回汉中, meta 诸葛亮 · 第95回, summary 要路已失，部署撤军
  arrow col1→col2 text 暴露水路, arrow col2→col3 text 饥渴致乱, arrow col3→col4 text 进退失据.
- Exactly TWO small branch nodes, not extra parallel universes:
  Above main col1 at y210 a warning node 王平劝阻, subtitle 预警：水道被断，军心自乱, meta 第95回. Thin downward connector to 拒谏屯山 labeled 未被采纳. Use restrained amber dot for warning. Do not imply 王平 caused defeat; connector is explicitly an ignored warning.
  Below main col3/col4 at y500, consequence node 挥泪斩马谡, meta 诸葛亮 · 第96回, subtitle 失守获罪，依军法处置. A clean elbow arrow from 街亭失守 down/right to this node labeled 军法追责. Clearly separate military loss and personal consequence. No arrow crossings, all arrowheads terminate at node borders. Do not add an AI motive dashed squiggle.
- Directly below graph, y630 heading 人物对同一风险的判断. Compact TWO-row table spanning workspace with columns 人物 / 当时的判断 / 结果核对. Row 王平: 断水会使军心自乱 / 后续情节印证 · 第95回. Row 马谡: 绝水会激发士卒死战 / 与实际溃散相反 · 第95回. These are paraphrases of explicit novel dialogue, not an AI personality score. Use subtle horizontal separators, 48-54px row height, readable 14px.
- At y824 one compact section 承诺与后果 · 军令状, three simple inline anchors: 立军令状 95回 → 街亭失守 95回 → 军法处置 96回. One concise note 情节中的承诺与回应；是否打动读者仍需审稿. NOT another huge timeline card. Do not equate military success with contract closure.
- Bottom small graph legend and one quiet density affordance 图 / 列表. Footer 设计样例. Keep content comfortably inside height1024.

RIGHT INSPECTOR x1104..1440, width336, independent light divider, 24px padding:
- Top header 原文依据 with close X (not giant quote illustration).
- Selected node name 围山断水, small badge 第95回.
- Section 原文 (explicitly sourced to public-domain novel), quote EXACTLY: “又令申耽、申仪引两路兵围山，先断了汲水道路；待蜀兵自乱，然后乘势击之。” Dark serif 16px, legible line length, no text overflow. Use a narrow green quote rule only.
- Under quote small clickable 第95回 · 司马懿部署 section source anchor. A short source footer 小说原文 · 简体转写.
- Divider, section 这条关系说明什么, plain sentence: 马谡把军队置于孤山，魏军切断水路，使山上军队陷入饥渴与混乱。 Label 依据原文归纳 so the causal graph is not misrepresented as authored schema.
- A further compact text detail 参与行动：司马懿部署围山；张郃阻截王平。 Never say Zhang He personally commands water cutoff in this novel example.
- At bottom main green primary button 定位原文, secondary plain text action 询问 Agent. One clear primary action in whole frame.

Density must come from connected concrete information: six small event nodes, two concise viewpoint rows, one compact promise row, and a selected evidence inspector. NOT smaller unreadable type or adding miscellaneous feature inventory. Main graph stays readable with labelled arrows. No unnecessary secondary prose, giant blank panels or repeated headings. Preserve all Chinese names accurately, especially 马谡、司马懿、张郃. Current date 2026-09-08 but no current-date UI needed.
```

## 连线校正

首张生成结果把“军法追责”接在“围山断水 → 街亭失守”的边上。校正要求从“街亭失守”节点直接连接到“挥泪斩马谡”，以下保存实际编辑 prompt。最终图已检查该连接。

```text
Edit this exact attached Suiming desktop UI mockup. Preserve its entire layout, content density, typography, panel sizes, colors, every table, every node, sidebar and inspector. Output one corrected screenshot at the same 1487 x 1058 dimensions/aspect ratio.

ONE MATERIAL GRAPH CORRECTION:
In the central four-node horizontal chain, the THIRD node is 街亭失守, approximately x745..884,y410..518. The personal-consequence node 挥泪斩马谡 is below it at x769..929,y562..660.
DELETE completely the current incorrect branch line that starts from the arrow BETWEEN the SECOND node 围山断水 and THIRD node 街亭失守, then travels down at about x711 and turns right into the consequence node. Erase that entire branch while KEEPING the uninterrupted main arrow 围山断水 → 街亭失守.
DRAW instead a direct downward arrow starting on the BOTTOM CENTER border of the THIRD node 街亭失守 (about x815,y518) and ending on the TOP border of the lower node 挥泪斩马谡 (about x815,y562). Label this short downward connector 军法追责 in small dark text just to its right, without overlapping nodes. The relation MUST unambiguously be 街亭失守 → 挥泪斩马谡, because the defeat triggers military punishment.
Keep every other arrow unchanged, especially 街亭失守 → 退回汉中.
Do not add nodes, move panels, shrink text, create blank expanses, or otherwise redesign. Check Chinese text 马谡 and 司马懿 is correctly written. This is a static design sample based on 三国演义 chapters95–96.
```
