export class SuimingHarnessError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SuimingHarnessError";
		this.code = code;
	}
}

/**
 * 作者在界面上按了停止：turn 的 AbortSignal 带着它。与应用退出、CLI 收到 SIGINT、用量检查点区分开——
 * 那几种只是停在原处、下一句续跑；作者停下正在跑的子任务多半是要改方向，子任务以「被作者停下」交回父 Agent，
 * 父 Agent 先读到作者的新话再决定续不续（Harness 设计第 4 节）。
 */
export class AuthorStop extends Error {
	constructor(message = "作者停止了当前回复") {
		super(message);
		this.name = "AuthorStop";
	}
}
