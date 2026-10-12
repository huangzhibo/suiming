import { MapPin, Package, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Book } from "../model.js";
import type { AxisModel, ResourceLane } from "./layout.js";

/** 地点没有空间坐标：只按作品实际顺序整理相关情节，不把提及解释成发生地。 */
export function PlaceUsage({ book, model, path }: { book: Book; model: AxisModel; path: string }) {
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
			<div className="mb-3 flex items-baseline gap-3">
				<h2 className="text-sm font-semibold">关联分布</h2>
				<span className="text-xs text-muted-foreground">
					{total} 个 · {groups.length} 卷
				</span>
			</div>
			{!total && <p className="text-sm text-muted-foreground">尚无情节关联这个地点。</p>}
			<div className="space-y-2">
				{groups.map((group) => (
					<section key={group.id} data-place-volume>
						<div className="grid max-w-xl grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3">
							<h3 className="min-w-0 text-xs font-semibold break-words text-success">{group.title}</h3>
							{
								<div className="h-1.5 rounded-full bg-green-bg" aria-hidden="true">
									<div
										className="h-full rounded-full bg-success"
										style={{ width: `${(group.beats.length / maximum) * 100}%` }}
									/>
								</div>
							}
							<span className="text-xs tabular-nums text-muted-foreground">{group.beats.length} 个</span>
						</div>
					</section>
				))}
			</div>
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
	const clean = (value: string) => value.replace(/^(character|place):/u, "");
	const holder = (value: string) => (value === "none" ? "无人持有" : `由${clean(value)}持有`);
	return (
		<section className="mt-6" data-resource-flow>
			<div className="mb-3 flex flex-wrap items-baseline gap-3">
				<h2 className="text-sm font-semibold">资源流转</h2>
				<span className="text-xs text-muted-foreground">{lane?.events.length ?? 0} 条变化记录</span>
			</div>
			{!lane?.events.length && (
				<p className="text-sm text-muted-foreground">尚无归属、位置、消耗或毁坏的变化记录。</p>
			)}
			{lane && lane.events.length > 0 && (
				<>
					<p className="mb-3 text-xs text-muted-foreground">
						开场归属：{lane.initialHolder === undefined ? "未声明" : holder(lane.initialHolder)}
					</p>
					<ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
						{lane.events.map((event) => {
							const beat = model.beats[event.ordinal];
							if (!beat) return null;
							const Icon = event.kind === "holder" ? UserRound : event.kind === "location" ? MapPin : Package;
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
								<li
									key={`${event.ordinal}:${event.kind}`}
									data-resource-event
									className="min-w-0 rounded-lg border border-hair p-3"
								>
									<div className="mb-2 flex items-start gap-2">
										<span className={cn("rounded-md p-1.5", color)}>
											<Icon className="size-4" aria-hidden="true" />
										</span>
										<div className="min-w-0">
											<p className="text-xs text-muted-foreground">第 {event.ordinal + 1} 个情节</p>
											<p className="mt-0.5 text-sm font-medium break-words">{label}</p>
										</div>
									</div>
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
				</>
			)}
		</section>
	);
}
