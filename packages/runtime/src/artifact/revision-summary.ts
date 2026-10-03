import type { ProjectRevision } from "./types.js";

/** ProjectRevision 的对外摘要。CLI 的 revisionData 与桌面的 `revisionId` 都收敛到这一份。 */
export function revisionSummary(revision: ProjectRevision): { id: string; parentId: string | null } {
	return { id: revision.id, parentId: revision.parentId };
}

/** commit 的对外结果：建没建新版本、新 head 的摘要。CLI 与桌面共用，不各抄一份。 */
export function commitResult(result: { created: boolean; revision: ProjectRevision }) {
	return { created: result.created, revision: revisionSummary(result.revision) };
}

/** rollback 比 commit 多说三件事：恢复到哪个版本、原来的 head、这次改了哪些文件。 */
export function rollbackResult<Change>(result: {
	created: boolean;
	targetRevisionId: string;
	previousHeadRevisionId: string;
	revision: ProjectRevision;
	changes: Change[];
}) {
	return {
		created: result.created,
		targetRevisionId: result.targetRevisionId,
		previousHeadRevisionId: result.previousHeadRevisionId,
		revision: revisionSummary(result.revision),
		changes: result.changes,
	};
}
