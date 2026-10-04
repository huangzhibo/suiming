import assert from "node:assert/strict";
import test from "node:test";
import { usageCheckpointOptions } from "../src/usage-checkpoint.js";

test("用量检查点的选项：默认档标出来，按默认模型的输入单价换算约合多少钱；config.toml 里的别的数也列出", () => {
	assert.deepEqual(
		usageCheckpointOptions(6_000_000, 2).map((option) => option.label),
		["200 万 · 约 $4.0", "600 万（默认） · 约 $12", "2,000 万 · 约 $40", "6,000 万 · 约 $120"],
		"GPT-6.1 Sol 的输入单价 $2 / 百万",
	);
	assert.equal(usageCheckpointOptions(6_000_000, 0.3)[1]?.label, "600 万（默认） · 约 $1.8", "DeepSeek Flash");
	assert.equal(usageCheckpointOptions(6_000_000, null)[1]?.label, "600 万（默认）", "目录里没有单价就不报钱");
	const custom = usageCheckpointOptions(8_000_000, null);
	assert.deepEqual(
		custom.map((option) => option.value),
		["2000000", "6000000", "8000000", "20000000", "60000000"],
	);
	assert.equal(custom[2]?.label, "800 万（自定义）");
});
