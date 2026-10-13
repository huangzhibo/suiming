import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Clock3, Flag, Info, MoveRight, TriangleAlert } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { invoke } from "../bridge.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.js";
import { EmptyNote, Hint, Tag } from "../ui-bits.js";
import { type ContractPhase, contractExcerpt, contractJourney } from "./contract-journey.js";
import type { AxisModel, ContractLane } from "./layout.js";
import { contractStatus } from "./layout.js";

const PHASES = {
	open: { label: "建立", Icon: Flag, color: "text-primary", surface: "bg-primary-soft border-primary-line" },
	advance: { label: "推进", Icon: MoveRight, color: "text-amber-ink", surface: "bg-amber-bg border-amber-line" },
	resolve: { label: "回应", Icon: CircleCheck, color: "text-success", surface: "bg-green-bg border-success/30" },
} satisfies Record<ContractPhase, unknown>;

export function ContractStatus({ model, lane }: { model: AxisModel; lane: ContractLane }) {
	const status = contractStatus(lane, model.beats.length - 1).split(" · ")[0];
	const resolved = status === "已回应";
	const Icon = resolved ? CircleCheck : Clock3;
	return (
		<Tag tone={resolved ? "green" : status === "尚未建立" ? "gray" : "amber"}>
			<Icon aria-hidden="true" />
			{status}
		</Tag>
	);
}

/** 期待页按实际事件连接，短路径横排、长路径纵排，全部节点直接可读。 */
export function ContractTrack({
	model,
	lane,
	projectId,
	open,
}: {
	model: AxisModel;
	lane: ContractLane;
	projectId: string;
	open(page: string): void;
}) {
	const entries = contractJourney(model, lane);
	const container = useRef<HTMLElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = container.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	// 按实际文档窗格宽度判断；分屏和右栏展开也会触发，不依赖窗口宽度。
	const horizontal = entries.length >= 2 && entries.length <= 6 && width >= Math.max(560, entries.length * 180);
	return (
		<section ref={container} className="mt-6" data-contract-track aria-label="读者期待进展">
			<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 className="text-sm font-semibold">期待进展</h2>
				<span className="text-xs text-muted-foreground">{entries.length} 个相关情节</span>
				<Hint content="按故事顺序展示已声明的建立、推进与回应。摘录来自情节设计原文；回应可以是兑现、转化或有意义的否定；已回应仅表示有记录，是否充分由审稿判断。">
					<button type="button" aria-label="期待进展说明" className="navigation-link text-muted-foreground">
						<Info className="size-3.5" aria-hidden="true" />
					</button>
				</Hint>
			</div>
			{entries.length === 0 ? (
				<EmptyNote>尚无建立、推进或回应记录。</EmptyNote>
			) : (
				<>
					{lane.open.length === 0 && <p className="mb-3 text-xs text-red-ink">尚无建立记录，请核对这些事件。</p>}
					<ol
						className="contract-path"
						data-layout={horizontal ? "horizontal" : "vertical"}
						style={
							{
								"--contract-columns": entries.length,
								maxWidth: horizontal ? Math.min(1260, entries.length * 280) : undefined,
							} as CSSProperties
						}
					>
						{entries.map((entry) => (
							<ContractEvent
								key={`${entry.beat.id}:${horizontal}`}
								entry={entry}
								horizontal={horizontal}
								volume={model.volumes.find((volume) => volume.id === entry.beat.volumeId)?.title ?? ""}
								projectId={projectId}
								open={open}
							/>
						))}
					</ol>
				</>
			)}
		</section>
	);
}

