import type { TSchema } from "typebox";
import { STORY_BEAT_ID_PATTERN, VOLUME_ID_PATTERN } from "./book-patterns.js";
import {
	CharacterHeaderSchema,
	CreativeIntentSchema,
	IDENTITY_ID_PATTERN,
	IdentityHeaderSchema,
	LOCAL_ID_PATTERN,
	STORY_POINT_PATTERN,
	StoryBeatHeaderSchema,
	StoryContractHeaderSchema,
	StoryIndexYamlSchema,
} from "./book-schema.js";
import {
	BOOLEAN_STATE_PROPERTIES,
	PROFILE_VERSION,
	PROPERTY_SUBJECT_KINDS,
	PROPERTY_VALUE_KINDS,
	REFERENCE_KINDS,
	SCOPED_STATE_PROPERTIES,
	STATE_PROPERTIES,
	TERMINAL_RESOURCE_PROPERTIES,
} from "./ir/profile.js";
import { STORY_LANGUAGE_DOCS } from "./story-language-docs.js";

interface SchemaNode {
	type?: string;
	const?: unknown;
	anyOf?: readonly SchemaNode[];
	items?: SchemaNode;
	properties?: Readonly<Record<string, SchemaNode>>;
	patternProperties?: Readonly<Record<string, SchemaNode>>;
	required?: readonly string[];
	pattern?: string;
	minLength?: number;
}

function nodeOf(schema: TSchema): SchemaNode {
	return schema as unknown as SchemaNode;
}

function patternLabel(pattern: string | undefined): string {
	if (pattern === VOLUME_ID_PATTERN) return "vol-id";
	if (pattern === STORY_BEAT_ID_PATTERN) return "beat-id";
	if (pattern === LOCAL_ID_PATTERN) return "local-id";
	if (pattern === IDENTITY_ID_PATTERN) return "identity-id";
	if (pattern === STORY_POINT_PATTERN) return "book_end | beat-id";
	return "string";
}

function inlineObjectLabel(schema: SchemaNode): string {
	const required = new Set(schema.required ?? []);
	const fields = Object.entries(schema.properties ?? {}).map(
		([name, property]) => `${name}: ${inlineLabel(property)}${required.has(name) ? "" : "?"}`,
	);
	return `{ ${fields.join(", ")} }`;
}

function inlineLabel(schema: SchemaNode): string {
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.anyOf !== undefined) {
		const choices = schema.anyOf.map(inlineLabel).map((choice) => choice.replace(/^<|>$/gu, ""));
		return `<${choices.join(" | ")}>`;
	}
	if (schema.type === "object") return inlineObjectLabel(schema);
	if (schema.type === "string") {
		if (schema.pattern !== undefined) return `<${patternLabel(schema.pattern)}>`;
		return schema.minLength === undefined ? "<string>" : "<non-empty string>";
	}
	if (schema.type === "boolean") return "<boolean>";
	if (schema.type === "number" || schema.type === "integer") return "<number>";
	return `<${schema.type ?? "value"}>`;
}

function dynamicKey(pattern: string): string {
	if (pattern === LOCAL_ID_PATTERN) return "<local-id>";
	if (pattern === IDENTITY_ID_PATTERN) return "<identity-id>";
	if (pattern === "^.*$") return "<state-property>";
	return "<key>";
}

function propertyLines(name: string, schema: SchemaNode, depth: number, required: boolean): string[] {
	const indentation = "  ".repeat(depth);
	const optional = required ? "" : " # optional";
	if (schema.type === "object") {
		return [`${indentation}${name}:${optional}`, ...objectLines(schema, depth + 1)];
	}
	if (schema.type === "array") {
		const item = schema.items;
		if (item?.type === "object") {
			return [`${indentation}${name}:${optional}`, `${"  ".repeat(depth + 1)}-`, ...objectLines(item, depth + 2)];
		}
		return [`${indentation}${name}: [${inlineLabel(item ?? {})}, ...]${optional}`];
	}
	return [`${indentation}${name}: ${inlineLabel(schema)}${optional}`];
}

function objectLines(schema: SchemaNode, depth: number): string[] {
	const required = new Set(schema.required ?? []);
	const properties = Object.entries(schema.properties ?? {}).flatMap(([name, property]) =>
		propertyLines(name, property, depth, required.has(name)),
	);
	const records = Object.entries(schema.patternProperties ?? {}).flatMap(([pattern, value]) =>
		propertyLines(dynamicKey(pattern), value, depth, true),
	);
	return [...properties, ...records];
}

function yamlShape(schema: TSchema): string {
	return objectLines(nodeOf(schema), 0)
		.map((line) => `    ${line}`)
		.join("\n");
}

function schemaSection(path: string, schema: TSchema): string {
	return `## ${path}\n\n${yamlShape(schema)}`;
}

/**
 * 命名两条写进说明：2026-10-02 斗破抽取里 GPT-6.1 Sol 把 Contract 等 id 全起成英文（故事轴的期待泳道露出 cave-treasure），
 * Beat 标题带「（原作1—4章）」；Story Language 原本只说 id「可以」用中文。
 */
const GUIDE_PREAMBLE =
	"以下 frontmatter 结构直接由 @suiming/story 当前 TypeBox schema 生成；尖括号表示占位符，不要原样写入。Markdown artifact 在 frontmatter 后还必须有非空正文。中文作品的人物、地点、物品、World 与 Contract 的本地 id 用中文——作者在文件和界面上看到的就是它；字段名、kind、状态属性与 vol-* / beat-* 结构 id 保持英文。title 只写标题，不带章节范围、编号或括注。";

