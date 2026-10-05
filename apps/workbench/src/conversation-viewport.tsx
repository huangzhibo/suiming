import { ArrowDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface ConversationPosition {
	top: number;
	follow: boolean;
}
/** 只维护本地阅读位置，跟随意图不会被输入器增高或消息尺寸变化改写。 */
export function ConversationViewport({
	children,
	position,
	onPosition,
	expanded,
}: {
	children: ReactNode;
	position: ConversationPosition | undefined;
	onPosition(value: ConversationPosition): void;
	expanded: boolean;
}) {
	const viewport = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const save = useRef(onPosition);
	save.current = onPosition;
	const desired = useRef(position?.top ?? 0);
	const follow = useRef(position?.follow ?? true);
	const expected = useRef<number | null>(null);
	const dimensions = useRef({ height: 0, viewport: 0 });
	const [away, setAway] = useState(!follow.current);
	useLayoutEffect(() => {
		const element = viewport.current;
		const body = content.current;
		if (!element || !body) return;
		const measure = () => {
			dimensions.current = { height: element.scrollHeight, viewport: element.clientHeight };
			expected.current = Math.min(
				follow.current ? element.scrollHeight : desired.current,
				Math.max(0, element.scrollHeight - element.clientHeight),
			);
			element.scrollTop = expected.current;
			setAway(!follow.current && element.scrollHeight > element.clientHeight + 8);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		observer.observe(body);
		measure();
		return () => observer.disconnect();
	}, []);
	const stopFollowing = () => {
		follow.current = false;
		expected.current = null;
		if (viewport.current) desired.current = viewport.current.scrollTop;
	};
	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<section
				ref={viewport}
				aria-label="创作对话"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动阅读区需要键盘滚动入口。
				tabIndex={0}
				data-conversation-viewport
				// relative：消息里绝对定位的读屏标签以滚动区为包含块，不然它们排到外层、把右栏撑成能被程序滚动。
				className="relative min-h-0 flex-1 overflow-auto px-3.5 pt-3 outline-none"
				onWheel={(event) => {
					if (event.deltaY < 0) stopFollowing();
				}}
				onKeyDown={(event) => {
					if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopFollowing();
				}}
				onScroll={() => {
					const element = viewport.current;
					if (!element) return;
					if (expected.current !== null && Math.abs(element.scrollTop - expected.current) < 1) {
						expected.current = null;
						return;
					}
					if (
						dimensions.current.height !== element.scrollHeight ||
						dimensions.current.viewport !== element.clientHeight
					)
						return;
					follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 8;
					desired.current = element.scrollTop;
					setAway(!follow.current);
					save.current({ top: desired.current, follow: follow.current });
				}}
			>
				<div ref={content} className={`mx-auto flex flex-col gap-3.5 pb-4 ${expanded ? "max-w-[720px]" : ""}`}>
					{children}
				</div>
			</section>
			{away && (
				<Button
					variant="outline"
					size="sm"
					className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-sm"
					onClick={() => {
						const element = viewport.current;
						if (!element) return;
						follow.current = true;
						expected.current = Math.max(0, element.scrollHeight - element.clientHeight);
						element.scrollTop = expected.current;
						setAway(false);
						save.current({ top: element.scrollTop, follow: true });
					}}
				>
					<ArrowDown data-icon="inline-start" />
					回到最新
				</Button>
			)}
		</div>
	);
}
