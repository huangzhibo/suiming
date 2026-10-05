import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ComposerAttachment, type ComposerDraft, emptyComposer } from "./composer-state.js";
import { codePoints, type WorkspaceData } from "./model.js";
import { Hint } from "./ui-bits.js";
import { useComposerSubmit } from "./use-composer-submit.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * 正文选段栏：在阅读态选中正文后浮在底部。写一句要求直接改，或把选段交给 Agent 当引用。
 * 一直挂着、没有选段时不画：写到一半的要求在选段消失、再选一次之后还在。
 */
export function SelectionBar({
	visible,
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
	// 走输入框同一条发送路径（先冻结、可确认、可重试）；输入框里有没发出的内容、有待确认的发送或对话暂停时
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
		const occupied =
			composer.goal.trim() !== "" ||
			composer.attachments.length > 0 ||
			composer.pending !== undefined ||
			conversation?.status === "paused";
		if (occupied) {
			updateComposer(draftKey, (draft) => ({
				...draft,
				goal: draft.goal.trim() ? `${draft.goal.trimEnd()}\n${goal}` : goal,
				attachments: [...draft.attachments, attachment],
			}));
		} else {
			void inlineEdit.submitDraft({
				...emptyComposer(),
				...(composer.model ? { model: composer.model } : {}),
				goal,
				attachments: [attachment],
			});
		}
		showAgent();
		setEditRequest("");
		clearSelection();
	};
	if (!visible || !selectedText) return null;
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-14 z-[5] flex justify-center px-3">
			<div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-lg bg-foreground py-1.5 pr-1.5 pl-3 text-xs text-[#fafafa] shadow-[0_8px_24px_#00000033]">
				<span className="text-faint">
					已选择 {codePoints(selectedText)} 字{selPara >= 0 ? ` · 第 ${selPara + 1} 段` : ""} · {source}
				</span>
				<Input
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
					className="h-6 w-56 border-white/20 bg-white/10 text-xs text-white placeholder:text-white/50"
				/>
				<Button size="xs" disabled={!editRequest.trim() || inlineEdit.busy} onClick={requestEdit}>
					修改
				</Button>
				<Button size="xs" className="bg-ink-3 hover:bg-ink-3/90" onClick={() => referenceSelection()}>
					询问 Agent
				</Button>
				<Hint content={"取消选择"}>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="取消选择"
						className="text-faint hover:bg-white/10 hover:text-white"
						onClick={clearSelection}
					>
						<X className="size-[12px]" />
					</Button>
				</Hint>
			</div>
		</div>
	);
}