function ContractEvent({
	entry,
	horizontal,
	volume,
	projectId,
	open,
}: {
	entry: ReturnType<typeof contractJourney>[number];
	horizontal: boolean;
	volume: string;
	projectId: string;
	open(page: string): void;
}) {
	const [previewOpen, setPreviewOpen] = useState(false);
	const anchor = useRef<HTMLButtonElement>(null);
	const { beat, phases, warnings } = entry;
	const phase = phases.includes("resolve") ? "resolve" : phases.includes("open") ? "open" : "advance";
	const { Icon, color, surface } = PHASES[phase];
	return (
		<li className="contract-event" data-contract-event data-ordinal={beat.ordinal}>
			<HoverCard open={previewOpen} onOpenChange={setPreviewOpen}>
				<div className="contract-event-label flex flex-wrap items-center gap-1.5 text-xs">
					{phases.map((kind) => (
						<span key={kind} data-phase={kind} className={cn("font-medium", PHASES[kind].color)}>
							{PHASES[kind].label}
						</span>
					))}
				</div>
				<div data-contract-rail className="contract-event-rail">
					<HoverCardTrigger
						delay={350}
						closeDelay={150}
						render={<button type="button" />}
						onClick={() => setPreviewOpen(true)}
						aria-label={`预览${beat.title}`}
						className={cn(
							"contract-event-marker navigation-link flex size-6 items-center justify-center rounded-full border",
							color,
							surface,
						)}
					>
						<Icon className="size-3.5" aria-hidden="true" />
					</HoverCardTrigger>
				</div>
				<div className="contract-event-body min-w-0">
					<span data-contract-order className="contract-event-order text-xs tabular-nums text-muted-foreground">
						{beat.ordinal + 1}
					</span>
					<HoverCardTrigger
						delay={350}
						closeDelay={150}
						render={<button ref={anchor} type="button" />}
						className="navigation-link inline-flex max-w-full items-baseline gap-1.5 text-left text-sm font-medium"
						data-page={beat.path}
						onClick={() => open(beat.path)}
					>
						<span className="min-w-0 break-words">{beat.title}</span>
						<ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
					</HoverCardTrigger>
					{beat.text === "none" && <span className="text-xs text-muted-foreground">仅设计</span>}
					{warnings.map((warning) => (
						<p key={warning} className="contract-event-warning flex items-start gap-1 text-xs text-red-ink">
							<TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
							{warning}
						</p>
					))}
				</div>
				<HoverCardContent
					anchor={anchor}
					side={horizontal ? "bottom" : "right"}
					align="start"
					sideOffset={8}
					role="region"
					aria-label={`情节预览：${beat.title}`}
					className="w-[360px] max-w-[calc(100vw-16px)] max-h-(--available-height) overflow-y-auto"
				>
					<p className="text-xs text-muted-foreground">
						{volume} · 第 {beat.ordinal + 1} 个情节
					</p>
					<p className="mt-2 text-sm font-medium">{beat.title}</p>
					<p className="mt-3 text-xs text-muted-foreground">情节原文</p>
					{previewOpen && <ContractExcerpt projectId={projectId} path={beat.path} />}
					<button
						type="button"
						className="navigation-link mt-3 inline-flex items-center gap-1 text-xs"
						onClick={() => open(beat.path)}
					>
						打开情节
						<ArrowRight className="size-3.5" aria-hidden="true" />
					</button>
				</HoverCardContent>
			</HoverCard>
		</li>
	);
}

function ContractExcerpt({ projectId, path }: { projectId: string; path: string }) {
	const source = useQuery({
		queryKey: ["file", projectId, path],
		queryFn: () => invoke("workspace.file.read", { path }),
		retry: false,
	});
	const excerpt = useMemo(() => contractExcerpt(source.data?.content ?? ""), [source.data?.content]);
	return (
		<p
			className="mt-2 max-w-[var(--reading-width)] text-xs leading-relaxed text-muted-foreground"
			data-contract-excerpt
		>
			{source.isError ? (
				<>
					情节摘录读取失败。
					<button type="button" className="navigation-link" onClick={() => void source.refetch()}>
						重试
					</button>
				</>
			) : source.isPending ? (
				"正在读取情节摘录…"
			) : (
				excerpt || "该情节暂无可摘录的段落。"
			)}
		</p>
	);
}
