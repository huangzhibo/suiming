import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

let installed = false;

/**
 * 让模型调用遵守代理。
 *
 * Node 的全局 `fetch` **默认不读** `HTTPS_PROXY` / `HTTP_PROXY`，`NODE_USE_ENV_PROXY=1` 又只在
 * bootstrap 时生效、进程内设置无效。结果是：作者的 shell 明明配了代理、curl 与浏览器都通，
 * 我们的 provider 调用却只报一句 `fetch failed`（实为 10 秒 `UND_ERR_CONNECT_TIMEOUT`），
 * 而且完全看不出代理没被用上。2026-09-13 在 `api.x.ai` 上实测：裸 fetch 超时，装上这个
 * dispatcher 后 797ms 拿到 401——通到了服务器，只是没凭据。
 *
 * 环境变量优先；没有时用调用方给的 `system`（桌面主进程从 macOS 系统代理解析出来的，见
 * `proxyFromPacResult`）。从 Finder / 程序坞启动的桌面拿不到 shell 的环境变量，Node 又不读系统代理：
 * 2026-10-02 查清 openai-codex 登录那次 403 就是这样绕过作者的代理直连出去的，同一台机器上
 * 读系统代理的客户端一直能用。
 *
 * 只在进程入口调用（CLI bin、Electron 主进程），不在库里：`setGlobalDispatcher` 是进程级副作用，
 * 库被测试反复导入时不该改全局网络行为。没有配代理时什么都不做，直连保持原样。
 */
export function useEnvironmentProxy(system?: string): string | undefined {
	const configured = PROXY_VARIABLES.map((name) => process.env[name]).find((value) => (value ?? "").trim().length > 0);
	const proxy = configured ?? system;
	if (proxy === undefined || installed) return proxy;
	setGlobalDispatcher(
		configured !== undefined
			? new EnvHttpProxyAgent()
			: new EnvHttpProxyAgent({
					httpProxy: proxy,
					httpsProxy: proxy,
					// 本机上的模型服务（如 Ollama）与 OAuth 回调不走代理。
					noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? "localhost,127.0.0.1,::1",
				}),
	);
	installed = true;
	return proxy;
}

/**
 * Chromium `session.resolveProxy` 的结果（PAC 语法，如 `PROXY 127.0.0.1:7890; DIRECT`）里第一个
 * HTTP(S) 代理的 URL。按 PAC 的顺序读：先遇到 DIRECT 就直连；SOCKS 跳过（undici 的代理只支持
 * HTTP / HTTPS，宁可直连也不假装接上）。
 */
export function proxyFromPacResult(result: string): string | undefined {
	for (const entry of result.split(";").map((part) => part.trim())) {
		if (/^DIRECT$/iu.test(entry)) return undefined;
		const match = /^(PROXY|HTTPS)\s+(\S+)$/iu.exec(entry);
		if (match) return `${match[1]?.toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`;
	}
	return undefined;
}
