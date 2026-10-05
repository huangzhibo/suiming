import type { ModelChoice } from "@suiming/sdk";
import { ChevronDown, Settings2 } from "lucide-react";
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
}: {
	choice?: ModelChoice | undefined;
	current?: ModelChoice | undefined;
	active: boolean;
	disabled: boolean;
	onChange(model: ModelChoice): void;
	openSettings(): void;
}) {
	const settings = useModelSettings();
	const [open, setOpen] = useState(false);
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
							? `当前使用 ${current?.model ?? "原模型"}；新选择在停止后继续或下次回复时生效`
							: "切换当前对话的模型，不修改默认设置"
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
								<span className="truncate">{label}</span>
								{pending && <span className="shrink-0 text-[10px]">待生效</span>}
								<ChevronDown className="shrink-0" />
							</Button>
						}
					/>
				</Hint>
				<PopoverContent side="top" align="start" className="w-[340px] max-w-[calc(100vw-32px)] overflow-hidden p-1">
					<p className="px-3 pt-2 text-xs text-muted-foreground">当前对话 · 不修改默认配置</p>
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
					<div className="mt-1 border-t pt-1">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="w-full justify-start text-xs"
							onClick={() => {
								setOpen(false);
								openSettings();
							}}
						>
							<Settings2 />
							模型设置…
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
