import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	SuimingHarness,
} from "../../../packages/runtime/src/index.ts";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.ts";

export async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "suiming-probe-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-probe" });
	const provider = fauxProvider({ provider: "probe" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const gateway = new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
	const harness = new SuimingHarness({ project, models: gateway });
	return {
		root, project, provider, harness,
		async close() { project.close(); await rm(root, { recursive: true, force: true }); },
	};
}
