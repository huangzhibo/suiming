import { useEffect } from "react";

/** 共用原生滚动条，只标记短暂的操作状态；覆盖分栏、编辑器和 portal 中的滚动区。 */
export function useAutoHideScrollbars() {
	useEffect(() => {
		const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
		const show = (element: HTMLElement) => {
			clearTimeout(timers.get(element));
			element.dataset.scrollActive = "true";
			timers.set(
				element,
				setTimeout(() => {
					delete element.dataset.scrollActive;
					timers.delete(element);
				}, 1000),
			);
		};
		const scroll = (event: Event) => {
			if (event.target instanceof HTMLElement) show(event.target);
		};
		// scroll 不冒泡；捕获监听也能覆盖之后挂载的编辑器和弹出层。
		document.addEventListener("scroll", scroll, { capture: true, passive: true });
		return () => {
			document.removeEventListener("scroll", scroll, true);
			for (const [element, timer] of timers) {
				clearTimeout(timer);
				delete element.dataset.scrollActive;
			}
		};
	}, []);
}
