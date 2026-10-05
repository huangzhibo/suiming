import type { LocalCommandOutput } from "@suiming/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { invoke } from "./bridge.js";
import type { ModelProvider as Provider, ModelSettingsData as Settings } from "./model-catalog.js";
import { Hint } from "./ui-bits.js";

type LoginStatus = LocalCommandOutput<"models.login.status">;

export function ProviderSettings({ settings }: { settings: Settings }) {
	const [selectedId, setSelectedId] = useState("");
	const [adding, setAdding] = useState(false);
	const [query, setQuery] = useState("");
	const selected = settings.providers.find((provider) => provider.id === selectedId);
	const configured = settings.providers.filter(
		(provider) =>
			provider.usable ||
			provider.stored !== "none" ||
			!provider.enabled ||
			settings.profiles.some((profile) => profile.provider === provider.id),
	);
	const available = settings.providers.filter((provider) => !configured.includes(provider));
	const matches = (adding ? available : configured).filter((provider) =>
		`${provider.name} ${provider.id}`.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const back = () => {
		setSelectedId("");
		setAdding(false);
		setQuery("");
	};
	if (selected)
		return (
			<>
				<Button variant="ghost" size="sm" className="mb-5 -ml-2" onClick={back}>
					<ArrowLeft />
					返回提供商
				</Button>
				<div className="mb-6 flex items-center justify-between gap-4">
					<div>
						<h2 className="text-base font-semibold">{selected.name}</h2>
						<p className="mt-1 text-xs text-muted-foreground">管理认证方式与本机凭据</p>
					</div>
					<ProviderSwitch provider={selected} />
				</div>
				<ProviderConnection key={selected.id} provider={selected} />
			</>
		);
	return (
		<>
			{adding && (
				<Button variant="ghost" size="sm" className="mb-5 -ml-2" onClick={back}>
					<ArrowLeft />
					返回提供商
				</Button>
			)}
			<div className="mb-5 flex items-start justify-between gap-4">
				<div>
					<h2 className="text-base font-semibold">{adding ? "添加提供商" : "提供商"}</h2>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
						{adding
							? "选择服务，配置账号或 API key。"
							: "管理已配置的服务。停用会保留凭据，不影响正在执行的回复。"}
					</p>
				</div>
				{!adding && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setAdding(true);
							setQuery("");
						}}
					>
						<Plus />
						添加提供商
					</Button>
				)}
			</div>
			{(adding || configured.length > 6) && (
				<Input
					aria-label="搜索提供商"
					placeholder="搜索提供商…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			)}
			<section className="mt-3 divide-y" aria-label={adding ? "可添加的提供商" : "已配置的提供商"}>
				{matches.map((provider) => (
					<div key={provider.id} className="flex min-h-16 items-center gap-4 py-3">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">{provider.name}</p>
							<p className="mt-1 truncate text-xs text-muted-foreground">
								{adding
									? [provider.apiKey?.login && "API key", provider.oauth?.name].filter(Boolean).join(" · ") ||
										"环境配置"
									: credentialSource(provider)}
							</p>
						</div>
						{!adding && <ProviderSwitch provider={provider} />}
						<Button
							variant="ghost"
							size={adding ? "sm" : "icon-sm"}
							aria-label={`配置 ${provider.name}`}
							onClick={() => setSelectedId(provider.id)}
						>
							{adding ? "连接" : <ChevronRight />}
						</Button>
					</div>
				))}
			</section>
			{!matches.length && (
				<p role="status" className="py-8 text-center text-sm text-muted-foreground">
					{query
						? "没有匹配的提供商，试试其他名称。"
						: adding
							? "目录中的提供商均已添加。"
							: "还没有配置提供商，点击「添加提供商」开始。"}
				</p>
			)}
		</>
	);
}

