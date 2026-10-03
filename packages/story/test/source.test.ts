import assert from "node:assert/strict";
import test from "node:test";
import { bindSourceDocuments, checkSource, type SourceExtractionDocuments } from "../src/index.js";
import { twoBeatDesignDocuments } from "./fixture.js";

const encoder = new TextEncoder();

function sourceExtraction(): SourceExtractionDocuments {
	const { intents: _, styleIds: __, ...extraction } = twoBeatDesignDocuments();
	return extraction;
}

function sourceWith(extraction: SourceExtractionDocuments) {
	return bindSourceDocuments("原作", {
		descriptor: { schema_version: 1, name: "原作.txt", encoding: "utf-8" },
		original: encoder.encode("黄盖挨打诈降，最终火烧曹营。"),
		material: "黄盖挨打诈降，最终火烧曹营。",
		extraction,
	});
}

test("Source extraction 复用 Story Language，但允许材料边界仍开放的 Contract", () => {
	const extraction = sourceExtraction();
	const second = extraction.beats[1];
	assert.ok(second);
	second.markdown = second.markdown.replace("contracts:\n  resolve: [诈降]\n", "");
	const contract = extraction.contracts[0];
	assert.ok(contract);
	contract.markdown = contract.markdown.replace("deadline: beat-0002", "deadline: book_end");

	const result = checkSource(sourceWith(extraction));
	assert.equal(result.passed, true);
	assert.deepEqual(result.contracts.openContractIds, ["诈降"]);
});

test("Source 不能用从未建立的 book_end Contract 冒充合法开放期待", () => {
	const extraction = sourceExtraction();
	const first = extraction.beats[0];
	const second = extraction.beats[1];
	const contract = extraction.contracts[0];
	assert.ok(first && second && contract);
	first.markdown = first.markdown.replace("contracts:\n  open: [诈降]\n", "");
	second.markdown = second.markdown.replace("contracts:\n  resolve: [诈降]\n", "");
	contract.markdown = contract.markdown.replace("deadline: beat-0002", "deadline: book_end");

	const result = checkSource(sourceWith(extraction));
	assert.equal(result.passed, false);
	assert.deepEqual(result.contracts.openContractIds, []);
	assert.equal(result.contracts.results[0]?.openedAt, null);
});

test("Source 仍拒绝错过显式 Beat deadline 的未解决 Contract", () => {
	const extraction = sourceExtraction();
	const second = extraction.beats[1];
	assert.ok(second);
	second.markdown = second.markdown.replace("contracts:\n  resolve: [诈降]\n", "");

	const result = checkSource(sourceWith(extraction));
	assert.equal(result.passed, false);
	assert.equal(result.contracts.results[0]?.deadlineStoryBeatId, "beat-0002");
});
