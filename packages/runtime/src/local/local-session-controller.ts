import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { ModelChoice } from "@suiming/sdk";
import { ArtifactError } from "../artifact/errors.js";
import type { ExecutionStateEvent, SessionRecord } from "../execution/types.js";
import { agentTurn } from "../harness/agent.js";
import type { SessionEventListener } from "../harness/events.js";
import { SuimingHarness, type TurnOutcome } from "../harness/suiming-harness.js";
import type { ModelBindingSnapshot, ModelGateway } from "../model/model-gateway.js";
import type { LocalProjectService } from "./local-project-service.js";

export interface LocalSessionControllerOptions {
	project: LocalProjectService;
	models: ModelGateway;
	telemetryContext?: TelemetryContext;
	now?: () => Date;
}

interface ActiveSession {
	controller: AbortController;
	completion: Promise<void>;
}

/**
 * paused 的 session 没有在跑的 turn：interrupt 就是放弃这次核对，回 idle，消息列表保留。
 * 不需要模型，桌面与 CLI 共用——CLI 不必为了放弃一次核对去建模型网关、要凭据。不是 paused 的原样返回。
 */
export function abandonPausedSession(project: LocalProjectService, sessionId: string): SessionRecord {
	const execution = project.createExecutionState();
	const session = execution.session(sessionId);
	if (session.status !== "paused") return session;
	execution.startTurn({
		commandId: `${session.id}:interrupt:${session.version}:start`,
		sessionId: session.id,
		// hostname 留空：这不是有进程驱动的 turn，「同一作品只有一个 running」的检查不算它。
		lease: { pid: process.pid, hostname: "", acquiredAt: new Date().toISOString() },
		turnId: `${session.id}:interrupt:${session.version}`,
		fromPaused: true,
	});
	return execution.endTurn({
		commandId: `${session.id}:interrupt:${session.version}:end`,
		sessionId: session.id,
		status: "idle",
	});
}

/** 在另一个进程里跑的 turn 只能由那个进程停：本进程没有它的中止信号，也不能去改它持有的状态。 */
export function notActiveInProcess(sessionId: string): ArtifactError {
	return new ArtifactError(
		"session_not_active_in_process",
		`session ${sessionId} 的 turn 在另一个进程里跑（桌面或另一个 suim），只能在那边停：桌面点停止，或在那个 suim 里按 Ctrl+C`,
	);
}

/** 收口结果：idle 表示本进程已无活动 turn，timeout 表示请求已发出但当前动作还没结束。 */
export type IdleOutcome = "idle" | "timeout";

/**
 * 收口等待的兜底上限。它是「不把调用方挂死」的保证，不是 UX 期限——作者在等的路径
 * （`session.interrupt`）自己传更短的值。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface SendInput {
	commandId: string;
	text: string;
	/** 缺省新建 session。 */
	sessionId?: string;
	/** 新 session 的模型，或在 turn 边界换绑。 */
	model?: ModelChoice;
	binding?: ModelBindingSnapshot;
	onEvent?: SessionEventListener;
}

export interface ResumeInput {
	commandId: string;
	sessionId: string;
	retryUnknownModelCall?: boolean;
	binding?: ModelBindingSnapshot;
	onEvent?: SessionEventListener;
}

/**
 * 本进程里的 session 驱动：作者说一句话就入 inbox，session 空闲就开一个 turn；turn 跑完后 inbox
 * 里还有没取走的消息就接着开，直到停下或被打断。一个 Project 同时只有一个 turn 在跑。
 */
export class LocalSessionController {
	readonly #project: LocalProjectService;
	readonly #models: ModelGateway;
	readonly #telemetryContext: TelemetryContext | undefined;
	readonly #now: (() => Date) | undefined;
	readonly #active = new Map<string, ActiveSession>();

	constructor(options: LocalSessionControllerOptions) {
		this.#project = options.project;
		this.#models = options.models;
		this.#telemetryContext = options.telemetryContext;
		this.#now = options.now;
	}

	subscribe(listener: (event: ExecutionStateEvent) => void): () => void {
		return this.#project.subscribeExecutionState(listener);
	}

	isBusy(): boolean {
		return this.#active.size > 0;
	}

