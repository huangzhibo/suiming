import {
	createModels,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { JsonFileCredentialStore, LocalModelSettings, loadModelRoutingConfig, ModelGateway } from "@suiming/runtime";
import { app, type BrowserWindow, ipcMain, screen } from "electron";
import { startDesktop } from "../dist/main.js";

/**
 * 测试窗口不罩住宿主机的真实光标。窗口出现、拿到或失去焦点、reload、改大小让光标进出窗口时，macOS 会按
 * 真实光标的位置给页面送 pointerover / pointerout / pointermove，与 Playwright 经 CDP 注入的事件交错：
 * 光标恰好停在带提示的控件上，就多弹一个提示，或把测试正在做的悬停抢走。「提示」那条 E2E 两周来的
 * 偶发超时都是它（2026-10-02 查清：放宽窗口后页面收到 (408, 661) 的指针事件，测试的鼠标在 (624, 58)，
 * 差值正是窗口在屏幕上的偏移）。setIgnoreMouseEvents 挡不住这些事件，所以把窗口放到光标右侧：测试只从
 * 左上角往右下改大小，光标始终在窗口外。光标靠屏幕右缘放不下时改放左侧，改大小后再查一遍；全屏不管。
 * 跑 E2E 时把鼠标移进测试窗口照样会干扰——那是真实的鼠标，测不了也不该屏蔽。
 */
function keepClearOfHostCursor(window: BrowserWindow): void {
	const place = () => {
		if (window.isDestroyed() || window.isFullScreen()) return;
		const cursor = screen.getCursorScreenPoint();
		const bounds = window.getBounds();
		const margin = 8;
		const covered =
			cursor.x >= bounds.x - margin &&
			cursor.x <= bounds.x + bounds.width + margin &&
			cursor.y >= bounds.y - margin &&
			cursor.y <= bounds.y + bounds.height + margin;
		if (!covered) return;
		const area = screen.getDisplayNearestPoint(cursor).workArea;
		const right = cursor.x + margin;
		const x = right + 200 <= area.x + area.width ? right : cursor.x - margin - bounds.width;
		window.setPosition(x, bounds.y);
	};
	place();
	window.on("show", place);
	window.on("resize", place);
}
app.on("browser-window-created", (_event, window) => keepClearOfHostCursor(window));

const modelTest = process.argv.includes("--model-picker-test");
const provider = fauxProvider(
	modelTest
		? {
				provider: "desktop-test",
				api: "openai-responses",
				models: [
					{ id: "first", name: "测试模型 A", reasoning: true },
					{ id: "second", name: "测试模型 B", reasoning: true },
				],
			}
		: { provider: "desktop-test", api: "desktop-test-api" },
);
if (process.argv.includes("--composer-test")) {
	const commands: { command: string; input: Record<string, unknown> }[] = [];
	Object.assign(globalThis, { composerTestCommands: commands });
	let lostLaunch = false;
	let failedResume = false;
	const handle = ipcMain.handle.bind(ipcMain);
	ipcMain.handle = (channel, listener) =>
		handle(channel, async (event, request, ...args) => {
			if (channel !== "suiming:command") return listener(event, request, ...args);
			const command = request as { command: string; input: Record<string, unknown> };
			commands.push(command);
			// 第一次 send 的回包丢失；同一 session 的第二次 send 先失败一次，验证重试沿用同一命令。
			if (command.command === "session.send" && command.input.sessionId !== undefined && !failedResume) {
				failedResume = true;
				return { ok: false, error: { code: "test_send_failed", message: "测试：发送暂时失败" } };
			}
			const result = await listener(event, request, ...args);
			if (command.command === "session.send" && command.input.sessionId === undefined && !lostLaunch) {
				lostLaunch = true;
				await new Promise((resolve) => setTimeout(resolve, 1800));
				return { ok: false, error: { code: "test_reply_lost", message: "测试：发送回包丢失" } };
			}
			return result;
		});
}
// 人工释放回包，验证窗格关闭期间的共享输入；只存在于测试入口。
if (process.argv.includes("--workspace-callback-test")) {
	const callbacks: { command: string; release?: () => void } = { command: "" };
	Object.assign(globalThis, { workspaceTestCallbacks: callbacks });
	const handle = ipcMain.handle.bind(ipcMain);
	ipcMain.handle = (channel, listener) =>
		handle(channel, async (event, request, ...args) => {
			const result = await listener(event, request, ...args);
			if (channel === "suiming:command" && request.command === callbacks.command) {
				callbacks.command = "";
				await new Promise<void>((resolve) => {
					callbacks.release = resolve;
				});
				delete callbacks.release;
			}
			return result;
		});
}
provider.setResponses([
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 1200));
		return fauxAssistantMessage("主角要公开密信，还是暂时保留？");
	},
	fauxAssistantMessage(fauxToolCall("commit", { summary: "提交设计" })),
	fauxAssistantMessage(fauxToolCall("write_context", { storyBeatId: "beat-0001" })),
	fauxAssistantMessage(
		fauxToolCall("write", {
			path: "text/beat-0001.md",
			content:
				"李牧推开皇档的门，霉味先于灯光涌出来。他知道匣子在哪一层，也知道拿走密信之后，自己就再没有可以讨价还价的东西。\n\n他还是伸手取了。",
		}),
	),
	fauxAssistantMessage(fauxToolCall("commit", { summary: "采用第一场正文" })),
	fauxAssistantMessage(fauxToolCall("review", { layer: "text", storyBeatIds: ["beat-0001"], goal: "核对行动与选择" })),
	fauxAssistantMessage(
		fauxToolCall("submit_review", {
			verdict: "revise",
			summary: "首场已建立选择，取信动作还可具体一些。".repeat(30),
			findings: [
				{
					severity: "minor",
					anchor: { kind: "artifact", path: "text/beat-0001.md" },
					issue: "取信动作略显概括",
					evidence: "结尾只有“他还是伸手取了”，缺少一次有阻力的身体动作。",
					repairLayer: "text",
					suggestion: "写出手指遇到封蜡时的停顿。",
				},
				...Array.from({ length: 5 }, (_, index) => ({
					severity: "minor",
					anchor: { kind: "artifact", path: "text/beat-0001.md" },
					issue: `补充审读问题 ${index + 1}`,
					evidence: `“他还是伸手取了”——${"长报告布局验收用的审读说明，覆盖完整意见的滚动和正文对照。".repeat(6)}`,
					repairLayer: "text",
					suggestion: "逐项核对当前稿与被审快照。".repeat(4),
				})),
			],
			uncovered: [],
			uncertainties: [],
		}),
	),
	fauxAssistantMessage(fauxToolCall("commit", { summary: "保留独立审稿意见，交作者裁决" })),
	fauxAssistantMessage("首场正文与独立审稿已提交，取信动作的意见留给作者裁决。"),
]);
if (process.argv.includes("--recovery-test"))
	provider.setResponses([
		async () => {
			if (!process.argv.includes("--recovery-second")) {
				process.stdout.write("SUIMING_TEST_MODEL_REQUEST_STARTED\n");
				await new Promise((resolve) => setTimeout(resolve, 60000));
			}
			return fauxAssistantMessage("恢复后的分析已完成，无需修改作品");
		},
	]);
