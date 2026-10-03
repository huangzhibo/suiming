import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ArtifactError } from "../artifact/errors.js";

/** 根目录可由 /var 等系统别名打开；根内的每一级路径都不得跟随 symlink。 */
export async function confinedPath(root: string, path: string): Promise<string> {
	const absolute = resolve(root, path);
	const logical = relative(resolve(root), absolute);
	const outside = (value: string) => value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
	if (path.includes("\0") || outside(logical))
		throw new ArtifactError("unsafe_file_path", `Path is outside the root: ${path}`);
	const realRoot = await realpath(root);
	let current = resolve(root);
	for (const part of logical.split(sep).filter(Boolean)) {
		current = resolve(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink() || outside(relative(realRoot, await realpath(current))))
				throw new ArtifactError("unsafe_file_path", `Symlink or escaped path: ${path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			break;
		}
	}
	return absolute;
}
