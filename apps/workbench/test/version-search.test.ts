import assert from "node:assert/strict";
import test from "node:test";
import { rankVersion } from "../src/version-search.js";

test("版本检索：短数字不混入 hash，长纯数字提交前缀仍可查找", () => {
	const id = "8675597653630481abcdef0123456789abcdef0123";
	assert.equal(rankVersion(id, "r250", "8675597653630481", 500), 0.6);
	assert.equal(rankVersion("21abcdef", "r40", "21", 500), 0);
	assert.equal(rankVersion(id, "r21", "21", 500), 1);
	assert.equal(rankVersion(id, "r210", "21", 500), 0.8);
	assert.equal(rankVersion("501abcdef", "r40", "501", 500), 0);
	assert.equal(rankVersion(id, "r250", "abcdef", 500), 0.4);
	assert.equal(rankVersion(id, "r250", id, 500), 1);
});
