import type { LocalCommandOutput, ModelChoice } from "@suiming/sdk";
import { Check, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { THINKING_LABELS } from "./model-labels.js";

export type ModelSettingsData = LocalCommandOutput<"models.show">;
export type ModelProvider = ModelSettingsData["providers"][number];

export function modelName(providers: ModelProvider[], choice?: Pick<ModelChoice, "provider" | "model">) {
	return (
		providers.find((provider) => provider.id === choice?.provider)?.models.find((model) => model.id === choice?.model)
			?.name ||
		choice?.model ||
		"选择模型"
	);
}

/** 设置与对话共用目录和键盘选择；凭据与模型可用性仍由主进程提供。 */
export function ModelCatalog({
	providers,
	selected,
	onSelect,
	fallback,
}: {
	providers: ModelProvider[];
	selected?: ModelChoice | undefined;
	onSelect(choice: ModelChoice): void;
	fallback?: ModelChoice | undefined;
}) {
	const visible = providers.filter((provider) => provider.enabled && provider.usable);
	return (
		<Command>
			<CommandInput aria-label="搜索模型" placeholder="搜索模型或提供商…" />
			<CommandList className="max-h-64">
				<CommandEmpty>
					{visible.length ? "没有匹配的模型，试试其他名称。" : "尚无可用模型，请在设置中配置并启用提供商。"}
				</CommandEmpty>
				{visible.map((provider) => (
					<CommandGroup key={provider.id} heading={provider.name}>
						{provider.models.map((model) => (
							<CommandItem
								key={model.id}
								value={`${provider.id} ${model.id}`}
								keywords={[provider.name, model.name]}
								aria-label={model.name}
								onSelect={() =>
									onSelect({
										provider: provider.id,
										model: model.id,
										thinking:
											selected?.thinking &&
											(selected.thinking === "default" || model.thinkingLevels.includes(selected.thinking))
												? selected.thinking
												: "default",
									})
								}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate">{model.name}</span>
								</span>
								{fallback?.provider === provider.id && fallback.model === model.id && (
									<span className="text-xs text-muted-foreground">默认</span>
								)}
								{selected?.provider === provider.id && selected.model === model.id && (
									<Check className="size-4 text-primary" aria-label="当前选择" />
								)}
							</CommandItem>
						))}
					</CommandGroup>
				))}
			</CommandList>
		</Command>
	);
}

export function ModelSelect({
	id,
	providers,
	selected,
	onSelect,
}: {
	providers: ModelProvider[];
	selected?: ModelChoice | undefined;
	onSelect(choice: ModelChoice): void;
	id?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="outline"
						id={id}
						role="combobox"
						aria-expanded={open}
						aria-label="模型"
						className="w-full min-w-0 justify-between"
					>
						<span className="truncate">{modelChoiceLabel(providers, selected)}</span>
						<ChevronDown />
					</Button>
				}
			/>
			<PopoverContent align="start" className="w-[340px] min-w-64 max-w-[calc(100vw-32px)] p-0">
				<ModelCatalog providers={providers} selected={selected} onSelect={onSelect} />
				<ModelThinking providers={providers} selected={selected} onSelect={onSelect} />
			</PopoverContent>
		</Popover>
	);
}

export function modelChoiceLabel(providers: ModelProvider[], selected?: ModelChoice) {
	const model = providers
		.find((provider) => provider.id === selected?.provider)
		?.models.find((model) => model.id === selected?.model);
	return `${modelName(providers, selected)}${model?.thinkingLevels.length ? ` · ${THINKING_LABELS[selected?.thinking ?? "default"]}` : ""}`;
}

/** 对话与设置共用；选模型后留在同一面板调整强度。 */
export function ModelThinking({
	providers,
	selected,
	onSelect,
}: {
	providers: ModelProvider[];
	selected: ModelChoice | undefined;
	onSelect(choice: ModelChoice): void;
}) {
	const id = useId();
	const provider = providers.find((provider) => provider.id === selected?.provider);
	const model = provider?.models.find((model) => model.id === selected?.model);
	if (!selected || !model?.thinkingLevels.length) return null;
	return (
		<>
			<Separator />
			<Field orientation="horizontal" className="justify-between p-3">
				<FieldLabel htmlFor={id}>思考强度</FieldLabel>
				<Select
					value={selected.thinking ?? "default"}
					items={[
						{ value: "default", label: "模型默认" },
						...model.thinkingLevels.map((level) => ({ value: level, label: THINKING_LABELS[level] })),
					]}
					disabled={!provider?.enabled || !provider.usable}
					onValueChange={(thinking) =>
						thinking !== null &&
						onSelect({ ...selected, thinking: thinking as NonNullable<ModelChoice["thinking"]> })
					}
				>
					<SelectTrigger id={id} aria-label="思考强度" size="sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value="default">模型默认</SelectItem>
							{model.thinkingLevels.map((level) => (
								<SelectItem key={level} value={level}>
									{THINKING_LABELS[level]}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</Field>
		</>
	);
}
