import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { navigationModeNames } from "./navigation-modes.js";

/** 图例条目：与故事轴、左栏上的图元同一套形状与颜色。 */
export function Legend({
	shape,
	color,
	label,
}: {
	shape: "dot" | "ring" | "half" | "square" | "tri" | "arc" | "bar";
	color: string;
	label: string;
}) {
	const style =
		shape === "arc"
			? { width: 14, height: 7, borderTop: `1.5px solid ${color}`, borderRadius: "7px 7px 0 0" }
			: shape === "bar"
				? { width: 2, height: 11, background: color }
				: shape === "dot"
					? { background: color, borderRadius: "50%" }
					: shape === "ring"
						? { border: `1.5px solid ${color}`, borderRadius: "50%" }
						: shape === "half"
							? {
									border: `1.5px solid ${color}`,
									borderRadius: "50%",
									background: `linear-gradient(90deg, ${color} 50%, var(--background) 50%)`,
								}
							: shape === "square"
								? { background: color, borderRadius: 2 }
								: {
										width: 0,
										height: 0,
										borderLeft: "5px solid transparent",
										borderRight: "5px solid transparent",
										borderBottom: `9px solid ${color}`,
									};
	return (
		<span className="flex items-center gap-1.5">
			<i className="inline-block size-2 shrink-0" style={style} />
			{label}
		</span>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mb-4">
			<h3 className="mb-1.5 text-[11px] tracking-[.08em] text-muted-foreground uppercase">{title}</h3>
			{children}
		</section>
	);
}

