import { Hint } from "../ui-bits.js";
import type { AxisModel, CharacterLane, ContractLane } from "./layout.js";
import { contractStatus } from "./layout.js";

/**
 * 单行轨迹：故事轴上某一条泳道的横向全书版本，嵌在承诺页 / 人物页标题下。
 * 横轴仍是 index.yaml 的顺序，卷名做刻度；点击锚点打开对应 Beat。
 */
const W = 900;
const H = 64;
const PAD = 16;

function useScale(model: AxisModel) {
	const n = Math.max(model.beats.length - 1, 1);
	return (ordinal: number) => PAD + (ordinal * (W - PAD * 2)) / n;
}

function Volumes({ model, x }: { model: AxisModel; x: (ordinal: number) => number }) {
	return (
		<>
			{model.volumes.map((volume) => (
				<g key={volume.id}>
					<line x1={x(volume.start)} y1={8} x2={x(volume.start)} y2={H - 14} stroke="var(--hair)" />
					<text x={x(volume.start) + 3} y={H - 3} className="fill-faint text-[9.5px]">
						{volume.title}
					</text>
				</g>
			))}
		</>
	);
}

const press = (handler: () => void) => ({
	role: "button" as const,
	tabIndex: 0,
	className: "cursor-pointer outline-none focus-visible:stroke-ring",
	onClick: handler,
	onKeyDown: (event: { key: string }) => {
		if (event.key === "Enter") handler();
	},
});

export function ContractTrack({
	model,
	lane,
	open,
}: {
	model: AxisModel;
	lane: ContractLane;
	open(page: string): void;
}) {
	const x = useScale(model);
	const title = (ordinal: number) => model.beats[ordinal]?.title ?? "";
	const named = (ordinal: number) => `${title(ordinal)}（${model.beats[ordinal]?.id ?? ""}）`;
	const openBeat = (ordinal: number) => open(model.beats[ordinal]?.path ?? "");
	const first = lane.open[0] ?? lane.advance[0] ?? 0;
	const last = lane.resolve[0] ?? (lane.deadlineIndex >= 0 ? lane.deadlineIndex : model.beats.length - 1);
	const y = 30;
	const anchors = [
		...lane.open.map((ordinal) => ({ ordinal, kind: "open" as const })),
		...lane.advance.map((ordinal) => ({ ordinal, kind: "advance" as const })),
		...lane.resolve.map((ordinal) => ({ ordinal, kind: "resolve" as const })),
	].sort((a, b) => a.ordinal - b.ordinal);
	return (
		<div className="mb-4">
			<div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs">
				<span className={lane.late.length > 0 ? "font-semibold text-red-ink" : "font-semibold text-amber-ink"}>
					{contractStatus(lane, model.beats.length - 1, named)}
				</span>
				<span className="text-muted-foreground">
					建立于{lane.open[0] === undefined ? "—" : title(lane.open[0])} · 推进 {lane.advance.length} 次 ·
					回应期限：
					{lane.deadline === "book_end"
						? "全书结束前"
						: lane.deadlineIndex >= 0
							? title(lane.deadlineIndex)
							: (lane.deadline ?? "未设置")}
					{lane.late.length > 0 ? ` · 回应之后仍有 ${lane.late.length} 次推进记录` : ""}
				</span>
			</div>
			<svg
				width="100%"
				viewBox={`0 0 ${W} ${H}`}
				role="img"
				aria-label="读者期待进展"
				className="block max-w-[900px]"
			>
				<title>读者期待进展</title>
				<Volumes model={model} x={x} />
				<line
					x1={x(first)}
					y1={y}
					x2={x(last)}
					y2={y}
					stroke="var(--amber)"
					strokeWidth={2.5}
					strokeDasharray={lane.resolve.length ? undefined : "5 4"}
				/>
				{lane.deadlineIndex >= 0 && (
					<g>
						<line
							x1={x(lane.deadlineIndex)}
							y1={y - 12}
							x2={x(lane.deadlineIndex)}
							y2={y + 12}
							stroke="var(--amber)"
							strokeWidth={1.5}
						/>
						<text x={x(lane.deadlineIndex) + 4} y={y - 14} className="fill-amber text-[10px]">
							deadline {lane.deadline?.replace("beat-", "") ?? ""}
						</text>
					</g>
				)}
				{anchors.map(({ ordinal, kind }) =>
					kind === "advance" ? (
						<Hint
							content={`推进期待 · ${title(ordinal)}${model.beats[ordinal]?.text === "none" ? "（仅设计）" : ""}${lane.late.includes(ordinal) ? "\n此前已有回应，之后仍有推进记录，请核对" : ""}`}
							key={`${kind}:${ordinal}`}
						>
							<circle
								aria-label={`推进期待 · ${title(ordinal)}${model.beats[ordinal]?.text === "none" ? "（仅设计）" : ""}${lane.late.includes(ordinal) ? "\n此前已有回应，之后仍有推进记录，请核对" : ""}`}
								cx={x(ordinal)}
								cy={y}
								r={4}
								fill={lane.late.includes(ordinal) ? "var(--destructive)" : "var(--amber)"}
								data-page={model.beats[ordinal]?.path}
								{...press(() => openBeat(ordinal))}
							></circle>
						</Hint>
					) : (
						<Hint
							content={`${kind === "open" ? "建立期待" : "回应期待"} · ${title(ordinal)}${model.beats[ordinal]?.text === "none" ? "（仅设计）" : ""}`}
							key={`${kind}:${ordinal}`}
						>
							<rect
								aria-label={`${kind === "open" ? "建立期待" : "回应期待"} · ${title(ordinal)}${model.beats[ordinal]?.text === "none" ? "（仅设计）" : ""}`}
								x={x(ordinal) - 6}
								y={y - 6}
								width={12}
								height={12}
								rx={2}
								fill="var(--amber)"
								data-page={model.beats[ordinal]?.path}
								{...press(() => openBeat(ordinal))}
							></rect>
						</Hint>
					),
				)}
			</svg>
		</div>
	);
}