/** `open_ended` 的形状由 schema 给出，谁有权写、写了意味着什么必须同屏说清：它不是让检查通过的开关。 */
const OPEN_ENDED_NOTE =
	"`open_ended: true` 是作者声明全书未完待续（连载、结局未定）：最后一个 Beat 不是结局，`deadline: book_end` 的 Contract 已建立未回应时算进行中；写明 Beat 期限的 Contract 照样要按期回应，从未建立的照样报错。只有作者说过全书未完待续才写，不能为了让检查通过自己加；全书写完删掉这一行。";

function designSections(root: string): string[] {
	const prefix = root === "" ? "" : `${root}/`;
	return [
		root === ""
			? `${schemaSection("outline/story/index.yaml", StoryIndexYamlSchema)}\n\n${OPEN_ENDED_NOTE}`
			: schemaSection(`${prefix}outline/story/index.yaml`, StoryIndexYamlSchema),
		schemaSection(`${prefix}outline/story/<vol-id>/<beat-id>.md frontmatter`, StoryBeatHeaderSchema),
		schemaSection(`${prefix}world/characters/<character-id>.md frontmatter`, CharacterHeaderSchema),
		schemaSection(
			`${prefix}world/places/<place-id>.md 和 ${prefix}world/resources/<resource-id>.md frontmatter`,
			IdentityHeaderSchema,
		),
		schemaSection(`${prefix}outline/contracts/<contract-id>.md frontmatter`, StoryContractHeaderSchema),
		`## ${prefix}world/core.md 和 ${prefix}world/<world-id>.md\n\n无 frontmatter 字段要求，写非空 Markdown。`,
	];
}

/**
 * 硬状态 profile 的机器边界：哪个属性能挂在哪类主体上、值是什么、哪些是终止态。
 * 常量来自 ir/profile.ts，语义（何时该写、不写代表什么）在 story-language/state.md。
 */
function stateProfileSection(): string {
	const rows = STATE_PROPERTIES.map((property) => {
		const valueKind = PROPERTY_VALUE_KINDS[property];
		const value = valueKind === undefined ? "boolean" : `${valueKind} 的 id 或 none`;
		const notes: string[] = [];
		if ((TERMINAL_RESOURCE_PROPERTIES as readonly string[]).includes(property)) notes.push("终止态");
		return `    ${property}: 主体 ${PROPERTY_SUBJECT_KINDS[property].join(" | ")}；值 ${value}${notes.length === 0 ? "" : `；${notes.join("，")}`}`;
	});
	return [
		`## 硬状态属性（profile ${PROFILE_VERSION}）`,
		`\`<state-property>\` 只能是下列之一，主体种类 ${REFERENCE_KINDS.join(" | ")}；不在表里的属性会被 check 拒绝。changes 里的键写成 \`<主体id>.<属性>\`（如 \`火船.holder: 黄盖\`，本地 id 撞名时写 \`resource:火船.holder\`）；initial 里主体就是这个文件，键只写属性（如 \`location: 萧家\`）。布尔属性（${BOOLEAN_STATE_PROPERTIES.join("、")}）只在成立时写 true，不用 false 填默认值。`,
		rows.join("\n"),
		`\`reader\` 与 \`character\` 作用域只能写 ${SCOPED_STATE_PROPERTIES.join("、")}（谁知道了哪个秘密）；位置、持有、生死这类客观状态写在 \`world\`。修为、伤势、心境、关系这类不在表里的状态写在 Beat 正文的自然语言里，不进 changes 或 initial。`,
	].join("\n\n");
}

/**
 * Target Story Language 的紧凑机器结构：host 与 Agent 写 Design 前查字段形状用。
 * 字段直接遍历当前 TypeBox schema 与硬状态 profile；语义说明属于 story-language 文档，使用策略属于上层 capability entry。
 */
export function renderTargetStoryLanguageSchemaGuide(): string {
	return [
		"# Target Story Language machine shape",
		GUIDE_PREAMBLE,
		schemaSection("intent/<intent-id>.md frontmatter（全部可省略，正文是自然语言意图）", CreativeIntentSchema),
		...designSections(""),
		stateProfileSection(),
		"## source/<source-id>/\n\nSource 抽取用同样的 outline/** 与 world/** 形状写在 source/<source-id>/ 下，没有 intent。",
	].join("\n\n");
}

/**
 * Source Story Language 的紧凑机器结构。字段直接遍历当前 TypeBox schema；
 * 语义说明属于 story-language 文档，使用策略属于上层 capability entry。
 */
export function renderSourceStoryLanguageSchemaGuide(sourceId: string): string {
	// 硬状态段 2026-10-02 前只给 Target：抽取时查的是这一份，两个模型都把修为、位置写成自由文字塞进 changes.character。
	return [
		"# Source Story Language machine shape",
		GUIDE_PREAMBLE,
		...designSections(`source/${sourceId}`),
		stateProfileSection(),
	].join("\n\n");
}

/** 按主题取 Story Language 语义原文（文件名去掉 .md 的小写，README 是 readme）；没有这个主题返回 undefined。 */
export function storyLanguageTopic(topic: string): string | undefined {
	return STORY_LANGUAGE_DOCS.find((doc) => doc.topic === topic)?.text;
}
