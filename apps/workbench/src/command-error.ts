import type { DesktopCommandFailure } from "@suiming/sdk";

/**
 * 命令失败：主进程的 code 与绑定期诊断都在这里，message 照旧可以直接展示。
 * 单独成文件而不放在 bridge.ts：它不碰 window，纯数据的模块与测试可以直接引用。
 */
export class CommandError extends Error {
	readonly code: string;
	readonly diagnostics: NonNullable<DesktopCommandFailure["diagnostics"]>;
	constructor(failure: DesktopCommandFailure) {
		super(failure.message);
		this.name = "CommandError";
		this.code = failure.code;
		this.diagnostics = failure.diagnostics ?? [];
	}
}
