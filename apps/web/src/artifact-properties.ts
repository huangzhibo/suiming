import type { Book, FileEntry } from "./model.js";

export interface PropertyValue {
	text: string;
	path?: string;
}
export interface PropertyRow {
	key: string;
	label: string;
	values: PropertyValue[];
	multiline?: boolean;
}

const LABELS: Record<string, string> = {
	title: "标题",
	name: "名称",
	aliases: "别名",
	"refs.character": "相关人物",
	"refs.place": "相关地点",
	"refs.resource": "相关资源",
	"refs.secret": "相关秘密",
	"refs.world": "世界设定",
	"refs.beat": "依赖情节",
	"subjects.character": "涉及人物",
	"subjects.place": "涉及地点",
	"subjects.resource": "涉及资源",
	"subjects.secret": "涉及秘密",
	"subjects.world": "涉及设定",
	"contracts.open": "建立期待",
	"contracts.advance": "推进期待",
	"contracts.resolve": "回应期待",
	deadline: "回应期限",
	applies_to: "适用内容",
	target: "适用范围",
	style_refs: "风格参考",
};

/** frontmatter 引用键的中文名；属性面板与「被引用」分组共用，界面上不出现 `refs.character` 这类原始键。 */
export const propertyLabel = (key: string) => LABELS[key] ?? key;

const BOOLEAN_STATES: Record<string, [string, string]> = {
	dead: ["已死亡", "未死亡"],
	incapacitated: ["已失去行动能力", "未失去行动能力"],
	imprisoned: ["被囚禁", "未被囚禁"],
	accessible: ["可进入", "不可进入"],
	secured: ["已确保安全", "未确保安全"],
	consumed: ["已消耗", "未消耗"],
	destroyed: ["已毁坏", "未毁坏"],
	sealed: ["已封印", "未封印"],
	installed: ["已安装", "未安装"],
};
const identityName = (value: string) => value.replace(/^(character|place|resource|secret):/u, "");
const literal = (value: unknown): string =>
	typeof value === "string" && value ? value : (JSON.stringify(value) ?? "undefined");

/** 只表达明确记录的结果，不补足缺省状态，也不把世界公开推断成人物或读者知情。 */
function stateText(keys: string[], value: unknown, file: FileEntry): string | undefined {
	const initial = keys[0] === "initial" && keys.length === 2;
	const world = keys[0] === "changes" && keys[1] === "world" && keys.length === 3;
	const reader = keys[0] === "changes" && keys[1] === "reader" && keys.length === 3;
	const character = keys[0] === "changes" && keys[1] === "character" && keys.length === 4;
	if (!initial && !world && !reader && !character) return;
	const statePath = initial ? `${file.localId}.${keys[1]}` : (keys.at(-1) ?? "");
	const split = statePath.lastIndexOf(".");
	if (split <= 0) return;
	const subject = statePath.slice(0, split);
	const property = statePath.slice(split + 1);
	const name = identityName(subject);
	// revealed 只属于 Secret，裸 id 与 secret: 前缀等价（Story Language state.md）
	if (property === "revealed" && typeof value === "boolean") {
		if (world) return `秘密「${name}」在故事世界中${value ? "已公开" : "未公开"}`;
		if (reader) return `读者${value ? "已获知" : "尚未知晓"}秘密「${name}」`;
		if (character) return `${keys[2]}${value ? "已获知" : "尚未知晓"}秘密「${name}」`;
		return;
	}
	if (!world && !initial) return;
	const booleanLabels = BOOLEAN_STATES[property];
	if (booleanLabels && typeof value === "boolean") return `${name}：${booleanLabels[value ? 0 : 1]}`;
	if (property === "location" && typeof value === "string")
		return `${name}：${value === "none" ? "未设定位置" : `位于${identityName(value)}`}`;
	if (property === "holder" && typeof value === "string")
		return `${name}：${value === "none" ? "无人持有" : `由${identityName(value)}持有`}`;
}

/** 作者视图的派生属性；未知字段保留原键和值，源文件仍是实际字段的入口。 */
export function propertyRows(book: Book, file: FileEntry): PropertyRow[] {
	const rows: PropertyRow[] = [];
	const resolve = (keys: string[], value: unknown): PropertyValue => {
		const key = keys.join(".");
		if (typeof value === "string") {
			const linkKey = keys.filter((item) => !/^\d+$/u.test(item)).join(".");
			const path = book.links.find(
				(link) => link.from === file.path && link.key === linkKey && book.byPath.get(link.to)?.localId === value,
			)?.to;
			if (path) return { text: book.title(book.byPath.get(path)), path };
			if (key === "deadline" && value === "book_end") return { text: book.bookEndLabel };
			if (key === "applies_to" && (value === "design" || value === "text"))
				return { text: value === "design" ? "设计" : "正文" };
			if (key === "target" && value === "book") return { text: "全书" };
		}
		return { text: literal(value) };
	};
	const walk = (keys: string[], value: unknown) => {
		if (keys.length === 1 && ["title", "name"].includes(keys[0] ?? "") && value === book.title(file)) return;
		const state = stateText(keys, value, file);
		if (state) {
			const group = keys[0] ?? "";
			const row = rows.find((row) => row.key === group);
			if (row) row.values.push({ text: state });
			else
				rows.push({
					key: group,
					label: group === "initial" ? "开场状态" : "本节变化",
					values: [{ text: state }],
					multiline: true,
				});
			return;
		}
		const key = keys.join(".");
		if (Array.isArray(value) && value.length && value.every((item) => item === null || typeof item !== "object")) {
			rows.push({
				key: JSON.stringify(keys),
				label: LABELS[key] ?? key,
				values: value.map((item) => resolve(keys, item)),
			});
		} else if (value && typeof value === "object" && Object.keys(value).length) {
			for (const [key, item] of Object.entries(value)) walk([...keys, key], item);
		} else rows.push({ key: JSON.stringify(keys), label: LABELS[key] ?? key, values: [resolve(keys, value)] });
	};
	for (const [key, value] of Object.entries(file.frontmatter)) walk([key], value);
	return rows;
}
