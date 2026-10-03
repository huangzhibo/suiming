/**
 * 用真实桌面应用给一部作品截宣传图、录动图。界面改了重跑这一个脚本即可，不手工截图。
 *
 * 用法：
 *   npm run build:desktop          # 先构建：脚本驱动的是 apps/desktop 与 apps/web/dist
 *   node scripts/capture-media.mjs --work <作品目录> --plan <分镜.json> --out <输出目录> [--video]
 *
 * 分镜文件写这部作品里要点的东西（名字按界面上显示的写）：
 *   { "beat": "情节标题", "volume": "卷名", "character": "人物名", "contract": "读者期待名" }
 *
 * 输出：axis.png（全书故事轴）、axis-state.png（选中一节并查看状态）、volume.png（进入一卷）、
 * character.png（人物页的关系图）、contract.png（读者期待的轨迹）；带 --video 时另出 tour.webp。
 * 截图是 2 倍像素。动图不用 Playwright 自带的录像（码率低，中文发糊），而是录 Chromium 的逐帧画面，
 * 按时间戳重采样后用 img2webp 合成；需要本机有 ImageMagick（magick）与 libwebp（img2webp）。
 * 窗口里画的光标只存在于录制时注入的页面元素里，不是产品的一部分。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { _electron as electron } from "playwright";

const { values } = parseArgs({
	options: {
		work: { type: "string" },
		plan: { type: "string" },
		out: { type: "string" },
		video: { type: "boolean", default: false },
		fps: { type: "string", default: "12" },
		width: { type: "string", default: "1280" },
	},
});
if (!values.work || !values.plan || !values.out) {
	console.error(
		"用法：node scripts/capture-media.mjs --work <作品目录> --plan <分镜.json> --out <输出目录> [--video]",
	);
	process.exit(2);
}
const repo = resolve(import.meta.dirname, "..");
const out = resolve(values.out);
const plan = JSON.parse(await readFile(values.plan, "utf8"));
await mkdir(out, { recursive: true });

const WIDTH = 1440;
const HEIGHT = 900;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const data = await mkdtemp(join(tmpdir(), "suiming-capture-"));
const app = await electron.launch({
	cwd: repo,
	args: [resolve(repo, "apps/desktop"), `--project=${resolve(values.work)}`, `--user-data-dir=${data}`],
});
const frames = [];
let recording;
try {
	const page = await app.firstWindow();
	await app.evaluate(
		({ BrowserWindow }, size) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.setContentSize(size.width, size.height);
			window.center();
		},
		{ width: WIDTH, height: HEIGHT },
	);
	await page.getByRole("button", { name: "打开故事轴" }).waitFor();
	await sleep(1500);

	// 录制用的光标：跟随 Playwright 的鼠标事件，按下时有一圈涟漪。
	await page.evaluate(() => {
		const cursor = document.createElement("div");
		cursor.innerHTML =
			'<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4 3.9 7.3-2.8 1.5-3.9-7.3L4 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
		Object.assign(cursor.style, {
			position: "fixed",
			left: "0",
			top: "0",
			zIndex: "2147483647",
			pointerEvents: "none",
			transform: "translate(-100px, -100px)",
			filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))",
		});
		document.body.append(cursor);
		document.addEventListener(
			"mousemove",
			(event) => {
				cursor.style.transform = `translate(${event.clientX - 4}px, ${event.clientY - 2}px)`;
			},
			true,
		);
		document.addEventListener(
			"mousedown",
			(event) => {
				const ring = document.createElement("div");
				Object.assign(ring.style, {
					position: "fixed",
					left: `${event.clientX - 18}px`,
					top: `${event.clientY - 18}px`,
					width: "36px",
					height: "36px",
					borderRadius: "50%",
					border: "2px solid rgba(59,130,246,.85)",
					zIndex: "2147483646",
					pointerEvents: "none",
					transition: "transform .45s ease-out, opacity .45s ease-out",
					transform: "scale(.4)",
				});
				document.body.append(ring);
				requestAnimationFrame(() => {
					ring.style.transform = "scale(1.3)";
					ring.style.opacity = "0";
				});
				setTimeout(() => ring.remove(), 600);
			},
			true,
		);
	});

	let pointer = { x: WIDTH * 0.62, y: HEIGHT * 0.55 };
	await page.mouse.move(pointer.x, pointer.y);
	/** 缓动移动到元素中心（或给定偏移），录出来像人在操作。 */
	const moveTo = async (locator, offset) => {
		const box = await locator.boundingBox();
		if (!box) throw new Error("要点的元素不在屏幕上");
		const target = {
			x: box.x + (offset?.x ?? box.width / 2),
			y: box.y + (offset?.y ?? box.height / 2),
		};
		const steps = 28;
		for (let index = 1; index <= steps; index += 1) {
			const t = index / steps;
			const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
			await page.mouse.move(pointer.x + (target.x - pointer.x) * eased, pointer.y + (target.y - pointer.y) * eased);
			await sleep(14);
		}
		pointer = target;
	};
	const click = async (locator, offset) => {
		await moveTo(locator, offset);
		await sleep(180);
		await page.mouse.down();
		await sleep(70);
		await page.mouse.up();
	};
	const shot = async (name) => {
		await sleep(900);
		await page.screenshot({ path: join(out, `${name}.png`) });
	};

	if (values.video) {
		const session = await page.context().newCDPSession(page);
		session.on("Page.screencastFrame", async (frame) => {
			frames.push({ data: frame.data, at: frame.metadata.timestamp });
			await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
		});
		await session.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
		recording = session;
	}

	// 1. 全书故事轴：收起左栏与右栏，留出整宽给泳道。
	await click(page.getByRole("button", { name: "打开故事轴" }));
	await sleep(600);
	await click(page.getByRole("button", { name: "收起左栏" }));
	await click(page.getByRole("button", { name: "收起右栏" }));
	await sleep(1200);
	await shot("axis");

	// 2. 悬停一条读者期待，再选中一节：只留与它相关的因果弧，查看这一节的状态。
	const contractLabel = page.getByRole("button", { name: plan.contract, exact: true }).first();
	await moveTo(contractLabel);
	await sleep(1400);
	await click(page.getByRole("button", { name: new RegExp(`^${plan.beat} · `) }).first());
	await sleep(1600);
	await click(page.getByRole("button", { name: "查看此处状态" }));
	await sleep(900);
	const change = page.getByRole("radio", { name: "本幕变化" }).or(page.getByRole("button", { name: "本幕变化" }));
	if (await change.count()) await click(change.first());
	await shot("axis-state");
	await sleep(800);

	// 3. 进入一卷。
	await click(page.getByText(plan.volume, { exact: true }).first());
	await sleep(1400);
	await shot("volume");

	// 4. 读者期待的轨迹页。
	await click(page.getByRole("button", { name: plan.contract, exact: true }).first());
	await sleep(1200);
	await shot("contract");

	// 5. 人物页：滚到页末的关系图。
	await click(page.getByRole("button", { name: "后退" }));
	await sleep(900);
	await click(page.getByRole("button", { name: plan.character, exact: true }).first());
	await sleep(900);
	await moveTo(page.locator("main").first(), { x: 700, y: 500 });
	for (let index = 0; index < 12; index += 1) {
		await page.mouse.wheel(0, 260);
		await sleep(60);
	}
	await sleep(1500);
	await shot("character");
	await sleep(600);

	if (recording) await recording.send("Page.stopScreencast");
} finally {
	await app.close();
	await rm(data, { recursive: true, force: true });
}

