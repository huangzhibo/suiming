/** 审稿结论的说法与配色：审稿页的标签和故事轴的图元共用这一份，不各自判断取值。 */
export const verdictLabel = (verdict: string) =>
	({ pass: "通过", revise: "需修订", block: "有阻断问题", insufficient_context: "依据不足" })[verdict] ?? verdict;

export const verdictTone = (verdict: string) =>
	verdict === "pass"
		? "green"
		: verdict === "revise" || verdict === "insufficient_context"
			? "amber"
			: verdict === "block"
				? "red"
				: "gray";

/** SVG 图元用的颜色；与 `verdictTone` 一一对应。 */
export const verdictColor = (verdict: string) =>
	({ green: "var(--success)", amber: "var(--amber)", red: "var(--destructive)", gray: "var(--muted-foreground)" })[
		verdictTone(verdict)
	];
