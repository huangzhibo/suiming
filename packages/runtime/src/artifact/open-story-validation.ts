import type { OpenPackageFile } from "./open-package.js";
import { candidateFromOpenStoryFiles } from "./open-story-snapshot.js";

/** 把一个完整 Open Story snapshot 当作不可信输入重新解析：Story Language、canonical path 与 Checker 都过一遍。 */
export function validateOpenStoryFiles(files: readonly OpenPackageFile[]): void {
	candidateFromOpenStoryFiles(files, "open-story-validation");
}
