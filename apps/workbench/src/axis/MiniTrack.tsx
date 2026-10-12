import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Clock3, Flag, Info, MoveRight, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { invoke } from "../bridge.js";
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
	const overdue = status === "已到期限，尚未回应";
	const Icon = resolved ? CircleCheck : overdue ? TriangleAlert : Clock3;
	return (
		<Tag tone={resolved ? "green" : overdue ? "red" : status === "尚未建立" ? "gray" : "amber"}>
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
	const deadline = model.beats[lane.deadlineIndex];
	const mergedDeadline = entries.some((entry) => entry.deadline);
	const bookEnd = lane.deadline === undefined || lane.deadline === "book_end";
	return (
		<section className="@container mt-6" data-contract-track aria-label="读者期待进展">
			<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 className="text-sm font-semibold">期待进展</h2>
				<span className="text-xs text-muted-foreground">{entries.length} 个相关情节 · 情节原文摘录</span>
				{lane.advance.length === 0 && lane.resolve.length > 0 && (
					<span className="text-xs text-muted-foreground">无单独推进记录</span>
				)}
				<Hint content="按故事顺序展示已声明的建立、推进与回应。摘录来自情节设计原文；已回应表示有回应记录，不代表语义兑现已经通过审稿。">
					<button type="button" aria-label="期待进展说明" className="navigation-link text-muted-foreground">
						<Info className="size-3.5" aria-hidden="true" />
					</button>
				</Hint>
				{!mergedDeadline && (
					<span
						className="flex flex-wrap items-baseline gap-1 text-xs text-muted-foreground"
						data-contract-deadline
					>
						回应期限：
						{bookEnd ? (
							"全书结束前"
						) : deadline ? (
							<button
								type="button"
								className="navigation-link text-left"
								data-page={deadline.path}
								onClick={() => open(deadline.path)}
							>
								{deadline.title}
							</button>
						) : (
							`情节未收录（${lane.deadline}）`
						)}
					</span>
				)}
			</div>
			{entries.length === 0 ? (
				<EmptyNote>尚无建立、推进或回应记录。</EmptyNote>
			) : (
				<>
					{lane.open.length === 0 && <p className="mb-3 text-xs text-red-ink">尚无建立记录，请核对这些事件。</p>}
					<ol className="contract-path" data-count={entries.length}>
						{entries.map((entry) => {
							const phase = entry.phases.includes("resolve")
								? "resolve"
								: entry.phases.includes("open")
									? "open"
									: "advance";
							const { Icon, color, surface } = PHASES[phase];
							return (
								<li
									key={entry.beat.id}
									className="contract-event"
									data-contract-event
									data-ordinal={entry.beat.ordinal}
								>
									<div className="contract-event-label flex flex-wrap items-center gap-2 text-xs">
										{entry.phases.map((kind) => (
											<span key={kind} data-phase={kind} className={cn("font-medium", PHASES[kind].color)}>
												{PHASES[kind].label}
											</span>
										))}
										<span data-contract-order className="contract-event-order text-muted-foreground">
											第 {entry.beat.ordinal + 1} 个情节{entry.beat.text === "none" && " · 仅设计"}
										</span>
										{entry.deadline && (
											<Badge variant="outline" data-contract-deadline>
												{bookEnd ? "全书结束 · 回应期限" : "回应期限"}
											</Badge>
										)}
									</div>
									<div data-contract-rail className="contract-event-rail">
										<span
											className={cn(
												"contract-event-marker flex size-6 items-center justify-center rounded-full border",
												color,
												surface,
											)}
											aria-hidden="true"
										>
											<Icon className="size-3.5" />
										</span>
									</div>
									<div className="contract-event-body min-w-0">
										<p
											data-contract-order
											className="contract-event-horizontal-order mb-1 text-xs text-muted-foreground"
										>
											第 {entry.beat.ordinal + 1} 个情节{entry.beat.text === "none" && " · 仅设计"}
										</p>
										<button
											type="button"
											className="navigation-link inline-flex max-w-full items-baseline gap-2 text-left text-sm font-medium"
											data-page={entry.beat.path}
											onClick={() => open(entry.beat.path)}
										>
											<span className="min-w-0 break-words">{entry.beat.title}</span>
											<ArrowRight
												className="size-3.5 shrink-0 self-center text-muted-foreground"
												aria-hidden="true"
											/>
										</button>
										<ContractExcerpt projectId={projectId} path={entry.beat.path} />
										{entry.warnings.map((warning) => (
											<p key={warning} className="mt-2 flex items-start gap-1 text-xs text-red-ink">
												<TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
												{warning}
											</p>
										))}
									</div>
								</li>
							);
						})}
					</ol>
				</>
			)}
		</section>
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
