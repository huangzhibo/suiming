import type { KeyboardEvent } from "react";

/** 两种搜索入口共用键盘行为；结果仍是普通按钮，不另造列表选择状态。 */
export function navigateSearch(event: KeyboardEvent<HTMLElement>) {
	if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	const scope = event.currentTarget.closest("[data-search]");
	if (!scope) return;
	const input = scope.querySelector<HTMLInputElement>("[data-search-input]");
	const results = [...scope.querySelectorAll<HTMLButtonElement>("[data-search-result]")];
	const target = event.target;
	const index = target instanceof HTMLButtonElement ? results.indexOf(target) : -1;
	let next: HTMLElement | undefined | null;
	if (target === input) {
		if (event.key === "Enter" && results[0]) {
			event.preventDefault();
			results[0].click();
			return;
		}
		if (event.key === "ArrowDown") next = results[0];
	} else if (index >= 0) {
		if (event.key === "ArrowDown") next = results[index + 1];
		if (event.key === "ArrowUp") next = index === 0 ? input : results[index - 1];
		if (event.key === "Home") next = results[0];
		if (event.key === "End") next = results.at(-1);
		if (event.key === "Escape") next = input;
	}
	if (next) {
		event.preventDefault();
		next.focus({ preventScroll: true });
		next.scrollIntoView({ block: "nearest" });
	}
}

/** 扩展结果后把焦点交给新增条目，避免「更多」按钮消失后焦点掉回页面。 */
export function focusNewSearchResult(trigger: HTMLElement, index: number) {
	const scope = trigger.closest("[data-search]");
	requestAnimationFrame(() => {
		const next = scope?.querySelectorAll<HTMLElement>("[data-search-result]")[index];
		next?.focus({ preventScroll: true });
		next?.scrollIntoView({ block: "nearest" });
	});
}
