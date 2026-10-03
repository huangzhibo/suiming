import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { BookParseError } from "./book-error.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { formatDiagnostic } from "./errors.js";

export function checkedBookSchema<T extends TSchema>(
	schema: T,
	input: unknown,
	label: string,
	location: { path: string; pointerPrefix?: string } = { path: label },
): Static<T> {
	if (!Value.Check(schema, input)) {
		const diagnostics = schemaDiagnostics(input, [...Value.Errors(schema, input)], location);
		const details = diagnostics.map(formatDiagnostic).join("；");
		throw new BookParseError("invalid_document", `${label}：${details || "不符合 schema"}`, diagnostics);
	}
	return input as Static<T>;
}
