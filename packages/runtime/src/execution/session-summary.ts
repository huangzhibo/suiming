import type { ModelChoice } from "@suiming/sdk";
import type { ModelProfileId } from "../model/config.js";
import type {
	ExecutionEntities,
	ExecutionFailure,
	ExecutionResultReference,
	ModelUsage,
	SessionRecord,
} from "./types.js";

/** Session 的对外摘要。CLI 与桌面 IPC 共用这一份，不各自投影。 */
export interface SessionSummary {
	id: string;
	/** 面向作者的标题：inbox 的第一条消息。不是记录字段，由调用方从收件箱取。 */
	title: string;
	kind: SessionRecord["kind"];
	status: SessionRecord["status"];
	turn: number;
	turnId?: string;
	usage?: ModelUsage;
	model?: ModelChoice;
	pause?: NonNullable<SessionRecord["pause"]>;
	lastFailure?: NonNullable<SessionRecord["lastFailure"]>;
	result?: NonNullable<SessionRecord["result"]>;
	createdAt: string;
	updatedAt: string;
}

function choiceOf(session: SessionRecord): ModelChoice | undefined {
	const binding = session.model;
	if (!binding) return undefined;
	return {
		provider: binding.provider,
		model: binding.model,
		...(binding.thinking === undefined ? {} : { thinking: binding.thinking }),
	};
}

export function sessionSummary(session: SessionRecord, title = ""): SessionSummary {
	const model = choiceOf(session);
	return {
		id: session.id,
		title,
		kind: session.kind,
		status: session.status,
		turn: session.turn,
		...(session.turnId === undefined ? {} : { turnId: session.turnId }),
		...(session.usage === undefined ? {} : { usage: session.usage }),
		...(model === undefined ? {} : { model }),
		...(session.pause === undefined ? {} : { pause: session.pause }),
		...(session.lastFailure === undefined ? {} : { lastFailure: session.lastFailure }),
		...(session.result === undefined ? {} : { result: session.result }),
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
	};
}

/** 列表顺序按创建时间，同刻再按更新时间。 */
export function sessionSummaries(
	execution: ExecutionEntities,
	title: (sessionId: string) => string = () => "",
): SessionSummary[] {
	return [...execution.sessions]
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt))
		.map((session) => sessionSummary(session, title(session.id)));
}

/** 子任务的对外摘要。桌面 IPC 的 `session.tasks` 与 CLI 的 `session show` 共用这一份。 */
export interface TaskSummary {
	id: string;
	kind: string;
	key: string;
	title?: string;
	status: string;
	parentTaskId?: string;
	model?: {
		profileId: ModelProfileId;
		provider: string;
		model: string;
		routingVersion: string;
		credentialType: string;
	};
	result?: ExecutionResultReference;
	failure?: ExecutionFailure;
}

/** 一个 session 的子任务，按创建时间排序。 */
export function taskSummaries(execution: ExecutionEntities, sessionId: string): TaskSummary[] {
	return execution.tasks
		.filter((task) => task.sessionId === sessionId)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map((task) => ({
			id: task.id,
			kind: task.kind,
			key: task.key,
			...(task.title === undefined ? {} : { title: task.title }),
			status: task.status,
			...(task.parent?.taskId === undefined ? {} : { parentTaskId: task.parent.taskId }),
			...(task.model === undefined
				? {}
				: {
						model: {
							profileId: task.model.modelProfileId,
							provider: task.model.provider,
							model: task.model.model,
							routingVersion: task.model.routingVersion,
							credentialType: task.model.credentialType,
						},
					}),
			...(task.result === undefined ? {} : { result: { kind: task.result.kind, id: task.result.id } }),
			...(task.failure === undefined
				? {}
				: {
						failure: {
							code: task.failure.code,
							message: task.failure.message,
							retryable: task.failure.retryable,
						},
					}),
		}));
}
