import { SuimError } from "./errors.js";

export function normalizeExactText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

export function extractExactIntentFragments(markdown: string, path = "Intent body"): string[] {
	const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const fragments: string[] = [];
	let opening: { character: "`" | "~"; length: number; line: number; exact: boolean } | undefined;
	let body: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (opening === undefined) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (match === null) continue;
			const fence = match[1] as string;
			opening = {
				character: fence[0] as "`" | "~",
				length: fence.length,
				line: index + 1,
				exact: (match[2] as string).trim() === "exact",
			};
			body = [];
			continue;
		}

		const closing = new RegExp(`^ {0,3}${opening.character}{${opening.length},}[ \\t]*$`);
		if (!closing.test(line)) {
			if (opening.exact) body.push(line);
			continue;
		}

		if (opening.exact) {
			const fragment = normalizeExactText(body.join("\n"));
			if (fragment.length === 0) {
				throw new SuimError("invalid_document", `${path} has an empty exact block at line ${opening.line}`);
			}
			fragments.push(fragment);
		}
		opening = undefined;
		body = [];
	}

	if (opening?.exact) {
		throw new SuimError("invalid_document", `${path} has an unclosed exact block at line ${opening.line}`);
	}

	return fragments;
}
