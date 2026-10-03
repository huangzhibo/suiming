import type { Diagnostic } from "./errors.js";

export interface SchemaIssue {
	keyword: string;
	instancePath: string;
	params: Record<string, unknown>;
	message?: string;
}

function pointerValue(input: unknown, pointer: string): unknown {
	if (pointer === "") return input;
	let current = input;
	for (const encoded of pointer.split("/").slice(1)) {
		const part = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(current)) {
			const index = Number(part);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function scalar(value: unknown): unknown {
	return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
}

function joinedPointer(prefix: string, pointer: string): string | undefined {
	const joined = `${prefix}${pointer}`;
	return joined === "" ? undefined : joined;
}

export function schemaDiagnostics(
	input: unknown,
	issues: readonly SchemaIssue[],
	options: { path: string; pointerPrefix?: string },
): Diagnostic[] {
	const pointerPrefix = options.pointerPrefix ?? "";
	const diagnostics: Diagnostic[] = [];
	const grouped = new Map<string, SchemaIssue[]>();
	for (const issue of issues) {
		const entries = grouped.get(issue.instancePath) ?? [];
		entries.push(issue);
		grouped.set(issue.instancePath, entries);
	}
	const unionPaths = new Set(
		issues
			.filter((issue) => issue.keyword === "anyOf" || issue.keyword === "oneOf")
			.map((issue) => issue.instancePath),
	);
	const invalidDiscriminants = new Map<string, { constants: (string | number | boolean)[]; unionPath: string }>();
	for (const [instancePath, entries] of grouped) {
		const constants = entries
			.filter((issue) => issue.keyword === "const")
			.map((issue) => issue.params.allowedValue)
			.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value));
		if (new Set(constants).size < 2) continue;
		const unionPath = [...unionPaths]
			.filter((candidate) => instancePath.startsWith(`${candidate}/`))
			.sort((left, right) => right.length - left.length)[0];
		if (unionPath !== undefined) invalidDiscriminants.set(instancePath, { constants, unionPath });
	}
	for (const [instancePath, entries] of grouped) {
		const hiddenByInvalidDiscriminant = [...invalidDiscriminants.entries()].some(
			([discriminantPath, value]) =>
				instancePath !== discriminantPath &&
				(instancePath === value.unionPath || instancePath.startsWith(`${value.unionPath}/`)),
		);
		if (hiddenByInvalidDiscriminant) continue;
		const constants = entries
			.filter((issue) => issue.keyword === "const")
			.map((issue) => issue.params.allowedValue)
			.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value));
		const invalidDiscriminant = invalidDiscriminants.get(instancePath);
		if (
			invalidDiscriminant !== undefined ||
			(constants.length > 0 && entries.some((issue) => issue.keyword === "anyOf"))
		) {
			const pointer = joinedPointer(pointerPrefix, instancePath);
			const allowed = invalidDiscriminant?.constants ?? constants;
			diagnostics.push({
				path: options.path,
				...(pointer === undefined ? {} : { pointer }),
				message: "取值不在允许范围内",
				expected: `以下之一：${[...new Set(allowed)].map(String).join(" | ")}`,
				actual: scalar(pointerValue(input, instancePath)),
			});
			continue;
		}
		for (const issue of entries) {
			if (diagnostics.length >= 20) return diagnostics;
			if (issue.keyword === "anyOf" || issue.keyword === "oneOf") continue;
			if (issue.keyword === "additionalProperties") {
				const fields = issue.params.additionalProperties;
				for (const field of Array.isArray(fields) ? fields : []) {
					if (typeof field !== "string") continue;
					const pointer = joinedPointer(pointerPrefix, `${instancePath}/${field}`);
					diagnostics.push({
						path: options.path,
						...(pointer === undefined ? {} : { pointer }),
						message: `未知字段 ${JSON.stringify(field)}`,
						hint: "删掉这个字段，或改用 Story Language 文档列出的字段",
					});
				}
				continue;
			}
			if (issue.keyword === "required") {
				const fields = Array.isArray(issue.params.requiredProperties)
					? issue.params.requiredProperties
					: [issue.params.missingProperty];
				for (const field of fields) {
					if (typeof field !== "string") continue;
					const pointer = joinedPointer(pointerPrefix, `${instancePath}/${field}`);
					diagnostics.push({
						path: options.path,
						...(pointer === undefined ? {} : { pointer }),
						message: "缺少必填字段",
					});
				}
				continue;
			}
			const expected =
				issue.keyword === "type" && typeof issue.params.type === "string"
					? issue.params.type
					: issue.keyword === "pattern" && typeof issue.params.pattern === "string"
						? `匹配 ${issue.params.pattern} 的值`
						: undefined;
			const pointer = joinedPointer(pointerPrefix, instancePath);
			diagnostics.push({
				path: options.path,
				...(pointer === undefined ? {} : { pointer }),
				message: issue.message ?? "不符合 schema",
				...(expected === undefined ? {} : { expected }),
				actual: scalar(pointerValue(input, instancePath)),
			});
		}
	}
	return diagnostics.slice(0, 20);
}
