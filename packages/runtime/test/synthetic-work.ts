import type { SampleWorkFile } from "./sample-work.js";

const encoder = new TextEncoder();

export interface SyntheticWorkOptions {
	volumes?: number;
	beatsPerVolume?: number;
	characters?: number;
	/** 每个 Beat 正文段落重复的句数，用来把 Design 撑过 Frame 阈值。 */
	proseSentences?: number;
}

/**
 * 合成一部超过 Frame 全量阈值的 Design：默认 3 卷 × 12 Beat、12 人物、4 地点、每卷一个 Contract，
 * 每个 Beat 引用两个人物与一个地点，第一卷内有 refs.beat 依赖；用来验证 Design Context 裁剪，
 * 内容没有文学意义。与 sample-work.ts 一样是 test 目录里的普通 helper。
 */
export function syntheticWorkFiles(options: SyntheticWorkOptions = {}): SampleWorkFile[] {
	const volumeCount = options.volumes ?? 3;
	const perVolume = options.beatsPerVolume ?? 12;
	const characterCount = options.characters ?? 12;
	const sentences = options.proseSentences ?? 20;
	const characters = Array.from({ length: characterCount }, (_, index) => `人物${String(index).padStart(2, "0")}`);
	const places = ["城东", "城西", "北道", "渡口"];
	const beatId = (index: number) => `beat-${String(index + 1).padStart(4, "0")}`;
	const volumeId = (index: number) => `vol-${String(index + 1).padStart(4, "0")}`;
	const files = new Map<string, string>();

	files.set(
		"intent/主旨.md",
		"---\nstyle_refs: [style_plain]\n---\n人物的每一个选择都要在当场付出可见代价，不靠巧合脱身。\n",
	);
	files.set("reference/style/style_plain.md", "短句，少解释。\n");
	files.set("world/core.md", "# 世界公理\n\n城邦之间以渡口为界，粮与信都要过渡口。\n");
	for (const [index, character] of characters.entries()) {
		files.set(
			`world/characters/${character}.md`,
			`---\naliases: [${character}的别名]\n---\n${character}出身${places[index % places.length]}，想要一个不被别人替他安排的去处。\n`,
		);
	}
	for (const place of places) files.set(`world/places/${place}.md`, `${place}是一处可被封锁的要地。\n`);

	const volumes: string[] = [];
	for (let volume = 0; volume < volumeCount; volume += 1) {
		const contractId = `承诺${volume + 1}`;
		const ids: string[] = [];
		for (let offset = 0; offset < perVolume; offset += 1) {
			const index = volume * perVolume + offset;
			const id = beatId(index);
			ids.push(id);
			const cast = [...new Set([characters[index % characterCount], characters[(index * 5 + 1) % characterCount]])];
			const place = places[index % places.length];
			const refs = [`  character: [${cast.join(", ")}]`, `  place: [${place}]`];
			if (offset > 0 && offset % 3 === 0) refs.push(`  beat: [${beatId(index - 1)}]`);
			const contracts =
				offset === 0
					? `contracts:\n  open: [${contractId}]\n`
					: offset === perVolume - 1
						? `contracts:\n  resolve: [${contractId}]\n`
						: "";
			const prose = Array.from(
				{ length: sentences },
				(_, sentence) =>
					`${cast[0]}在${place}第${sentence + 1}次向${cast[cast.length - 1]}提出要求，对方拒绝了一半，另一半以粮换人。`,
			).join("");
			files.set(
				`outline/story/${volumeId(volume)}/${id}.md`,
				`---\ntitle: 第${index + 1}场\nrefs:\n${refs.join("\n")}\n${contracts}---\n${prose}\n`,
			);
		}
		volumes.push(`  - id: ${volumeId(volume)}\n    title: 第${volume + 1}卷\n    beat_ids: [${ids.join(", ")}]`);
		files.set(
			`outline/contracts/${contractId}.md`,
			`---\nsubjects:\n  character: [${characters[volume % characterCount]}]\ndeadline: ${ids[ids.length - 1]}\n---\n第${volume + 1}卷的长期期待必须在卷末兑现。\n`,
		);
	}
	files.set("outline/story/index.yaml", `schema_version: 2\nvolumes:\n${volumes.join("\n")}\n`);

	return [...files.entries()].map(([path, text]) => ({
		path,
		mediaType: path.endsWith(".yaml") ? "application/yaml" : "text/markdown",
		bytes: encoder.encode(text),
	}));
}
