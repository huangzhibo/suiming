import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type {
	CollaborationMode,
	EditorFileHandler,
	GoalAction,
	ModelChoice,
	SessionGoal,
	WorkbenchHandler,
} from "@suiming/sdk";
import { ArtifactError } from "../artifact/errors.js";
import type { ExecutionStateEvent, SessionRecord } from "../execution/types.js";
import { agentTurn } from "../harness/agent.js";
import type { SessionEventListener } from "../harness/events.js";
import { SuimingHarness, type TurnOutcome, type UsageWindow } from "../harness/suiming-harness.js";
import type { ModelBindingSnapshot, ModelGateway } from "../model/model-gateway.js";
import type { LocalProjectService } from "./local-project-service.js";

export interface LocalSessionControllerOptions {
	editorFiles?: EditorFileHandler;
	workbench?: WorkbenchHandler;
	project: LocalProjectService;
	models: ModelGateway;
	telemetryContext?: TelemetryContext;
	now?: () => Date;
	/** 每轮用量检查点；桌面与 CLI 传读 config.toml 的函数，每个 turn 开始读一次。缺省用 Runtime 的默认值。 */
	usageCheckpoint?: () => Promise<number>;
}

interface ActiveSession {
	controller: AbortController;
	completion: Promise<void>;
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
	/** 协作模式（ADR-0038）：新 session 的初始模式，或从这一轮起换用；对正在跑的对话换模式会被拒绝。 */
	mode?: CollaborationMode;
	/** 把这句话设为对话的目标（ADR-0038）；对正在跑的对话会被拒绝。 */
	goal?: boolean;
	onEvent?: SessionEventListener;
}

/**
 * 本进程里的 session 驱动：作者说一句话就入 inbox，session 空闲就开一个 turn；turn 跑完后 inbox
 * 里还有没取走的消息就接着开，直到停下或被打断。一个 Project 同时只有一个 turn 在跑。
 */
export class LocalSessionController {
	readonly #project: LocalProjectService;
	readonly #models: ModelGateway;
	readonly #workbench: WorkbenchHandler | undefined;
	readonly #editorFiles: EditorFileHandler | undefined;
	readonly #telemetryContext: TelemetryContext | undefined;
	readonly #now: (() => Date) | undefined;
	readonly #usageCheckpoint: (() => Promise<number>) | undefined;
	readonly #active = new Map<string, ActiveSession>();

