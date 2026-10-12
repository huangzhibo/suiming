import { ArrowUpRight, Circle, Diamond, Info, MapPin, Minus, X } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { Hint } from "../ui-bits.js";
import { type CharacterMomentKind, characterJourney } from "./character-journey.js";
import type { AxisModel, CharacterLane } from "./layout.js";

const momentStyle = {
	related: { label: "相关情节", Icon: Circle, color: "text-primary", surface: "", mark: "fill-primary" },
	secret: { label: "秘密揭示", Icon: Diamond, color: "text-purple", surface: "bg-purple-bg/60", mark: "fill-purple" },
	location: { label: "位置变化", Icon: MapPin, color: "text-amber", surface: "bg-amber-bg", mark: "fill-amber-bg" },
	dead: { label: "死亡", Icon: X, color: "text-destructive", surface: "bg-red-bg/60", mark: "" },
} satisfies Record<CharacterMomentKind, object>;

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
	const journey = characterJourney(model, lane);
	const kinds = (["related", "secret", "location", "dead"] as const).filter((kind) =>
		kind === "related" ? lane.present.length > 0 : journey.events.some((event) => event.kind === kind),
	);
	return (
		<section className="mt-6" data-character-track aria-label="人物经历">
			<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 className="text-base font-semibold">人物经历</h2>
				<span className="text-xs text-muted-foreground">
					{journey.entries.length} 个相关情节
					{journey.events.length > 0 && ` · ${journey.events.length} 条状态变化`}
				</span>
				<Hint content="按全书情节顺序展示设计中的人物引用与状态变化。引用不等于出场；未记录的变化不作推断。">
					<button type="button" aria-label="人物经历说明" className="navigation-link text-muted-foreground">
						<Info className="size-3.5" aria-hidden="true" />
					</button>
				</Hint>
			</div>
			{journey.overview && (
				<div className="mb-4" data-character-overview>
					<div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
						<h3 className="text-xs font-medium text-sub">全书分布</h3>
						<fieldset
							className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
							aria-label="经历图例"
						>
							{kinds.map((kind) => {
								const style = momentStyle[kind];
								return (
									<span key={kind} className="inline-flex items-center gap-1.5">
										<style.Icon className={cn("size-3", style.color, style.mark)} aria-hidden="true" />
										{style.label}
									</span>
								);
							})}
						</fieldset>
					</div>
					<div
						role="img"
						aria-label={`全书分布：${model.beats.length} 个情节中有 ${journey.entries.length} 个相关情节，分布在 ${journey.groups.length} 卷`}
						className="relative mx-1 h-5 rounded-full bg-muted"
					>
						{model.volumes.map((volume) => (
							<span
								key={volume.id}
								aria-hidden="true"
								className={cn(
									"absolute inset-y-0 border-l border-background first:rounded-l-full last:rounded-r-full",
									journey.groups.some((group) => group.volume.id === volume.id) && "bg-primary-soft",
								)}
								style={{
									left: `${(volume.start / model.beats.length) * 100}%`,
									width: `${((volume.end - volume.start + 1) / model.beats.length) * 100}%`,
								}}
							/>
						))}
						{journey.entries
							.filter((entry) => entry.kind === "related")
							.map((entry) => (
								<Minus
									key={entry.beat.path}
									aria-hidden="true"
									className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-90 text-primary"
									style={{ left: `${entry.position}%` }}
									strokeWidth={3}
								/>
							))}
						{journey.entries
							.filter((entry) => entry.kind !== "related")
							.map((entry) => {
								const style = momentStyle[entry.kind];
								return (
									<style.Icon
										key={entry.beat.path}
										aria-hidden="true"
										className={cn(
											"absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2",
											style.color,
											style.mark,
										)}
										style={{ left: `${entry.position}%` }}
									/>
								);
							})}
					</div>
					<div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
						<span>1</span>
						<span>{model.beats.length}</span>
					</div>
				</div>
			)}
			{journey.groups.length > 1 && (
				<nav aria-label="按卷定位人物经历" className="mb-4 flex flex-wrap gap-x-2 gap-y-1">
					{journey.groups.map(({ volume, entries }) => (
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
							<span className="ml-1 text-muted-foreground">· {entries.length}</span>
						</button>
					))}
				</nav>
			)}
			{journey.groups.map(({ volume, entries }) => (
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
					<h3 className="mb-2 rounded-r-md border-l-4 border-primary bg-primary-soft px-3 py-2 text-sm font-semibold">
						{volume.title}
					</h3>
					<ol className="relative before:absolute before:inset-y-2 before:left-[17px] before:border-l before:border-primary-line">
						{entries.map(({ beat, events, kind }) => {
							const style = momentStyle[kind];
							return (
								<li
									key={beat.path}
									data-character-event
									data-kind={kind}
									className={cn(
										"relative grid grid-cols-[34px_34px_minmax(0,1fr)] items-start rounded-md py-1.5 pr-2",
										events.length > 0 && "my-1 py-2",
										style.surface,
									)}
								>
									<style.Icon
										className={cn(
											"relative justify-self-center bg-background",
											kind === "related"
												? "mt-2 size-2.5 rounded-full ring-2 ring-background"
												: "mt-1.5 size-4 rounded-sm",
											style.color,
											style.mark,
										)}
										aria-hidden="true"
									/>
									<span
										className="pt-1.5 text-xs tabular-nums text-muted-foreground"
										title={`全书第 ${beat.ordinal + 1} 个情节`}
									>
										{beat.ordinal + 1}
									</span>
									<div className="min-w-0">
										<button
											type="button"
											className="navigation-link -ml-1.5 flex max-w-full items-center gap-2 text-left text-sm font-medium"
											data-page={beat.path}
											onClick={() => open(beat.path)}
										>
											<span>{beat.title}</span>
											{events.length > 0 && (
												<ArrowUpRight className={cn("size-3.5 shrink-0", style.color)} aria-hidden="true" />
											)}
										</button>
										{events.length > 0 && (
											<div className="mt-1 flex flex-col gap-1 text-xs">
												{events.map((event) => {
													const eventStyle = momentStyle[event.kind];
													return (
														<span
															key={`${event.kind}:${event.note}`}
															className={cn("inline-flex items-start gap-1.5", eventStyle.color)}
														>
															<eventStyle.Icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
															{event.kind === "dead" ? "死亡" : event.note}
														</span>
													);
												})}
											</div>
										)}
									</div>
								</li>
							);
						})}
					</ol>
				</section>
			))}
		</section>
	);
}
