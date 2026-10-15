/** 隔离 OAuth 验收：真实 pi-ai 认证路径，只把远端换成回环服务，不读取宿主凭据。 */
import { type AssistantMessage, createModels, fauxProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { JsonFileCredentialStore, ModelGateway } from "@suiming/runtime";

export const OAUTH_TEST_PROVIDER = "isolated-oauth";
export function oauthFixture(path: string, endpoint: string) {
	if (new URL(endpoint).hostname !== "127.0.0.1") throw new Error("OAuth 测试只能连接回环服务");
	const credentials = new JsonFileCredentialStore({ path });
	const faux = fauxProvider({ provider: OAUTH_TEST_PROVIDER, models: [{ id: "story", name: "隔离认证模型" }] });
	const post = async (route: string, body: unknown, signal?: AbortSignal) => {
		const response = await fetch(`${endpoint}/${route}`, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			...(signal ? { signal } : {}),
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	};
	faux.setResponses(
		Array.from(
			{ length: 30 },
			() => async (context, options) =>
				(await post("model", { context, access: options?.apiKey }, options?.signal)) as AssistantMessage,
		),
	);
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider({
		...faux.provider,
		name: "隔离认证",
		auth: {
			oauth: {
				name: "测试登录",
				async login(interaction) {
					const code = await interaction.prompt({ type: "manual_code", message: "输入隔离授权码" });
					return (await post("login", { code }, interaction.signal)) as OAuthCredential;
				},
				refresh: async (credential, signal) => (await post("refresh", credential, signal)) as OAuthCredential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	});
	const profile = { provider: OAUTH_TEST_PROVIDER, model: "story" };
	return {
		credentials,
		models,
		model: faux.getModel(),
		gateway: new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }),
	};
}
