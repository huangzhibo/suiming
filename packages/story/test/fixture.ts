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
title: 旧档案
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
黄盖进入旧档案库，取得火船；位置在档案库。
`,
			},
			{
				volumeId: "vol-0001",
				beatId: "beat-0002",
				path: "outline/story/vol-0001/beat-0002.md",
				markdown: `---
title: 焚信
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
黄盖公开苦肉计并焚毁唯一火船。
`,
			},
		],
		characters: [
			{
				id: "黄盖",
				path: "world/characters/黄盖.md",
				markdown: "---\nname: 黄盖\naliases: [公覆]\n---\n想查明苦肉计，却必须在真相与家族安全之间选择。",
			},
		],
		places: [
			{
				id: "赤壁",
				path: "world/places/赤壁.md",
				markdown: "---\nname: 赤壁\n---\n收藏旧朝档案的封闭库房。",
			},
		],
		resources: [
			{
				id: "火船",
				path: "world/resources/火船.md",
				markdown: "---\nname: 火船\ninitial:\n  holder: 黄盖\n---\n唯一一封能证明苦肉计的火船。",
			},
		],
		world: [],
		contracts: [
			{
				id: "诈降",
				path: "outline/contracts/诈降.md",
				markdown:
					"---\nsubjects:\n  character: [黄盖]\n  resource: [火船]\n  secret: [苦肉计]\ndeadline: beat-0002\n---\n黄盖公开真相时，必须失去唯一火船。",
			},
		],
		intents: [
			{
				id: "计谋的代价",
				path: "intent/计谋的代价.md",
				markdown:
					"---\nstyle_refs: [style_contemporary_restraint]\n---\n黄盖计谋的代价时必须消耗不可恢复的资源，不能靠巧合脱身。",
			},
		],
		styleIds: ["style_contemporary_restraint"],
	};
}
