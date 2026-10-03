export class CloudStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CloudStoreError";
		this.code = code;
	}
}
