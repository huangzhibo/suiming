import type { DesignDocuments } from "../src/index.js";

export type MutableDesignDocuments = {
	[Key in keyof DesignDocuments]: DesignDocuments[Key] extends readonly (infer Item)[] ? Item[] : DesignDocuments[Key];
};

export function twoBeatDesignDocuments(): MutableDesignDocuments {
	return {
		storyIndex: {
			schema_version: 2,
			volumes: [{ id: "vol-0001", title: "赤壁之战", beat_ids: ["beat-0001", "beat-0002"] }],
		},
		beats: [
			{
				volumeId: "vol-0001",
				beatId: "beat-0001",
				path: "outline/story/vol-0001/beat-0001.md",
				markdown: `---
title: 苦肉计
refs:
  character: [黄盖]
  place: [赤壁]
  resource: [火船]
  secret: [苦肉计]
contracts:
  open: [诈降]
changes:
  world:
    黄盖.location: 赤壁
---
黄盖在赤壁大营当众挨了军杖，托人给曹操送去降书；他留在赤壁。
`,
			},
			{
				volumeId: "vol-0001",
				beatId: "beat-0002",
				path: "outline/story/vol-0001/beat-0002.md",
				markdown: `---
title: 火烧赤壁
refs:
  character: [黄盖]
  resource: [火船]
  secret: [苦肉计]
  beat: [beat-0001]
contracts:
  resolve: [诈降]
changes:
  world:
    火船.consumed: true
    secret:苦肉计.revealed: true
  reader:
    secret:苦肉计.revealed: true
---
约定之夜，黄盖的火船冲进曹营，曹操这才知道挨打是苦肉计，火船随之烧尽。
`,
			},
		],
		characters: [
			{
				id: "黄盖",
				path: "world/characters/黄盖.md",
				markdown: "---\nname: 黄盖\naliases: [公覆]\n---\n江东老将，甘愿当众挨打做苦肉计，为火攻铺路。",
			},
		],
		places: [
			{
				id: "赤壁",
				path: "world/places/赤壁.md",
				markdown: "---\nname: 赤壁\n---\n长江南岸，孙刘联军扎营之处。",
			},
		],
		resources: [
			{
				id: "火船",
				path: "world/resources/火船.md",
				markdown: "---\nname: 火船\ninitial:\n  holder: 黄盖\n---\n黄盖备下的二十艘火船，舱里装满浇了油的干柴。",
			},
		],
		world: [],
		contracts: [
			{
				id: "诈降",
				path: "outline/contracts/诈降.md",
				markdown:
					"---\nsubjects:\n  character: [黄盖]\n  resource: [火船]\n  secret: [苦肉计]\ndeadline: beat-0002\n---\n黄盖的投降是假的，约定之夜必须兑现成一把火，火船随之烧尽。",
			},
		],
		intents: [
			{
				id: "计谋的代价",
				path: "intent/计谋的代价.md",
				markdown:
					"---\nstyle_refs: [style_contemporary_restraint]\n---\n黄盖的计谋必须用不可恢复的东西去换，不能靠巧合取胜。",
			},
		],
		styleIds: ["style_contemporary_restraint"],
	};
}
