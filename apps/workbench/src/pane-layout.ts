export type PaneSide = "left" | "right";
export const PANE_WIDTH = {
	// 244px 能完整显示五个导航入口；384px 为中文对话与引用留出阅读空间。
	left: { min: 200, default: 244, max: 480 },
	right: { min: 260, default: 384, max: 560 },
};
const RAIL_WIDTH = 44;
const MAIN_MIN = 600;

export function paneWidth(side: PaneSide, value: number, max = PANE_WIDTH[side].max): number {
	const limits = PANE_WIDTH[side];
	return Math.round(Math.max(limits.min, Math.min(max, Number.isFinite(value) ? value : limits.default)));
}

/** 保存作者偏好；窗口适配只派生实际宽度，不把临时收窄写回偏好。 */
export function paneLayout(
	windowWidth: number,
	view: {
		leftWidth: number;
		rightWidth: number;
		sideOpen: boolean;
		right: boolean;
		expanded: boolean;
		rightMode: string;
	},
	priority: PaneSide,
) {
	let left = paneWidth("left", view.leftWidth);
	let right = paneWidth("right", view.rightWidth);
	const expanded = view.expanded && view.right && view.rightMode === "agent";
	const available = windowWidth - RAIL_WIDTH;
	const narrow = !expanded && available < MAIN_MIN + PANE_WIDTH.left.min + PANE_WIDTH.right.min;
	const showLeft = view.sideOpen && (!narrow || !view.right || priority === "left");
	const showRight = view.right && (!narrow || !view.sideOpen || priority === "right");
	if (!expanded && showLeft && showRight) {
		// 先临时压缩辅助栏，再压缩目录；达到两栏最小宽度后才收起一侧。
		// 这里仅计算实际尺寸，不改写作者保存的宽度偏好。
		right = paneWidth("right", right, available - MAIN_MIN - left);
		left = paneWidth("left", left, available - MAIN_MIN - right);
	}
	const leftMax = Math.max(
		PANE_WIDTH.left.min,
		Math.min(PANE_WIDTH.left.max, available - (expanded ? PANE_WIDTH.right.min : MAIN_MIN + (showRight ? right : 0))),
	);
	const rightMax = Math.max(
		PANE_WIDTH.right.min,
		Math.min(PANE_WIDTH.right.max, available - MAIN_MIN - (showLeft ? left : 0)),
	);
	return {
		showLeft,
		showRight,
		rightExpanded: expanded && showRight,
		leftWidth: paneWidth("left", left, leftMax),
		rightWidth: paneWidth("right", right, rightMax),
		leftMax,
		rightMax,
	};
}
