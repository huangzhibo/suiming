import { ArrowUp, FileText, Loader2, Plus, RotateCcw, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { invoke } from "./bridge.js";
import {
	type ComposerAttachment,
	type ComposerDraft,
	composerReferenceBytes,
	composerText,
	MAX_INPUT_BYTES,
	textFileAttachment,
} from "./composer-state.js";
import { ConversationModelPicker } from "./conversation-model-picker.js";
import type { Book } from "./model.js";
import { isSessionActive } from "./run-presentation.js";
import { Hint } from "./ui-bits.js";
import { useComposerSubmit } from "./use-composer-submit.js";

export interface ComposerBinding {
	composer: ComposerDraft;
	draftKey: string;
	updateComposer(key: string, update: (draft: ComposerDraft) => ComposerDraft, persist?: boolean): void;
	onSubmitted(key: string, id: string, sessionId: string): void;
	readReference(path: string, selection?: string): Promise<ComposerAttachment>;
	completeAttachment(result: ComposerAttachment): void;
	currentPath: string;
	currentSelection: string;
	isCurrentProject(): boolean;
}
export function AgentComposer({
	book,
	session,
	expanded,
	refresh,
	openSettings,
	...binding
}: ComposerBinding & {
	book: Book;
	session: { id: string; status: string; model?: import("@suiming/sdk").ModelChoice } | undefined;
	expanded: boolean;
	refresh(): void;
	openSettings(): void;
}) {
	const {
		composer,
		draftKey,
		updateComposer,
		onSubmitted,
		readReference,
		completeAttachment,
		currentPath,
		currentSelection,
		isCurrentProject,
	} = binding;
	const { busy, setBusy, error, setError, submit } = useComposerSubmit({
		composer,
		draftKey,
		session,
		updateComposer,
		onSubmitted,
		refresh,
		isCurrentProject,
	});
	const [picker, setPicker] = useState(false);
	const [query, setQuery] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const attachmentFiles = useRef(new Map<string, File>());
	const replacement = useRef<ComposerAttachment | null>(null);
	const update = (change: (draft: ComposerDraft) => ComposerDraft, persist = false) =>
		updateComposer(draftKey, change, persist);
	const active = isSessionActive(session);
	const paused = session?.status === "paused";
	const stopping = active && !composerText(composer);
	const sendLabel = stopping ? "停止" : "发送";
	async function stop() {
		if (!session || busy) return;
		setBusy(true);
		setError("");
		try {
			await invoke("session.interrupt", { sessionId: session.id });
			refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	async function readAttachment(item: ComposerAttachment, file?: File) {
		const id = item.id;
		const readId = crypto.randomUUID();
		update((draft) => ({
			...draft,
			attachments: [
				...draft.attachments.filter((entry) => entry.id !== id),
				{ ...item, readId, status: "reading", error: "" },
			],
		}));
		if (file) attachmentFiles.current.set(id, file);
		try {
			const result = file
				? { ...item, content: await textFileAttachment(file) }
				: await readReference(item.path ?? "", item.selection);
			completeAttachment({ ...item, ...result, id, readId, status: "ready", error: "" });
		} catch (reason) {
			completeAttachment({
				...item,
				readId,
				status: "failed",
				content: "",
				error: reason instanceof Error ? reason.message : "读取失败，请重新选择。",
			});
		}
	}
	const addFiles = (files: File[]) => {
		for (const file of files)
			void readAttachment(
				{ id: crypto.randomUUID(), label: file.name, kind: "text", status: "reading", content: "" },
				file,
			);
	};
	const addDocument = (path: string, selection = false) => {
		void readAttachment({
			id: crypto.randomUUID(),
			label: book.title(book.byPath.get(path)) || path,
			path,
			kind: selection ? "selection" : "document",
			...(selection ? { selection: currentSelection } : {}),
			status: "reading",
			content: "",
		});
	};
	const attachments = composer.attachments;
	const tooLarge = composerReferenceBytes(composer) > MAX_INPUT_BYTES;
	const ready = !tooLarge && !attachments.some((item) => item.status !== "ready") && !paused;
	const matches = book.data.files.filter((file) =>
		`${book.title(file)} ${file.path} ${file.kind === "story-beat" ? "设计" : file.kind === "story-text" ? "正文" : ""}`
			.normalize("NFKC")
			.toLowerCase()
			.includes(query.trim().normalize("NFKC").toLowerCase()),
	);
	const openPicker = () => {
		setQuery("");
		setPicker(true);
	};
	return (
		<form
			className={`agent-composer mx-auto w-full shrink-0 ${expanded ? "max-w-[720px]" : ""}`}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
				if (event.dataTransfer.files.length) {
					event.preventDefault();
					addFiles([...event.dataTransfer.files]);
				}
			}}
		>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				accept=".txt,.md,.markdown,.json,.yaml,.yml,.csv,.log,.ts,.tsx,.js,.jsx,.css,.html,.xml"
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					if (replacement.current && files[0]) {
						void readAttachment({ ...replacement.current, label: files[0].name }, files[0]);
						addFiles(files.slice(1));
					} else addFiles(files);
					replacement.current = null;
					event.target.value = "";
				}}
			/>
			{composer.pending && (
				<div className="composer-pending mb-2 rounded-lg border p-2 text-xs" role="status">
					<p>{busy ? "正在确认本次发送，可以继续输入。" : "上次发送尚未确认，原内容已保留。"}</p>
					<details>
						<summary className="cursor-pointer text-muted-foreground">查看本次内容</summary>
						<p className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{composer.pending.text}</p>
					</details>
					{composer.pending.error && (
						<p className="mt-1 text-destructive" role="alert">
							{composer.pending.error}
						</p>
					)}
					{!busy && (
						<Button
							type="button"
							variant="outline"
							size="xs"
							className="mt-2"
							onClick={() => void submit(composer.pending)}
						>
							<RotateCcw />
							确认发送结果
						</Button>
					)}
				</div>
			)}
			{attachments.length > 0 && (
				<div className="composer-attachments mb-2 flex max-h-40 flex-col gap-1.5 overflow-auto">
					{attachments.map((item) => (
						<div key={item.id} className="flex min-w-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
							<Popover>
								<PopoverTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										className="min-w-0 flex-1 justify-start"
										aria-label="查看引用内容"
									>
										<FileText />
										<span className="truncate">{item.label}</span>
										{item.status === "reading" && <Loader2 className="animate-spin" />}
										{item.status === "failed" && <span>读取失败</span>}
									</Button>
								</PopoverTrigger>
								<PopoverContent
									side="top"
									align="end"
									className="w-[min(560px,calc(100vw-32px))] [--ring:var(--resize-active)]"
								>
									<h3 className="mb-2 text-sm font-medium">引用内容</h3>
									<div className="reference-preview max-h-[50vh] overflow-auto text-xs [overflow-wrap:anywhere]">
										{item.status === "ready" ? (
											<pre className="m-0 whitespace-pre-wrap break-words font-[inherit]">
												{item.content}
											</pre>
										) : (
											<p>{item.error ?? "尚未完成读取；重载后请重试或重新选择文件。"}</p>
										)}
									</div>
									{item.status !== "ready" && (item.path || attachmentFiles.current.has(item.id)) && (
										<Button
											type="button"
											size="xs"
											variant="outline"
											className="mt-2"
											onClick={() => void readAttachment(item, attachmentFiles.current.get(item.id))}
										>
											重新读取
										</Button>
									)}
									{item.status !== "ready" &&
										item.kind === "text" &&
										!attachmentFiles.current.has(item.id) && (
											<Button
												type="button"
												size="xs"
												variant="outline"
												className="mt-2"
												onClick={() => {
													replacement.current = item;
													input.current?.click();
												}}
											>
												重新选择文件
											</Button>
										)}
								</PopoverContent>
							</Popover>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={`移除引用：${item.label}`}
								onClick={() => {
									attachmentFiles.current.delete(item.id);
									update((draft) => ({
										...draft,
										attachments: draft.attachments.filter((entry) => entry.id !== item.id),
									}));
								}}
							>
								<X />
							</Button>
						</div>
					))}
				</div>
			)}
			{tooLarge && (
				<p role="alert" className="mb-2 text-xs text-destructive">
					引用总量超过 256 KB，请移除部分内容或改为引用选段。
				</p>
			)}
			{paused && (
				<p role="status" className="mb-2 text-xs text-muted-foreground">
					这个对话需要先处理上面的问题才能继续发消息。
				</p>
			)}
			<InputGroup data-variant="composer">
				<InputGroupTextarea
					ref={textarea}
					value={composer.goal}
					aria-label="输入消息"
					rows={2}
					placeholder="输入消息…"
					onChange={(event) => {
						const goal = event.target.value;
						update((draft) => ({ ...draft, goal }));
					}}
					onPaste={(event) => {
						if (event.clipboardData.files.length) {
							event.preventDefault();
							addFiles([...event.clipboardData.files]);
						}
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing || event.keyCode === 229) return;
						const cursor = event.currentTarget.selectionStart;
						if (event.key === "@" && (cursor === 0 || /\s/u.test(event.currentTarget.value[cursor - 1] ?? ""))) {
							event.preventDefault();
							openPicker();
							return;
						}
						if (
							(event.metaKey || event.ctrlKey) &&
							event.key === "Enter" &&
							!event.nativeEvent.isComposing &&
							event.keyCode !== 229
						) {
							event.preventDefault();
							if (!busy && !composer.pending && ready) event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
				<InputGroupAddon align="block-end">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" aria-label="添加内容">
								<Plus />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent side="top" align="start">
							<DropdownMenuGroup>
								<DropdownMenuItem
									disabled={!currentPath}
									onSelect={() => addDocument(currentPath, !!currentSelection)}
								>
									{currentSelection
										? "引用当前选段"
										: currentPath
											? "引用当前文档"
											: "引用当前文档（当前页面不是作品文件）"}
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={openPicker}>
									选择作品文件…
									<span className="ml-auto text-muted-foreground">@</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => {
										replacement.current = null;
										input.current?.click();
									}}
								>
									添加文本文件…
								</DropdownMenuItem>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<ConversationModelPicker
						choice={composer.model}
						current={session?.model}
						active={active}
						disabled={busy || !!composer.pending}
						onChange={(model) => update((draft) => ({ ...draft, model }), true)}
						openSettings={openSettings}
					/>
					<span className="flex-1" />
					{active && !stopping && (
						<Hint side="top" content="停止当前回复">
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="停止"
								disabled={busy}
								onClick={() => void stop()}
							>
								<Square />
							</Button>
						</Hint>
					)}
					<Hint side="top" content={stopping ? "停止当前回复" : "发送消息\n⌘ / Ctrl + Enter 发送，Enter 换行"}>
						<Button
							type={stopping ? "button" : "submit"}
							onClick={stopping ? () => void stop() : undefined}
							size="icon-sm"
							data-composer-submit
							aria-label={sendLabel}
							aria-keyshortcuts="Meta+Enter Control+Enter"
							disabled={busy || (stopping ? false : !!composer.pending || !ready || !composerText(composer))}
						>
							{busy ? <Loader2 className="animate-spin" /> : stopping ? <Square /> : <ArrowUp />}
						</Button>
					</Hint>
				</InputGroupAddon>
			</InputGroup>
			{error && (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			<Dialog open={picker} onOpenChange={setPicker}>
				<DialogContent
					className="[--ring:var(--resize-active)]"
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						textarea.current?.focus();
					}}
				>
					<DialogHeader>
						<DialogTitle>选择作品文件</DialogTitle>
						<DialogDescription>引用当前文件内容；已修改的内容按工作草稿发送。</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="搜索作品引用"
						placeholder="搜索中文标题或相对路径…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<div className="flex max-h-[50vh] flex-col gap-1 overflow-auto">
						{!matches.length && (
							<p className="py-4 text-center text-sm text-muted-foreground">没有找到匹配的作品文件</p>
						)}
						{matches.map((file) => (
							<Button
								type="button"
								key={file.path}
								variant="ghost"
								className="h-auto justify-start py-2 text-left"
								onClick={() => {
									addDocument(file.path);
									setPicker(false);
									textarea.current?.focus();
								}}
							>
								<span className="min-w-0">
									<span className="block truncate">
										{book.title(file)}
										{file.kind === "story-beat" ? " · 设计" : file.kind === "story-text" ? " · 正文" : ""}
									</span>
									<span className="block truncate text-xs text-muted-foreground">{file.path}</span>
								</span>
							</Button>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</form>
	);
}
