import assert from "node:assert/strict";
import test from "node:test";
import { proxyFromPacResult } from "../src/index.js";

test("系统代理：Chromium resolveProxy 的 PAC 结果取第一个 HTTP(S) 代理，DIRECT 在前就直连，只有 SOCKS 不接", () => {
	// 2026-10-02：openai-codex 那次 403 是直连出去的——从 Finder 启动的桌面拿不到 shell 的 HTTPS_PROXY，
	// Node 的 fetch 又不读 macOS 系统代理；同一台机器上 Codex 走系统代理（OpenAI 看到 SG）一直能用。
	assert.equal(proxyFromPacResult("PROXY 127.0.0.1:7890"), "http://127.0.0.1:7890");
	assert.equal(proxyFromPacResult("PROXY 127.0.0.1:7890; DIRECT"), "http://127.0.0.1:7890");
	assert.equal(proxyFromPacResult("HTTPS proxy.example.com:443"), "https://proxy.example.com:443");
	assert.equal(proxyFromPacResult("DIRECT"), undefined);
	assert.equal(proxyFromPacResult("DIRECT; PROXY 127.0.0.1:7890"), undefined, "PAC 说先直连就直连");
	assert.equal(proxyFromPacResult("SOCKS5 127.0.0.1:7890"), undefined, "undici 不支持 SOCKS，宁可直连也不假装接上");
	assert.equal(proxyFromPacResult("SOCKS5 127.0.0.1:7890; PROXY 127.0.0.1:7890"), "http://127.0.0.1:7890");
	assert.equal(proxyFromPacResult(""), undefined);
});
