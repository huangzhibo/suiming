import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	checkDiagnostic,
	classifyOpenStoryDirectoryFile,
	createBuiltinModelGateway,
	JsonFileCredentialStore,
	LocalModelSettings,
	LocalProjectService,
	LocalWorkspace,
	loadModelRoutingConfig,
	type ModelGateway,
	proxyFromPacResult,
	readOpenStoryDirectory,
	type SuimingTelemetry,
	telemetryFromEnvironment,
	useEnvironmentProxy,
} from "@suiming/runtime";
import { type DesktopCommandFailure, LOCAL_COMMANDS, type LocalCommandName, type WorkspaceChange } from "@suiming/sdk";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";

const here = fileURLToPath(new URL(".", import.meta.url));
const renderer = resolve(here, "../../workbench/dist/index.html");
const rendererURL = pathToFileURL(renderer).href;
/** 主进程给窗口的回复：错误不经 Electron 的远程调用包装，窗口拿到的就是能直接展示的话。 */
type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
async function reply<T>(body: () => Promise<T>): Promise<Reply<T>> {
	try {
		return { ok: true, value: await body() };
	} catch (error) {
		return {
			ok: false,
			error: {
				code: (error as { code?: string }).code ?? "desktop_command_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
/** 绑定期失败（SuimError）带着全部诊断，message 只是「共 N 处，第一处」的汇总；与 CLI 失败信封同一份。 */
function commandFailure(error: unknown): DesktopCommandFailure {
	const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
	return {
		code: (error as { code?: string }).code ?? "desktop_command_failed",
		message: error instanceof Error ? error.message : String(error),
		...(Array.isArray(diagnostics) && diagnostics.length > 0
			? { diagnostics: (diagnostics as Parameters<typeof checkDiagnostic>[0][]).map(checkDiagnostic) }
			: {}),
	};
}
/** init 阶段的校验失败说成作者能看懂的话：是哪份文件、哪一项；旧仓作品不做自动迁移。 */
function describeOpenFailure(error: unknown): Error & { code: string } {
	const typed = error as {
		code?: string;
		message?: string;
		diagnostics?: { path: string; pointer: string; message: string }[];
	};
	const diagnostics = Array.isArray(typed.diagnostics) ? typed.diagnostics : [];
	const shown =
		diagnostics.length > 0
			? diagnostics.slice(0, 4).map((item) => `${item.path}${item.pointer}：${item.message}`)
			: [typed.message ?? String(error)];
	const rest = diagnostics.length - shown.length;
	return Object.assign(
		new Error(
			`这个文件夹里的作品文件不是当前 Story Language 格式，没有作为作品打开，也没有改动它。\n${shown.join("\n")}${rest > 0 ? `\n…还有 ${rest} 条` : ""}\n旧仓作品需要先按 Story Language 一次性重写，桌面不做自动迁移。`,
		),
		{ code: typed.code ?? "invalid_document" },
	);
}
export function startDesktop(
	options: { models?: () => Promise<ModelGateway>; settings?: LocalModelSettings; telemetry?: SuimingTelemetry } = {},
): void {
	const telemetry = options.telemetry ?? telemetryFromEnvironment(process.env);
	let window: BrowserWindow | undefined;
	let workspace: LocalWorkspace | undefined;
	let quitting = false;
	let quitRequested = false;
	let notifying = false;
	const pendingChanges = new Set<WorkspaceChange>();
	let stopWatching: (() => void) | undefined;
	const trusted = (url: string) => url.split("#")[0] === rendererURL;
	function changed(change: WorkspaceChange = "workspace") {
		pendingChanges.add(change);
		if (notifying) return;
		notifying = true;
		setTimeout(() => {
			notifying = false;
			const changes = [...pendingChanges];
			pendingChanges.clear();
			if (window && !window.isDestroyed()) window.webContents.send("suiming:changed", changes);
		}, 100);
	}
	/** 打开是多步 await 的过程，串成一条链，连续点击两个作品不会交错。 */
	let opening: Promise<void> = Promise.resolve();
	function openProject(requested: string, create = false): Promise<void> {
		const next = opening.catch(() => undefined).then(() => openProjectNow(requested, create));
		opening = next;
		return next;
	}
	async function openProjectNow(requested: string, create: boolean) {
		if (workspace?.activeSessionIds().length) throw new Error("当前作品的对话还在运行，请先停止再切换作品。");
		// macOS 的 /var 是 /private/var 的符号链接；统一成真实路径，最近列表才不会把同一作品记两次。
		const path = await realpath(requested).catch(() => requested);
		// 像 Obsidian 打开任意文件夹一样：目录还没有 .suiming 时就地初始化，作品仍只是目录，.suiming 只是版本库。
		// scaffold 是幂等的，只补缺失的 index.yaml 等最小 Design；已有作品文件直接成为第一个版本。
		// 「打开」一个既非空、又没有任何作品文件的目录（例如误选 ~/Documents）时拒绝，不往里写东西。
		const project = await LocalProjectService.open(path).catch(async (error: unknown) => {
			if ((error as { code?: string } | null)?.code !== "local_project_not_initialized") throw error;
			const scanned = await readOpenStoryDirectory(path);
			const hasStoryFiles = scanned.files.some((file) => classifyOpenStoryDirectoryFile(file.path) === "story");
			// 目录扫描只列作品相关文件；判断“是否空目录”要看真实条目，隐藏文件与 .suiming 不算。
			const visibleEntries = (await readdir(path)).filter((entry) => !entry.startsWith("."));
			if (!create && !hasStoryFiles && visibleEntries.length > 0)
				throw new Error(
					"这个文件夹里没有作品文件，也不是空目录。请选择 Open Story Directory，或用「新建作品」选一个空目录。",
				);
			try {
				(await LocalProjectService.initWithStarter({ checkoutPath: path })).service.close();
			} catch (initError) {
				throw describeOpenFailure(initError);
			}
			return LocalProjectService.open(path);
		});
		stopWatching?.();
		workspace?.project.close();
		workspace = new LocalWorkspace(
			project,
			options.models ??
				(async () => {
					const loaded = await loadModelRoutingConfig();
					return createBuiltinModelGateway(loaded.config, {
						credentials: new JsonFileCredentialStore(),
						telemetryContext: telemetry.context,
					});
				}),
			// provider 登录流程给出的授权链接由主进程打开系统浏览器；renderer 不能打开外部窗口。
			options.settings ?? new LocalModelSettings({ openUrl: (url) => shell.openExternal(url) }),
			async (absolute, action) => {
				if (action === "reveal") shell.showItemInFolder(absolute);
				else {
					const error = await shell.openPath(absolute);
					if (error) throw new Error(error);
				}
			},
			telemetry.context,
		);
		const { watch } = await import("node:fs");
		const watcher = watch(path, { recursive: true }, (_event, filename) => {
			if (filename && !filename.startsWith(".suiming")) changed();
		});
		const unsubscribe = workspace.onChange(changed);
		stopWatching = () => {
			watcher.close();
			unsubscribe();
		};
		await mkdir(app.getPath("userData"), { recursive: true });
		const recent = [path, ...(await readStored()).recent.filter((item) => item !== path)].slice(0, 8);
		await writeFile(join(app.getPath("userData"), "workspace.json"), JSON.stringify({ path, recent }));
		changed();
	}
	/** 最近作品只是桌面偏好，不进作品目录；文件缺失或损坏时当作空。 */
	async function readStored(): Promise<{ path?: string; recent: string[] }> {
		try {
			const parsed = JSON.parse(await readFile(join(app.getPath("userData"), "workspace.json"), "utf8")) as {
				path?: string;
				recent?: unknown;
			};
			return {
				...(parsed.path === undefined ? {} : { path: parsed.path }),
				recent: Array.isArray(parsed.recent) ? parsed.recent.filter((item) => typeof item === "string") : [],
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				console.error("作品记录读取失败：", error instanceof Error ? error.message : error);
			return { recent: [] };
		}
	}
	function finishQuit() {
		if (quitting) return;
		quitting = true;
		void Promise.race([
			(async () => {
				const deadline = Date.now() + 5000;
				await Promise.race([
					workspace?.shutdown() ?? Promise.resolve(),
					new Promise<void>((resolve) => setTimeout(resolve, 3500)),
				]);
				await telemetry.shutdown(Math.max(0, deadline - Date.now()));
			})(),
			new Promise<void>((resolve) => setTimeout(resolve, 5000)),
		]).finally(() => {
			stopWatching?.();
			workspace?.project.close();
			app.exit(0);
		});
	}
	function createWindow() {
		window = new BrowserWindow({
			width: 1460,
			height: 940,
			minWidth: 960,
			minHeight: 640,
			title: "燧明 · 创作工作台",
			// 与 renderer 的 --background 一致；原来是 2026-09-11 换中性主题前的米色，启动时闪一下。
			backgroundColor: "#ffffff",
			titleBarStyle: "hiddenInset",
			// 顶栏 40px（与 Obsidian 的 header 同高）：窗口按钮 12px 高，从 y=13 起（macOS 习惯略偏上），与模式按钮、标签页同一条线。
			trafficLightPosition: { x: 12, y: 13 },
			webPreferences: {
				preload: join(here, "preload.cjs"),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
			},
		});
		// 原生窗口布局只驱动 preload 的呈现标记，不进入作品状态或领域命令。
		const syncWindowChrome = () => window?.webContents.send("suiming:window-fullscreen", window.isFullScreen());
		window.on("enter-full-screen", syncWindowChrome);
		window.on("leave-full-screen", syncWindowChrome);
		window.webContents.on("dom-ready", syncWindowChrome);
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("will-navigate", (event, url) => {
			if (!trusted(url)) event.preventDefault();
		});
		window.webContents.on("will-prevent-unload", (event) => {
			const choice = dialog.showMessageBoxSync(window as BrowserWindow, {
				type: "question",
				buttons: ["继续编辑", "放弃未保存内容"],
				defaultId: 0,
				cancelId: 0,
				message: "这页还有未保存的修改",
				detail: quitRequested
					? "退出应用会丢失未保存的编辑；已经保存的候选和运行进度会保留。"
					: "关闭或重载窗口会丢失未保存的编辑。",
			});
			if (choice === 1) event.preventDefault();
			else quitRequested = false;
		});
		window.on("closed", () => {
			window = undefined;
			if (quitRequested) finishQuit();
		});
		void window.loadFile(renderer);
	}
	if (!app.requestSingleInstanceLock()) app.quit();
	else {
		app.on("second-instance", () => {
			if (!window) createWindow();
			window?.show();
			window?.focus();
		});
		void app.whenReady().then(async () => {
			// 模型调用要遵守代理。Node 的 fetch 既不读 HTTPS_PROXY 这类变量，也不读 macOS 系统代理；从 Finder
			// 启动时连变量都没有。环境变量优先，没有就用 Chromium 解析出的系统代理（与其他桌面应用一致）。
			// 必须在任何模型调用与登录之前装好，所以放在 ready 之后的第一步。
			useEnvironmentProxy(proxyFromPacResult(await session.defaultSession.resolveProxy("https://api.openai.com/")));
			ipcMain.handle("suiming:command", async (event, request: { command: LocalCommandName; input: unknown }) => {
				if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("Untrusted renderer");
				try {
					if (!workspace) throw new Error("请先打开或创建作品");
					if (!Object.hasOwn(LOCAL_COMMANDS, request.command)) throw new Error("Unknown command");
					return { ok: true, value: await workspace.invoke(request.command, request.input as never) };
				} catch (error) {
					return { ok: false, error: commandFailure(error) };
				}
			});
			ipcMain.handle("suiming:choose-project", async (event, create: boolean) => {
				if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("Untrusted renderer");
				return reply(async () => {
					const selection = await dialog.showOpenDialog({
						title: create ? "选择新作品的空目录" : "打开 Suiming 作品",
						properties: ["openDirectory", "createDirectory"],
					});
					if (selection.canceled || !selection.filePaths[0]) return false;
					await openProject(selection.filePaths[0], create);
					return true;
				});
			});
			ipcMain.handle("suiming:export-conversation", async (event, content: string) => {
				if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("Untrusted renderer");
				return reply(async () => {
					if (typeof content !== "string" || !content.trim()) throw new Error("没有可导出的对话");
					const selection = await dialog.showSaveDialog({
						title: "导出对话",
						defaultPath: "对话记录.md",
						filters: [{ name: "Markdown 文本", extensions: ["md"] }],
					});
					if (selection.canceled || !selection.filePath) return false;
					await writeFile(selection.filePath, content, "utf8");
					return true;
				});
			});
			ipcMain.handle("suiming:recent-projects", async (event) => {
				if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("Untrusted renderer");
				const stored = await readStored();
				const existing = await Promise.all(
					stored.recent.map(async (path) => {
						try {
							return (await stat(path)).isDirectory() ? path : undefined;
						} catch {
							return undefined;
						}
					}),
				);
				return existing
					.filter((path): path is string => path !== undefined)
					.map((path) => ({ path, name: path.split("/").at(-1) ?? path }));
			});
			ipcMain.handle("suiming:open-project", async (event, path: string) => {
				if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("Untrusted renderer");
				return reply(async () => {
					if (typeof path !== "string" || !path.trim()) throw new Error("缺少作品路径");
					// 只开最近列表里的作品：别的目录走 chooseProject 的系统对话框。打开空目录会就地建作品，
					// 不能让 renderer 把任意路径交给主进程去初始化。
					const target = resolve(path);
					if (!(await readStored()).recent.includes(target))
						throw new Error("只能直接打开最近列表里的作品；别的目录请用「打开作品」选择");
					await openProject(target);
					return true;
				});
			});
			const explicit = process.argv
				.find((argument) => argument.startsWith("--project="))
				?.slice("--project=".length);
			if (explicit) await openProject(resolve(explicit));
			else {
				const stored = await readStored();
				if (stored.path) {
					try {
						await openProject(stored.path);
					} catch (error) {
						console.error("作品重开失败：", error instanceof Error ? error.message : error);
					}
				}
			}
			createWindow();
		});
		app.on("activate", () => {
			if (!window) createWindow();
		});
		app.on("window-all-closed", () => {
			/* 关掉窗口不停正在跑的 turn：主进程继续持有作品与会话，Dock 可重新打开窗口。 */
		});
		app.on("before-quit", (event) => {
			if (quitting) return;
			event.preventDefault();
			if (quitRequested) return;
			quitRequested = true;
			if (window && !window.isDestroyed()) window.close();
			else finishQuit();
		});
	}
}