if (process.argv.includes("--composer-test"))
	provider.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 700));
			return fauxAssistantMessage("需要公开密信吗？");
		},
		fauxAssistantMessage("对话回看测试。李牧在封蜡前停了一下，仍决定公开密信。\n\n".repeat(120)),
	]);
// 选段就地修改：模型读正文、只改选中的那句，再回一句改了什么
if (process.argv.includes("--selection-edit-test"))
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "text/beat-0001.md" })),
		fauxAssistantMessage(
			fauxToolCall("edit", {
				path: "text/beat-0001.md",
				oldText: "李牧推开皇档的门。",
				newText: "李牧在皇档门前停了一下，才推开门。",
			}),
		),
		fauxAssistantMessage("改好了：推门前先停了一下，其余没动。"),
	]);
if (process.argv.includes("--conversation-test")) {
	// 被停下的那次请求只能由停止结束，不靠计时器赌停止先到。停止落在请求发出前还是进行中都可以，
	// 两种情况下一句都只发一次请求、带着停止前那句，所以按有没有「接着说」分辨，排两份。
	const stopThenContinue: FauxResponseFactory = async (context, options) => {
		const encoded = JSON.stringify(context.messages);
		if (!encoded.includes("接着说")) {
			const signal = options?.signal;
			if (!signal?.aborted)
				await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
			return fauxAssistantMessage("停止没有生效");
		}
		if (!encoded.includes("继续分析这个选择")) throw new Error("停止前那句不见了");
		return fauxAssistantMessage("接着停下前的分析：他公开密信，是在赌朝廷还肯认旧案。");
	};
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "outline/story/vol-0001/beat-0001.md" })),
		fauxAssistantMessage("可以让李牧主动公开密信，把失去谈判筹码作为代价。先讨论这个选择，不修改作品。"),
		async (context) => {
			if (!JSON.stringify(context.messages).includes("把失去谈判筹码作为代价")) throw new Error("追问缺少前文");
			return fauxAssistantMessage(
				"接着刚才的方案，关键是补足他为什么愿意失去筹码，以及这个决定如何影响后面的关系。",
			);
		},
		async (context) => {
			if (JSON.stringify(context.messages).includes("接着刚才的方案")) throw new Error("新对话混入历史");
			return fauxAssistantMessage("这是独立的新对话，可以重新讨论叙事节奏。");
		},
		stopThenContinue,
		stopThenContinue,
	]);
}
const credentials =
	modelTest && process.env.SUIMING_CONFIG_PATH
		? new JsonFileCredentialStore({ path: `${process.env.SUIMING_CONFIG_PATH}.auth.json` })
		: undefined;
