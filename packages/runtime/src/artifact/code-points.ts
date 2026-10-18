/**
 * 码点计数与切片，与 `[...text].length`、`[...text].slice(start, end).join("")` 相同但不分配数组。
 * 斗破的原作材料两百多万码点，展开一次就是两百多万个元素；读材料、覆盖率、目录投影都在热路径上。
 * 输入都来自 fatal 的 UTF-8 解码，没有落单的代理项。
 */
export function codePointCount(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		// 低位代理只是前一个高位代理的后半，不单独计数。
		if (unit < 0xdc00 || unit > 0xdfff) count++;
	}
	return count;
}

function unitOffset(text: string, codePoints: number, fromUnit = 0): number {
	let unit = fromUnit;
	for (let point = 0; point < codePoints && unit < text.length; point++) {
		const code = text.charCodeAt(unit);
		const next = text.charCodeAt(unit + 1);
		unit += code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
	}
	return unit;
}

export function sliceCodePoints(text: string, start: number, end: number): string {
	const from = unitOffset(text, start);
	return text.slice(from, unitOffset(text, Math.max(0, end - start), from));
}

/**
 * 篇幅的确定性口径：去掉 Markdown 标题行与全部空白后的码点数，与对照原作的 compare.py 一样（标题会泄露章号，也不算正文）。
 * Write Context 标篇幅、评委结果标各版长短都用它。
 */
export function bodyCharCount(text: string): number {
	return codePointCount(
		text
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("")
			.replace(/\s/gu, ""),
	);
}
