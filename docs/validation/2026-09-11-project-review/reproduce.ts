import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	JsonFileCredentialStore,
	LocalCheckoutSynchronizer,
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	runAgent,
	SuimingHarness,
	resumeRun,
} from "../../../packages/runtime/src/index.ts";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.ts";

const root = await mkdtemp(join(tmpdir(), "suiming-review-"));
async function fixture(name: string) {
	const checkout = join(root, name);
	await mkdir(checkout);
	await materializeOpenStoryDirectorySnapshot(checkout, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: checkout, projectId: name });
	const provider = fauxProvider({ provider: "audit-test" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const harness = new SuimingHarness({
		project,
		models: new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }),
	});
	return { checkout, project, provider, harness };
}
try {
	// Two stores are used by settings and running gateways, and by desktop / CLI.
	const a = new JsonFileCredentialStore({ path: join(root, "auth.json") });
	const b = new JsonFileCredentialStore({ path: join(root, "auth.json") });
	let release!: () => void;
	let entered!: () => void;
	const hold = new Promise<void>((r) => (release = r));
	const ready = new Promise<void>((r) => (entered = r));
	const update = a.modify("provider-a", async () => {
		entered();
		await hold;
		return { type: "api_key", key: "fake-a" };
	});
	await ready;
	await b.modify("provider-b", async () => ({ type: "api_key", key: "fake-b" }));
	release();
	await update;
	console.log("CREDENTIAL_LOST_UPDATE", {
		expected: ["provider-a", "provider-b"],
		actual: (await a.list()).map((x) => x.providerId),
	});

	const checkout = join(root, "journal");
	const outside = join(root, "outside");
	await mkdir(join(checkout, "intent"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(checkout, "intent", "test.md"), "conflicting edit");
	await writeFile(join(outside, "test.md"), "before");
	const sync = new LocalCheckoutSynchronizer(checkout);
	const files = (text: string) => [{ path: "intent/test.md", mediaType: "text/markdown", bytes: Buffer.from(text) }];
	let initialError = "";
	try {
		await sync.sync(files("before"), files("after"), "revision-1");
	} catch (e) {
		initialError = (e as any).code;
	}
	await rename(join(checkout, "intent"), join(checkout, "intent-old"));
	await symlink(outside, join(checkout, "intent"));
	await sync.recover("revision-1");
	console.log("RECOVERY_ESCAPES_CHECKOUT", {
		initialError,
		outsideContent: await readFile(join(outside, "test.md"), "utf8"),
	});

	const steering = await fixture("steering");
	try {
		let runId = "";
		const correction = "补充要求：请分析黄盖，而不是赤壁";
		steering.provider.setResponses([
			async () => {
				steering.project.queueRunSteering(runId, correction);
				return fauxAssistantMessage(fauxToolCall("finish", { summary: "赤壁是档案收藏地。" }));
			},
		]);
		const result = await runAgent(steering.harness, {
			goal: "讨论赤壁，不修改作品",
			onStarted(v) {
				runId = v.runId;
			},
		});
		console.log("STEERING_IGNORED_ON_FINISH", {
			status: result.status,
			queued: steering.project.readRunSteering(runId),
			correctionInEvents: JSON.stringify(steering.project.readRunEvents(runId)).includes(correction),
		});
	} finally {
		steering.project.close();
	}

	const startup = await fixture("startup");
	try {
		let runId = "";
		let error = "";
		try {
			await runAgent(startup.harness, {
				goal: "讨论作品",
				async onStarted(v) {
					runId = v.runId;
					await mkdir(join(startup.checkout, ".suiming", "worktrees"), { recursive: true });
					await writeFile(
						join(startup.checkout, ".suiming", "worktrees", runId),
						"simulate materialization failure",
					);
				},
			});
		} catch (e) {
			error = (e as any).code ?? (e as Error).message;
		}
		const run = startup.project.loadExecutionState().runs.find((x) => x.id === runId);
		let resumeError = "";
		try {
			await resumeRun(startup.harness, { runId });
		} catch (e) {
			resumeError = (e as any).code;
		}
		console.log("STARTUP_FAILURE_STILL_RUNNING", {
			error,
			status: run?.status,
			taskCount: run?.taskIds.length,
			lease: !!run?.lease,
			resumeError,
		});
	} finally {
		startup.project.close();
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
