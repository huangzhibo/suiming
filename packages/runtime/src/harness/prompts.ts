import { STORY_CONSTITUTION } from "@suiming/story";

/**
 * 故事创作宪法进入 prompt（ADR-0008 决定 6）：Agent、Reviewer、Writer 的 system prompt 都引用同一份宪法原文，
 * 版本写在宪法标题里；system prompt 每次组装请求时用当前的，宪法改了从下一次请求起生效，不另记 promptBinding。
 */
function constitutionBody(): string {
	// 去掉一级标题，其余原文保留：宪法是长期稳定的价值与取舍，不在这里改写或摘要。
	return STORY_CONSTITUTION.markdown.replace(/^# [^\n]*\n+/u, "").trim();
}

/** 把宪法附在角色 prompt 之后；角色 prompt 说职责与工具，宪法说创作取舍。 */
export function withConstitution(systemPrompt: string): string {
	return `${systemPrompt}\n\n# 故事创作宪法（${STORY_CONSTITUTION.version}）\n\n${constitutionBody()}`;
}
