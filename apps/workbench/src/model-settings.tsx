import type { LocalCommandInput } from "@suiming/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Plug, SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { invoke } from "./bridge.js";
import { ModelSelect, type ModelSettingsData as Settings } from "./model-catalog.js";
import { ProviderSettings } from "./provider-settings.js";
import { ActionButton } from "./ui-bits.js";
import { usageCheckpointOptions } from "./usage-checkpoint.js";

type Profile = LocalCommandInput<"models.save">["profile"];

export function useModelSettings() {
	return useQuery({ queryKey: ["models"], queryFn: () => invoke("models.show", {}), staleTime: 15000 });
}

/** 模型、连接和任务偏好各自呈现；分类切换不重置未保存内容。 */
export function ModelSettings() {
	const settings = useModelSettings();
	const [tab, setTab] = useState("models");
	const data = settings.data;
	if (!data)
		return (
			<div className="p-6 text-sm" role={settings.error ? "alert" : "status"}>
				{settings.error ? (
					<>
						{settings.error.message}
						<Button variant="link" onClick={() => settings.refetch()}>
							重新加载
						</Button>
					</>
				) : (
					"正在读取模型与连接…"
				)}
			</div>
		);
	return (
		<Tabs orientation="vertical" value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
			<aside className="flex w-36 shrink-0 flex-col border-r bg-muted/40 p-3">
				<TabsList aria-label="设置分类" className="w-full gap-1 bg-transparent p-0">
					<TabsTrigger value="models" className="h-9 flex-none px-3">
						<SlidersHorizontal />
						模型配置
					</TabsTrigger>
					<TabsTrigger value="providers" className="h-9 flex-none px-3">
						<Plug />
						提供商
					</TabsTrigger>
					<TabsTrigger value="tasks" className="h-9 flex-none px-3">
						<ListChecks />
						任务偏好
					</TabsTrigger>
				</TabsList>
				<p className="mt-auto px-3 pt-6 text-[11px] text-muted-foreground">应用偏好 · 本机</p>
			</aside>
			<TabsContent keepMounted value="models" className="min-h-0 min-w-0 overflow-auto px-7 py-6 data-hidden:hidden">
				<div className="mb-6">
					<h2 className="text-base font-semibold">模型配置</h2>
					<p className="mt-1 text-xs text-muted-foreground">设置新对话的默认模型。对话中的临时选择独立生效。</p>
				</div>
				<ProfileSettings profile="main" settings={data} />
				<div className="mt-6 border-t pt-6">
					<UsageCheckpointSettings settings={data} />
				</div>
			</TabsContent>
			<TabsContent keepMounted value="tasks" className="min-h-0 min-w-0 overflow-auto px-7 py-6 data-hidden:hidden">
				<div className="mb-4">
					<h2 className="text-base font-semibold">任务偏好</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						按创作用途选择模型。展开参数可调整思考深度与高级选项。
					</p>
				</div>
				<div className="divide-y">
					{data.profiles
						.filter((profile) => profile.id !== "main")
						.map((profile) => (
							<div key={profile.id} className="py-4">
								<ProfileSettings profile={profile.id} settings={data} />
							</div>
						))}
				</div>
			</TabsContent>
			<TabsContent
				keepMounted
				value="providers"
				className="min-h-0 min-w-0 overflow-auto px-7 py-6 data-hidden:hidden"
			>
				<ProviderSettings settings={data} />
			</TabsContent>
		</Tabs>
	);
}

