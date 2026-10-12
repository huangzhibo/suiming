import { ArrowUp, ArrowUpRight, Circle, Diamond, Info, MapPin, Minus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Hint } from "../ui-bits.js";
import { type CharacterMoment, type CharacterMomentKind, characterJourney } from "./character-journey.js";
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
	children,
}: {
	model: AxisModel;
	lane: CharacterLane;
	open(page: string): void;
	children?: ReactNode;
}) {
	const root = useRef<HTMLElement>(null);
	const sections = useRef(new Map<string, HTMLElement>());
	const moments = useRef(new Map<string, HTMLLIElement>());
	const compactNav = useRef<HTMLDivElement>(null);
	const journey = useMemo(() => characterJourney(model, lane), [model, lane]);
	const [activeVolume, setActiveVolume] = useState(journey.groups[0]?.volume.id);
	const locate = (element: HTMLElement | undefined) => {
		element?.scrollIntoView({ block: "start" });
		element?.focus({ preventScroll: true });
	};
	useEffect(() => {
		const scroll = root.current?.closest<HTMLElement>("[data-scroll-key]");
		if (!scroll) return;
		let frame = 0;
		const update = () => {
			// 窄窗还要计入吸顶栏上下各 8px 留白，定位线需低于 scroll-mt-16 的标题。
			const compactHeight = compactNav.current?.offsetHeight ?? 0;
			const edge = scroll.getBoundingClientRect().top + (compactHeight > 0 ? compactHeight + 40 : 24);
			let current = journey.groups[0]?.volume.id;
			for (const { volume } of journey.groups) {
				if ((sections.current.get(volume.id)?.getBoundingClientRect().top ?? Infinity) <= edge) current = volume.id;
			}
			if (
				scroll.scrollHeight > scroll.clientHeight + 1 &&
				scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1
			) {
				current = journey.groups.at(-1)?.volume.id;
			}
			setActiveVolume(current);
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		scroll.addEventListener("scroll", schedule, { passive: true });
		const resize = () => {
			root.current?.style.setProperty("--character-viewport-height", `${scroll.clientHeight}px`);
			schedule();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(scroll);
		resize();
		return () => {
			scroll.removeEventListener("scroll", schedule);
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [journey]);
	const kinds = (["related", "secret", "location", "dead"] as const).filter((kind) =>
		kind === "related" ? lane.present.length > 0 : journey.events.some((event) => event.kind === kind),
	);
	return (
		<section ref={root} className="@container/character mt-6" data-character-track aria-label="人物经历">
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
					<JourneyDistribution
						model={model}
						entries={journey.entries}
						locate={(entry) => locate(moments.current.get(entry.beat.path))}
					/>
					<div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
						<span>1</span>
						<span>{model.beats.length}</span>
					</div>
				</div>
			)}
			<div
				className={cn(
					"grid items-start gap-x-8",
					journey.groups.length > 1 && "@min-[880px]/character:grid-cols-[minmax(0,1fr)_220px]",
				)}
			>
				{/* 宽窗吸顶间距与卷标题的 scroll-mt-4 一致，首卷自然位置和后续卷吸顶位置才不会跳动。 */}
				{journey.groups.length > 1 && (
					<aside className="sticky top-0 z-10 mb-3 flex max-h-[calc(var(--character-viewport-height)-32px)] min-w-0 flex-col bg-background py-2 @min-[880px]/character:top-4 @min-[880px]/character:order-2 @min-[880px]/character:mb-0">
						<div ref={compactNav} className="flex items-center gap-2 @min-[880px]/character:hidden">
							<Select
								value={activeVolume ?? null}
								items={journey.groups.map(({ volume }) => ({ value: volume.id, label: volume.title }))}
								onValueChange={(value) => {
									if (value) locate(sections.current.get(value));
								}}
							>
								<SelectTrigger size="sm" aria-label="按卷定位人物经历" className="min-w-0 flex-1">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{journey.groups.map(({ volume, entries }) => (
											<SelectItem key={volume.id} value={volume.id}>
												{volume.title} · {entries.length}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							<Hint content="回到人物经历的全书分布">
								<button
									type="button"
									aria-label="回到经历概览"
									className="navigation-link"
									onClick={() => root.current?.scrollIntoView({ block: "start" })}
								>
									<ArrowUp className="size-4" />
								</button>
							</Hint>
						</div>
						<div className="hidden min-h-0 flex-col @min-[880px]/character:flex">
							<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
								<span>按卷定位 · {journey.groups.length} 卷</span>
								<Hint content="回到人物经历的全书分布">
									<button
										type="button"
										aria-label="回到经历概览"
										className="navigation-link"
										onClick={() => root.current?.scrollIntoView({ block: "start" })}
									>
										<ArrowUp className="size-3.5" />
									</button>
								</Hint>
							</div>
							<nav aria-label="按卷定位人物经历" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
								{journey.groups.map(({ volume, entries }) => (
									<Hint
										key={volume.id}
										side="left"
										content={`${volume.title}\n全书第 ${volume.start + 1}–${volume.end + 1} 个情节 · ${entries.length} 个相关情节\n点击定位到本卷经历`}
									>
										<button
											type="button"
											aria-current={activeVolume === volume.id ? "location" : undefined}
											className={cn(
												"navigation-link flex w-full shrink-0 flex-col items-stretch gap-1.5 rounded-md px-3 py-2 text-left text-xs",
												activeVolume === volume.id && "bg-primary-soft text-primary",
											)}
											onClick={() => locate(sections.current.get(volume.id))}
										>
											<span className="flex items-start justify-between gap-2">
												<span>{volume.title}</span>
												<span className="text-muted-foreground tabular-nums">{entries.length}</span>
											</span>
											<span aria-hidden="true" className="h-1 rounded-full bg-muted">
												<span
													className="block h-full rounded-full bg-primary/50"
													style={{
														width: `${(entries.length / Math.max(...journey.groups.map((g) => g.entries.length))) * 100}%`,
													}}
												/>
											</span>
										</button>
									</Hint>
								))}
							</nav>
						</div>
					</aside>
				)}
				{/* 关联文档和页尾留白也属于目录的滚动范围，防止页底把 sticky 目录向上推走。 */}
				<div className="min-w-0 pb-[var(--page-bottom-space)]">
					{journey.groups.map(({ volume, entries }) => (
						<section
							key={volume.id}
							data-character-volume={volume.id}
							aria-label={volume.title}
							tabIndex={-1}
							className="mb-5 scroll-mt-16 @min-[880px]/character:scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
							ref={(element) => {
								if (element) sections.current.set(volume.id, element);
								else sections.current.delete(volume.id);
							}}
						>
							<h3 className="mb-2 rounded-r-md border-l-4 border-primary bg-primary-soft px-3 py-2 text-sm font-semibold">
								{volume.title}
							</h3>
							<ol className="relative before:absolute before:inset-y-2 before:left-[14px] before:border-l before:border-primary-line">
								{entries.map(({ beat, events, kind }) => {
									const style = momentStyle[kind];
									return (
										<li
											key={beat.path}
											data-character-event
											data-character-ordinal={beat.ordinal + 1}
											tabIndex={-1}
											ref={(element) => {
												if (element) moments.current.set(beat.path, element);
												else moments.current.delete(beat.path);
											}}
											data-kind={kind}
											className={cn(
												"@container/moment relative grid grid-cols-[28px_34px_minmax(0,1fr)] scroll-mt-16 items-start rounded-md py-1 pr-3 outline-none focus:ring-2 focus:ring-ring @min-[880px]/character:scroll-mt-4",
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
											<span className="pt-1.5 text-xs tabular-nums text-muted-foreground">
												{beat.ordinal + 1}
											</span>
											<div className="flex min-w-0 flex-col gap-x-5 @min-[600px]/moment:flex-row @min-[600px]/moment:flex-wrap @min-[600px]/moment:items-baseline">
												<Hint content={`第 ${beat.ordinal + 1} 个情节 · ${volume.title}\n打开情节设计`}>
													<button
														type="button"
														className="navigation-link -ml-1.5 flex max-w-full items-center gap-2 text-left text-sm font-medium"
														data-page={beat.path}
														onClick={() => open(beat.path)}
													>
														<span>{beat.title}</span>
														{events.length > 0 && (
															<ArrowUpRight
																className={cn("size-3.5 shrink-0", style.color)}
																aria-hidden="true"
															/>
														)}
													</button>
												</Hint>
												{events.length > 0 && (
													<div className="flex min-w-0 flex-col gap-1 py-1 text-xs">
														{events.map((event) => {
															const eventStyle = momentStyle[event.kind];
															return (
																<span
																	key={`${event.kind}:${event.note}`}
																	className={cn("inline-flex items-start gap-1.5", eventStyle.color)}
																>
																	<eventStyle.Icon
																		className="mt-0.5 size-3 shrink-0"
																		aria-hidden="true"
																	/>
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
					{children}
				</div>
			</div>
		</section>
	);
}

/** 一条可用鼠标与键盘探索的分布带，避免密集人物出现上百个重叠热区或 Tab 停靠点。 */
function JourneyDistribution({
	model,
	entries,
	locate,
}: {
	model: AxisModel;
	entries: CharacterMoment[];
	locate(entry: CharacterMoment): void;
}) {
	const [index, setIndex] = useState(0);
	const plot = useRef<HTMLSpanElement>(null);
	const marker = useRef<HTMLSpanElement>(null);
	const entry = entries[Math.min(index, entries.length - 1)];
	if (!entry) return null;
	const volume = model.volumes.find((volume) => volume.id === entry.beat.volumeId);
	return (
		<Hint
			anchor={marker}
			side="top"
			content={`${volume?.title} · 第 ${entry.beat.ordinal + 1} 个情节\n${entry.beat.title}${entry.events.map((event) => `\n${event.note}`).join("")}\n点击定位 · ← → 切换情节`}
		>
			<button
				type="button"
				role="slider"
				aria-label="全书分布"
				aria-valuemin={1}
				aria-valuemax={model.beats.length}
				aria-valuenow={entry.beat.ordinal + 1}
				aria-valuetext={`${entry.beat.title}，${volume?.title}，${entry.events.map((event) => event.note).join("；")}`}
				data-character-distribution
				className="group relative block h-8 w-full rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onPointerMove={(event) => {
					const bounds = plot.current?.getBoundingClientRect();
					if (!bounds) return;
					const ordinal = ((event.clientX - bounds.left) / bounds.width) * model.beats.length - 0.5;
					let closest = 0;
					for (let next = 1; next < entries.length; next++) {
						if (
							Math.abs((entries[next]?.beat.ordinal ?? Infinity) - ordinal) <
							Math.abs((entries[closest]?.beat.ordinal ?? Infinity) - ordinal)
						)
							closest = next;
					}
					setIndex(closest);
				}}
				onKeyDown={(event) => {
					if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					setIndex((old) =>
						event.key === "Home"
							? 0
							: event.key === "End"
								? entries.length - 1
								: Math.max(
										0,
										Math.min(
											entries.length - 1,
											old + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1),
										),
									),
					);
				}}
				onClick={() => locate(entry)}
			>
				<span ref={plot} data-character-plot aria-hidden="true" className="absolute inset-x-2 inset-y-0">
					{model.volumes.map((volume) => (
						<span
							key={volume.id}
							aria-hidden="true"
							className="absolute inset-y-0 border-l border-background bg-primary-soft first:rounded-l-md last:rounded-r-md"
							style={{
								left: `${(volume.start / model.beats.length) * 100}%`,
								width: `${((volume.end - volume.start + 1) / model.beats.length) * 100}%`,
							}}
						/>
					))}
					{entries.map((moment) => {
						const style = momentStyle[moment.kind];
						const Icon = moment.kind === "related" ? Minus : style.Icon;
						return (
							<Icon
								key={moment.beat.path}
								aria-hidden="true"
								className={cn(
									"pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2",
									moment.kind === "related" ? "size-2.5 rotate-90" : "size-3.5",
									style.color,
									style.mark,
								)}
								style={{ left: `${moment.position}%` }}
							/>
						);
					})}
					<span
						aria-hidden="true"
						ref={marker}
						data-character-selection
						className="pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 rounded-full border border-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
						style={{ left: `${entry.position}%` }}
					/>
				</span>
			</button>
		</Hint>
	);
}
