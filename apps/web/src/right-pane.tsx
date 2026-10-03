import { useQuery } from "@tanstack/react-query";
import { ArrowDownWideNarrow } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { propertyLabel } from "./artifact-properties.js";
import { invoke } from "./bridge.js";
import {
	type BacklinkGroup,
	type Book,
	type FileEntry,
	issuePage,
	KIND_LABEL,
	outlinksFor,
	paragraphs,
	type ReviewReport,
	reviewsFor,
	shortId,
} from "./model.js";
import { Hint, PanelToolbar, reviewCurrencyLabel, ToolButton, verdictLabel } from "./ui-bits.js";

const Tools = ({ children }: { children: React.ReactNode }) => (
	<PanelToolbar className="justify-center">{children}</PanelToolbar>
);
const Cap = ({ children }: { children: React.ReactNode }) => (
	<div className="mb-1.5 text-[11px] text-muted-foreground">{children}</div>
);

/** 被引用：引用当前 artifact 的其它 artifact，按 frontmatter 键分组。 */
export function BacklinksPane({
	title,
	groups,
	open,
	ordinal,
}: {
	title: string;
	groups: BacklinkGroup[];
	open(page: string): void;
	ordinal(path: string): number;
}) {
	const [byOrder, setByOrder] = useState(false);
	const visible = groups
		.map((group) => {
			const items = [...group.items];
			if (byOrder) items.sort((a, b) => ordinal(a.path) - ordinal(b.path));
			return { ...group, items };
		})
		.filter((group) => group.items.length);
	const count = visible.reduce((sum, group) => sum + group.items.length, 0);
	return (
		<>
			<Tools>
				<ToolButton
					label={byOrder ? "恢复默认排序" : "按故事顺序排序"}
					on={byOrder}
					onClick={() => setByOrder(!byOrder)}
				>
					<ArrowDownWideNarrow />
				</ToolButton>
			</Tools>
			<div className="min-h-0 flex-1 overflow-auto px-3.5 pt-3.5 pb-5">
				<div className="mb-3 text-xs leading-normal text-muted-foreground">
					引用「{title}」的内容 · {count}
				</div>
				{visible.map((group) => (
					<div className="mb-3.5" key={group.label}>
						<div className="mb-1 flex justify-between text-[11px] text-ink-3">
							<span>{group.label}</span>
							<span className="font-sans text-faint">{group.items.length}</span>
						</div>
						{group.items.map((item) => (
							<button
								type="button"
								key={`${item.path}:${item.meta}`}
								className="bl-card"
								data-page={item.path}
								onClick={() => open(item.path)}
							>
								<span className="flex justify-between gap-2 text-[12.5px]">
									<b className="font-medium">{item.title}</b>
									<small className="text-[11px] whitespace-nowrap text-faint">{item.meta}</small>
								</span>
							</button>
						))}
					</div>
				))}
				{count === 0 && <div className="text-xs text-faint">还没有别的内容引用这里。</div>}
			</div>
		</>
	);
}

/** 依据：版本与正文时效、当前 artifact 的第一段、审稿、正向引用与 Runtime 派生视图。 */
export function EvidencePane({
	book,
	reviews,
	file,
	content,
	open,
}: {
	book: Book;
	reviews: ReviewReport[];
	file: FileEntry | undefined;
	content: string;
	open(page: string): void;
}) {
	const reports = file ? reviewsFor(book, reviews, file.path) : [];
	const task =
		file?.kind === "character"
			? `design:character:${file.localId}`
			: file?.kind === "story-beat" || file?.kind === "story-text"
				? `write:${file.localId}`
				: "";
	const view = useQuery({
		queryKey: ["context", book.data.revisionId, task],
		queryFn: () => invoke("workspace.context", { task }),
		enabled: !!task,
	});
	const quote = paragraphs(content)[0];
	const out = file ? outlinksFor(book, file.path) : [];
	const intents = book.data.files.filter((item) => item.kind === "intent");
	return (
		<>
			{/* 空工具行只为与其它右栏对齐；版本、未提交与本页时效分别在底栏与页面标题下，不在这里再说一遍。 */}
			<Tools>{null}</Tools>
			<div className="min-h-0 flex-1 overflow-auto px-3.5 pt-4 pb-5">
				<Cap>正文时效</Cap>
				<p className="mb-3.5 text-xs leading-[1.7] text-ink-2">{book.currencySummary()}</p>
				{quote && file && (
					<>
						<Cap>{KIND_LABEL[file.kind] ?? file.kind} · 第 1 段</Cap>
						<blockquote className="mb-3.5 rounded-r-md border-l-2 border-primary bg-white px-3 py-2.5 text-[12.5px] leading-[1.75] text-ink-2">
							{quote}
						</blockquote>
					</>
				)}
				{reports.length > 0 && (
					<>
						<Cap>审稿依据</Cap>
						{reports.map((report) => (
							<button
								type="button"
								key={report.id}
								className="bl-card"
								data-page={issuePage(report.id)}
								onClick={() => open(issuePage(report.id))}
							>
								<span className="flex justify-between gap-2 text-[12.5px]">
									<b className="font-medium">
										{verdictLabel(report.verdict)} · {reviewCurrencyLabel(report.current)}
									</b>
									<small className="text-[11px] text-faint">{shortId(report.id)}</small>
								</span>
								<span className="mt-[3px] block text-[11.5px] leading-[1.55] text-sub">{report.summary}</span>
							</button>
						))}
					</>
				)}
				{out.length > 0 && (
					<>
						<Cap>这里引用的内容</Cap>
						<div className="mb-3.5 flex flex-wrap gap-1">
							{out.map((link) => (
								<Hint content={propertyLabel(link.key)} key={`${link.key}:${link.path}`}>
									<Button variant="outline" size="xs" data-page={link.path} onClick={() => open(link.path)}>
										{link.title}
									</Button>
								</Hint>
							))}
						</div>
					</>
				)}
				{task && (
					<>
						<Cap>{file?.kind === "character" ? "人物轨迹" : "这一节的写作依据"}</Cap>
						{view.data ? (
							<>
								{view.data.paths.length > 0 && (
									<div className="mb-2 flex flex-wrap gap-1">
										{view.data.paths.map((path) => (
											<Button
												variant="outline"
												size="xs"
												key={path}
												data-page={path}
												onClick={() => open(path)}
											>
												{path.split("/").at(-1)}
											</Button>
										))}
									</div>
								)}
								<pre className="mb-3.5 max-h-[50vh] overflow-auto rounded-md border border-hair bg-white px-3 py-2.5 font-sans text-xs leading-[1.8] whitespace-pre-wrap [overflow-wrap:anywhere]">
									{view.data.text}
								</pre>
							</>
						) : (
							<p className="mb-3.5 text-[11px] text-muted-foreground">
								{view.error ? view.error.message : "正在整理…"}
							</p>
						)}
					</>
				)}
				<Cap>创作意图</Cap>
				<div className="text-[11px] leading-[1.7] text-muted-foreground">
					{intents.map((item) => (
						<Button
							variant="link"
							size="xs"
							key={item.path}
							className="ml-1.5 h-auto p-0 text-[11px]"
							data-page={item.path}
							onClick={() => open(item.path)}
						>
							{book.title(item)} →
						</Button>
					))}
				</div>
			</div>
		</>
	);
}
