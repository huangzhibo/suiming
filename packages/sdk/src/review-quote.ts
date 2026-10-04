/**
 * 审稿引文规则（Harness 设计第 6 节）：Runtime 在 `submit_review` 时核对引文逐字出自被审文件，审稿页拿同一段引文把 finding
 * 锚回段落。两边必须是同一套规则，否则审稿交得上去、页面却锚不上（或反过来），所以放在两边都依赖的 sdk 里。
 */

/** 比较前去掉空白与引号，模型转述时最常改的就是这两样；标点保留，否则短引文会误命中。 */
export function normalizeReviewQuote(text: string): string {
	return text.replace(/\s+/gu, "").replace(/[「」“”"『』‘’']/gu, "");
}

const QUOTE = /[「“"『]([^」”"』]{2,})[」”"』]/gu;

/**
 * evidence 里该逐字出自原文的片段（原样返回，比较前再规范化）：有引号就是每段引号内的原文（`quoted`）；没有引号退回到
 * 规范化后 8 字以上的句子，避免把 Reviewer 的评语当原文找；连这样的句子都没有就为空。
 */
export function reviewQuoteFragments(evidence: string): { quoted: boolean; fragments: string[] } {
	const quoted = [...evidence.matchAll(QUOTE)].map((match) => match[1] ?? "");
	if (quoted.length > 0) return { quoted: true, fragments: quoted };
	return {
		quoted: false,
		fragments: evidence
			.split(/[。！？；\n]/u)
			.map((sentence) => sentence.trim())
			.filter((sentence) => normalizeReviewQuote(sentence).length >= 8),
	};
}
