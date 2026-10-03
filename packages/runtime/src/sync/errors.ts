export class CloudSyncError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CloudSyncError";
		this.code = code;
	}
}