/**
 * 帮助模态框：图例与操作说明只在这里常驻，界面上不占位；行与图元自己的 hover 提示负责当场解释。
 * 像 Obsidian 一样从左下角的「?」打开。
 */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					// 阅读型对话框先聚焦内容，避免初次打开就弹出关闭按钮的 Tooltip。
					event.preventDefault();
					if (event.target instanceof HTMLElement) event.target.focus();
				}}
				className="flex max-h-[82vh] max-w-[640px] flex-col gap-0 p-0 sm:max-w-[640px]"
			>
				<DialogHeader className="border-b border-hair px-6 py-4 text-left">
					<DialogTitle className="text-base">图例与操作</DialogTitle>
					<DialogDescription className="text-xs leading-[1.7]">
						所有标记都来自作品文件里写下的引用、读者期待、状态变化与审稿，不是模型的解读；悬停任一标记可看到它来自哪里。
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-auto px-6 py-4 text-[12px] leading-[1.8] text-sub">
					<Section title="分栏与导航">
						<p className="text-xs leading-[1.8] text-ink-3">
							拖动左右栏与正文之间的分隔线调宽，双击恢复默认。也可用 Tab 聚焦分隔线，左右方向键微调，Home / End
							调到最小 / 最大，Enter 恢复默认。只有图标放不下时，才通过当前导航菜单切换{navigationModeNames}
							；⌘/Ctrl K 可直接搜索。
						</p>
					</Section>
					<Section title="内容与分屏">
						<p className="text-xs leading-[1.8] text-ink-3">
							首次打开情节默认显示设计，之后沿用当前窗格的设计或正文选择。正文尚空时会展示设计并说明；明确选择正文仍可开始写作。⌘/Ctrl
							E 切换阅读与编辑。
						</p>
						<p className="mt-2 text-xs leading-[1.8] text-ink-3">
							“更多”中可左右或上下分屏，也可一键并排查看设计与正文。各窗格独立浏览，同一文件共享草稿；合并到相邻窗格会保留全部标签。窗口放不下时可切换当前窗格，放宽后恢复分屏。
						</p>
					</Section>
					<Section title="文件与标签页">
						<p className="text-xs leading-[1.8] text-ink-3">
							首次打开作品默认选中大纲。左栏的{navigationModeNames}
							只切换导航。普通打开复用页面；固定或未保存的页面会保留。⌘/Ctrl 点击或中键在后台新开，加 Shift
							切到新页；右键也可新开。标签页右键可固定、复制和关闭。
						</p>
						<p className="mt-2 text-xs leading-[1.8] text-ink-3">
							⌘/Ctrl T 打开空白选择页，⌘/Ctrl W
							关闭当前页。文件树中的作品文件与大纲打开同一页面，设计和正文各自保存；普通文件也可阅读、编辑。“更多”可定位文件或复制路径。原始字段在编辑视图中查看，同一文件的多个标签共享草稿。保存写入项目目录，提交才成为作品版本。
						</p>
					</Section>
					<Section title="左栏 · 大纲">
						<div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
							<Legend shape="dot" color="var(--success)" label="已提交正文" />
							<Legend shape="half" color="var(--amber)" label="有正文，设计已变" />
							<Legend shape="ring" color="var(--amber)" label="正文未提交" />
							<Legend shape="ring" color="var(--faint)" label="仅设计" />
							<Legend shape="square" color="var(--amber)" label="在此建立或回应读者期待" />
							<Legend shape="tri" color="var(--purple)" label="锚到这个情节的审稿" />
							<Legend shape="bar" color="var(--primary)" label="故事轴选中的情节" />
						</div>
						<p className="mt-1.5 text-muted-foreground">
							卷标题右侧的 6 / 9 是有正文的情节数；点情节打开它，悬停查看读者期待与审稿详情。
						</p>
					</Section>
					<Section title="故事轴">
						<div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
							<Legend shape="dot" color="var(--success)" label="已提交正文" />
							<Legend shape="half" color="var(--amber)" label="有正文，设计已变" />
							<Legend shape="ring" color="var(--amber)" label="正文未提交" />
							<span className="pl-[14px]">空 = 仅设计</span>
							<Legend shape="tri" color="var(--purple)" label="审稿（空心 = 稿子已改）" />
							<Legend shape="square" color="var(--amber)" label="建立或回应读者期待" />
							<Legend shape="dot" color="var(--amber)" label="推进读者期待" />
							<Legend shape="dot" color="var(--destructive)" label="回应之后仍在推进" />
							<Legend shape="arc" color="var(--purple)" label="因果弧：情节依赖（与选中情节相关的加粗）" />
							<Legend shape="dot" color="var(--muted-foreground)" label="人物被引用（不表示出场 / POV）" />
							<span className="pl-[14px]">✕ 死亡 ◆ 秘密揭示 ⌖ 位置变化</span>
							<Legend shape="dot" color="var(--primary)" label="资源换持有者（空心 = 换位置）" />
						</div>
					</Section>
					<Section title="操作">
						<ul className="list-disc pl-4">
							<li>
								故事轴：点情节列选择，双击打开；拖竖线或按 ← → 改变选择；在列头拖过多列即刷选区间，可引用给
								Agent。
							</li>
							<li>
								情节页：设计 /
								正文两种视图，并排查看在「更多」里；每个作品对象页末尾的「关系」是以它为中心的邻域图，点节点换中心。
							</li>
							<li>
								状态查询：在情节页点击右栏「故事状态」后，可切换进入前、本幕变化和结束后；人物、资源和读者期待可按故事位置查询。回看依据不改变查询条件，可显式引用给
								Agent。
							</li>
							<li>
								正文：选中一段后在选段栏写修改要求，回车直接发给 Agent；也可以「询问
								Agent」把选段引用到对话。比较页右侧可编辑，「还原当前差异」把这一处退回已提交稿。
							</li>
							<li>审稿页：点一条意见的标题聚焦，右侧当前稿高亮对应段落。</li>
						</ul>
					</Section>
					<Section title="快捷键">
						<ul className="list-disc pl-4">
							<li>⌘ S 保存；⌘ Enter 发送；Esc 关闭弹层或清除刷选。</li>
						</ul>
					</Section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
