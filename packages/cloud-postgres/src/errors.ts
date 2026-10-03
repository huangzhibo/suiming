export class CloudPostgresError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CloudPostgresError";
		this.code = code;
	}
}