function ProviderSwitch({ provider }: { provider: Provider }) {
	const client = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function change(enabled: boolean) {
		setBusy(true);
		setError("");
		try {
			await invoke("models.provider.setEnabled", { provider: provider.id, enabled });
			await client.invalidateQueries({ queryKey: ["models"] });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="flex flex-col items-end gap-1">
			{/* 不用 <label>：Base UI 的 Switch 会拿关联的 label 作 aria-labelledby，名字就成了状态字「启用 / 停用」，
			    读屏要听到的是「启用 某提供商」加上开关状态。 */}
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<span>{busy ? "保存中…" : provider.enabled ? "启用" : "停用"}</span>
				<Switch
					aria-label={`启用 ${provider.name}`}
					checked={provider.enabled}
					disabled={busy}
					onCheckedChange={(enabled) => void change(enabled)}
				/>
			</div>
			{error && (
				<p role="alert" className="max-w-48 text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

function credentialSource(provider: Provider) {
	if (!provider.usable) return provider.stored === "none" ? "未配置凭据" : "凭据需要更新";
	if (provider.usable.type === "oauth") return "账号登录";
	if (provider.stored === "api_key") return "API key · 本地保存";
	return provider.usable.source === "provider" ? "提供商配置" : "环境配置";
}

/** 一个 provider 的连接状态与入口：API key、OAuth 登录、断开；登录进行中时显示向导。 */
function ProviderConnection({ provider }: { provider: Provider }) {
	const [session, setSession] = useState<string | undefined>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const client = useQueryClient();
	useEffect(
		() => () => {
			if (session) void invoke("models.login.cancel", { sessionId: session }).catch(() => undefined);
		},
		[session],
	);
	async function disconnect() {
		setBusy(true);
		setError("");
		try {
			await invoke("models.disconnect", { provider: provider.id });
			await client.invalidateQueries({ queryKey: ["models"] });
			setConfirmDisconnect(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	async function start(type: "api_key" | "oauth") {
		setError("");
		setBusy(true);
		try {
			const started = await invoke("models.login.start", { provider: provider.id, type });
			setSession(started.sessionId);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<p className="mb-5 text-sm text-muted-foreground">{credentialSource(provider)}</p>
			{!provider.enabled && (
				<p className="mb-5 text-xs text-muted-foreground">此服务已停用。更新凭据不会自动启用，需打开上方开关。</p>
			)}
			{!session && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{provider.apiKey?.login && (
						<Button variant="outline" size="sm" disabled={busy} onClick={() => start("api_key")}>
							{provider.stored === "api_key" ? "更换 API key" : "输入 API key"}
						</Button>
					)}
					{provider.oauth && (
						<Button size="sm" disabled={busy} onClick={() => start("oauth")}>
							登录 {provider.oauth.name}
						</Button>
					)}

					{!provider.apiKey?.login && !provider.oauth && (
						<span className="text-xs text-muted-foreground">
							通过环境配置连接（例如环境变量或 AWS profile）；此提供商未提供应用内登录方式。
						</span>
					)}
				</div>
			)}
			{provider.oauth?.subscription && !session && (
				<p className="mt-2 text-[11.5px] leading-[1.6] text-muted-foreground">
					{provider.oauth.name} 是产品订阅登录，可用范围与额度由服务商决定。
				</p>
			)}
			{provider.stored !== "none" && !session && (
				<>
					<Separator className="my-6" />
					<div className="flex items-center justify-between gap-4">
						<p className="text-xs text-muted-foreground">仅暂时不用此服务时，关闭启用开关即可。</p>
						<Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDisconnect(true)}>
							删除本地凭据
						</Button>
					</div>
				</>
			)}
			{confirmDisconnect && (
				<div className="mt-3 text-xs" role="alert">
					<p>删除 {provider.name} 的本地凭据？使用它的模型可能需要重新连接。环境中的凭据不受影响。</p>
					<div className="mt-2 flex gap-2">
						<Button variant="destructive" size="sm" disabled={busy} onClick={disconnect}>
							确认删除
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
							保留
						</Button>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" className="mt-2 text-xs text-destructive">
					{error}
				</p>
			)}
			{session && <LoginWizard sessionId={session} onClose={() => setSession(undefined)} />}
		</div>
	);
}

/** 登录向导：轮询主进程的登录会话，展示 provider 的提示并把回答交回去。 */
function LoginWizard({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
	const client = useQueryClient();
	const status = useQuery({
		queryKey: ["login", sessionId],
		queryFn: () => invoke("models.login.status", { sessionId }),
		refetchInterval: (query) => (query.state.data?.status === "pending" ? 400 : false),
	});
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const data = status.data;
	const prompt = data?.prompt;
	// 每个新提示从空白开始；provider 可能连着问几次（选登录方式、再粘贴授权码）。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在提示切换时清空输入
	useEffect(() => setValue(""), [prompt?.id]);
	useEffect(() => {
		if (data?.status === "succeeded") void client.invalidateQueries({ queryKey: ["models"] });
	}, [data?.status, client]);
	async function reply(answer: string) {
		if (!prompt || busy) return;
		setError("");
		setBusy(true);
		try {
			await invoke("models.login.reply", { sessionId, promptId: prompt.id, value: answer });
			await status.refetch();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	if (!data)
		return (
			<p role="status" className="mt-3 text-xs">
				{status.error?.message ?? "正在获取登录提示…"}
			</p>
		);
	return (
		<div className="mt-5 border-t pt-5 text-xs leading-[1.6]" aria-live="polite">
			<div className="mb-2 flex items-center justify-between">
				<strong className="font-medium">
					{data.status === "pending"
						? "正在登录"
						: data.status === "succeeded"
							? "已连接"
							: data.status === "cancelled"
								? "已取消"
								: "登录失败"}
				</strong>
				{data.status === "pending" ? (
					<Button
						variant="ghost"
						size="xs"
						disabled={busy}
						onClick={() => {
							setBusy(true);
							void invoke("models.login.cancel", { sessionId })
								.then(() => status.refetch())
								.catch((error) => setError(error instanceof Error ? error.message : String(error)))
								.finally(() => setBusy(false));
						}}
					>
						取消
					</Button>
				) : (
					<Button variant="ghost" size="xs" onClick={onClose}>
						关闭
					</Button>
				)}
			</div>
			{data.events.map((event, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 事件列表只追加不重排，序号就是稳定身份
				<LoginEventView key={`${index}-${event.type}`} event={event} />
			))}
			{data.error && <p className="text-red-ink">{data.error}</p>}
			{prompt && (
				<form
					className="mt-2 flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void reply(value);
					}}
				>
					<span className="text-ink-3">{prompt.message}</span>
					{prompt.type === "select" ? (
						<div className="flex flex-wrap gap-2">
							{prompt.options?.map((option) => (
								<Hint content={option.description} key={option.id}>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() => reply(option.id)}
									>
										{option.label}
									</Button>
								</Hint>
							))}
						</div>
					) : (
						<div className="flex gap-2">
							<Input
								type={prompt.type === "secret" ? "password" : "text"}
								aria-label={prompt.message}
								autoComplete="off"
								autoFocus
								className="bg-white"
								value={value}
								placeholder={prompt.placeholder}
								onChange={(event) => setValue(event.target.value)}
							/>
							<Button type="submit" size="sm" disabled={busy || (prompt.type === "secret" && !value.trim())}>
								提交
							</Button>
						</div>
					)}
				</form>
			)}
			{error && <p className="mt-1 text-red-ink">{error}</p>}
		</div>
	);
}

function LoginEventView({ event }: { event: LoginStatus["events"][number] }) {
	if (event.type === "auth_url")
		return (
			<p className="my-1 text-ink-3">
				登录页已在浏览器打开；若没有，请手动打开：
				<code className="ml-1 select-all break-all text-[11px]">{event.url}</code>
			</p>
		);
	if (event.type === "device_code")
		return (
			<p className="my-1 text-ink-3">
				在 <code className="select-all">{event.verificationUri}</code> 输入代码
				<code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-sm font-semibold tracking-wider select-all">
					{event.userCode}
				</code>
				{event.expiresInSeconds ? `（${Math.round(event.expiresInSeconds / 60)} 分钟内有效）` : ""}
			</p>
		);
	return <p className="my-1 text-muted-foreground">{event.message}</p>;
}
