/** 公共样例隔离副本：真实模型在读后遇到作者保存，拒绝旧 write，再重读继续。 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	ConfinedExecutionEnv,
	JsonFileCredentialStore,
	loadModelRoutingConfig,
	ModelGateway,
	SuimingHarness,
	useEnvironmentProxy,
} from "@suiming/runtime";
import { agentTurn } from "../../../packages/runtime/dist/harness/agent.js";
import { withSampleProject } from "../../../packages/runtime/test/harness-fixtures.js";

useEnvironmentProxy();
const gateway = new ModelGateway(
	builtinModels({ credentials: new JsonFileCredentialStore() }),
	(await loadModelRoutingConfig()).config,
);
await withSampleProject(async (project, root) => {
	const path = "intent/计谋的代价.md";
	const author = "作者补充：不可牺牲无辜者。";
	const addition = "创作补充：揭示真相必须承担代价。";
	const originalRead = ConfinedExecutionEnv.prototype.readBinaryFile;
	let injected = false;
	let reads = 0;
	ConfinedExecutionEnv.prototype.readBinaryFile = async function (file, signal) {
		const content = await originalRead.call(this, file, signal);
		if (resolve(this.rootPath, file) === join(project.paths.checkoutPath, path)) {
			reads++;
			if (!injected) {
				injected = true;
				// 工具仍返回刚读到的旧内容，作者的新保存已经在磁盘上。
				await writeFile(join(root, path), `${new TextDecoder().decode(content)}\n${author}\n`);
			}
		}
		return content;
	};
	try {
		const harness = new SuimingHarness({ project, models: gateway });
		const session = await harness.createSession();
		const run = async (message: string) => {
			project.queueInbox(session.id, message);
			const outcome = await harness.turn(session.id, {}, (handle) => agentTurn(handle));
			assert.equal(outcome.failure, undefined);
			return outcome;
		};
		const first = await run(`隔离文件工具验收，不创作其他内容、不委派、不提交。请先 read ${path}，再用 write 完整写回，在原文后追加一句“${addition}”。保留原有全部句子和 frontmatter，此次特意验证整篇 write，不用 edit 或 copy。`);
		const after = await readFile(join(root, path), "utf8");
		console.log(JSON.stringify({ injected, reads }));
		assert.ok(injected && reads >= 2, "拒绝迟到结果之后必须重读");
		assert.ok(after.includes(author) && after.includes(addition), "作者与模型内容都保留");
		const checkpoint = first.session.checkpointRef ?? assert.fail("missing checkpoint");
		const saved = await harness.checkpoints.read((await project.readExecutionObject(checkpoint.id)).bytes);
		assert.match(JSON.stringify(saved.loop.actions), /file_write_conflict/, "真实模型确实遇到写冲突");
		const readsBefore = reads;
		await run(`继续在同一文件末尾追加“续轮补充：代价必须在场景中体现。”，仍用 write，保留已有全部内容，不提交。`);
		const content = await readFile(join(root, path), "utf8");
		assert.ok(reads > readsBefore, "下一轮不能凭旧消息授权覆盖");
		assert.ok(content.includes(author) && content.includes(addition) && content.includes("续轮补充：代价必须在场景中体现。"));
		console.log("两轮文本冲突恢复通过");
		await writeFile(join(root, "附件.bin"), new Uint8Array([255, 254, 0, 1]));
		await writeFile(join(root, "附件副本.bin"), new Uint8Array([255, 0, 2]));
		const final = await run("接着验证仓库辅助附件：先 read 附件.bin 与 附件副本.bin，确认当前版本；用 copy 将附件.bin 原样覆盖到附件副本.bin，再 delete 附件.bin。不要转录或改写二进制内容，不改其他文件，不提交。");
		assert.deepEqual(await readFile(join(root, "附件副本.bin")), Buffer.from([255, 254, 0, 1]));
		await assert.rejects(readFile(join(root, "附件.bin")), { code: "ENOENT" });
		assert.equal((await project.history()).length, 1, "未自行提交 Canon");
		console.log(JSON.stringify({ passed: true, sessionId: session.id, turns: final.session.turn, reads, usage: final.session.usage }, null, 2));
	} finally {
		ConfinedExecutionEnv.prototype.readBinaryFile = originalRead;
	}
});
