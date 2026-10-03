import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { invoke } from "./bridge.js";
import { Markdown } from "./markdown.js";
import type { Book } from "./model.js";
import { Hint, PanelToolbar, Segmented } from "./ui-bits.js";
import type { ObservationSelection } from "./view-state.js";

export const OBSERVATION_PHASES = { before: "进入前", changes: "本幕变化", after: "结束后" };

export function ObservationPanel({
	book,
	selection,
	change,
	allowPositionChange,
	pendingSubject,
	open,
	reference,
}: {
	book: Book;
	selection: ObservationSelection | null;
	change(value: ObservationSelection): void;
	allowPositionChange: boolean;
	pendingSubject: ObservationSelection["subject"];
	open(path: string): void;
	reference(text: string): void;
}) {
	const { storyBeatId = "", phase = "before" } = selection ?? {};
	const subject = selection ? selection.subject : pendingSubject;
	const task = `design:state:${storyBeatId}:${phase}${subject ? `:${subject.kind}:${subject.id}` : ""}`;
	const query = useQuery({
		queryKey: ["context", book.data.projectId, book.data.revisionId, task],
		queryFn: () => invoke("workspace.context", { task, revisionId: book.data.revisionId }),
		enabled: !!selection,
	});
	const title = `${book.beatTitle(storyBeatId)} · ${OBSERVATION_PHASES[phase]}`;
	return (
		<section className="flex min-h-0 flex-1 flex-col" aria-label="故事状态查询">
			<PanelToolbar>
				<h2 className="text-xs font-medium">故事状态</h2>
			</PanelToolbar>
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<p className="mb-1 text-xs text-muted-foreground">观察位置</p>
						<p className="text-sm font-medium">
							{storyBeatId ? book.beatTitle(storyBeatId) : "尚未选择故事位置"}
						</p>
					</div>
					{(allowPositionChange || !selection) && (
						<Select
							value={storyBeatId}
							onValueChange={(storyBeatId) => change({ storyBeatId, phase, ...(subject ? { subject } : {}) })}
						>
							<SelectTrigger
								className="h-6 w-auto shrink-0 gap-1 border-0 bg-transparent px-1 text-xs shadow-none"
								size="sm"
								aria-label="选择观察位置"
							>
								<span>{selection ? "更换位置" : "选择位置"}</span>
							</SelectTrigger>
							<SelectContent position="popper" align="end" className="max-h-80 w-64">
								{book.data.volumes.map((volume) => (
									<SelectGroup key={volume.id}>
										<SelectLabel>{volume.title}</SelectLabel>
										{book.order
											.filter((id) => book.volumeOf(id)?.id === volume.id)
											.map((id) => (
												<SelectItem key={id} value={id}>
													{book.beatTitle(id)}
												</SelectItem>
											))}
									</SelectGroup>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
				{!selection && (
					<p className="text-xs leading-relaxed text-muted-foreground">
						从大纲或故事轴定位一幕，再点击「故事状态」；也可以在这里选择观察位置。
					</p>
				)}
				{selection && (
					<Segmented
						value={phase}
						options={(Object.entries(OBSERVATION_PHASES) as [ObservationSelection["phase"], string][]).map(
							([id, label]) => ({ id, label }),
						)}
						onChange={(phase) => change({ ...selection, phase })}
						className="self-start"
					/>
				)}

				<div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
					<span>{subject ? `只看 ${subject.id}` : "全部人物、资源与读者期待"}</span>
					{subject && selection && (
						<Button size="xs" variant="ghost" onClick={() => change({ storyBeatId, phase })}>
							查看全部
						</Button>
					)}
				</div>
				{selection && (
					<p className="text-xs text-muted-foreground">
						{book.headLabel} 已提交的设计；没写下的不等于没发生，也不等于人物不知道。
					</p>
				)}
				{query.error && (
					<p role="alert" className="text-sm text-destructive">
						{query.error.message}
					</p>
				)}
				{selection && !query.data && !query.error && <p className="text-xs text-muted-foreground">正在读取状态…</p>}
				{selection && query.data && (
					<>
						<Markdown
							className="design-body text-sm"
							content={query.data.text.slice(Math.max(0, query.data.text.indexOf("### 硬状态")))}
							links={new Map(query.data.paths.map((path) => [path, () => open(path)]))}
						/>
						<details>
							<summary className="cursor-pointer text-xs text-muted-foreground">
								依据文件 · {query.data.paths.length}
							</summary>
							<div className="mt-2 flex flex-col items-start gap-1">
								{query.data.paths.map((path) => (
									<Hint content={path} key={path}>
										<Button
											variant="link"
											size="xs"
											className="max-w-full"
											data-page={path}
											onClick={() => open(path)}
										>
											<span className="truncate">{book.title(book.byPath.get(path)) || path}</span>
										</Button>
									</Hint>
								))}
							</div>
						</details>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								if (!query.data) return;
								reference(
									`故事状态引用：${title}\n观察 Beat：${storyBeatId}\n观察边界：${phase}\n观察主体：${subject ? `${subject.kind}:${subject.id}` : "全书状态"}\nrevision: ${query.data.revisionId}\nContext 查询：${task}\n\n${query.data.text}`,
								);
							}}
						>
							引用此状态给 Agent
						</Button>
					</>
				)}
			</div>
		</section>
	);
}
