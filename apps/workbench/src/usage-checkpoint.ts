import { USAGE_CHECKPOINT_TOKENS } from "@suiming/sdk";

/** 设置页的几档：保守一点、默认（约一次整本抽取）、两档给整夜跑的长任务。config.toml 里写的别的数照样显示。 */
const PRESETS = [2_000_000, USAGE_CHECKPOINT_TOKENS.default, 20_000_000, 60_000_000];

const tenThousands = (tokens: number) => `${Math.round(tokens / 10_000).toLocaleString("en-US")} 万`;

/**
 * 每档的文字：折算 token 数，默认档标出来；知道默认模型的输入单价时附上约合多少钱——折算口径以未缓存输入为一，
 * 所以「折算 token × 输入单价」就是按这个模型估的花费（GPT-6.1 Sol 600 万约 $12，DeepSeek Flash 约 $1.8）。
 */
export function usageCheckpointOptions(current: number, mainInputPrice: number | null) {
	const values = PRESETS.includes(current) ? PRESETS : [...PRESETS, current].sort((a, b) => a - b);
	return values.map((tokens) => {
		const money = mainInputPrice === null ? "" : ` · 约 $${formatUsd((tokens / 1_000_000) * mainInputPrice)}`;
		const tag =
			tokens === USAGE_CHECKPOINT_TOKENS.default ? "（默认）" : PRESETS.includes(tokens) ? "" : "（自定义）";
		return { value: String(tokens), label: `${tenThousands(tokens)}${tag}${money}` };
	});
}

function formatUsd(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
