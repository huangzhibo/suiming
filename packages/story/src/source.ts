import { type Static, Type } from "typebox";
import { stringify } from "yaml";
import { checkDesign, type DesignCheckResult } from "./checker.js";
import { SuimError } from "./errors.js";
import type { CheckResult } from "./ir/index.js";
import { isLocalId } from "./local-id.js";
import { type BindBookOptions, type BookSources, type BoundBook, bindBookDocuments } from "./parse-book.js";
import { checkedBookSchema } from "./schema-check.js";
import type { ContractLifecycleEval } from "./story-contract.js";

export const SOURCE_ENCODINGS = ["utf-8", "gb18030", "gbk", "big5", "utf-16le", "utf-16be"] as const;

function literals<T extends string>(values: readonly T[]) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

export const SourceDescriptorSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		name: Type.String({ minLength: 1 }),
		encoding: Type.Optional(literals(SOURCE_ENCODINGS)),
	},
	{ additionalProperties: false },
);

export type SourceDescriptorWire = Static<typeof SourceDescriptorSchema>;
export type SourceEncoding = (typeof SOURCE_ENCODINGS)[number];

export interface SourceDescriptor {
	schemaVersion: 1;
	name: string;
	encoding?: SourceEncoding;
}

export type SourceExtractionDocuments = Omit<BookSources, "intents" | "styleIds">;

export interface SourceDocuments {
	descriptor: unknown;
	original: Uint8Array;
	material: string;
	extraction: SourceExtractionDocuments;
}

export interface BoundSource {
	sourceId: string;
	descriptor: SourceDescriptor;
	original: Uint8Array;
	material: string;
	extraction: BoundBook;
}

export interface SourceCheckResult {
	passed: boolean;
	sourceId: string;
	state: CheckResult;
	diagnostics: DesignCheckResult["diagnostics"];
	warnings: DesignCheckResult["warnings"];
	contracts: {
		checked: true;
		passed: boolean;
		openContractIds: string[];
		results: ContractLifecycleEval[];
	};
}

export function parseSourceDescriptor(input: unknown, path = "source.yaml"): SourceDescriptor {
	const wire = checkedBookSchema(SourceDescriptorSchema, input, `${path} source descriptor`, { path });
	return {
		schemaVersion: 1,
		name: wire.name,
		...(wire.encoding === undefined ? {} : { encoding: wire.encoding }),
	};
}

export function renderSourceDescriptor(descriptor: SourceDescriptor): string {
	const parsed = parseSourceDescriptor({
		schema_version: descriptor.schemaVersion,
		name: descriptor.name,
		...(descriptor.encoding === undefined ? {} : { encoding: descriptor.encoding }),
	});
	return stringify({
		schema_version: parsed.schemaVersion,
		name: parsed.name,
		...(parsed.encoding === undefined ? {} : { encoding: parsed.encoding }),
	});
}

export function bindSourceDocuments(
	sourceId: string,
	documents: SourceDocuments,
	options: BindBookOptions = {},
): BoundSource {
	if (!isLocalId(sourceId)) throw new SuimError("invalid_source", `invalid Source id: ${sourceId}`);
	if (documents.original.byteLength === 0) {
		throw new SuimError("invalid_source", `source/${sourceId}/original.bin must not be empty`);
	}
	if (documents.material.trim().length === 0) {
		throw new SuimError("invalid_source", `source/${sourceId}/material.txt must not be empty`);
	}
	const extraction = bindBookDocuments(
		{
			...documents.extraction,
			intents: [],
			styleIds: [],
		},
		{
			...options,
			enforceStyleEvidence: false,
			openEnded: true,
		},
	);
	if (extraction.story.beats.length === 0) {
		throw new SuimError("invalid_source", `Source ${sourceId} extraction must contain at least one StoryBeat`);
	}
	return {
		sourceId,
		descriptor: parseSourceDescriptor(documents.descriptor, `source/${sourceId}/source.yaml`),
		original: new Uint8Array(documents.original),
		material: documents.material,
		extraction,
	};
}

export function checkSource(source: BoundSource): SourceCheckResult {
	const checked = checkDesign(source.extraction);
	return {
		passed: checked.passed,
		sourceId: source.sourceId,
		state: checked.state,
		diagnostics: checked.diagnostics,
		warnings: checked.warnings,
		contracts: {
			checked: true,
			passed: checked.contracts.passed,
			openContractIds: checked.contracts.openContractIds,
			results: checked.contracts.results,
		},
	};
}
