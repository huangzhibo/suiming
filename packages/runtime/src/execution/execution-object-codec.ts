const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function executionJsonBytes(value: unknown): Uint8Array {
	return encoder.encode(
		`${JSON.stringify(
			value,
			(_key, item) =>
				item instanceof Uint8Array ? { encoding: "base64", bytes: Buffer.from(item).toString("base64") } : item,
			2,
		)}\n`,
	);
}

export function parseExecutionJson(bytes: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(decoder.decode(bytes));
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}
