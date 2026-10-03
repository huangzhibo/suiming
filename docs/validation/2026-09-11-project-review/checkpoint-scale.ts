import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runTaskLoop } from "../../../packages/runtime/src/harness/loop.ts";
import { ModelGateway } from "../../../packages/runtime/src/model/model-gateway.ts";
for (const turns of [8, 16, 32]) {
	const provider = fauxProvider({ provider: "scale-test" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const model = await new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }).bind("main",
	);
	provider.setResponses(Array.from({ length: turns }, () => fauxAssistantMessage(fauxToolCall("read", {}))));
	let checkpoints = 0;
	let total = 0;
	let last = 0;
	const start = performance.now();
	await runTaskLoop({
		model,
		systemPrompt: "read test",
		prompt: "read documents",
		budget: { maxTurns: turns },
		tools: [
			{
				name: "read",
				description: "read",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }] }),
			},
		],
		async saveCheckpoint(checkpoint) {
			checkpoints++;
			last = Buffer.byteLength(JSON.stringify(checkpoint));
			total += last;
		},
	});
	console.log(
		JSON.stringify({
			turns,
			toolOutputBytes: 10000,
			checkpoints,
			lastBytes: last,
			cumulativeBytes: total,
			elapsedMs: Math.round(performance.now() - start),
		}),
	);
}
