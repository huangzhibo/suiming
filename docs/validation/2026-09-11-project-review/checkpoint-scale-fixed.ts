import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { CheckpointArchive } from "../../../packages/runtime/src/harness/checkpoint-archive.ts";
import { runTaskLoop } from "../../../packages/runtime/src/harness/loop.ts";
import { ModelGateway } from "../../../packages/runtime/src/model/model-gateway.ts";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "../../../packages/runtime/src/index.ts";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.ts";

const disk = process.argv.includes("--disk");
for (const turns of disk ? [32] : [32, 100, 300]) {
	const root = disk ? await mkdtemp(join(tmpdir(), "suiming-checkpoint-disk-")) : undefined;
	if (root) await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = root ? await LocalProjectService.init({ checkoutPath: root }) : undefined;
	try {
	const objects = new Map<string, Uint8Array>();
	let storedBytes = 0;
	let last = "";
	let checkpoints = 0;
	const archive = new CheckpointArchive({
		async saveExecutionObject(mediaType, bytes) {
			const id = createHash("sha256").update(mediaType).update(bytes).digest("hex");
			if (!objects.has(id)) { objects.set(id, bytes); storedBytes += bytes.length; }
			return project ? project.saveExecutionObject(mediaType, bytes) : { id };
		},
		async readExecutionObject(id) { return project ? project.readExecutionObject(id) : { bytes: objects.get(id)! }; },
	});
	const provider = fauxProvider({ provider: "scale-test" });
	const models = createModels(); models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const model = await new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }).bind("main");
	provider.setResponses(Array.from({ length: turns }, () => fauxAssistantMessage(fauxToolCall("read", {}))));
	let index = 0;
	const start = performance.now();
	await runTaskLoop({ model, systemPrompt: "read test", prompt: "read documents", budget: { maxTurns: turns },
		tools: [{ name: "read", description: "read", parameters: Type.Object({}), async execute() {
			return { content: [{ type: "text", text: `${index++}:${"x".repeat(10000)}` }] };
		} }],
		async saveCheckpoint(checkpoint) { checkpoints++; last = (await archive.write(checkpoint)).id; },
	});
	const writeMs = Math.round(performance.now() - start);
	const recoverStart = performance.now();
	const recovered = await archive.read(project ? (await project.readExecutionObject(last)).bytes : objects.get(last)!) as { messages: unknown[] };
	const recoverMs = Math.round(performance.now() - recoverStart);
	let diskBytes: number | undefined;
	if (project) {
		const privatePath = project.paths.privatePath;
		project.close();
		diskBytes = 0;
		for (const entry of await readdir(privatePath, { recursive: true, withFileTypes: true })) {
			if (entry.isFile()) diskBytes += (await stat(join(entry.parentPath, entry.name))).size;
		}
	}
	console.log(JSON.stringify({ turns, checkpoints, storedBytes, diskBytes, objects: objects.size, writeMs, recoverMs, messages: recovered.messages.length }));
	} finally { project?.close(); if (root) await rm(root, { recursive: true, force: true }); }
}
