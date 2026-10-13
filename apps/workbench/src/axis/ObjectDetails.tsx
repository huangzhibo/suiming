import { Info, MapPin, Package, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Book } from "../model.js";
import { Hint } from "../ui-bits.js";
import type { AxisModel, ResourceLane } from "./layout.js";
import { resourceEventGroups } from "./object-details.js";

/** 地点没有空间坐标：只按作品实际顺序整理相关情节，不把提及解释成发生地。 */
export function PlaceUsage({
	book,
	model,
	path,
	selectedVolume,
	onVolume,
}: {
	book: Book;
	model: AxisModel;
	path: string;
	selectedVolume: string;
	onVolume(volume: string): void;
}) {
	const paths = new Set(book.links.filter((link) => link.to === path).map((link) => link.from));
	const groups = model.volumes
		.map((volume) => ({
			...volume,
			beats: model.beats.filter((beat) => beat.volumeId === volume.id && paths.has(beat.path)),
		}))
		.filter((group) => group.beats.length > 0);
	const total = groups.reduce((sum, group) => sum + group.beats.length, 0);
	const maximum = Math.max(1, ...groups.map((group) => group.beats.length));
	return (
		<section className="mt-6" data-place-usage>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<h2 className="text-sm font-semibold">关联分布</h2>
				{total > 0 && (
					<span className="text-xs text-muted-foreground">
						{total} 个情节 · {groups.length} 卷
					</span>
				)}
				{total > 0 && (
					<Hint
						content={`按卷统计关联这个地点的情节，不等同于事件都发生在这里。${groups.length > 1 ? "选择一卷查看下方关系图。" : ""}`}
					>
						<button type="button" aria-label="地点分布说明" className="navigation-link text-muted-foreground">
							<Info className="size-3.5" />
						</button>
					</Hint>
				)}
				{groups.length > 1 && (
					<Button
						size="xs"
						variant={selectedVolume ? "ghost" : "secondary"}
						aria-pressed={!selectedVolume}
						onClick={() => onVolume("")}
					>
						全书
					</Button>
				)}
			</div>
			{!total && <p className="text-sm text-muted-foreground">尚无情节关联这个地点。</p>}
			<div className="flex max-w-xl flex-col gap-1">
				{groups.map((group) => {
					const content = (
						<>
							<span className="min-w-0 break-words text-left">{group.title}</span>
							<span className="h-1.5 rounded-full bg-green-bg" aria-hidden="true">
								<span
									className="block h-full rounded-full bg-success"
									style={{ width: `${(group.beats.length / maximum) * 100}%` }}
								/>
							</span>
							<span className="tabular-nums text-muted-foreground">{group.beats.length} 个</span>
						</>
					);
					return (
						<div key={group.id} data-place-volume>
							{groups.length > 1 ? (
								<button
									type="button"
									aria-pressed={selectedVolume === group.id}
									className={cn(
										"navigation-link grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-xs",
										selectedVolume === group.id && "bg-accent",
									)}
									onClick={() => onVolume(selectedVolume === group.id ? "" : group.id)}
								>
									{content}
								</button>
							) : (
								<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 py-2 text-xs">
									{content}
								</div>
							)}
						</div>
					);
				})}
			</div>
			{selectedVolume && (
				<p className="mt-2 text-xs text-muted-foreground" role="status">
					关系图范围：{groups.find((group) => group.id === selectedVolume)?.title}
				</p>
			)}
		</section>
	);
}

/** 资源流转只呈现已声明的 holder / location / consumed / destroyed；来源情节始终可打开。 */
export function ResourceFlow({
	model,
	lane,
	open,
}: {
	model: AxisModel;
	lane: ResourceLane | undefined;
	open(page: string): void;
}) {
	const groups = resourceEventGroups(lane?.events ?? []);
	const clean = (value: string) => value.replace(/^(character|place):/u, "");
	const holder = (value: string) => (value === "none" ? "无人持有" : `由${clean(value)}持有`);
	return (
		<section className="mt-6" data-resource-flow>
			<div className="mb-3 flex flex-wrap items-baseline gap-3">
				<h2 className="text-sm font-semibold">资源流转</h2>
				{lane && lane.events.length > 0 && (
					<span className="text-xs text-muted-foreground">
						{lane.events.length} 条变化记录
						{groups.length < lane.events.length && ` · ${groups.length} 个情节`}
					</span>
				)}
			</div>
			{!lane?.events.length && (
				<p className="text-sm text-muted-foreground">尚无归属、位置、消耗或毁坏的变化记录。</p>
			)}
			{lane && lane.events.length > 0 && (
				<ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
					{groups.map((group) => {
						const beat = model.beats[group.ordinal];
						if (!beat) return null;
						return (
							<li key={group.ordinal} data-resource-event className="min-w-0 rounded-lg border border-hair p-3">
								<p className="mb-2 text-xs text-muted-foreground">第 {group.ordinal + 1} 个情节</p>
								{group.events.map((event) => {
									const Icon =
										event.kind === "holder" ? UserRound : event.kind === "location" ? MapPin : Package;
									const color =
										event.kind === "holder"
											? "text-primary bg-accent"
											: event.kind === "location"
												? "text-amber-ink bg-amber-bg"
												: event.kind === "destroyed"
													? "text-red-ink bg-red-bg"
													: "text-muted-foreground bg-muted";
									const label =
										event.kind === "holder"
											? holder(event.value)
											: event.kind === "location"
												? event.value === "none"
													? "未设定位置"
													: `位于${clean(event.value)}`
												: event.kind === "consumed"
													? "已消耗"
													: "已毁坏";
									return (
										<div key={event.kind} className="mb-2 flex items-center gap-2" data-resource-change>
											<span className={cn("rounded-md p-1", color)}>
												<Icon className="size-3.5" aria-hidden="true" />
											</span>
											<p className="min-w-0 text-sm font-medium break-words">{label}</p>
										</div>
									);
								})}

								<button
									type="button"
									className="navigation-link text-left text-xs leading-relaxed break-words"
									data-page={beat.path}
									onClick={() => open(beat.path)}
								>
									{beat.title}
								</button>
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}
