import { BookOpen, File } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { documentTarget } from "./document-navigation.js";
import { type Book, filePage, pageKind, pageTarget } from "./model.js";
import type { OpenPage } from "./view-state.js";

export function EmptyPage({
	book,
	files,
	recent,
	open,
}: {
	book: Book;
	files: string[];
	recent: string[];
	open: OpenPage;
}) {
	const [query, setQuery] = useState("");
	const targets = query.trim()
		? [
				...book.data.files
					.filter((file) => file.kind !== "story-text")
					.map((file) => documentTarget(book, file.path).page),
				...files
					.filter((path) => !book.byPath.has(path) || book.byPath.get(path)?.kind === "story-text")
					.map(filePage),
			]
				.filter((page) => `${book.pageTitle(page)} ${page}`.toLowerCase().includes(query.toLowerCase()))
				.slice(0, 60)
		: recent;
	return (
		<div className="mx-auto w-full max-w-[640px] overflow-auto px-8 py-12" data-scroll-key="empty">
			<h1 className="mb-2 text-xl font-semibold">打开一个工作页面</h1>
			<p className="mb-6 text-xs text-muted-foreground">搜索作品或文件，也可以从左栏开始浏览。</p>
			<Input
				aria-label="搜索对象或文件"
				placeholder="搜索标题或相对路径…"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<p className="mt-6 mb-2 text-xs text-muted-foreground">{query ? "匹配的对象与文件" : "最近访问"}</p>
			{targets.map((page) => (
				<button
					type="button"
					key={page}
					data-page={page}
					// tree-row 是 h-7 的单行树行；这里一行标题加一行路径约 36px，压不进 28px 就会互相叠上。
					// h-auto 把高度交还给内容（utilities 层压过 @layer components 的 @apply），其余交互样式照旧复用。
					className="tree-row h-auto gap-3 py-2 text-left"
					onClick={() => open(page)}
				>
					{pageKind(page) === "file" ? (
						<File className="size-4 shrink-0 text-muted-foreground" />
					) : (
						<BookOpen className="size-4 shrink-0 text-muted-foreground" />
					)}
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm">{book.pageTitle(page)}</span>
						<span className="block truncate text-xs text-muted-foreground">
							{pageKind(page) === "file" ? pageTarget(page) : `作品 · ${page}`}
						</span>
					</span>
				</button>
			))}
			{!targets.length && (
				<p className="mt-4 text-xs text-muted-foreground">{query ? "没有匹配项。" : "还没有访问记录。"}</p>
			)}
		</div>
	);
}
