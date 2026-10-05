import { useEffect, useRef, useState } from "react";
import { PANE_WIDTH, type PaneSide, paneWidth } from "./pane-layout.js";

/** 顶部和内容行共享像素宽度，手柄不占据布局空间。 */
export function PaneResizer({
	side,
	width,
	max,
	onChange,
}: {
	side: PaneSide;
	width: number;
	max: number;
	onChange(width: number): void;
}) {
	const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
	const [active, setActive] = useState(false);
	const direction = side === "left" ? 1 : -1;
	const label = side === "left" ? "调整左栏宽度" : "调整右栏宽度";
	const change = (value: number) => onChange(paneWidth(side, value, max));
	const finish = () => {
		drag.current = null;
		setActive(false);
	};
	useEffect(() => {
		if (!active) return;
		document.documentElement.dataset.paneResizing = "true";
		const blur = () => {
			drag.current = null;
			setActive(false);
		};
		window.addEventListener("blur", blur);
		return () => {
			delete document.documentElement.dataset.paneResizing;
			window.removeEventListener("blur", blur);
		};
	}, [active]);
	return (
		// biome-ignore lint/a11y/useSemanticElements: 这是可聚焦、可调值的窗口分隔器，不是文档中的静态 hr。
		<div
			role="separator"
			aria-label={label}
			aria-description="按左右方向键调整；按 Enter 恢复默认宽度"
			aria-controls={`workbench-${side}`}
			aria-orientation="vertical"
			aria-valuemin={PANE_WIDTH[side].min}
			aria-valuemax={max}
			aria-valuenow={width}
			aria-valuetext={`${width} 像素`}
			tabIndex={0}
			data-active={active}
			className={`pane-resizer no-drag absolute z-20 w-2 touch-none cursor-col-resize outline-none ${side === "left" ? "-right-1" : "-left-1"}`}
			onPointerDown={(event) => {
				if (event.button !== 0 || !event.isPrimary) return;
				event.preventDefault();
				event.currentTarget.focus({ preventScroll: true });
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointer: event.pointerId, x: event.clientX, width };
				setActive(true);
			}}
			onPointerMove={(event) => {
				if (drag.current?.pointer !== event.pointerId) return;
				change(drag.current.width + direction * (event.clientX - drag.current.x));
			}}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
			onDoubleClick={() => change(PANE_WIDTH[side].default)}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
					event.preventDefault();
					change(width + direction * (event.key === "ArrowRight" ? 16 : -16));
				} else if (event.key === "Home" || event.key === "End" || event.key === "Enter") {
					event.preventDefault();
					change(
						event.key === "Home" ? PANE_WIDTH[side].min : event.key === "End" ? max : PANE_WIDTH[side].default,
					);
				} else if (event.key === "Escape" && drag.current) {
					change(drag.current.width);
					finish();
				}
			}}
		/>
	);
}
