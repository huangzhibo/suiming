import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

// 从 npm 已锁定并安装的桌面生产依赖闭包取包；不再解析一次 semver，也不把整个工作仓送进安装包。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("macOS 预览包需要在 macOS 上构建和验收。");
const output = resolve(process.argv[2] ?? join(root, "dist/macos"));
const desktop = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const electron = JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8"));
const stage = await mkdtemp(join(tmpdir(), "suiming-package-"));
try {
	const dependencies = execFileSync(
		"npm",
		["ls", "--omit=dev", "--all", "--parseable", "--workspace", "@suiming/desktop"],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		},
	)
		.trim()
		.split("\n")
		.filter((path) => path !== root);
	for (const source of dependencies) {
		const destination = join(stage, relative(root, source));
		await mkdir(dirname(destination), { recursive: true });
		const actual = await realpath(source);
		if (!actual.startsWith(join(root, "node_modules/"))) {
			// workspace 只带 manifest 和编译产物，不能沿符号链接复制源码、测试、作品或开发配置。
			await mkdir(destination, { recursive: true });
			await cp(join(actual, "package.json"), join(destination, "package.json"));
			await cp(join(actual, "dist"), join(destination, "dist"), { recursive: true });
		} else {
			await cp(source, destination, { recursive: true, dereference: true });
		}
	}
	// 保留生产入口相对 renderer / preload 的路径关系。workspace 包仍由 node_modules 解析。
	for (const path of ["apps/desktop/dist", "apps/workbench/dist"])
		await cp(join(root, path), join(stage, path), { recursive: true });
	await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
	await writeFile(
		join(stage, "package.json"),
		JSON.stringify(
			{
				name: "suiming",
				productName: "Suiming",
				version: desktop.version,
				type: "module",
				main: "apps/desktop/dist/bin.js",
				license: "MIT",
				suimingBuild: {
					commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
					dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()),
				},
			},
			null,
			2,
		),
	);
	const paths = await packager({
		dir: stage,
		out: output,
		name: "Suiming",
		executableName: "Suiming",
		appBundleId: "org.suiming.desktop",
		appCategoryType: "public.app-category.productivity",
		platform: "darwin",
		arch: process.arch,
		electronVersion: electron.version,
		...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
		asar: true,
		prune: false,
		overwrite: true,
	});
	const app = join(paths[0], "Suiming.app");
	const zip = join(output, `Suiming-${desktop.version}-macOS-${process.arch}.zip`);
	await rm(zip, { force: true });
	execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
	console.log(`macOS 本机构建（未签名、未公证）：\n${app}\n${zip}`);
} finally {
	await rm(stage, { recursive: true, force: true });
}