	activeSessionIds(): string[] {
		return [...this.#active.keys()].sort();
	}

	/**
	 * 有界收口。调用方必须能在已知时间内拿回控制权：外部请求可能不响应 abort，无界等待会把
	 * `session.interrupt` 这类命令挂死。超时不清理任何状态——session 留在 running，由下一次操作或
	 * 重开进程按 lease 收敛，调用方据返回值决定怎么如实告诉作者。
	 */
	async waitForIdle(options: { timeoutMs?: number } = {}): Promise<IdleOutcome> {
		const pending = [...this.#active.values()].map((session) => session.completion);
		if (pending.length === 0) return "idle";
		const settled = Promise.allSettled(pending).then((): IdleOutcome => "idle");
		const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<IdleOutcome>((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([settled, timedOut]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	harness(): SuimingHarness {
		return new SuimingHarness({
			project: this.#project,
			models: this.#models,
			...(this.#telemetryContext === undefined ? {} : { telemetryContext: this.#telemetryContext }),
			...(this.#now === undefined ? {} : { now: this.#now }),
		});
	}

	/** 作者说一句话：入 inbox；idle 就开 turn，running 就等下一边界注入，paused 由 inbox 拒绝。 */
	async send(input: SendInput): Promise<{ sessionId: string; sequence: number }> {
		const harness = this.harness();
		let sessionId = input.sessionId;
		if (sessionId === undefined) {
			// 新 session 一定要开 turn；先确认本进程没在跑别的，免得留下一个没人驱动的空 session。
			// 重发的命令对应已有 session，走下面的回执路径。
			if (!harness.hasSession(harness.sessionIdForCommand(input.commandId))) this.#requireFree("");
			const created = await harness.createSession({
				commandId: input.commandId,
				...(input.model === undefined ? {} : { model: input.model }),
				...(input.binding === undefined ? {} : { binding: input.binding }),
			});
			sessionId = created.id;
		}
		const queued = this.#project.queueInbox(sessionId, input.text, `${input.commandId}:send`, {
			model: input.model ?? null,
		});
		const record = harness.session(sessionId);
		// 重发的命令只拿回原回执：消息早已进消息列表，不再开一个什么都不做的 turn。
		if (record.status === "idle" && !this.#active.has(sessionId) && harness.pendingInbox(sessionId) > 0) {
			this.#requireFree(sessionId);
			this.#drive(harness, sessionId, {
				...(input.binding === undefined ? {} : { model: input.binding }),
				...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
			});
		}
		return { sessionId, sequence: queued.sequence };
	}

	/** 从 paused 继续；作者已核对原因。 */
	async resume(input: ResumeInput): Promise<{ sessionId: string }> {
		const harness = this.harness();
		const record = harness.session(input.sessionId);
		if (record.status !== "paused")
			throw new ArtifactError("session_not_paused", `session ${input.sessionId} 是 ${record.status}，不需要 resume`);
		this.#requireFree(input.sessionId);
		this.#drive(harness, input.sessionId, {
			fromPaused: true,
			retryUnknownModelCall: input.retryUnknownModelCall ?? false,
			...(input.binding === undefined ? {} : { model: input.binding }),
			...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
		});
		return { sessionId: input.sessionId };
	}

	/** 中止当前 turn：消息列表原样，回 idle。不在本进程跑的 session 只能由持有进程停。 */
	interrupt(sessionId: string, reason = "作者停止了当前回复"): SessionRecord {
		const active = this.#active.get(sessionId);
		if (active === undefined) {
			const existing = this.#project.loadExecutionEntities().sessions.find((session) => session.id === sessionId);
			if (existing === undefined) throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
			if (existing.status !== "running") return existing;
			throw notActiveInProcess(sessionId);
		}
		if (!active.controller.signal.aborted) active.controller.abort(new Error(reason));
		const session = this.#project.loadExecutionEntities().sessions.find((item) => item.id === sessionId);
		if (session === undefined) throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
		return session;
	}

	/** 本进程最近一次 turn 的结果；给 CLI 这类等 turn 跑完再回话的调用方。 */
	completion(sessionId: string): Promise<void> {
		return this.#active.get(sessionId)?.completion ?? Promise.resolve();
	}

	#requireFree(sessionId: string): void {
		const other = this.activeSessionIds().find((id) => id !== sessionId);
		if (other !== undefined)
			throw new ArtifactError("session_running", `本进程正在跑 session ${other}；一个作品同时只跑一个 turn`);
	}

	#drive(
		harness: SuimingHarness,
		sessionId: string,
		options: {
			model?: ModelBindingSnapshot;
			onEvent?: SessionEventListener;
			fromPaused?: boolean;
			retryUnknownModelCall?: boolean;
		},
	): void {
		const controller = new AbortController();
		const completion = (async () => {
			try {
				let first = true;
				while (!controller.signal.aborted) {
					const outcome: TurnOutcome<unknown> = await harness.turn(
						sessionId,
						{
							signal: controller.signal,
							...(first ? options : {}),
							...(first && options.fromPaused ? { fromPaused: true } : {}),
							...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
						},
						(session) => agentTurn(session),
					);
					first = false;
					if (outcome.session.status !== "idle" || outcome.failure !== undefined) return;
					if (harness.pendingInbox(sessionId) === 0) return;
				}
			} finally {
				// 在 completion 兑现之前摘掉：等 completion 的调用方看到的 activeSessionIds 必须已经不含它。
				this.#active.delete(sessionId);
			}
		})();
		this.#active.set(sessionId, { controller, completion });
		void completion.catch(() => undefined);
	}
}
