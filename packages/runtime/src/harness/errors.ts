export class SuimingHarnessError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SuimingHarnessError";
		this.code = code;
	}
}