function ProfileSettings({ profile, settings }: { profile: Profile; settings: Settings }) {
	const current = settings.profiles.find((item) => item.id === profile);
	const [draft, setDraft] = useState<LocalCommandInput<"models.save"> | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const client = useQueryClient();
	const id = useId();
	const value = draft ?? {
		profile,
		provider: current?.provider ?? "",
		model: current?.model ?? "",
		options: current?.options ?? "{}",
		thinking: current?.thinking ?? "default",
	};
	const provider = settings.providers.find((item) => item.id === value.provider);
	const definition = provider?.models.find((item) => item.id === value.model);
	const update = (change: Partial<typeof value>) => {
		setDraft({ ...value, ...change });
		setError("");
		setSaved(false);
	};
	async function save() {
		setError("");
		setSaved(false);
		setBusy(true);
		try {
			const parsed: unknown = JSON.parse(value.options ?? "{}");
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("模型参数须为 JSON 对象，例如 {}。");
			await invoke("models.save", value);
			await client.invalidateQueries({ queryKey: ["models"] });
			setDraft(undefined);
			setSaved(true);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	const name = current?.label ?? profile;
	const description = current?.description ?? "";
	const parameters = (
		<FieldGroup className="gap-4">
			<details>
				<summary className="cursor-pointer text-xs text-muted-foreground">高级模型参数</summary>
				<Field className="mt-3">
					<FieldLabel htmlFor={`${id}-options`}>模型参数（JSON）</FieldLabel>
					<Textarea
						id={`${id}-options`}
						aria-label="模型参数"
						aria-invalid={!!error}
						className="min-h-24 font-mono text-xs"
						value={value.options}
						onChange={(event) => update({ options: event.target.value })}
					/>
				</Field>
			</details>
		</FieldGroup>
	);
	return (
		<form
			aria-label={name}
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<fieldset disabled={busy} className="min-w-0">
				<Field orientation="horizontal" className="flex-wrap items-start justify-between gap-y-3">
					<div className="min-w-32 flex-1 pt-1">
						<FieldLabel htmlFor={`${id}-model`}>{profile === "main" ? "默认模型" : name}</FieldLabel>
						<p className="mt-1 max-w-48 text-xs leading-relaxed text-muted-foreground">{description}</p>
					</div>
					<div className="w-64 max-w-full">
						<ModelSelect
							id={`${id}-model`}
							providers={settings.providers}
							selected={value}
							onSelect={(choice) =>
								update({
									...choice,
									...(choice.provider !== value.provider || choice.model !== value.model
										? { options: "{}" }
										: {}),
								})
							}
						/>
						{provider && (
							<div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
								<span className="min-w-0 truncate text-muted-foreground">{provider.name}</span>
							</div>
						)}
					</div>
				</Field>
				{(!provider?.usable || !provider.enabled) && value.model && (
					<p className="mt-2 text-xs text-amber">
						{provider && !provider.enabled
							? "此提供商已停用，请在「提供商」中启用或选择其他模型。"
							: "此模型尚无可用凭据，请在「提供商」中配置。"}
					</p>
				)}
				{profile === "main" ? (
					<div className="mt-5 border-t pt-5">{parameters}</div>
				) : (
					<details className="mt-2">
						<summary className="cursor-pointer text-xs text-muted-foreground">参数</summary>
						<div className="py-3">{parameters}</div>
					</details>
				)}
				{current?.source === "environment" && (
					<p className="mt-3 text-xs text-muted-foreground">
						当前使用环境变量配置；保存的偏好在移除环境覆盖后生效。
					</p>
				)}
				{current?.source === "main-default" && (
					<p className="mt-3 text-xs text-muted-foreground">
						还没单独设置：跟随这次对话所选的模型。在这里保存后改用固定的模型。
					</p>
				)}
				{value.model && !definition && (
					<p className="mt-3 text-xs text-destructive">当前模型不在目录中，请重新选择。</p>
				)}
				{(draft || busy || saved) && (
					<div className="mt-4 flex items-center justify-end gap-2 border-t pt-3">
						<span className="mr-auto text-xs text-muted-foreground" role="status">
							{saved ? "已保存" : busy ? "正在保存…" : "未保存更改"}
						</span>
						{draft && (
							<>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setDraft(undefined);
										setError("");
									}}
								>
									还原
								</Button>
								<ActionButton
									type="submit"
									size="sm"
									disabled={busy}
									disabledReason={
										definition
											? undefined
											: value.model
												? "模型目录里没有这个模型，请重新选择"
												: "先选择一个模型"
									}
								>
									保存模型配置
								</ActionButton>
							</>
						)}
					</div>
				)}
			</fieldset>
			{error && (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
		</form>
	);
}

/**
 * 每轮用量检查点：一轮里 Agent 与子任务的折算用量到线就停下等作者说继续，防的是没人看着时空转烧钱（Harness 设计
 * 第 10 节）。选了就保存，与提供商开关一样；下一轮开始时生效。
 */
function UsageCheckpointSettings({ settings }: { settings: Settings }) {
	const id = useId();
	const client = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const { tokens, mainInputPrice } = settings.usageCheckpoint;
	async function change(value: string) {
		setBusy(true);
		setError("");
		setSaved(false);
		try {
			await invoke("models.usageCheckpoint.save", { tokens: Number(value) });
			await client.invalidateQueries({ queryKey: ["models"] });
			setSaved(true);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div>
			<Field orientation="horizontal" className="flex-wrap items-start justify-between gap-y-3">
				<div className="min-w-32 flex-1 pt-1">
					<FieldLabel htmlFor={id}>每轮用量检查点</FieldLabel>
					<p className="mt-1 max-w-56 text-xs leading-relaxed text-muted-foreground">
						一轮对话里 Agent
						与子任务的用量到这里就先停下，说一句「继续」接着做，进度不丢。防止没人看着时空转烧钱。
					</p>
				</div>
				<div className="w-64 max-w-full">
					<Select
						value={String(tokens)}
						items={usageCheckpointOptions(tokens, mainInputPrice)}
						disabled={busy}
						onValueChange={(value) => value !== null && void change(value)}
					>
						<SelectTrigger id={id} aria-label="每轮用量检查点" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{usageCheckpointOptions(tokens, mainInputPrice).map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
					<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground" role="status">
						{busy
							? "正在保存…"
							: saved
								? "已保存，下一轮生效"
								: "折算 token：缓存命中按一成、输出按五倍。600 万约是整本抽取一百多章的量；金额按默认模型的目录价估算。"}
					</p>
				</div>
			</Field>
			{error && (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
