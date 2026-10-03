import type { DesignDocuments } from "../src/index.js";

export type MutableDesignDocuments = {
	[Key in keyof DesignDocuments]: DesignDocuments[Key] extends readonly (infer Item)[] ? Item[] : DesignDocuments[Key];
};

export function twoBeatDesignDocuments(): MutableDesignDocuments {
	return {
		storyIndex: {
			schema_version: 2,
			volumes: [{ id: "vol-0001", title: "入局", beat_ids: ["beat-0001", "beat-0002"] }],
		},
		beats: [
			{
				volumeId: "vol-0001",
				beatId: "beat-0001",
				path: "outline/story/vol-0001/beat-0001.md",
				markdown: `---
title: 旧档案
refs:
  character: [李牧]
  place: [皇档]
  resource: [密信]
  secret: [旧案真相]
contracts:
  open: [真相的代价]
changes:
  world:
    李牧.location: 皇档
---
李牧进入旧档案库，取得密信；位置在档案库。
`,
			},
			{
				volumeId: "vol-0001",
				beatId: "beat-0002",
				path: "outline/story/vol-0001/beat-0002.md",
				markdown: `---
title: 焚信
refs:
  character: [李牧]
  resource: [密信]
  secret: [旧案真相]
  beat: [beat-0001]
contracts:
  resolve: [真相的代价]
changes:
  world:
    密信.consumed: true
    secret:旧案真相.revealed: true
  reader:
    secret:旧案真相.revealed: true
---
李牧公开旧案真相并焚毁唯一密信。
`,
			},
		],
		characters: [
			{
				id: "李牧",
				path: "world/characters/李牧.md",
				markdown: "---\nname: 李牧\naliases: [小李]\n---\n想查明旧案真相，却必须在真相与家族安全之间选择。",
			},
		],
		places: [
			{
				id: "皇档",
				path: "world/places/皇档.md",
				markdown: "---\nname: 皇档\n---\n收藏旧朝档案的封闭库房。",
			},
		],
		resources: [
			{
				id: "密信",
				path: "world/resources/密信.md",
				markdown: "---\nname: 密信\ninitial:\n  holder: 李牧\n---\n唯一一封能证明旧案真相的密信。",
			},
		],
		world: [],
		contracts: [
			{
				id: "真相的代价",
				path: "outline/contracts/真相的代价.md",
				markdown:
					"---\nsubjects:\n  character: [李牧]\n  resource: [密信]\n  secret: [旧案真相]\ndeadline: beat-0002\n---\n李牧公开真相时，必须失去唯一密信。",
			},
		],
		intents: [
			{
				id: "揭开真相",
				path: "intent/揭开真相.md",
				markdown:
					"---\nstyle_refs: [style_contemporary_restraint]\n---\n李牧揭开真相时必须消耗不可恢复的资源，不能靠巧合脱身。",
			},
		],
		styleIds: ["style_contemporary_restraint"],
	};
}
