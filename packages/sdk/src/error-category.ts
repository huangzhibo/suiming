/**
 * 错误类别（ADR-0009 决定 17 / 26）：CLI exit code、Domain API 状态码与桌面端 IPC 的错误呈现都从这里派生，
 * 不再各自维护错误码清单。类别由错误码的命名约定决定，新增错误码只要遵守约定就自动落到正确类别：
 *
 * - `*_not_found` / `*_not_initialized` / `*_not_linked`：not_found
 * - `*_conflict` / `*_locked` / `*_lock_lost` / `*_already_*` / `*_stale` / `*_mismatch` / `*_busy` / `session_not_*` /
 *   `cloud_sync_*` / `*dirty_checkout`：conflict
 * - 凭据、认证、配置、endpoint、transport、migration、`domain_api_*`、模型调用失败：configuration
 * - `invalid_*` / `duplicate_*` / `unsupported_*` / `unexpected_*` / `unsafe_*` / `orphan_*` / `missing_*` /
 *   `*_check_failed` / `*_not_extracted` / `*_incomplete` / `*_cycle` / `*_missing`：validation
 * - `*_corrupt` / `*_integrity_error` / `*_store_error`：internal
 *
 * 少数不符合约定的历史错误码写在 OVERRIDES 里；宁可在这里显式列出，也不让它们默认落到 internal。
 */
export type SuimErrorCategory =
	| "usage"
	| "validation"
	| "conflict"
	| "configuration"
	| "not_found"
	| "interrupted"
	| "internal";

const OVERRIDES: Readonly<Record<string, SuimErrorCategory>> = {
	session_running: "conflict",
	session_paused: "conflict",
	command_required: "usage",
	invalid_cli_usage: "usage",
	run_interrupted: "interrupted",
	run_no_progress: "interrupted",
	turn_usage_checkpoint: "interrupted",
	model_call_unknown: "interrupted",
	action_effect_unknown: "interrupted",
	binding_mismatch: "interrupted",
	session_owner_lost: "conflict",
	dirty_checkout: "conflict",
	review_quote_not_found: "validation",
	review_anchor_not_found: "validation",
	review_scope_unknown_beat: "validation",
	review_exists: "conflict",
	story_directory_not_empty: "conflict",
	cloud_last_owner: "conflict",
	cloud_no_changes: "conflict",
	model_call_failed: "configuration",
	model_provider_disabled: "configuration",
	model_output_truncated: "configuration",
	context_overflow: "configuration",
	revision_project_mismatch: "not_found",
	artifact_not_in_candidate: "not_found",
	path_identity_mismatch: "validation",
	model_config_not_found: "configuration",
	cloud_config_not_found: "configuration",
	cloud_access_denied: "configuration",
	cloud_authentication_failed: "configuration",
	permission_denied: "configuration",
	local_project_closed: "internal",
	invalid_cli_response: "internal",
	unknown: "internal",
};

const RULES: readonly [RegExp, SuimErrorCategory][] = [
	[/(_not_found|_not_initialized|_not_linked)$/u, "not_found"],
	[
		/(^|_)conflict(_|$)|_locked$|_lock_lost$|_already_|_stale$|_mismatch$|_busy$|^session_not_|^cloud_sync_|dirty_checkout$/u,
		"conflict",
	],
	[
		/credential|authenticat|_config(_|$)|_endpoint|transport|_migration(_|$)|^domain_api_|_requires_|_forbidden$|^cloud_actor_/u,
		"configuration",
	],
	[/_corrupt$|_integrity_error$|_store_error$/u, "internal"],
	[
		/^(invalid|duplicate|unsupported|unexpected|unsafe|orphan|empty|no|missing)_|_invalid$|_check_failed$|_not_extracted$|_not_current$|_incomplete$|_cycle$|_missing$|_too_large$/u,
		"validation",
	],
];

export function errorCategory(code: string): SuimErrorCategory {
	const override = OVERRIDES[code];
	if (override !== undefined) return override;
	for (const [pattern, category] of RULES) if (pattern.test(code)) return category;
	return "internal";
}

/**
 * 原样再来一次就可能成功的错误：作品被另一进程短暂占用、模型调用失败（网络、限流、provider 5xx）。
 * 其余要先改输入、凭据或作品。子任务失败记录与 CLI 的 JSON 信封共用；错误对象自己带 `retryable` 的照它。
 */
export function retryableErrorCode(code: string): boolean {
	return code === "project_locked" || code === "model_call_failed";
}
