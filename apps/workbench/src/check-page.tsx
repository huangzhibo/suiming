import { queryOptions, useQuery } from "@tanstack/react-query";
import { CircleX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invoke } from "./bridge.js";
import {
	blockingTextFailures,
	type CheckDiagnostic,
	candidateBasis,
	diagnosticPosition,
	groupDiagnostics,
	runCheck,
} from "./check-result.js";
import { type Book, filePage, textPathFor } from "./model.js";
import { Hint, Segmented, Tag } from "./ui-bits.js";
import type { PageState } from "./view-state.js";

/**
 * 检查结果按作品缓存在 query 里：检查按钮与这个页面共用一份，页面不在时也保留，
 * 但不进 refresh 的失效列表——检查要读整份候选，不能随每次作品刷新重跑。
 * 指纹取检查前现读的作品状态，而不是界面手上那份：外部刚改完、刷新还没到时点检查，
 * 结果是新的，指纹却是旧的，会被误标成过期。
 */
export function checkQuery(projectId: string) {
	return queryOptions({
		queryKey: ["project-check", projectId],
		queryFn: async () => runCheck(await invoke("workspace.show", {}), () => invoke("project.check", {})),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
}

function DiagnosticRow({ item }: { item: CheckDiagnostic }) {
	const position = diagnosticPosition(item);
	return (
		<li className="flex gap-2 py-1 text-[12.5px] leading-[1.7]" data-severity={item.severity}>
			{item.severity === "error" ? (
				<CircleX aria-label="错误" className="mt-[4px] size-3.5 shrink-0 text-red-ink" />
			) : (
				<TriangleAlert aria-label="警告" className="mt-[4px] size-3.5 shrink-0 text-amber" />
			)}
			<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
				{position && <code className="mr-1.5 font-mono text-[11.5px] text-muted-foreground">{position}</code>}
				{item.detail}
			</span>
		</li>
	);
}

function DiagnosticList({
	book,
	diagnostics,
	open,
}: {
	book: Book;
	diagnostics: readonly CheckDiagnostic[];
	open(page: string): void;
}) {
	return groupDiagnostics(diagnostics).map((group) => {
		const file = group.path === undefined ? undefined : book.byPath.get(group.path);
		const target = group.path === undefined ? undefined : file ? group.path : filePage(group.path);
		const counts = [group.errors ? `${group.errors} 处错误` : "", group.warnings ? `${group.warnings} 条警告` : ""]
			.filter(Boolean)
			.join(" · ");
		return (
			<section
				key={group.path ?? ""}
				aria-label={group.path ?? "未指明文件"}
				className="border-t border-hair-2 py-2.5"
				data-check-path={group.path ?? ""}
			>
				<div className="mb-1 flex items-baseline gap-2">
					{target ? (
						<Button
							variant="link"
							size="xs"
							className="h-auto min-w-0 shrink p-0 text-[13px] font-semibold text-foreground"
							data-page={target}
							onClick={() => open(target)}
						>
							<span className="truncate">{(file && book.title(file)) || group.path}</span>
						</Button>
					) : (
						<span className="text-[13px] font-semibold">未指明文件</span>
					)}
					{file && book.title(file) !== group.path && (
						<span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">{group.path}</span>
					)}
					<span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{counts}</span>
				</div>
				<ul>
					{group.items.map((item) => (
						<DiagnosticRow key={item.message} item={item} />
					))}
				</ul>
			</section>
		);
	});
}

export function CheckPage({
	book,
	open,
	disabledReason,
	onRecheck,
	filter,
	onFilter,
}: {
	book: Book;
	open(page: string): void;
	/** 有未保存的修改或正在处理时不能检查：检查读的是作品目录里的文件，不是编辑器里的草稿。 */
	disabledReason?: string | undefined;
	/** 页面自己重新检查时，上一次检查留下的一句话提示就过时了，由外面收掉。 */
	onRecheck(): void;
	filter: PageState["checkFilter"];
	onFilter(value: PageState["checkFilter"]): void;
}) {
	const query = useQuery({ ...checkQuery(book.data.projectId), enabled: disabledReason === undefined });
	const outcome = query.data;
	const stale = outcome !== undefined && outcome.basis !== candidateBasis(book.data);
	const button = (
		<Button
			variant="outline"
			size="xs"
			disabled={disabledReason !== undefined || query.isFetching}
			onClick={() => {
				onRecheck();
				void query.refetch();
			}}
		>
			{query.isFetching ? "正在检查…" : "重新检查"}
		</Button>
	);
	const recheck =
		disabledReason === undefined ? (
			button
		) : (
			<Hint content={disabledReason}>
				<span>{button}</span>
			</Hint>
		);
	if (!outcome)
		return (
			<div className="flex flex-1 flex-col items-center gap-3 px-8 py-20 text-center text-muted-foreground">
				<h2 className="text-base font-medium">
					{query.isFetching
						? "正在检查作品…"
						: query.error
							? `检查失败：${query.error.message}`
							: (disabledReason ?? "还没有检查过这部作品")}
				</h2>
				{!query.isFetching && recheck}
			</div>
		);
	const result = outcome.result;
	const blocking = result ? blockingTextFailures(result) : [];
	const diagnostics: CheckDiagnostic[] = [
		...(outcome.failure?.diagnostics ?? result?.diagnostics ?? []),
		...blocking.map((failure) => ({
			severity: "error" as const,
			path: textPathFor(failure.storyBeatId),
			detail: failure.message,
			message: `${failure.storyBeatId}:${failure.code}:${failure.message}`,
		})),
	];
	const search = filter.query.trim().toLocaleLowerCase();
	const visible = diagnostics.filter(
		(item) =>
			(filter.severity === "all" || item.severity === filter.severity) &&
			`${item.path ?? ""} ${item.pointer ?? ""} ${item.detail} ${book.title(book.byPath.get(item.path ?? ""))}`
				.toLocaleLowerCase()
				.includes(search),
	);
	const errors = diagnostics.filter((item) => item.severity === "error").length;
	const warnings = diagnostics.length - errors;
	const missing = result ? result.storyTextFailures.filter((failure) => failure.code === "missing_text") : [];
	const verdict = outcome.failure
		? { tone: "red" as const, label: "无法检查" }
		: result?.passed
			? { tone: "green" as const, label: "通过" }
			: { tone: "amber" as const, label: "未通过" };
	const time = new Date(outcome.at).toLocaleTimeString("zh-CN", { hour12: false });
	const basis = `${book.revisionLabel(outcome.revisionId)}${outcome.dirtyFiles ? ` + ${outcome.dirtyFiles} 个未提交文件` : ""}`;
	const passLabel = (passed: boolean) => (
		<span className={passed ? "text-success" : "text-amber"}>{passed ? "通过" : "未通过"}</span>
	);
	return (
		<div className="min-h-0 flex-1 overflow-auto px-5 py-3" data-scroll-key="check">
			<div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
				<Tag tone={verdict.tone}>{verdict.label}</Tag>
				<span className="text-[11.5px] text-muted-foreground">
					检查于 {time} · 基于 {basis}
				</span>
				<span className="flex-1" />
				{recheck}
			</div>
			{query.error && !query.isFetching ? (
				<p role="status" className="mb-2 rounded-md bg-amber-bg px-3 py-1.5 text-xs text-amber">
					重新检查失败，下面仍是上一次的结果：{query.error.message}
				</p>
			) : (
				stale && (
					<p role="status" className="mb-2 rounded-md bg-amber-bg px-3 py-1.5 text-xs text-amber">
						作品在这次检查之后有改动，结果可能已过期。
					</p>
				)
			)}
			<h1 className="mb-2 text-base font-semibold">
				检查结果
				{diagnostics.length
					? ` · ${[errors ? `${errors} 处错误` : "", warnings ? `${warnings} 条警告` : ""].filter(Boolean).join("、")}`
					: ""}
			</h1>
			{outcome.failure ? (
				<p className="mb-3 text-[12.5px] leading-[1.7] text-ink-3">
					作品文件有结构问题（引用、路径或格式），设计、硬状态与正文的检查都没有跑。先修下面的问题，再重新检查。
				</p>
			) : (
				result && (
					<div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-[1.7]">
						<span>设计 {passLabel(result.designPassed)}</span>
						<span>硬状态 {passLabel(result.statePassed)}</span>
						<span>正文 {passLabel(blocking.length === 0)}</span>
						{result.sourceCount > 0 && (
							<span className="text-muted-foreground">原作 {result.sourceCount} 份</span>
						)}
						{missing.length > 0 && (
							<span className="text-muted-foreground">还有 {missing.length} 个情节没有正文，不阻塞提交</span>
						)}
					</div>
				)
			)}
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<Segmented
					value={filter.severity}
					options={[
						{ id: "all", label: `全部 ${diagnostics.length}` },
						{ id: "error", label: `错误 ${errors}` },
						{ id: "warning", label: `警告 ${warnings}` },
					]}
					onChange={(severity) => onFilter({ ...filter, severity })}
				/>
				<Input
					aria-label="筛选诊断"
					placeholder="搜索文件、字段或内容"
					className="h-8 min-w-40 flex-1"
					value={filter.query}
					onChange={(event) => onFilter({ ...filter, query: event.target.value })}
				/>
				<span className="text-xs text-muted-foreground" role="status">
					显示 {visible.length} / {diagnostics.length} 条
				</span>
				{(filter.query || filter.severity !== "all") && (
					<Button size="xs" variant="ghost" onClick={() => onFilter({ severity: "all", query: "" })}>
						清除筛选
					</Button>
				)}
			</div>
			<DiagnosticList book={book} diagnostics={visible} open={open} />
			{visible.length === 0 && (
				<p className="border-t border-hair-2 py-3 text-xs text-muted-foreground">
					{diagnostics.length === 0 ? "没有诊断。" : "没有符合筛选条件的诊断。"}
				</p>
			)}
		</div>
	);
}
