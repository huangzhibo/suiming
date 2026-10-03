/** 与 Open Story Directory 扫描结果同形状的一个文件。 */
export interface SampleWorkFile {
	path: string;
	mediaType: string;
	bytes: Uint8Array;
}

/**
 * 测试用最小作品：2 个 StoryBeat、1 个 Contract、1 个人物与它的世界依赖，足以走通 Checker、
 * Design 冻结与 Write 的全部确定性检查。内容内联在这里而不是仓库根的 fixture 目录，
 * 因为它是测试数据不是产品内容：它不进入任何产品包的导出面，与 packages/story/test/fixture.ts 一样是 test 目录里的普通 helper。
 */
const SAMPLE_WORK_TEXT: Readonly<Record<string, string>> = {
	"intent/揭开真相.md": `---
style_refs: [style_contemporary_restraint]
---
主角不能靠巧合取胜，真相必须由主动选择揭示，并在当场产生不可恢复的个人代价。
`,
	"outline/contracts/真相的代价.md": `---
subjects:
  character: [李牧]
  resource: [密信]
deadline: beat-0002
---
公开真相必须让李牧不可逆地失去唯一密信与由它带来的谈判优势。
`,
	"outline/story/index.yaml": `schema_version: 2
volumes:
  - id: vol-0001
    title: 入局
    beat_ids: [beat-0001, beat-0002]
`,
	"outline/story/vol-0001/beat-0001.md": `---
refs:
  character: [李牧]
  place: [皇档]
  resource: [密信]
contracts:
  open: [真相的代价]
changes:
  world:
    李牧.location: 皇档
---
李牧进入皇档，取得能证明旧案的唯一密信。他知道公开它会让自己失去最后的谈判筹码。
`,
	"outline/story/vol-0001/beat-0002.md": `---
refs:
  character: [李牧]
  resource: [密信]
  beat: [beat-0001]
contracts:
  resolve: [真相的代价]
changes:
  world:
    密信.consumed: true
---
李牧在众人面前公开真相，并亲手焚毁密信，以失去筹码换取证词不再被任何一方垄断。
`,
	"reference/style/style_contemporary_restraint.md": `短句，少解释；先让人物行动，再让读者看见代价。
`,
	"world/characters/李牧.md": `---
name: 李牧
---
李牧相信真相必须由证据和承担代价的选择共同成立。他习惯先保留筹码，因此公开密信既符合信念，也违背自我保护本能。
`,
	"world/places/皇档.md": `收藏旧朝档案的封闭库房，出入记录受到多方共同监督。
`,
	"world/resources/密信.md": `---
initial:
  holder: 李牧
---
唯一能证明旧案、也能作为谈判筹码的原始密信。
`,
};

const encoder = new TextEncoder();

/** 样例作品的逻辑路径列表，顺序与 `sampleWorkFiles()` 一致。 */
export function sampleWorkPaths(): string[] {
	return Object.keys(SAMPLE_WORK_TEXT);
}

/** 单个样例文件的原文；路径不存在时抛错，避免测试静默依赖空内容。 */
export function sampleWorkText(path: string): string {
	const text = SAMPLE_WORK_TEXT[path];
	if (text === undefined) throw new Error(`Sample work has no file at ${path}`);
	return text;
}

/** 与 `readOpenStoryDirectory(...).files` 同形状的样例作品快照。 */
export function sampleWorkFiles(): SampleWorkFile[] {
	return Object.entries(SAMPLE_WORK_TEXT).map(([path, text]) => ({
		path,
		mediaType: path.endsWith(".yaml") ? "application/yaml; charset=utf-8" : "text/markdown; charset=utf-8",
		bytes: encoder.encode(text),
	}));
}
