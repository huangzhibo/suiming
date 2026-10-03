export class ModelGatewayError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ModelGatewayError";
		this.code = code;
	}
}
