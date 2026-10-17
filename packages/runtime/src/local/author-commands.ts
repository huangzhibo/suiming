import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthorCommand } from "@suiming/sdk";

/** 一条命令的上限：常用话不是文档，过大的文件多半放错了地方，跳过而不是整表失败。 */
const MAX_COMMAND_BYTES = 16 * 1024;

/**
 * 作者存的常用话（ADR-0038）：与 config.toml 同目录的 `commands/<名字>.md`，文件名就是命令名。
 * 目录不存在是空表；读不了或过大的单个文件跳过，不让一个坏文件挡住整个菜单。
 */
export async function readAuthorCommands(configPath: string): Promise<AuthorCommand[]> {
	const directory = join(dirname(configPath), "commands");
	const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
		throw error;
	});
	const commands: AuthorCommand[] = [];
	for (const file of names.filter((name) => name.endsWith(".md")).sort((a, b) => a.localeCompare(b))) {
		const path = join(directory, file);
		try {
			const info = await stat(path);
			if (!info.isFile() || info.size > MAX_COMMAND_BYTES) continue;
			const text = (await readFile(path, "utf8")).trim();
			const name = file.slice(0, -".md".length).normalize("NFC").trim();
			if (name && !/\s/u.test(name) && text) commands.push({ name, text });
		} catch {
			// 单个文件读不了就跳过
		}
	}
	return commands;
}