if (values.video && frames.length > 0) {
	const fps = Number(values.fps);
	const work = await mkdtemp(join(tmpdir(), "suiming-frames-"));
	try {
		// 逐帧画面只在页面变化时到达；按时间戳重采样成固定帧率，相同的帧合并成一帧并延长时长。
		const start = frames[0].at;
		const end = frames.at(-1).at + 1.2;
		const sampled = [];
		let cursor = 0;
		for (let t = start; t <= end; t += 1 / fps) {
			while (cursor + 1 < frames.length && frames[cursor + 1].at <= t) cursor += 1;
			const last = sampled.at(-1);
			if (last && last.index === cursor) last.duration += 1000 / fps;
			else sampled.push({ index: cursor, duration: 1000 / fps });
		}
		const args = ["-loop", "0", "-lossy", "-q", "72", "-m", "4"];
		for (const [order, item] of sampled.entries()) {
			const jpeg = join(work, `${String(order).padStart(4, "0")}.jpg`);
			const png = join(work, `${String(order).padStart(4, "0")}.png`);
			await writeFile(jpeg, Buffer.from(frames[item.index].data, "base64"));
			execFileSync("magick", [jpeg, "-resize", `${values.width}x`, "-strip", png]);
			args.push("-d", String(Math.round(item.duration)), png);
		}
		args.push("-o", join(out, "tour.webp"));
		execFileSync("img2webp", args, { stdio: "inherit" });
		console.log(`tour.webp：${sampled.length} 帧（原始 ${frames.length} 帧）`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
console.log(`输出在 ${out}`);
