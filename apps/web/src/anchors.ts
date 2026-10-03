import type { Paragraph, Root } from "mdast";
import { toString as mdastText } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * Review finding 只锚到文件，没有文本范围（ADR-0009 决定的边界，Reviewer 契约不变）。
 * 这里在窗口内把 finding 的 evidence 引文对回当前稿的段落：段号按 mdast 里 paragraph 节点的文档顺序编，
 * 与 Streamdown 渲染出的 <p> 顺序一致，所以能直接映射到阅读态的 data-index。
 */
export interface ParagraphSpan {
	index: number;
	text: string;
	start: number;
	end: number;
}

const parser = unified().use(remarkParse);

export function paragraphSpans(markdown: string): ParagraphSpan[] {
	const tree = parser.parse(markdown) as Root;
	const spans: ParagraphSpan[] = [];
	visit(tree, "paragraph", (node: Paragraph) => {
		spans.push({
			index: spans.length,
			text: mdastText(node),
			start: node.position?.start.offset ?? 0,
			end: node.position?.end.offset ?? 0,
		});
	});
	return spans;
}

const QUOTE = /[「“"『]([^」”"』]{2,})[」”"』]/gu;
/** evidence 里的引文：优先取引号内的原文；没有引号时退回到长句，避免把 Reviewer 的评语当原文找。 */
export function quotedFragments(evidence: string): string[] {
	const quoted = [...evidence.matchAll(QUOTE)].map((match) => match[1] ?? "");
	if (quoted.length > 0) return quoted;
	return evidence
		.split(/[。！？；\n]/u)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 8);
}

/** 比较前去掉空白与引号，模型转述时最常改的就是这两样；标点保留，否则短引文会误命中。 */
const normalize = (text: string) => text.replace(/\s+/gu, "").replace(/[「」“”"『』‘’']/gu, "");

/** 被引文命中的段号，按段落顺序去重；没有命中返回空数组，页面就退回到只锚文件。 */
export function anchorParagraphs(evidence: string, markdown: string): number[] {
	const fragments = quotedFragments(evidence)
		.map(normalize)
		.filter((fragment) => fragment.length >= 4);
	if (fragments.length === 0) return [];
	return paragraphSpans(markdown)
		.filter((span) => {
			const text = normalize(span.text);
			return fragments.some((fragment) => text.includes(fragment));
		})
		.map((span) => span.index);
}
