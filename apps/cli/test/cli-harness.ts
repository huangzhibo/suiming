/**
 * CLI 测试共用的 harness：进程内调 runSuimCli、收 stdout / stderr；样例作品加一份已抽取的 Source。
 * 拆出来是为了让要等真实锁超时的用例单独成文件（cli-lock.test.ts），不拖长 cli.test 这一组的关键路径。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type CloudProjectStore,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	type OpenPackageFile,
} from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { runSuimCli, type SuimCliIo } from "../src/cli.js";

export interface CliHarness {
	io: SuimCliIo;
	stdout: string[];
	stderr: string[];
	interrupt(): void;
}

export interface CloudHarness {
	store: CloudProjectStore;
	endpoint: string;
	actorId: string;
}

const encoder = new TextEncoder();

// 测试不读开发者本机的 ~/.suiming：没传 gateway 的命令走默认解析时，只会看到这两个不存在的文件。
// 2026-10-03 在干净的 HOME 里模拟 CI 时查出，「另一个 CLI 往进行中的 session 补一句」靠本机配置才通过。
const NO_USER_CONFIG = join(tmpdir(), `suiming-cli-test-no-config-${process.pid}`);
process.env.SUIMING_CONFIG_PATH = join(NO_USER_CONFIG, "config.toml");
process.env.SUIMING_AUTH_PATH = join(NO_USER_CONFIG, "auth.json");

export function extractedSourceFiles(sourceId: string): OpenPackageFile[] {
	const root = `source/${sourceId}`;
	const text = (path: string, value: string, mediaType = "text/markdown; charset=utf-8"): OpenPackageFile => ({
		path,
		mediaType,
		bytes: encoder.encode(value),
	});
	return [
		text(
			`${root}/source.yaml`,
			`schema_version: 1\nname: ${sourceId}.txt\nencoding: utf-8\n`,
			"application/yaml; charset=utf-8",
		),
		text(`${root}/original.bin`, "黄盖备下火船，准备诈降。", "application/octet-stream"),
		text(`${root}/material.txt`, "黄盖备下火船，准备诈降。\n", "text/plain; charset=utf-8"),
		text(
			`${root}/outline/story/index.yaml`,
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 来源\n    beat_ids: [beat-0001]\n",
			"application/yaml; charset=utf-8",
		),
		text(
			`${root}/outline/story/vol-0001/beat-0001.md`,
			"---\nrefs:\n  character: [黄盖]\ncontracts:\n  open: [火船去向]\n---\n黄盖备下火船，材料没有交代它最终去了哪里。\n",
		),
		text(`${root}/world/characters/黄盖.md`, "上阵前先算清退路。\n"),
		text(
			`${root}/outline/contracts/火船去向.md`,
			"---\nsubjects:\n  character: [黄盖]\ndeadline: book_end\n---\n材料已经建立火船去向的期待，但当前边界尚未回答。\n",
		),
	];
}

export function harness(cwd: string, models?: ModelGateway, cloud?: CloudHarness): CliHarness {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const interruptHandlers = new Set<() => void>();
	return {
		stdout,
		stderr,
		interrupt: () => {
			for (const handler of interruptHandlers) handler();
		},
		io: {
			cwd: () => cwd,
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
			onInterrupt: (handler) => {
				interruptHandlers.add(handler);
				return () => interruptHandlers.delete(handler);
			},
			...(models === undefined ? {} : { resolveModelGateway: async () => models }),
			...(cloud === undefined
				? {}
				: {
						cloudDefaults: () => ({ endpoint: cloud.endpoint, actorId: cloud.actorId }),
						resolveCloudProjectStore: async () => cloud.store,
					}),
		},
	};
}

export async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "suiming-cli-"));
	await materializeOpenStoryDirectorySnapshot(root, [...sampleWorkFiles(), ...extractedSourceFiles("原作")]);
	return root;
}

export function response(output: readonly string[]): Record<string, unknown> {
	assert.equal(output.length, 1);
	return JSON.parse(output[0] as string) as Record<string, unknown>;
}

export async function jsonCommand(cwd: string, args: readonly string[], models?: ModelGateway, cloud?: CloudHarness) {
	const cli = harness(cwd, models, cloud);
	const exitCode = await runSuimCli(["--json", ...args], cli.io);
	return { cli, exitCode, value: response(cli.stdout) };
}

/** 只回一句话的网关：只测 CLI 的会话 contract、不测 Agent 行为的用例用它。 */
export function replyGateway(reply = "收到"): ModelGateway {
	const providerId = "suiming-cli-reply-faux";
	const provider = fauxProvider({ provider: providerId, models: [{ id: "agent-model" }] });
	provider.setResponses([fauxAssistantMessage(reply)]);
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: providerId, model: "agent-model" };
	return new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
}
