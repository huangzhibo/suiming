import { Diamond, MapPin, X } from "lucide-react";
import { useRef } from "react";
import type { AxisModel, CharacterLane } from "./layout.js";

/** 人物的情节引用与硬状态变化共用经历线；同一情节只出现一次，不把引用推断为出场。 */
export function CharacterTrack({
	model,
	lane,
	open,
}: {
	model: AxisModel;
	lane: CharacterLane;
	open(page: string): void;
}) {
	const sections = useRef(new Map<string, HTMLElement>());
	const ordinals = new Set([...lane.present, ...lane.events.map((event) => event.ordinal)]);
	const groups = model.volumes
		.map((volume) => ({
			volume,
			beats: model.beats.filter((beat) => beat.volumeId === volume.id && ordinals.has(beat.ordinal)),
		}))
		.filter((group) => group.beats.length > 0);
	return (
		<section className="mt-7" data-character-track aria-label="人物经历">
			<div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 className="text-base font-semibold">人物经历</h2>
				<span className="text-xs text-muted-foreground">
					{ordinals.size} 个相关情节 · {lane.events.length} 条状态变化
				</span>
			</div>
			<p className="mb-4 text-xs text-muted-foreground">按全书情节顺序；情节引用不等于人物出场。</p>
			{groups.length > 1 && (
				<nav aria-label="按卷定位人物经历" className="mb-5 flex flex-wrap gap-2">
					{groups.map(({ volume, beats }) => (
						<button
							key={volume.id}
							type="button"
							className="navigation-link max-w-full text-left text-xs"
							onClick={() => {
								const section = sections.current.get(volume.id);
								section?.scrollIntoView({ block: "start" });
								section?.focus({ preventScroll: true });
							}}
						>
							{volume.title}
							<span className="ml-1.5 text-muted-foreground">· {beats.length}</span>
						</button>
					))}
				</nav>
			)}
			{groups.map(({ volume, beats }) => (
				<section
					key={volume.id}
					data-character-volume={volume.id}
					aria-label={volume.title}
					tabIndex={-1}
					className="mb-5 scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
					ref={(element) => {
						if (element) sections.current.set(volume.id, element);
						else sections.current.delete(volume.id);
					}}
				>
					<h3 className="mb-3 text-xs font-medium text-muted-foreground">{volume.title}</h3>
					<ol className="ml-2 border-l border-hair">
						{beats.map((beat) => {
							const events = lane.events.filter((event) => event.ordinal === beat.ordinal);
							return (
								<li key={beat.path} data-character-event className="relative pb-3 pl-5 last:pb-1">
									<span
										aria-hidden="true"
										className={`absolute top-2 -left-1 size-2 rounded-full ring-4 ring-background ${events.length ? "bg-primary" : "bg-muted-foreground"}`}
									/>
									<div className="flex items-baseline gap-3">
										<span
											className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
											title={`全书第 ${beat.ordinal + 1} 个情节`}
										>
											{beat.ordinal + 1}
										</span>
										<button
											type="button"
											className="navigation-link -ml-1.5 text-left text-sm font-medium"
											data-page={beat.path}
											onClick={() => open(beat.path)}
										>
											{beat.title}
										</button>
										{lane.present.includes(beat.ordinal) && (
											<span className="shrink-0 text-xs text-muted-foreground">引用</span>
										)}
									</div>
									{events.length > 0 && (
										<div className="mt-1 ml-9 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
											{events.map((event) => {
												const Icon =
													event.kind === "dead" ? X : event.kind === "location" ? MapPin : Diamond;
												return (
													<span
														key={`${event.kind}:${event.note}`}
														className="inline-flex items-center gap-1 text-foreground"
													>
														<Icon className="size-3.5 shrink-0" aria-hidden="true" />
														{event.kind === "dead" ? "死亡" : event.note}
													</span>
												);
											})}
										</div>
									)}
								</li>
							);
						})}
					</ol>
				</section>
			))}
		</section>
	);
}
