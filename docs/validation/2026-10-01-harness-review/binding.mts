// 第 1 轮工具描述 v1，第 2 轮升级成 v2；第 2 轮动作停在 effect_pending 时进程「退出」，第 3 轮恢复。
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { fixture } from "./fixture.mts";

const CHECKPOINT = "application/vnd.suiming.harness-checkpoint+json";
const f = await fixture();
const probe = (description: string) => ({
	name: "probe", description, replay: "reconcile" as const,
	parameters: Type.Object({}, { additionalProperties: false }),
	prepare: async () => ({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	reconcile: async () => ({ content: [{ type: "text" as const, text: "reconciled" }] }),
});
const turn = (id: string, description: string) =>
	f.harness.turn(id, {}, (session) => session.runRoot({ systemPrompt: "测试", tools: () => [probe(description)] }));
const id = (await f.harness.createSession()).id;
f.provider.setResponses([fauxAssistantMessage("第一轮")]);
f.project.queueInbox(id, "第一轮");
console.log("turn1", (await turn(id, "v1")).session.status);

let crash = true;
const save = f.project.saveExecutionObject.bind(f.project);
f.project.saveExecutionObject = async (mediaType: string, bytes: Uint8Array) => {
	if (crash && mediaType === CHECKPOINT) {
		const checkpoint = (await f.harness.checkpoints.read(bytes)) as { loop: { actions: { state: string }[] } };
		if (checkpoint.loop.actions.some((a) => a.state === "result_ready")) { crash = false; throw new Error("process exited"); }
	}
	return save(mediaType, bytes);
};
f.provider.setResponses([fauxAssistantMessage(fauxToolCall("probe", {})), fauxAssistantMessage("第二轮完成")]);
f.project.queueInbox(id, "第二轮");
const upgraded = process.argv[2] === "control" ? "v1" : "v2";
const second = await turn(id, upgraded);
console.log("turn2", second.session.status, second.failure?.code);
const third = await turn(id, upgraded);
console.log("turn3 recovery", third.session.status, third.session.pause?.code ?? third.failure?.code ?? "", third.value?.reply ?? "");
if (third.session.status === "paused") {
	const resumed = await f.harness.turn(id, { fromPaused: true }, (session) => session.runRoot({ systemPrompt: "测试", tools: () => [probe(upgraded)] }));
	console.log("resume fromPaused", resumed.session.status, resumed.session.pause?.code ?? "");
}
await f.close();
