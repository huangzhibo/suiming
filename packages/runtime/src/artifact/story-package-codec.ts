import { ArtifactError } from "./errors.js";
import {
	artifactIdentityKey,
	formatArtifactIdentity,
	sourceArtifactIdentity,
	targetArtifactIdentity,
} from "./identity.js";
import type { ArtifactPathCodec } from "./open-package.js";
import type { ArtifactCandidate, ArtifactIdentity } from "./types.js";

export const STORY_PACKAGE_ARTIFACT_KINDS = [
	"intent",
	"story-index",
	"story-beat",
	"story-contract",
	"character",
	"place",
	"resource",
	"world",
	"reference-material",
	"reference-research",
	"style-evidence",
	"story-text",
	"source-descriptor",
	"source-input",
	"source-material",
	"release-manifest",
	"release-chapter",
	"review",
	"source-note",
] as const;

export type StoryPackageArtifactKind = (typeof STORY_PACKAGE_ARTIFACT_KINDS)[number];

const decoders: readonly [RegExp, StoryPackageArtifactKind, (match: RegExpExecArray) => string][] = [
	[/^intent\/([^/]+)\.md$/u, "intent", (match) => match[1] as string],
	[/^outline\/story\/(vol-[^/]+)\/(beat-[^/]+)\.md$/u, "story-beat", (match) => match[2] as string],
	[/^outline\/contracts\/([^/]+)\.md$/u, "story-contract", (match) => match[1] as string],
	[/^world\/characters\/([^/]+)\.md$/u, "character", (match) => match[1] as string],
	[/^world\/places\/([^/]+)\.md$/u, "place", (match) => match[1] as string],
	[/^world\/resources\/([^/]+)\.md$/u, "resource", (match) => match[1] as string],
	[/^world\/([^/]+)\.md$/u, "world", (match) => match[1] as string],
	[/^reference\/materials\/(.+)$/u, "reference-material", (match) => match[1] as string],
	[/^reference\/research\/(.+)$/u, "reference-research", (match) => match[1] as string],
	[/^reference\/style\/([^/]+)\.md$/u, "style-evidence", (match) => match[1] as string],
	[/^text\/(beat-[^/]+)\.md$/u, "story-text", (match) => match[1] as string],
	[/^release\/chapters\/(ch-[0-9]{4})\.md$/u, "release-chapter", (match) => match[1] as string],
	[/^review\/([^/]+)\.md$/u, "review", (match) => match[1] as string],
];

const sourceDecoders: readonly [RegExp, StoryPackageArtifactKind, (match: RegExpExecArray) => string][] = [
	[/^source\/([^/]+)\/outline\/story\/(vol-[^/]+)\/(beat-[^/]+)\.md$/u, "story-beat", (match) => match[3] as string],
	[/^source\/([^/]+)\/outline\/contracts\/([^/]+)\.md$/u, "story-contract", (match) => match[2] as string],
	[/^source\/([^/]+)\/world\/characters\/([^/]+)\.md$/u, "character", (match) => match[2] as string],
	[/^source\/([^/]+)\/world\/places\/([^/]+)\.md$/u, "place", (match) => match[2] as string],
	[/^source\/([^/]+)\/world\/resources\/([^/]+)\.md$/u, "resource", (match) => match[2] as string],
	[/^source\/([^/]+)\/world\/([^/]+)\.md$/u, "world", (match) => match[2] as string],
	[/^source\/([^/]+)\/notes\/([^/]+)\.md$/u, "source-note", (match) => match[2] as string],
];

export const storyPackageCodec: ArtifactPathCodec = {
	identityForPath(path) {
		if (path === "outline/story/index.yaml") return targetArtifactIdentity("story-index", "main");
		if (path === "release/manifest.yaml") return targetArtifactIdentity("release-manifest", "main");
		const sourceIndex = /^source\/([^/]+)\/outline\/story\/index\.yaml$/u.exec(path);
		if (sourceIndex !== null) return sourceArtifactIdentity(sourceIndex[1] as string, "story-index", "main");
		const sourceSpecial = /^source\/([^/]+)\/(source\.yaml|original\.bin|material\.txt)$/u.exec(path);
		if (sourceSpecial !== null) {
			const sourceId = sourceSpecial[1] as string;
			const kind =
				sourceSpecial[2] === "source.yaml"
					? "source-descriptor"
					: sourceSpecial[2] === "original.bin"
						? "source-input"
						: "source-material";
			return sourceArtifactIdentity(sourceId, kind, "main");
		}
		for (const [pattern, kind, id] of sourceDecoders) {
			const match = pattern.exec(path);
			if (match !== null) return sourceArtifactIdentity(match[1] as string, kind, id(match));
		}
		for (const [pattern, kind, id] of decoders) {
			const match = pattern.exec(path);
			if (match !== null) return targetArtifactIdentity(kind, id(match));
		}
		throw new ArtifactError("unsupported_story_package_path", `Story Language 不认识这个路径：${path}`);
	},

	/**
	 * 候选里这个 artifact 的路径。**查表，不是投影**——路径是扫描得到的事实，与 identity 一起进候选。
	 *
	 * 手上已经有 artifact 时直接读 `artifact.path`，不要绕这里。留着这个方法是因为 Story Language
	 * 的引用按 localId 写（frontmatter 是 `character: [黄盖]`，不是路径），解析引用只有 identity。
	 * 引用可能指向不存在的 artifact，所以找不到就抛；`storyImpact` 与提交回执都已按抛错处理。
	 */
	pathForIdentity(identity: ArtifactIdentity, candidate: ArtifactCandidate): string {
		const key = artifactIdentityKey(identity);
		const found = candidate.artifacts.find((artifact) => artifactIdentityKey(artifact.identity) === key);
		if (found === undefined) {
			throw new ArtifactError(
				"artifact_not_in_candidate",
				`${formatArtifactIdentity(identity)} is not in this candidate`,
			);
		}
		return found.path;
	},
};
