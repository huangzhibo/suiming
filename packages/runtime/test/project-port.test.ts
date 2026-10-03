import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { HarnessProjectPort } from "../src/harness/project-port.js";
import type { LocalProjectService } from "../src/local/local-project-service.js";

/**
 * 端口的意义是「Harness 不认识具体实现」。类型层面由这一行守住：改坏 LocalProjectService 的
 * 任一端口成员，`npm run check` 的 tsc 会失败。
 */
const localSatisfiesPort: (service: LocalProjectService) => HarnessProjectPort = (service) => service;
void localSatisfiesPort;

test("harness 不再依赖 local 的任何具体实现", () => {
	// 端口化前 SuimingHarnessOptions.project 的类型是 LocalProjectService，这是 Cloud 接不进来的
	// 直接原因。这条断言守住结果：harness 目录不得再 import local。
	const dir = fileURLToPath(new URL("../src/harness/", import.meta.url));
	const offenders = readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => /from "\.\.\/local\//u.test(readFileSync(`${dir}${name}`, "utf8")));
	assert.deepEqual(offenders, []);
});

test("端口只列 Harness 真正调用的成员", () => {
	// 判据写在 project-port.ts 的注释里：新增成员必须先有 harness 的调用点。这条把「不到一半」
	// 这个事实钉住——端口一旦悄悄长回整个 LocalProjectService，它就失去意义。
	const port = readFileSync(new URL("../src/harness/project-port.ts", import.meta.url), "utf8");
	const members = [...port.matchAll(/^\t(?:readonly )?([a-z][A-Za-z]*)[(:]/gmu)].map((match) => match[1]);
	assert.ok(members.length > 0);
	assert.ok(
		members.length <= 20,
		`端口膨胀到 ${members.length} 个成员：${members.join(", ")}。新增前先确认 harness 真的调用它。`,
	);
});