	constructor(options: LocalSessionControllerOptions) {
		this.#project = options.project;
		this.#models = options.models;
		this.#editorFiles = options.editorFiles;
		this.#workbench = options.workbench;
		this.#telemetryContext = options.telemetryContext;
		this.#now = options.now;
		this.#usageCheckpoint = options.usageCheckpoint;
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
			...(this.#editorFiles ? { editorFiles: this.#editorFiles } : {}),
			...(this.#workbench ? { workbench: this.#workbench } : {}),
			...(this.#telemetryContext === undefined ? {} : { telemetryContext: this.#telemetryContext }),
			...(this.#now === undefined ? {} : { now: this.#now }),
			...(this.#usageCheckpoint === undefined ? {} : { turnUsageCheckpointTokens: this.#usageCheckpoint }),
		});
	}

	/** 作者说一句话：入 inbox；idle 就开 turn，running 就等下一边界注入。 */
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
				...(input.mode === undefined ? {} : { collaboration: input.mode }),
			});
			sessionId = created.id;
		} else {
			const current = harness.session(sessionId);
			// 模式与模型一样只在 turn 边界换：排进正在跑的对话就会悄悄失效，所以明确拒绝（本进程和别的进程在跑都算）。
			if (
				input.mode !== undefined &&
				current.status === "running" &&
				(current.collaboration ?? "autonomous") !== input.mode
			)
				throw new ArtifactError(
					"session_running",
					"对话正在进行，换模式要从下一轮起生效：等它停下或先停止，再发这句话",
				);
			if (input.goal === true && current.status === "running")
				throw new ArtifactError("session_running", "对话正在进行：先停止当前回复，再设目标");
			// 目标停在「需要作者拍板」时，作者回的这句话就是答复：目标回到进行中，这一轮之后照常续跑。
			if (input.goal !== true && current.status === "idle" && current.goal?.status === "blocked")
				this.#writeGoal(`${input.commandId}:goal:answer`, sessionId, {
					...current.goal,
					status: "active",
					updatedAt: this.#timestamp(),
				});
		}
		if (input.goal === true) {
			const now = this.#timestamp();
			this.#writeGoal(`${input.commandId}:goal`, sessionId, {
				objective: input.text,
				status: "active",
				autoTurns: 0,
				setAt: now,
				updatedAt: now,
			});
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
				...(input.mode === undefined ? {} : { collaboration: input.mode }),
				...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
			});
		}
		return { sessionId, sequence: queued.sequence };
	}

	/**
	 * 清除、暂停或继续目标（ADR-0038）。只在对话停着时改：跑着的时候 Session 记录只归持有 turn 的进程写。
	 * resume 立刻开一轮续跑，不冒充作者说话。
	 */
	async updateGoal(input: {
		commandId: string;
		sessionId: string;
		action: GoalAction;
	}): Promise<{ sessionId: string }> {
		const harness = this.harness();
		const current = harness.session(input.sessionId);
		if (current.status === "running" || this.#active.has(input.sessionId))
			throw new ArtifactError("session_running", "对话正在进行：先停止当前回复，再改目标");
		const goal = current.goal;
		if (goal === undefined) throw new ArtifactError("goal_not_found", "这段对话没有目标");
		if (input.action === "resume") this.#requireFree(input.sessionId);
		if (input.action === "clear") this.#writeGoal(`${input.commandId}:goal`, input.sessionId, undefined);
		else {
			const { reason: _reason, ...rest } = goal;
			this.#writeGoal(`${input.commandId}:goal`, input.sessionId, {
				...(input.action === "pause" ? goal : rest),
				status: input.action === "pause" ? "paused" : "active",
				updatedAt: this.#timestamp(),
			});
		}
		if (input.action === "resume") this.#drive(harness, input.sessionId, { continueGoal: true });
		return { sessionId: input.sessionId };
	}

	#timestamp(): string {
		return (this.#now?.() ?? new Date()).toISOString();
	}

	#writeGoal(commandId: string, sessionId: string, goal: SessionGoal | undefined): void {
		this.#project
			.createExecutionState(this.#now ? { now: this.#now } : {})
			.setSessionGoal(commandId, sessionId, goal);
	}

	/**
	 * 中止当前 turn：消息列表原样，回 idle，下一句接着跑。不在本进程跑的 session 只能由持有进程停。
	 * stop 是给 turn 的原因（作者停止、应用退出、SIGINT），只用于说明。
	 */
	interrupt(sessionId: string, stop: Error = new Error("作者停止了当前回复")): SessionRecord {
		const active = this.#active.get(sessionId);
		if (active === undefined) {
			const existing = this.#project.loadExecutionEntities().sessions.find((session) => session.id === sessionId);
			if (existing === undefined) throw new ArtifactError("session_not_found", `找不到对话：${sessionId}`);
			if (existing.status !== "running") return existing;
			throw notActiveInProcess(sessionId);
		}
		if (!active.controller.signal.aborted) active.controller.abort(stop);
		const session = this.#project.loadExecutionEntities().sessions.find((item) => item.id === sessionId);
		if (session === undefined) throw new ArtifactError("session_not_found", `找不到对话：${sessionId}`);
		return session;
	}

	/** 本进程最近一次 turn 的结果；给 CLI 这类等 turn 跑完再回话的调用方。 */
	completion(sessionId: string): Promise<void> {
		return this.#active.get(sessionId)?.completion ?? Promise.resolve();
	}

	#pauseGoal(sessionId: string, session: SessionRecord): void {
		if (session.status !== "idle" || session.goal?.status !== "active") return;
		this.#writeGoal(`${sessionId}:goal:pause:${session.turn}`, sessionId, {
			...session.goal,
			status: "paused",
			updatedAt: this.#timestamp(),
		});
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
			collaboration?: CollaborationMode;
			onEvent?: SessionEventListener;
			/** 第一轮就是目标的续跑（作者 resume）。 */
			continueGoal?: boolean;
		},
	): void {
		const controller = new AbortController();
		const completion = (async () => {
			try {
				let first = true;
				// 目标续跑（ADR-0038）：作者开的那一轮与它自动续的轮次共用一个用量检查点窗口。
				let continuing = options.continueGoal === true;
				let carried: UsageWindow | undefined;
				while (!controller.signal.aborted) {
					const outcome: TurnOutcome<unknown> = await harness.turn(
						sessionId,
						{
							signal: controller.signal,
							...(first && options.model !== undefined ? { model: options.model } : {}),
							...(first && options.collaboration !== undefined ? { collaboration: options.collaboration } : {}),
							...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
							...(continuing ? { continueGoal: true } : {}),
							...(carried === undefined ? {} : { usageCarried: carried }),
						},
						(session) => agentTurn(session),
					);
					first = false;
					if (controller.signal.aborted) {
						// 作者停止（或应用退出）：目标暂停，等作者 resume，不在下一次打开时自己续跑。
						this.#pauseGoal(sessionId, outcome.session);
						return;
					}
					if (outcome.session.status !== "idle" || outcome.failure !== undefined) return;
					if (harness.pendingInbox(sessionId) > 0) {
						// 作者又说话了：下一轮由作者开，窗口重新计。
						continuing = false;
						carried = undefined;
						continue;
					}
					const goal = outcome.session.goal;
					if (goal?.status !== "active") return;
					if (continuing && madeNoProgress(outcome)) {
						this.#writeGoal(`${sessionId}:goal:no-progress:${outcome.session.turn}`, sessionId, {
							...goal,
							status: "blocked",
							reason: "自动续的一轮没有改动任何作品文件，也没有提交或更新目标，续跑停下",
							updatedAt: this.#timestamp(),
						});
						return;
					}
					continuing = true;
					carried = outcome.usageWindow;
				}
			} finally {
				// 在 completion 兑现之前摘掉：等 completion 的调用方看到的 activeSessionIds 必须已经不含它。
				this.#active.delete(sessionId);
			}
		})().then(async () => {
			// 维护不改变 turn 结果；失败与缺失要进诊断输出，不能静默吞掉。下次到点再试。
			try {
				const result = await this.#project.collectExecutionObjects();
				if (result !== undefined && result.missing.length > 0)
					process.emitWarning(`执行对象缺失或损坏，已跳过回收：${result.missing.join(", ")}`, {
						code: "execution_objects_missing",
					});
			} catch (error) {
				process.emitWarning(`执行对象回收未完成：${error instanceof Error ? error.message : String(error)}`, {
					code: "execution_object_collection_failed",
				});
			}
		});
		this.#active.set(sessionId, { controller, completion });
		void completion.catch(() => undefined);
	}
}

/** 续跑的一轮有没有做事：作品文件改了、或提交了版本。对账读不出来时当作没做，宁可停下。 */
function madeNoProgress(outcome: TurnOutcome<unknown>): boolean {
	const summary = outcome.summary;
	if (summary === undefined) return true;
	const changed = Object.values(summary.changed).reduce((sum, group) => sum + group.count, 0);
	return changed === 0 && summary.revisions === 0;
}
