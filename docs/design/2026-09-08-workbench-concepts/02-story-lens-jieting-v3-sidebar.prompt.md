# 故事透镜侧栏修订

日期：2026-09-08。使用内置 Image Gen，以已修正连线的失街亭稿为编辑目标，并附上作者提供的四张侧栏截图作为参考。本文件保存实际生成 prompt，仍属于静态设计探索。

```text
Use case: ui-mockup edit.
Produce ONE revised Suiming desktop UI screenshot, output target 1488 x 1057, same natural aspect ratio and exact layout geometry as image1.

INPUT ROLES:
Image1 is the CURRENT Suiming 失街亭 mockup, the edit target. Preserve its central causal graph, right evidence inspector, selected 围山断水 node, all story data, and correctly routed 街亭失守 → 挥泪斩马谡 punishment edge.
Images2–5 are four USER-PROVIDED SIDEBAR REFERENCES. Inspect and use their actual visual language:
- Image2: compact indented content tree, small toolbar controls, thin hierarchy guide lines, subdued full-row selection, anchored bottom controls.
- Image3: stable primary navigation above scoped content lists, clear groups, simple familiar icons.
- Image4: quiet neutral gray selected row, consistent small icon/label alignment, compact groups and fixed footer.
- Image5: clear navigation scope, economical grouped link rows, understated boundary to main workspace.
These are REFERENCES ONLY. Do NOT reproduce their account names, project names, chat titles, brand logos, billing plans or other user-specific data. Use only the Suiming/三国演义 story content below.

PRIMARY CHANGE: Replace ONLY the LEFT SIDEBAR (roughly x0..240) with a meticulously designed desktop navigation sidebar grounded in the four refs. Avoid the prior big decorative 燧明 branding row, giant boxed project selector/search field, excessive vertical spacing, repeated contextual sections and separate related-person inventory. The user wants useful information density and familiar, dependable desktop interaction.

SIDEBAR EXACT STRUCTURE, compact but readable:
- Width240px, background neutral #f6f6f4, subtle right divider. No permanent second vertical icon rail.
- Top40px macOS traffic light area; native small close/minimize/maximize dots left, a small collapse-sidebar icon right. App drag region only in this small sidebar top; NEVER create a full-width global titlebar/project header. No giant app logo/title row underneath.
- At y64 one 34px unboxed project switcher row: small outlined book icon + bold 15px 三国演义 + chevron right. Small secondary 小说示例 may sit on same row if it fits; do not wrap it into a large card.
- At y110 compact unboxed 搜索作品 row with magnifier left and small ⌘K shortcut right. No chunky input-border rectangle.
- At y150 a plain icon-text action 新建委托 with plus-in-circle or edit icon; same32px row height as navigation, not a giant filled CTA.
- Subtle 12px group heading 作品 at y197. Five primary nav rows below, each32px with 4px gap, 14px Chinese SYSTEM SANS-SERIF text and 16px aligned monochrome lucide-like icon:
  正文
  故事结构 (CURRENT MODE: muted #e9eae7 background, darker slightly bolder label; no saturated green rectangle)
  人物与世界
  材料
  审稿与版本
- At y427 a compact section header 情节摘录 with tiny expand/collapse-all control on right. This tree is a navigation projection from the original novel, not a new Canon schema or a list of six new chapters.
- Hierarchical tree, indents16px, row heights30px, consistent caret and text baselines, subtle short hierarchy line:
  v 第95回 · 失街亭
      王平劝阻
      拒谏屯山
      围山断水 (ACTIVE OBJECT: quiet neutral full-row background, dark label, a subtle short deep-green left indicator)
      街亭失守
      退回汉中
  > 第96回 · 斩马谡
  The chapter tree items should have tiny neutral dots or minimal event icons, no separate colored badge per item. Chapter titles are supplied display summaries, not long full original titles. KEEP 围山断水 selected in sidebar and graph/inspector consistently. 第96回 is collapsed; no redundant additional recent-conversation list or character directory.
- Footer anchored y1008..1057 with subtle top hairline: small local-storage/book icon plus 本地作品 left; help circle and settings gear right. No invented account avatar/plan. Main list is the scrollable portion; footer never scrolls away.
- Geometry tokens: outside horizontal padding12px, icon-label gap8px, row heights30–34px, small corner radius5px; group gap20px, label14px, section label12px high-contrast muted #71746f. Do NOT achieve density by microscopic type. Keep hover and selected state quiet like reference4, with clear keyboard-focus affordances reserved in actual UI. Icons support visible labels; no row full of tool buttons.
- Do not add divider between every row; grouping by alignment/space, one footer divider, one pane divider. No decorative shadows or gradients.

PRESERVE REST OF IMAGE1 exactly:
Current story is 三国演义 chapters95–96, not history; page 失街亭：选择如何变成败局.
Top central toolbar 因果 / 人物视角 / 承诺与回应; Agent collapsed.
Six event nodes: 王平劝阻 ignored-warning arrow into 拒谏屯山; main chain 拒谏屯山 → 围山断水 → 街亭失守 → 退回汉中; punishment arrow must start at bottom border of 街亭失守 and end at top border of 挥泪斩马谡. Preserve the main cause arrow labels, graph nodes positions, selected green outline on 围山断水.
Keep two-row table comparing 王平 and 马谡 judgments, compact military-pledge row, and right source quote with 定位原文 primary action. Keep corrected facts: 司马懿部署围山；张郃阻截王平.
Do not enlarge title, shrink main text, move nodes, add graph edges, change story words, or make a full-width project header. Do not add illustrations or marketing imagery.
Keep the main paper white and restrained deep green; sidebar should feel like a precise everyday authoring tool, not an AI marketing dashboard.
Current date2026-09-08; no date-based UI needed. Output only one finished flat app screenshot, no numbered options, exterior device frame, or side-by-side comparisons.
```
