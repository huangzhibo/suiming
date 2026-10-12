import { CircleCheck, Flag, MoveRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AxisModel, ContractLane } from "./layout.js";
import { contractStatus } from "./layout.js";

/** 期待页回答「怎样建立、怎样推进、在哪里回应」，不用全书比例压缩相邻锚点。 */
export function ContractTrack({
	model,
	lane,
	open,
}: {
	model: AxisModel;
	lane: ContractLane;
	open(page: string): void;
}) {
	const status = contractStatus(lane, model.beats.length - 1).split(" · ")[0];
	const tone =
		lane.late.length || status === "已到期限，尚未回应"
			? "text-red-ink"
			: status === "已回应"
				? "text-success"
				: "text-amber-ink";
	const deadline = model.beats[lane.deadlineIndex];
	const phases = [
		{
			kind: "open",
			label: "建立",
			icon: Flag,
			ordinals: lane.open,
			color: "text-primary",
			bg: "bg-accent",
			empty: "尚无建立记录",
		},
		{
			kind: "advance",
			label: "推进",
			icon: MoveRight,
			ordinals: lane.advance,
			color: "text-amber-ink",
			bg: "bg-amber-bg",
			empty: "没有单独的推进记录",
		},
		{
			kind: "resolve",
			label: "回应",
			icon: CircleCheck,
			ordinals: lane.resolve,
			color: "text-success",
			bg: "bg-green-bg",
			empty: "尚未回应",
		},
	];
	return (
		<section className="@container mt-6" data-contract-track aria-label="读者期待进展">
			<div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 className="text-sm font-semibold">期待进展</h2>
				<span className={cn("text-xs font-medium", tone)}>{status}</span>
				<span className="text-xs text-muted-foreground">
					回应期限：
					{deadline ? (
						<button
							type="button"
							className="navigation-link"
							data-page={deadline.path}
							onClick={() => open(deadline.path)}
						>
							{deadline.title}
						</button>
					) : lane.deadline === "book_end" ? (
						"全书结束前"
					) : (
						(lane.deadline ?? "未设置")
					)}
				</span>
			</div>
			<div className="grid items-start gap-3 @min-[600px]:grid-cols-3">
				{phases.map((phase) => (
					<div
						key={phase.kind}
						data-phase={phase.kind}
						className="min-w-0 overflow-hidden rounded-lg border border-hair"
					>
						<h3 className={cn("flex items-center gap-2 px-3 py-2 text-xs font-semibold", phase.color, phase.bg)}>
							<phase.icon className="size-3.5" aria-hidden="true" />
							{phase.label}
							<span className="ml-auto tabular-nums">{phase.ordinals.length}</span>
						</h3>
						<ul className="space-y-2 p-3">
							{phase.ordinals.length === 0 && <li className="text-xs text-muted-foreground">{phase.empty}</li>}
							{phase.ordinals.map((ordinal) => {
								const beat = model.beats[ordinal];
								if (!beat) return null;
								return (
									<li key={ordinal}>
										<button
											type="button"
											className="navigation-link flex w-full items-start gap-2 text-left text-sm leading-relaxed"
											data-page={beat.path}
											onClick={() => open(beat.path)}
										>
											<span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
												{ordinal + 1}
											</span>
											<span className="min-w-0 break-words">{beat.title}</span>
										</button>
										{beat.text === "none" && <span className="text-xs text-muted-foreground">仅设计</span>}
										{phase.kind === "advance" && lane.late.includes(ordinal) && (
											<p className="mt-1 text-xs text-red-ink">回应后仍有推进，请核对</p>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}