export function CharacterTrack({
	model,
	lane,
	open,
}: {
	model: AxisModel;
	lane: CharacterLane;
	open(page: string): void;
}) {
	const x = useScale(model);
	const title = (ordinal: number) => model.beats[ordinal]?.title ?? "";
	const openBeat = (ordinal: number) => open(model.beats[ordinal]?.path ?? "");
	const y = 30;
	const known = lane.events.filter((event) => event.kind === "secret");
	const volumeOf = (ordinal: number) =>
		model.volumes.find((volume) => ordinal >= volume.start && ordinal <= volume.end)?.title ?? "";
	const first = lane.present[0];
	return (
		<div className="mb-4">
			<div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
				<span className="font-semibold text-ink-3">被 {lane.present.length} 个情节引用</span>
				{first !== undefined && (
					<span>
						最早用到 {volumeOf(first)} · {title(first)}
					</span>
				)}
				{lane.deadAt >= 0 && (
					<span>
						✕ 死于 {volumeOf(lane.deadAt)} · {title(lane.deadAt)}
					</span>
				)}
				{/* 图例讲语义，不搬字段名（可视化设计 3.4）：● 是 refs.character，✕ ◆ ⌖ 是 changes。 */}
				<span>● 是这一节的设计用到了此人，不等于出场或视角；✕ ◆ ⌖ 是设计里记下的状态变化，没记下不等于没发生</span>
			</div>
			<svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="人物轨迹" className="block max-w-[900px]">
				<title>人物轨迹</title>
				<Volumes model={model} x={x} />
				{lane.present.map((ordinal) => (
					<Hint
						content={`${volumeOf(ordinal)} · ${title(ordinal)}（${model.beats[ordinal]?.id ?? ""}）${lane.deadAt >= 0 && ordinal > lane.deadAt ? "\n此时已死亡，仍被引用（回忆或遗产）" : ""}`}
						key={`p:${ordinal}`}
					>
						<circle
							aria-label={`${volumeOf(ordinal)} · ${title(ordinal)}（${model.beats[ordinal]?.id ?? ""}）${lane.deadAt >= 0 && ordinal > lane.deadAt ? "\n此时已死亡，仍被引用（回忆或遗产）" : ""}`}
							cx={x(ordinal)}
							cy={y}
							r={4}
							fill={lane.deadAt >= 0 && ordinal > lane.deadAt ? "#fff" : "var(--ink-2)"}
							stroke="var(--ink-2)"
							strokeWidth={1.4}
							data-page={model.beats[ordinal]?.path}
							{...press(() => openBeat(ordinal))}
						></circle>
					</Hint>
				))}
				{lane.events.map((event) => (
					<Hint content={`${title(event.ordinal)}\n${event.note}`} key={`e:${event.kind}:${event.ordinal}`}>
						<text
							aria-label={`${title(event.ordinal)}\n${event.note}`}
							x={x(event.ordinal)}
							y={y - 9}
							textAnchor="middle"
							fontSize={11}
							fill={
								event.kind === "dead"
									? "var(--destructive)"
									: event.kind === "secret"
										? "var(--purple)"
										: "var(--muted-foreground)"
							}
							data-page={model.beats[event.ordinal]?.path}
							{...press(() => openBeat(event.ordinal))}
						>
							{event.kind === "dead" ? "✕" : event.kind === "secret" ? "◆" : "⌖"}
						</text>
					</Hint>
				))}
			</svg>
			{known.length > 0 && (
				<ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
					{known.map((event) => (
						<li key={`${event.ordinal}:${event.note}`}>
							<button
								type="button"
								className="navigation-link -ml-1.5 text-left"
								onClick={() => openBeat(event.ordinal)}
							>
								◆ {event.note.replace("秘密揭示：", "")} · {title(event.ordinal)}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
