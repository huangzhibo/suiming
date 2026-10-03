import { cjk } from "@streamdown/cjk";
import { Children, createElement, type HTMLAttributes, type ReactNode, useLayoutEffect, useRef } from "react";
import { type Components, type ExtraProps, Streamdown } from "streamdown";
import { Hint } from "./ui-bits.js";

/**
 * 作品正文、设计文档与 Agent 消息共用的 Markdown 渲染。
 * Streamdown 为流式输出设计：未闭合的强调、列表、代码块在流到一半时也能稳定渲染；静态内容用 static 模式一次解析。
 * 段落、标题、链接、强调交给我们自己的排版（.prose-text / .design-body / .msg-text 的规则），
 * 否则 Streamdown 自带的 utility 类会压过 components 层的字号与行距；列表、引用、代码块、表格沿用它的默认样式。
 */
type PlainProps = ExtraProps & HTMLAttributes<HTMLElement>;
const plain =
	(tag: string) =>
	({ node: _node, ...props }: PlainProps) =>
		createElement(tag, props);
const COMPONENTS = {
	p: plain("p"),
	h1: plain("h1"),
	h2: plain("h2"),
	h3: plain("h3"),
	strong: plain("strong"),
	em: plain("em"),
	// renderer 不能打开外部窗口：链接只显示，不导航。
	a: ({ href, children }: ExtraProps & { href?: string | undefined; children?: ReactNode }) => {
		const label = Children.toArray(children);
		const repeats = label.every((child) => typeof child === "string") && label.join("") === href;
		return (
			<Hint content={typeof href === "string" && !repeats ? href : undefined}>
				<span className="underline decoration-dotted underline-offset-2">{children}</span>
			</Hint>
		);
	},
} as Components;
const PLUGINS = { cjk };

export function Markdown({
	content,
	streaming = false,
	selected,
	marks,
	className,
	links,
	...rest
}: {
	content: string;
	/** 仍在流入的消息：按块增量解析并淡入新词。 */
	streaming?: boolean;
	/** 给每个 <p> 标 data-index / data-sel，供正文选段引用；不传则不标。 */
	selected?: number;
	/** 段号 → 说明：有 Review finding 锚到的段落标 data-mark，title 是 finding 标题。 */
	marks?: ReadonlyMap<number, string>;
	className?: string;
	/** 只允许调用方列出的作品链接；其它链接仍只显示，不打开外部窗口。 */
	links?: ReadonlyMap<string, () => void>;
	"data-prose"?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// 段号来自渲染结果而不是解析器：Streamdown 按块缓存，块内位置不是全文位置。
	useLayoutEffect(() => {
		if ((selected === undefined && marks === undefined) || !ref.current) return;
		ref.current.querySelectorAll<HTMLParagraphElement>("p").forEach((paragraph, index) => {
			paragraph.dataset.index = String(index);
			paragraph.dataset.sel = String(selected === index);
			const mark = marks?.get(index);
			if (mark === undefined) {
				delete paragraph.dataset.mark;
				paragraph.removeAttribute("title");
			} else {
				paragraph.dataset.mark = "true";
				paragraph.title = mark;
			}
		});
	});
	return (
		<div ref={ref} className={className} {...rest}>
			<Streamdown
				mode={streaming ? "streaming" : "static"}
				isAnimating={streaming}
				animated={streaming}
				parseIncompleteMarkdown={streaming}
				components={
					links
						? {
								...COMPONENTS,
								a: ({ href, children }: ExtraProps & { href?: string | undefined; children?: ReactNode }) => {
									let target = href ?? "";
									try {
										target = decodeURIComponent(target).replace(/^(?:\.\/|\/)/u, "");
									} catch {
										/* 非法 URL 不成为作品链接 */
									}
									const onClick = links.get(target);
									return onClick ? (
										<button
											type="button"
											className="cursor-pointer text-primary underline underline-offset-2"
											data-page={target}
											onClick={onClick}
										>
											{children}
										</button>
									) : (
										<span>{children}</span>
									);
								},
							}
						: COMPONENTS
				}
				plugins={PLUGINS}
				controls={false}
				lineNumbers={false}
			>
				{content}
			</Streamdown>
		</div>
	);
}
