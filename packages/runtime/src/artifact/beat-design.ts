import {
	type BoundDesign,
	type CreativeIntent,
	type IdentityEntry,
	intentCoversBeat,
	type StoryBeat,
	type StoryContract,
	type WorldEntry,
} from "@suiming/story";

export interface BeatIdentity {
	kind: "character" | "place" | "resource";
	entry: IdentityEntry;
	/** refs 没写、只出现在这一节硬状态变化里（stateRefs），比如物品交到一个不在场的人手里。 */
	stateOnly: boolean;
}

export interface BeatDesign {
	/** 人物、地点、物品依次排；每类里 refs 写了的在前，只出现在 changes 里的在后。 */
	identities: BeatIdentity[];
	/** world/core 在前（存在时），然后是 refs 里的 World 文档。 */
	world: WorldEntry[];
	contracts: { phase: "open" | "advance" | "resolve"; contract: StoryContract }[];
	intents: CreativeIntent[];
}

const IDENTITY_KINDS = ["character", "place", "resource"] as const;

function idsOf(refs: readonly string[], kind: string): string[] {
	const prefix = `${kind}:`;
	return refs.filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length));
}

/**
 * 写一节正文要读的那部分 Design。Write Context 照它装入，正文时效的 Design 闭包（`designClosurePaths`）照它比较，
 * 两边必须是同一份：写的时候没读过的文件改了，不该让这节正文变成「设计已变」；读过的改了，必须变。2026-10-04 之前
 * 两边各写一份，Writer 拿不到 world/core 与只在 changes 里出现的人物物品，闭包却都算上了。
 *
 * - 人物 / 地点 / 物品：refs 里的，加上只出现在这一节硬状态变化里的——状态变了的参与者，Writer 得知道是谁。
 * - World：world/core（Story Language：多数局部任务不读它就可能误判故事，所以不要求 Beat 引用）加 refs 里的。
 * - Contract：这一节 open / advance / resolve 的；Intent：覆盖这一节的。
 * 其它 Beat 的细纲不在里面（ADR-0009 决定 13），它们的 changes 只经硬状态时间线进来。
 */
export function beatDesign(design: BoundDesign, beat: StoryBeat): BeatDesign {
	const identities: BeatIdentity[] = [];
	for (const kind of IDENTITY_KINDS) {
		const entries = kind === "character" ? design.characters : kind === "place" ? design.places : design.resources;
		const authored = idsOf(beat.refs, kind);
		const stateOnly = idsOf(beat.stateRefs, kind).filter((id) => !authored.includes(id));
		for (const [ids, flag] of [
			[authored, false],
			[stateOnly, true],
		] as const) {
			for (const id of ids) {
				const entry = entries.find((item) => item.id === id);
				if (entry !== undefined) identities.push({ kind, entry, stateOnly: flag });
			}
		}
	}
	const core = design.world.find((entry) => entry.id === "core");
	const world = [
		...(core === undefined ? [] : [core]),
		...idsOf(beat.refs, "world")
			.filter((id) => id !== "core")
			.flatMap((id) => design.world.filter((entry) => entry.id === id)),
	];
	const contracts: BeatDesign["contracts"] = [];
	for (const phase of ["open", "advance", "resolve"] as const) {
		for (const id of beat.contracts[phase]) {
			const contract = design.contracts.find((item) => item.id === id);
			if (contract !== undefined) contracts.push({ phase, contract });
		}
	}
	const ordinals = new Map(design.story.beats.map((item) => [item.id, item.ordinal]));
	const intents = design.intents.filter((intent) => intentCoversBeat(intent, beat, ordinals));
	return { identities, world, contracts, intents };
}
