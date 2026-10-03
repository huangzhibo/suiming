export class ExecutionStateError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ExecutionStateError";
		this.code = code;
	}
}
