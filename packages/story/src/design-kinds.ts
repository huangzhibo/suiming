/** Target namespace 里构成 Design 的 artifact kind：story-index 与全部非正文、非 Reference 的设计文件。 */
export const TARGET_DESIGN_KINDS = [
	"intent",
	"story-index",
	"story-beat",
	"story-contract",
	"character",
	"place",
	"resource",
	"world",
] as const;
