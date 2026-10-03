// 一个 turn 里连续 N 次 read，量每轮耗时随会话增长的变化，以及 receipt 数。
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { agentTurn } from "../../../packages/runtime/src/harness/agent.ts";
import { fixture } from "./fixture.mts";

const N = Number(process.argv[2] ?? 300);
const f = await fixture();
const stamps: number[] = [];
const steps = Array.from({ length: N }, () => async () => {
	stamps.push(performance.now());
	return fauxAssistantMessage(fauxToolCall("read", { path: "intent/揭开真相.md" }));
});
f.provider.setResponses([...steps, async () => { stamps.push(performance.now()); return fauxAssistantMessage("完成"); }]);
const id = (await f.harness.createSession()).id;
f.project.queueInbox(id, "反复读意图");
const t0 = performance.now();
const outcome = await f.harness.turn(id, {}, (session) => agentTurn(session));
const total = performance.now() - t0;
const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const snap = f.project.loadExecutionState();
console.log(JSON.stringify({
	N, status: outcome.session.status, failure: outcome.failure?.code,
	totalMs: Math.round(total),
	firstRoundsMs: Math.round(avg(gaps.slice(0, 20)) * 10) / 10,
	lastRoundsMs: Math.round(avg(gaps.slice(-20)) * 10) / 10,
	receipts: snap.commandReceipts.length,
}));
await f.close();
