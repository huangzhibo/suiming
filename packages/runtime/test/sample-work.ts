/** 与 Open Story Directory 扫描结果同形状的一个文件。 */
export interface SampleWorkFile {
	path: string;
	mediaType: string;
	bytes: Uint8Array;
}

/**
 * 测试用最小作品：2 个 StoryBeat、1 个 Contract、1 个人物与它的世界依赖，足以走通 Checker、
 * Design 冻结与 Write 的全部确定性检查。内容内联在这里而不是仓库根的 fixture 目录，
 * 因为它是测试数据不是产品内容：它不进入任何产品包的导出面，与 packages/story/test/fixture.ts 一样是 test 目录里的普通 helper。
 *
 * 故事取《三国演义》的苦肉计与火烧赤壁（公有领域）：两节的篇幅交代不了一个陌生的前提，名著读者不用交代就懂。
 * 原先那个自造的「李牧、皇档、密信」作者读不懂，真实模型回归里三次写正文也都卡在它的前后矛盾上（2026-10-03 换掉）。
 * 每个字段都要有情节上的对应：火船开场就在黄盖手里（initial），第一节他在赤壁大营挨打诈降（location），
 * 第二节火船烧尽（consumed），诈降这个约定在第一节立、第二节兑现。
 */
const SAMPLE_WORK_TEXT: Readonly<Record<string, string>> = {
	"intent/计谋的代价.md": `---
style_refs: [style_contemporary_restraint]
---
计谋要让读者看见代价：骗局的每一步，都由人物亲身承担。
`,
	"outline/contracts/诈降.md": `---
subjects:
  character: [黄盖]
  resource: [火船]
deadline: beat-0002
---
黄盖的投降是假的：约定那夜，他带到曹营跟前的不是粮船，而是一把火。
`,
	"outline/story/index.yaml": `schema_version: 2
volumes:
  - id: vol-0001
    title: 赤壁之战
    beat_ids: [beat-0001, beat-0002]
`,
	"outline/story/vol-0001/beat-0001.md": `---
refs:
  character: [黄盖]
  place: [赤壁]
  resource: [火船]
contracts:
  open: [诈降]
changes:
  world:
    黄盖.location: 赤壁
---
赤壁的江东大营里，周瑜召集众将商议破曹。黄盖当众顶撞，说曹军势大，不如早降。周瑜大怒，下令杖责五十，黄盖被打得皮开肉绽。当夜，他托阚泽过江给曹操送去降书，约好日子带粮船来投；他说的粮船，就是早已备好的火船。曹操安插在营中的人回报黄盖确实挨了打，曹操信了。
`,
	"outline/story/vol-0001/beat-0002.md": `---
refs:
  character: [黄盖]
  resource: [火船]
  beat: [beat-0001]
contracts:
  resolve: [诈降]
changes:
  world:
    火船.consumed: true
---
约定那夜，黄盖带着二十艘火船驶向对岸，船头插着约好的青龙牙旗，曹军以为是来投的粮船。离曹营二里，各船同时点火，借着风势冲进用铁索连在一起的战船。曹军船队烧成一片，火船也烧得一艘不剩。
`,
	"reference/style/style_contemporary_restraint.md": `短句，少解释；先让人物行动，再让读者看见代价。
`,
	"world/characters/黄盖.md": `---
name: 黄盖
---
江东老将，跟过孙坚、孙策，如今在周瑜帐下。他看出曹军战船用铁索连在一起，一处起火就躲不开，于是献计诈降火攻。他宁可自己受刑，也不让这条计露出破绽。
`,
	"world/places/赤壁.md": `长江南岸的赤壁，孙刘联军在此扎营；对岸乌林是曹军水寨，战船用铁索连成一片。
`,
	"world/resources/火船.md": `---
initial:
  holder: 黄盖
---
黄盖早已备下的二十艘船，舱里装满浇了油的干柴，外面盖着布幔，看上去像运粮的船。
`,
};

const encoder = new TextEncoder();

/** 样例作品的逻辑路径列表，顺序与 `sampleWorkFiles()` 一致。 */
export function sampleWorkPaths(): string[] {
	return Object.keys(SAMPLE_WORK_TEXT);
}

/** 单个样例文件的原文；路径不存在时抛错，避免测试静默依赖空内容。 */
export function sampleWorkText(path: string): string {
	const text = SAMPLE_WORK_TEXT[path];
	if (text === undefined) throw new Error(`Sample work has no file at ${path}`);
	return text;
}

/** 与 `readOpenStoryDirectory(...).files` 同形状的样例作品快照。 */
export function sampleWorkFiles(): SampleWorkFile[] {
	return Object.entries(SAMPLE_WORK_TEXT).map(([path, text]) => ({
		path,
		mediaType: path.endsWith(".yaml") ? "application/yaml; charset=utf-8" : "text/markdown; charset=utf-8",
		bytes: encoder.encode(text),
	}));
}
