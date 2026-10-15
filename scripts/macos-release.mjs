// macOS 发行只处理预览构建的副本；不读作品、用户配置或凭据内容。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sign } from "@electron/osx-sign";

const execute = promisify(execFile);
const runCommand = (command, args) => execute(command, args, { maxBuffer: 4 * 1024 * 1024 });

export function signingConfiguration(env, identities) {
	const identity = env.SUIMING_MAC_SIGN_IDENTITY?.toUpperCase();
	if (!identity) throw new Error("请设置 SUIMING_MAC_SIGN_IDENTITY（证书 SHA-1 指纹，不是私钥）。");
	if (!/^[a-f\d]{40}$/i.test(identity)) throw new Error("签名身份必须是 40 位十六进制证书指纹。");
	const profile = env.SUIMING_MAC_NOTARY_PROFILE;
	if (!profile) throw new Error("请设置 SUIMING_MAC_NOTARY_PROFILE（已存入钥匙串的公证配置名）。");
	if (
		!identities
			.split("\n")
			.some((line) => line.includes(identity.toUpperCase()) && line.includes('"Developer ID Application:'))
	) {
		throw new Error("指定指纹不是可用的 Developer ID Application 签名身份；请安装证书及其私钥。");
	}
	return { identity, profile, ...(env.SUIMING_MAC_KEYCHAIN ? { keychain: env.SUIMING_MAC_KEYCHAIN } : {}) };
}

export async function notarizeAndStaple({ app, directory, profile, keychain, run = runCommand }) {
	const credentials = ["--keychain-profile", profile, ...(keychain ? ["--keychain", keychain] : [])];
	const submission = join(directory, "submission.zip");
	await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, submission]);
	const resultPath = join(directory, "notary-result.json");
	// 先保存 Apple 的编号再等待；超时 / 断网不丢编号，也不自动重复上传。
	let result;
	async function request(args) {
		try {
			return JSON.parse(
				(await run("xcrun", ["notarytool", ...args, ...credentials, "--output-format", "json"])).stdout,
			);
		} catch (error) {
			if (error.stdout) {
				try {
					return JSON.parse(error.stdout);
				} catch {
					/* 保留原始错误 */
				}
			}
			throw error;
		}
	}
	result = await request(["submit", submission]);
	await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
	if (!result.id) throw new Error("公证未返回 submission ID；请检查 notary-result.json，不要直接重复上传。");
	if (result.status === "In Progress") {
		try {
			result = { ...result, ...(await request(["wait", result.id, "--timeout", "20m"])) };
			await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
		} catch (error) {
			throw new Error(`公证等待失败，编号已保存在 ${resultPath}；使用 notarytool wait 继续查询。`, { cause: error });
		}
	}
	if (result.status === "Accepted" || result.status === "Invalid") {
		await run("xcrun", ["notarytool", "log", result.id, ...credentials, join(directory, "notary-log.json")]);
	}
	if (result.status !== "Accepted") throw new Error(`公证未通过：${result.status}；结果保存在 ${resultPath}。`);
	await run("xcrun", ["stapler", "staple", app]);
	await run("xcrun", ["stapler", "validate", app]);
	await run("codesign", ["--verify", "--deep", "--strict", app]);
	await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
}

async function check() {
	if (process.platform !== "darwin") throw new Error("macOS 签名检查必须在 macOS 上运行。");
	await runCommand("xcrun", ["--find", "notarytool"]);
	await runCommand("xcrun", ["--find", "stapler"]);
	const keychain = process.env.SUIMING_MAC_KEYCHAIN;
	const { stdout } = await runCommand("security", [
		"find-identity",
		"-v",
		"-p",
		"codesigning",
		...(keychain ? [keychain] : []),
	]);
	console.log(
		`Developer ID Application 可用身份：${stdout.split("\n").filter((line) => line.includes('"Developer ID Application:')).length}`,
	);
	const configuration = signingConfiguration(process.env, stdout);
	// 验证 profile 能向 Apple 认证；不读取或打印密码，不提交应用。
	await runCommand("xcrun", [
		"notarytool",
		"history",
		"--keychain-profile",
		configuration.profile,
		...(keychain ? ["--keychain", keychain] : []),
		"--output-format",
		"json",
	]);
	return configuration;
}

async function main() {
	const [mode, input, output] = process.argv.slice(2);
	if (mode === "check") {
		await check();
		console.log("签名身份与公证认证检查通过。");
		return;
	}
	if (!["rehearse", "release"].includes(mode) || !input || !output) {
		throw new Error(
			"用法：macos-release.mjs check | rehearse <输入.app> <新输出目录> | release <输入.app> <新输出目录>",
		);
	}
	const formal = mode === "release";
	const configuration = formal ? await check() : undefined;
	const source = await realpath(input);
	const directory = resolve(output);
	if (directory === source || directory.startsWith(source + sep)) throw new Error("输出不能位于输入应用内。");
	const plist = join(source, "Contents", "Info.plist");
	const bundleId = (
		await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])
	).stdout.trim();
	if (bundleId !== "org.suiming.desktop" || basename(source) !== "Suiming.app")
		throw new Error("输入不是 Suiming 生产应用。");
	await mkdir(directory); // 不覆盖已有产物。
	const app = join(directory, "Suiming.app");
	await runCommand("ditto", [source, app]);
	console.log(
		formal ? "签署独立副本，随后提交 Apple 公证。" : "仅本地 ad-hoc 演练，不使用开发者身份、不提交 Apple 公证。",
	);
	await sign({
		app,
		platform: "darwin",
		type: "distribution",
		identity: configuration?.identity ?? "-",
		...(configuration?.keychain ? { keychain: configuration.keychain } : {}),
		identityValidation: formal,
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		strictVerify: true,
		optionsForFile: () => ({
			hardenedRuntime: true,
			// ad-hoc 没有 Team ID，无法通过同团队动态库校验；正式签名不携带此例外。
			entitlements: [
				"com.apple.security.cs.allow-jit",
				...(!formal ? ["com.apple.security.cs.disable-library-validation"] : []),
			],
			...(!formal ? { timestamp: "none" } : {}),
		}),
	});
	await runCommand("codesign", ["--verify", "--deep", "--strict", app]);
	const metadata = await runCommand("codesign", ["-d", "--verbose=4", app]);
	await writeFile(join(directory, "signature.txt"), metadata.stderr);
	if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(metadata.stderr)) throw new Error("签名未启用 Hardened Runtime。");
	if (formal) {
		if (!metadata.stderr.includes("Authority=Developer ID Application:") || !metadata.stderr.includes("Timestamp=")) {
			throw new Error("发行签名缺少 Developer ID 或安全时间戳。");
		}
		await notarizeAndStaple({ app, directory, ...configuration });
	}
	// 只有全部步骤通过，才产生交付归档；staple 之后重新压缩。
	const archive = join(directory, formal ? "Suiming-notarized.zip" : "Suiming-local-adhoc.zip");
	await runCommand("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archive)) hash.update(chunk);
	await writeFile(`${archive}.sha256`, `${hash.digest("hex")}  ${basename(archive)}\n`);
	console.log(
		`${formal ? "签名、公证与本机 Gatekeeper 校验完成" : "本地签名演练完成（不能用于正式分发）"}：${archive}`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
