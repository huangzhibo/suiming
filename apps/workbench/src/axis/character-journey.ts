import type { AxisBeat, AxisModel, AxisVolume, CharacterEvent, CharacterLane } from "./layout.js";

export type CharacterMomentKind = "related" | CharacterEvent["kind"];
export interface CharacterMoment {
	beat: AxisBeat;
	events: CharacterEvent[];
	kind: CharacterMomentKind;
	/** 情节中心在全书中的百分比位置；不是人物经历内部的相对位置。 */
	position: number;
}
export interface CharacterJourneyGroup {
	volume: AxisVolume;
	entries: CharacterMoment[];
}

/** 只投影故事轴已有记录，不从标题或正文推断出场、重要性或人物关系。 */
export function characterJourney(model: AxisModel, lane: CharacterLane) {
	const ordinals = new Set(lane.present);
	const changes = new Map<number, CharacterEvent[]>();
	for (const event of lane.events) {
		ordinals.add(event.ordinal);
		changes.set(event.ordinal, [...(changes.get(event.ordinal) ?? []), event]);
	}
	const entries: CharacterMoment[] = model.beats
		.filter((beat) => ordinals.has(beat.ordinal))
		.map((beat) => {
			const events = changes.get(beat.ordinal) ?? [];
			return {
				beat,
				events,
				kind: events.some((event) => event.kind === "dead")
					? "dead"
					: events.some((event) => event.kind === "secret")
						? "secret"
						: events.length
							? "location"
							: "related",
				position: ((beat.ordinal + 0.5) / model.beats.length) * 100,
			};
		});
	const groups: CharacterJourneyGroup[] = model.volumes
		.map((volume) => ({
			volume,
			entries: entries.filter((entry) => entry.beat.volumeId === volume.id),
		}))
		.filter((group) => group.entries.length > 0);
	return {
		entries,
		groups,
		events: entries.flatMap((entry) => entry.events),
		// 全书位置不因记录少而失去价值；没有记录时才省略分布图。
		overview: entries.length > 0,
	};
}
