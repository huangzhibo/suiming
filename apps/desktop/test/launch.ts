import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";

/**
 * 被测应用的环境：去掉开发 shell 里会改变产品行为的变量（SUIMING_* 覆盖、各家模型凭据、Langfuse / OTel 导出），
 * 配置与凭据指到这次测试的临时目录。2026-10-04 之前只有设置页这样做，其余用例读的是维护者本机的
 * ~/.suiming/config.toml 与 auth.json：结果随本机配置变（比如用量检查点），trace 还可能导进本机的 Langfuse。
 */
export function isolatedEnv(directory: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env))
		if (value !== undefined && !/^(?:SUIMING_|LANGFUSE_|OTEL_)|_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/u.test(name))
			env[name] = value;
	return {
		...env,
		SUIMING_CONFIG_PATH: join(directory, "config.toml"),
		SUIMING_AUTH_PATH: join(directory, "auth.json"),
		...extra,
	};
}

export interface DesktopLaunch {
	/** 这次测试的临时目录：配置、凭据与 user-data 都放在它下面。 */
	directory: string;
	/** 启动时打开的作品；不给就不带 --project。 */
	project?: string;
	/** entry.ts 认的测试开关，如 --recovery-test。 */
	flags?: readonly string[];
	/** 在隔离环境之上再加的变量。 */
	env?: Record<string, string>;
	timeout?: number;
}

/** 所有桌面 E2E 的唯一启动入口：测试入口、隔离的环境、这次测试自己的 user-data。 */
export function launchDesktop(options: DesktopLaunch): Promise<ElectronApplication> {
	return electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			...(options.project === undefined ? [] : [`--project=${options.project}`]),
			`--user-data-dir=${join(options.directory, "app-data")}`,
			...(options.flags ?? []),
		],
		env: isolatedEnv(options.directory, options.env),
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
	});
}

/** 渲染层未捕获的异常；每个用例结尾断言为空。 */
export function collectPageErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

/** 放行 entry.ts 里同名的测试闸门。 */
export async function openGate(app: ElectronApplication, name: string): Promise<void> {
	await app.evaluate(
		(_electron, gateName) => (globalThis as unknown as { openTestGate(name: string): void }).openTestGate(gateName),
		name,
	);
}

/**
 * 断言接下来一段时间里提示框没有出现过。不是「等一下再数」：Tooltip 有 400ms 延迟，负载高时晚出现，
 * 原来「等 500ms 数到 0」就会空过、漏掉回归。这里用 MutationObserver 记下窗口期里新出现的 role=tooltip，
 * 窗口留足延迟之外的余量；之前一个提示的退场动画还挂着不算。
 */
export async function assertNoTooltip(page: Page, message?: string, windowMs = 800): Promise<void> {
	const appeared = await page.evaluate(async (ms) => {
		// 测试的 tsconfig 不带 DOM 类型，这里只声明用到的那几样。
		type Element = { matches(selector: string): boolean; querySelector(selector: string): unknown };
		type Records = { addedNodes: ArrayLike<unknown> }[];
		const dom = globalThis as unknown as {
			document: { body: unknown; querySelector(selector: string): unknown };
			MutationObserver: new (
				callback: (records: Records) => void,
			) => { observe(target: unknown, options: object): void; disconnect(): void };
		};
		// 函数在浏览器里执行：不要在里面定义具名函数，tsx 的 keepNames 会给它包一层页面里没有的 __name。
		let seen = false;
		const observer = new dom.MutationObserver((records) => {
			for (const record of records)
				for (const node of Array.from(record.addedNodes)) {
					const element = node as Element;
					if (
						typeof element.matches === "function" &&
						(element.matches('[role="tooltip"]') || element.querySelector('[role="tooltip"]') !== null)
					)
						seen = true;
				}
		});
		observer.observe(dom.document.body, { childList: true, subtree: true });
		await new Promise((done) => setTimeout(done, ms));
		observer.disconnect();
		return seen || dom.document.querySelector('[role="tooltip"]') !== null;
	}, windowMs);
	assert.equal(appeared, false, message ?? "不应弹出提示");
}

/**
 * 在 Node 这边轮询，直到 check 为真。要查主进程状态（`window.suiming.invoke`）这类异步条件时用它，
 * 不用 page.waitForFunction：它不 await 异步谓词，返回的 Promise 本身就是真值，会立刻放行
 * （2026-10-04 改 telemetry 测试时踩到；模型选择测试里两处等待也一直是空等）。
 */
export async function eventually(check: () => Promise<boolean>, message: string, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 50));
	}
	assert.fail(message);
}

/** 等某个 session 回到 idle、跑完第 turn 轮。 */
export async function waitForSessionIdle(page: Page, sessionId: string, turn = 1, timeoutMs = 10000): Promise<void> {
	await eventually(
		() =>
			page.evaluate(
				async ({ id, round }) => {
					const bridge = (
						globalThis as unknown as {
							suiming: {
								invoke(
									command: "session.list",
									input: object,
								): Promise<{ sessions: { id: string; status: string; turn: number }[] }>;
							};
						}
					).suiming;
					return (await bridge.invoke("session.list", {})).sessions.some(
						(session) => session.id === id && session.status === "idle" && session.turn === round,
					);
				},
				{ id: sessionId, round: turn },
			),
		`session ${sessionId} 在 ${timeoutMs}ms 内没有回到 idle（turn ${turn}）`,
		timeoutMs,
	);
}
