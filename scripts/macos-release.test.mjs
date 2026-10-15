import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { notarizeAndStaple, signingConfiguration } from "./macos-release.mjs";

const fingerprint = "A".repeat(40);
const identity = `  1) ${fingerprint} "Developer ID Application: Test Publisher (TESTTEAM12)"`;

test("正式签名只认明确选择的 Developer ID Application；缺项和其他证书不能自动降为预览", () => {
	assert.throws(() => signingConfiguration({}, identity), /SUIMING_MAC_SIGN_IDENTITY/);
	assert.throws(
		() => signingConfiguration({ SUIMING_MAC_SIGN_IDENTITY: fingerprint }, identity),
		/SUIMING_MAC_NOTARY_PROFILE/,
	);
	const env = { SUIMING_MAC_SIGN_IDENTITY: fingerprint, SUIMING_MAC_NOTARY_PROFILE: "fixture-notary" };
	assert.throws(
		() => signingConfiguration(env, identity.replace("Developer ID Application", "Apple Development")),
		/Developer ID Application/,
	);
	assert.throws(() => signingConfiguration({ ...env, SUIMING_MAC_SIGN_IDENTITY: "-" }, identity), /40/);
	assert.equal(signingConfiguration(env, identity).identity, fingerprint);
	assert.equal(
		signingConfiguration({ ...env, SUIMING_MAC_SIGN_IDENTITY: fingerprint.toLowerCase() }, identity).identity,
		fingerprint,
	);
});

for (const status of ["Invalid", "In Progress", "Accepted"]) {
	test(`公证 ${status}：只有 Accepted 才 staple，其余状态必须停止系统校验`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "suiming-notary-contract-"));
		const commands = [];
		const run = async (command, args) => {
			commands.push([command, ...args]);
			if (args[0] === "notarytool" && ["submit", "wait"].includes(args[1])) {
				const stdout = JSON.stringify({ id: "fixture-submission", status });
				if (status === "Invalid") throw Object.assign(new Error("notarytool rejected"), { stdout });
				return { stdout, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		};
		try {
			const operation = notarizeAndStaple({
				app: "/fixture/Suiming.app",
				directory,
				profile: "fixture-notary",
				run,
			});
			if (status === "Accepted") {
				await operation;
				assert.deepEqual(
					commands.slice(-4).map((args) => args.slice(0, 3)),
					[
						["xcrun", "stapler", "staple"],
						["xcrun", "stapler", "validate"],
						["codesign", "--verify", "--deep"],
						["spctl", "--assess", "--type"],
					],
				);
			} else {
				await assert.rejects(operation, /未通过/);
				assert.equal(
					commands.some((args) => args.includes("stapler")),
					false,
				);
			}
			assert.equal(JSON.parse(await readFile(join(directory, "notary-result.json"), "utf8")).status, status);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const failure of ["wait", "staple", "validate", "spctl"]) {
	test(`公证流程 ${failure} 失败保留编号并拒绝交付`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "suiming-notary-failure-"));
		let submissions = 0;
		const run = async (command, args) => {
			if (command === failure || args[1] === failure) throw new Error("故障注入");
			if (args[1] === "submit") {
				submissions++;
				return { stdout: JSON.stringify({ id: "persist-before-wait", status: "In Progress" }) };
			}
			if (args[1] === "wait") return { stdout: JSON.stringify({ status: "Accepted" }) };
			return { stdout: "" };
		};
		try {
			await assert.rejects(notarizeAndStaple({ app: "/fixture/Suiming.app", directory, profile: "fixture", run }));
			assert.equal(
				JSON.parse(await readFile(join(directory, "notary-result.json"), "utf8")).id,
				"persist-before-wait",
			);
			assert.equal(submissions, 1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
