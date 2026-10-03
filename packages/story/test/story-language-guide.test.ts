import assert from "node:assert/strict";
import test from "node:test";
import { renderSourceStoryLanguageSchemaGuide, renderTargetStoryLanguageSchemaGuide } from "../src/index.js";

test("Source Story Language 机器结构由 schema 渲染，不携带 capability 策略", () => {
	const guide = renderSourceStoryLanguageSchemaGuide("访谈");
	assert.match(guide, /source\/访谈\/outline\/story\/index\.yaml/u);
	assert.match(guide, /schema_version: 2/u);
	assert.match(guide, /refs: # optional/u);
	assert.match(guide, /secret: \[<identity-id>, \.\.\.\] # optional/u);
	assert.match(guide, /kind: <"parent" \| "spouse" \| "sibling" \| "guardian">/u);
	assert.match(guide, /deadline: <book_end \| beat-id> # optional/u);
	assert.match(guide, /<state-property>: <non-empty string \| boolean>/u);
	assert.doesNotMatch(guide, /style_refs|intent\//u);
	assert.doesNotMatch(guide, /只修改|运行 check|提交/u);
	assert.ok(guide.length < 6_000, `Source Story Language guide is too large: ${guide.length}`);
});

test("Target Story Language 机器结构带 Intent frontmatter 与硬状态属性表，都由 schema 与 profile 渲染", () => {
	const guide = renderTargetStoryLanguageSchemaGuide();
	assert.match(guide, /^## intent\/<intent-id>\.md frontmatter/mu);
	assert.match(guide, /style_refs: \[<string>, \.\.\.\] # optional/u);
	assert.match(guide, /target: <"book" \| \{ from_beat_id: <beat-id>, to_beat_id: <beat-id> \}> # optional/u);
	assert.match(guide, /^## outline\/story\/index\.yaml/mu);
	assert.match(guide, /^## world\/characters\/<character-id>\.md frontmatter/mu);
	assert.match(guide, /dead: 主体 character；值 boolean/u);
	assert.match(guide, /holder: 主体 resource；值 character 的 id 或 none/u);
	assert.match(guide, /consumed: 主体 resource；值 boolean；终止态/u);
	assert.match(guide, /不在表里的属性会被 check 拒绝/u);
	assert.doesNotMatch(guide, /source\/<source-id>\/outline/u);
	assert.doesNotMatch(guide, /只修改|运行 check 后|提交/u);
	assert.ok(guide.length < 8_000, `Target Story Language guide is too large: ${guide.length}`);
});

test("Source 版说明也带硬状态规则：属性表、两种键的写法、人物与读者作用域只放 secret.revealed", () => {
	// 2026-10-02 斗破抽取：Source 版说明漏了整段硬状态，只剩 `<state-property>: <non-empty string | boolean>`，
	// DeepSeek 与 GPT-6.1 Sol 都把修为、位置、伤势写成自由文字塞进 changes.character，Checker 整片拒绝。
	for (const guide of [renderSourceStoryLanguageSchemaGuide("访谈"), renderTargetStoryLanguageSchemaGuide()]) {
		assert.match(guide, /location: 主体 character \| resource；值 place 的 id 或 none/u);
		assert.match(guide, /changes 里的键写成 `<主体id>\.<属性>`/u);
		assert.match(guide, /initial 里主体就是这个文件，键只写属性/u);
		assert.match(guide, /`reader` 与 `character` 作用域只能写 revealed/u);
		assert.match(guide, /修为、伤势/u);
	}
});

test("说明写明中文作品的本地 id 用中文、title 只写标题：作者在文件与界面上看到的就是它们", () => {
	// 2026-10-02 斗破抽取（GPT-6.1 Sol）：Contract id 全是 cave-treasure 这类英文，故事轴的期待泳道露出英文；
	// Beat 标题带「（原作1—4章）」。host 版（Claude Code）用了中文 id，没有这个问题——差别只在模型自己的选择。
	for (const guide of [renderSourceStoryLanguageSchemaGuide("访谈"), renderTargetStoryLanguageSchemaGuide()]) {
		assert.match(guide, /中文作品.*本地 id 用中文/u);
		assert.match(guide, /title 只写标题，不带章节范围/u);
	}
});

test("Story Language 语义原文随 @suiming/story 发布，按主题可取；与仓库 story-language/*.md 逐字一致", async () => {
	// 2026-10-02 审查：host 的 Skill 带着 story-language/*.md，Agent 只有 story_guide 的字段形状，
	// 「Beat 保证因果完整」「人物档写开场基底」「秘密在 refs.secret 声明」这些语义一条也看不到。
	const { readdir, readFile } = await import("node:fs/promises");
	const { STORY_LANGUAGE_DOCS, storyLanguageTopic } = await import("../src/index.js");
	const dir = new URL("../../../story-language/", import.meta.url);
	const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
	assert.deepEqual(
		STORY_LANGUAGE_DOCS.map((doc) => doc.name),
		names,
	);
	for (const doc of STORY_LANGUAGE_DOCS)
		assert.equal(doc.text, `${(await readFile(new URL(doc.name, dir), "utf8")).replace(/\r\n/gu, "\n").trimEnd()}\n`);
	assert.match(storyLanguageTopic("outline") ?? "", /StoryBeat 保证因果完整/u);
	// 2026-10-03 前 12 章小样本分了 4 卷，一场冲突一卷：Story Language 对卷只说了「服务故事组织」
	assert.match(storyLanguageTopic("outline") ?? "", /一场冲突不单独成卷/u);
	assert.equal(STORY_LANGUAGE_DOCS.find((doc) => doc.topic === "state")?.title, "硬状态投影");
	assert.equal(storyLanguageTopic("不存在"), undefined);
});