const models = createModels(credentials ? { credentials } : {});
if (modelTest) {
	const extra = fauxProvider({
		provider: "connection-test",
		api: "openai-responses",
		models: [{ id: "story-model-with-a-long-id", name: "示例故事模型 · 长名称排版验证", reasoning: false }],
	});
	models.setProvider({
		...extra.provider,
		name: "示例提供商",
		auth: {
			apiKey: {
				name: "API key",
				async login(interaction) {
					const key = await interaction.prompt({ type: "secret", message: "输入测试 API key" });
					if (key !== "test-only-key") throw new Error("测试连接失败，请重新输入");
					return { type: "api_key", key };
				},
				async resolve({ credential }) {
					return credential?.key ? { auth: { apiKey: credential.key }, source: "local" } : undefined;
				},
			},
		},
	});
}
if (process.argv.includes("--telemetry-test"))
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "intent/揭开真相.md" })),
		fauxAssistantMessage("Synthetic desktop telemetry probe"),
	]);
if (process.argv.includes("--product-audit-test")) {
	const commands: string[] = [];
	Object.assign(globalThis, { productAuditCommands: commands });
	const handle = ipcMain.handle.bind(ipcMain);
	ipcMain.handle = (channel, listener) =>
		handle(channel, (event, request, ...args) => {
			if (channel === "suiming:command") commands.push(request.command);
			return listener(event, request, ...args);
		});
	provider.setResponses([
		fauxAssistantMessage("已核对作品状态，准备交付。".repeat(20)),
		fauxAssistantMessage("预算调整后已交付，作品未修改。"),
	]);
}
models.setProvider(provider.provider);
const profile = { provider: provider.provider.id, model: provider.getModel().id };
if (modelTest) {
	provider.setResponses([
		async (_context, options, _state, model) => {
			if (model.id !== "second" || (options as Record<string, unknown>).reasoningEffort !== "high")
				throw new Error("对话模型或思考参数未生效");
			return fauxAssistantMessage("模型 B 已按高思考深度完成讨论。");
		},
		async (_context, options, _state, model) => {
			if (model.id !== "first" || (options as Record<string, unknown>).reasoningEffort !== "low")
				throw new Error("新对话没有恢复全局默认");
			return fauxAssistantMessage("新对话使用模型 A 和低思考深度。");
		},
	]);
	const settings = new LocalModelSettings({
		models,
		...(credentials ? { credentials } : {}),
		...(process.env.SUIMING_CONFIG_PATH ? { configPath: process.env.SUIMING_CONFIG_PATH } : {}),
	});
	const sessions: string[] = [];
	const startLogin = settings.startLogin.bind(settings);
	settings.startLogin = (input) => {
		const result = startLogin(input);
		sessions.push(result.sessionId);
		return result;
	};
	Object.assign(globalThis, { modelSettingsTest: { settings, sessions } });
	await settings.save({ profile: "main", ...profile, thinking: "low" });
	await settings.save({ profile: "reviewer", ...profile });
	startDesktop({ settings, models: async () => new ModelGateway(models, (await loadModelRoutingConfig()).config) });
} else
	startDesktop({
		models: async () => new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }),
	});
