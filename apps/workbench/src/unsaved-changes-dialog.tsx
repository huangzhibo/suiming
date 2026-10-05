import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** 关标签或取消编辑时，那些文件还有未保存的草稿：保存并继续、放弃修改，或取消。 */
export function UnsavedChangesDialog({
	paths,
	busy,
	error,
	onCancel,
	onDiscard,
	onSave,
}: {
	/** 有草稿的文件；不给就是没打开。 */
	paths: string[] | undefined;
	busy: boolean;
	error: string;
	onCancel: () => void;
	onDiscard: () => void;
	onSave: () => void;
}) {
	return (
		<Dialog
			open={paths !== undefined}
			onOpenChange={(on) => {
				if (!on) onCancel();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>保留未保存的修改？</DialogTitle>
					<DialogDescription>这些文件还有未保存内容。保存会写入项目目录，放弃会移除共享草稿。</DialogDescription>
				</DialogHeader>
				<ul className="max-h-40 overflow-auto text-xs text-muted-foreground">
					{paths?.map((path) => (
						<li key={path} className="py-1 break-all">
							{path}
						</li>
					))}
				</ul>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={busy} onClick={onCancel}>
						取消
					</Button>
					<Button variant="outline" disabled={busy} onClick={onDiscard}>
						放弃修改
					</Button>
					<Button disabled={busy} onClick={onSave}>
						保存并继续
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
