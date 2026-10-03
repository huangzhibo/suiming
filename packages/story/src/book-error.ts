import { type Diagnostic, SuimError } from "./errors.js";

export class BookParseError extends SuimError {
	constructor(code: string, message: string, diagnostics: readonly Diagnostic[] = []) {
		super(code, message, diagnostics);
		this.name = "BookParseError";
	}
}
