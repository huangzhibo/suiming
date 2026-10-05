import { useRef, useState } from "react";

/** MergeView 持有两侧编辑器的 DOM，分隔器只调整布局，不重建编辑器与撤销历史。 */
export function ComparisonResizer({ ratio, onChange }: { ratio: number; onChange(value: number): void }) {
	const drag = useRef<{ pointer: number; start: number; size: number; ratio: number } | null>(null);
	const [active, setActive] = useState(false);
	const change = (value: number) => onChange(Math.max(25, Math.min(75, value)));
	const finish = () => {
		drag.current = null;
		setActive(false);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: 可调值的交互分隔器。
		<div
			role="separator"
			tabIndex={0}
			aria-label="调整比较宽度"
			aria-orientation="vertical"
			aria-valuemin={25}
			aria-valuemax={75}
			aria-valuenow={Math.round(ratio)}
			data-active={active}
			className="comparison-resizer no-drag"
			onPointerDown={(event) => {
				if (event.button !== 0 || !event.isPrimary) return;
				const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
				if (!bounds) return;
				event.preventDefault();
				event.currentTarget.focus({ preventScroll: true });
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = {
					pointer: event.pointerId,
					start: event.clientX,
					size: bounds.width,
					ratio,
				};
				setActive(true);
			}}
			onPointerMove={(event) => {
				const value = drag.current;
				if (value?.pointer === event.pointerId)
					change(value.ratio + ((event.clientX - value.start) / value.size) * 100);
			}}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
			onBlur={finish}
			onDoubleClick={() => change(50)}
			onKeyDown={(event) => {
				if (["Home", "End", "Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) {
					event.preventDefault();
					change(
						event.key === "Home"
							? 25
							: event.key === "End"
								? 75
								: event.key === "Enter"
									? 50
									: ratio + (event.key === "ArrowLeft" ? -2 : 2),
					);
				} else if (event.key === "Escape" && drag.current) {
					change(drag.current.ratio);
					finish();
				}
			}}
		/>
	);
}
