import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import {
	type ComposerAttachment,
	type ComposerDraft,
	composerReferenceBytes,
	emptyComposer,
	MAX_INPUT_BYTES,
} from "./composer-state.js";
import { codePoints, type WorkspaceData } from "./model.js";
import { Hint } from "./ui-bits.js";
import { useComposerSubmit } from "./use-composer-submit.js";
import { useWorkspace } from "./workspace-context.js";

export interface ReadingEditAnchor {
	range: Range;
	scope: HTMLElement;
	boundary: HTMLElement;
	focusInput: boolean;
}

/** 阅读态和编辑态共用选段要求及对话发送。阅读态在选区旁展示输入框。 */
export function SelectionBar({
	visible,
	reading,
	dismissReading,
	selectedText,
	selPara,
	source,
	path,
	revisionId,
	contentSHA,
	setSelectedText,
	setSelPara,
	composer,
	draftKey,
	conversation,
	addReference,
	showAgent,
	refresh,
}: {
	visible: boolean;
	reading?: ReadingEditAnchor | undefined;
	dismissReading: () => void;
	selectedText: string;
	/** 选段所在段落的段号，从 0 起；-1 是跨段或找不到。 */
	selPara: number;
	/** 「标题 · 版本」，告诉作者选的是哪份内容。 */
	source: string;
	path: string;
	revisionId: string;
	contentSHA: string | null;
	setSelectedText: (text: string) => void;
	setSelPara: (index: number) => void;
	composer: ComposerDraft;
	draftKey: string;
	conversation: WorkspaceData["sessions"][number] | undefined;
	addReference: (text: string) => void;
	showAgent: (prefillText?: string) => void;
	refresh: () => void;
}) {
	const { composerActions } = useWorkspace();
	const { updateComposer, onSubmitted, isCurrentProject } = composerActions;
	const quote = (label: string) =>
		`作品引用：${path}\nrevision: ${revisionId}\ncontentSHA: ${contentSHA ?? ""}\n${label}：\n${selectedText}`;
	const clearSelection = () => {
		setEditRequest("");
		setSelectedText("");
		setSelPara(-1);
		window.getSelection()?.removeAllRanges();
	};
	const referenceSelection = (prefillText?: string) => {
		addReference(quote(selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段"));
		showAgent(prefillText);
		clearSelection();
	};
	// 选段就地修改：在选段栏里写一句要求，回车直接发给当前对话，不必挪到输入框再组织一遍。
	// 走输入框同一条发送路径（先冻结、可确认、可重试）；输入框里有没发出的内容或有待确认的发送时
	// 不直接发——会顶掉作者的草稿或被拒收——改为把选段和这句要求接进输入框，由作者一起发。
	const inlineEdit = useComposerSubmit({
		composer,
		draftKey,
		session: conversation,
		updateComposer,
		onSubmitted,
		refresh,
		isCurrentProject,
	});
	const [editRequest, setEditRequest] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const anchor = useMemo(
		() =>
			reading && {
				contextElement: reading.scope,
				getBoundingClientRect: () => reading.range.getBoundingClientRect(),
			},
		[reading],
	);
	const requestEdit = () => {
		const request = editRequest.trim();
		if (!request || inlineEdit.busy) return;
		const goal = `请修改这一段：${request}`;
		const attachment: ComposerAttachment = {
			id: crypto.randomUUID(),
			label: selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段",
			kind: "selection",
			status: "ready",
			content: quote(selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段"),
		};
		const draft = {
			...emptyComposer(),
			...(composer.model ? { model: composer.model } : {}),
			goal,
			attachments: [attachment],
		};
		const occupied = composer.goal.trim() !== "" || composer.attachments.length > 0 || composer.pending !== undefined;
		// 整块引用也遵循对话的容量限制。保留到对话草稿，让作者看到原有的超限提示。
		if (occupied || composerReferenceBytes(draft) > MAX_INPUT_BYTES) {
			updateComposer(draftKey, (draft) => ({
				...draft,
				goal: draft.goal.trim() ? `${draft.goal.trimEnd()}\n${goal}` : goal,
				attachments: [...draft.attachments, attachment],
			}));
		} else {
			void inlineEdit.submitDraft(draft);
		}
		showAgent();
		clearSelection();
	};
	if (!visible || !selectedText) return null;
	const controls = (
		<>
			<span className="truncate text-xs text-muted-foreground" title={source}>
				已选择 {codePoints(selectedText)} 字{selPara >= 0 ? ` · 第 ${selPara + 1} 段` : ""} · {source}
			</span>
			<Input
				ref={inputRef}
				aria-label="说明要怎么改"
				placeholder="说明要怎么改，回车发送"
				value={editRequest}
				onChange={(event) => setEditRequest(event.target.value)}
				onKeyDown={(event) => {
					// 中文输入法确认候选字的回车不算发送
					if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
					event.preventDefault();
					requestEdit();
				}}
				className="h-8 min-w-0 flex-1"
			/>
			<div className="flex shrink-0 items-center gap-1">
				<Button size="xs" disabled={!editRequest.trim() || inlineEdit.busy} onClick={requestEdit}>
					修改
				</Button>
				<Button size="xs" variant="secondary" onClick={() => referenceSelection()}>
					询问 Agent
				</Button>
				<Hint content={"取消选择"}>
					<Button type="button" variant="ghost" size="icon-xs" aria-label="取消选择" onClick={clearSelection}>
						<X className="size-[12px]" />
					</Button>
				</Hint>
			</div>
		</>
	);
	if (reading && anchor)
		return (
			<Popover
				open
				onOpenChange={(open, details) => {
					if (open) return;
					if (details.reason === "escape-key") clearSelection();
					else dismissReading();
				}}
			>
				<PopoverContent
					data-reading-edit
					anchor={anchor}
					collisionBoundary={reading.boundary}
					collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
					side="top"
					align="start"
					sideOffset={6}
					initialFocus={reading.focusInput ? inputRef : false}
					finalFocus={false}
					className="w-[min(26rem,var(--available-width))] gap-1.5 p-2"
				>
					<PopoverTitle className="sr-only">请 Agent 修改</PopoverTitle>
					<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 [&>span]:col-span-2">
						{controls}
					</div>
				</PopoverContent>
			</Popover>
		);
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-14 z-[5] flex justify-center px-3">
			<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md [&>input]:w-56 [&>input]:flex-none">
				{controls}
			</div>
		</div>
	);
}
