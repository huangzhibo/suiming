import type { ModelChoice } from "@suiming/sdk";
import { Brain, ChevronDown, Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelCatalog, ModelThinking, modelChoiceLabel } from "./model-catalog.js";
import { useModelSettings } from "./model-settings.js";
import { Hint } from "./ui-bits.js";

export function ConversationModelPicker({
	choice,
	current,
	active,
	disabled,
	onChange,
	openSettings,
	open: controlledOpen,
	onOpenChange,
}: {
	choice?: ModelChoice | undefined;
	current?: ModelChoice | undefined;
	active: boolean;
	disabled: boolean;
	onChange(model: ModelChoice): void;
	openSettings(): void;
	/** 给 `/模型` 用（ADR-0039）：由输入框打开同一个面板，不另做一个入口。 */
	open?: boolean;
	onOpenChange?(open: boolean): void;
}) {
	const settings = useModelSettings();
	const [ownOpen, setOwnOpen] = useState(false);
	const open = controlledOpen ?? ownOpen;
	const setOpen = (next: boolean) => {
		setOwnOpen(next);
		onOpenChange?.(next);
	};
	const profile = settings.data?.profiles.find((profile) => profile.id === "main");
	const fallback = profile?.model
		? {
				provider: profile.provider,
				model: profile.model,
				...(profile.thinking ? { thinking: profile.thinking } : {}),
			}
		: undefined;
	const selected = choice ?? current ?? fallback;
	const pending = active && choice && JSON.stringify(choice) !== JSON.stringify(current);
	const label = modelChoiceLabel(settings.data?.providers ?? [], selected);
	return (
		<div className="flex min-w-0 items-center gap-0.5">
			<Popover open={open} onOpenChange={setOpen}>
				<Hint
					side="top"
					content={
						pending
							? `${label}\n当前使用 ${current?.model ?? "原模型"}；新选择在停止后继续或下次回复时生效`
							: `${label}\n切换这段对话的模型与思考强度，不改默认设置（/模型）`
					}
				>
					<PopoverTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="xs"
								className="min-w-0 max-w-[240px] shrink gap-1 text-muted-foreground"
								disabled={disabled}
								aria-label="对话模型"
							>
								{/* 输入框窄时只留图标，模型名在提示里（照 Codex） */}
								<Brain className="hidden shrink-0 @max-[300px]/composer:block" />
								<span className="truncate @max-[300px]/composer:hidden">{label}</span>
								{pending && <span className="shrink-0 text-[10px]">待生效</span>}
								<ChevronDown className="shrink-0 @max-[300px]/composer:hidden" />
							</Button>
						}
					/>
				</Hint>
				<PopoverContent side="top" align="end" className="w-[340px] max-w-[calc(100vw-32px)] overflow-hidden p-1">
					{settings.isPending ? (
						<p role="status" className="p-3 text-xs">
							正在读取模型…
						</p>
					) : settings.error ? (
						<div role="alert" className="p-3 text-xs text-destructive">
							{settings.error.message}
							<Button variant="link" size="xs" onClick={() => settings.refetch()}>
								重新加载
							</Button>
						</div>
					) : (
						<ModelCatalog
							providers={settings.data?.providers ?? []}
							selected={selected}
							fallback={fallback}
							onSelect={onChange}
						/>
					)}

					<ModelThinking providers={settings.data?.providers ?? []} selected={selected} onSelect={onChange} />
					<div className="mt-1 flex items-center justify-between border-t pt-1">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="justify-start text-xs"
							onClick={() => {
								setOpen(false);
								openSettings();
							}}
						>
							<Settings2 />
							模型设置…
						</Button>
						<span className="pr-2 text-[11px] text-muted-foreground">只改这段对话</span>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
