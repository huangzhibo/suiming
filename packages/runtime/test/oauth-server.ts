import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type OAuthCredential,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/** 单次刷新令牌的回环服务；闸门由测试控制，避免用固定延时碰并发。 */
export async function oauthServer() {
	let generation = 0;
	const state = {
		refreshes: 0,
		logins: 0,
		messages: [] as TranscriptContext[],
		failure: "" as string,
		refreshEntered: Promise.withResolvers<void>(),
		refreshGate: undefined as Promise<void> | undefined,
		refreshRotated: Promise.withResolvers<void>(),
		refreshResultGate: undefined as Promise<void> | undefined,
		loginIssued: Promise.withResolvers<void>(),
		respond: async (_context: TranscriptContext): Promise<AssistantMessage> =>
			fauxAssistantMessage("认证后继续成功。"),
	};
	const credential = (): OAuthCredential => ({
		type: "oauth",
		access: `test-access-${generation}`,
		refresh: `test-refresh-${generation}`,
		expires: Date.now() + 3_600_000,
	});
	const server = createServer(async (req, res) => {
		try {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const body = JSON.parse(raw);
			let result: unknown;
			if (req.url === "/refresh") {
				state.refreshes++;
				state.refreshEntered.resolve();
				await state.refreshGate;
				if (state.failure) throw new Error(state.failure);
				assert.equal(body.refresh, credential().refresh, "invalid_grant: refresh token already used");
				generation++;
				result = credential();
				state.refreshRotated.resolve();
				await state.refreshResultGate;
			} else if (req.url === "/login") {
				assert.equal(body.code, "isolated-code");
				state.logins++;
				generation++;
				result = credential();
				state.loginIssued.resolve();
			} else if (req.url === "/model") {
				assert.equal(body.access, credential().access, "401 invalid access token");
				state.messages.push(body.context);
				result = await state.respond(body.context);
			} else throw new Error("Unknown test route");
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(result));
		} catch (error) {
			res.statusCode = 401;
			res.end(error instanceof Error ? error.message : String(error));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		state,
		credential,
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
