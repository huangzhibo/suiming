import { InMemoryArtifactStore } from "./memory-store.js";
import { importOpenPackage, type OpenPackageFile } from "./open-package.js";
import { validateStoryProjectCandidate } from "./story-design-validator.js";
import { storyPackageCodec } from "./story-package-codec.js";

/** 把一个完整 Open Story snapshot 当作不可信输入重新解析：Story Language、canonical path 与 Checker 都过一遍。 */
export function validateOpenStoryFiles(files: readonly OpenPackageFile[]): void {
	importOpenPackage(
		new InMemoryArtifactStore(),
		"open-story-validation",
		files,
		storyPackageCodec,
		validateStoryProjectCandidate,
	);
}
