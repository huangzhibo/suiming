/** 隔离交互实验；复用生产编辑器和保存回执归并，绝不导入生产入口。 */
import { createRoot } from "react-dom/client";
import { useReducer } from "react";
import CodeEditor from "../../../apps/workbench/src/code-editor.js";
import {
	DEFAULT_VIEW,
	editDocument,
	savedDocument,
	type DocumentDraft,
} from "../../../apps/workbench/src/view-state.js";

type File = { path: string; content: string; sha256: string | null };
type Mode = "manual" | "handoff" | "idle";
declare global {
	interface Window {
		prototypeInvoke(action: string, input?: unknown): Promise<any>;
		lab: { snapshot(): unknown; setMode(mode: Mode): void };
	}
}
const labels: Record<Mode, string> = { manual: "手动保存", handoff: "交给 Agent 时同步", idle: "停顿 1.5 秒后保存" };
const files: Record<string, File> = Object.fromEntries(
	(await window.prototypeInvoke("files")).map((f: File) => [f.path, f]),
);
const paths = Object.keys(files);
let state = { ...DEFAULT_VIEW, documents: {} as Record<string, DocumentDraft> };
let mode: Mode = "manual";
let active = paths[0]!;
let selected = new Set([active]);
let composing = new Set<string>();
let agent: { path: string; content: string }[] = [];
let reads = 0;
let status = "仅草稿保全不等于保存到作品；本原型的草稿只在内存。";
let log: string[] = [];
const failures: Record<string, string> = {};
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Promise<boolean>>();
let notify = () => {};
function report(message: string) {
	status = message;
	log = [...log.slice(-15), message];
	notify();
}
function cancel(path: string) {
	clearTimeout(timers.get(path));
	timers.delete(path);
}
function setMode(next: Mode) {
	for (const path of timers.keys()) cancel(path);
	mode = next;
	report(`模式：${labels[mode]}。切换本身不保存旧草稿。`);
}
async function save(path: string, captured?: DocumentDraft): Promise<boolean> {
	if (pending.has(path)) {
		if (!(await pending.get(path))) return false;
		// 已落盘一份旧快照，使用最新基线；不把等待期间的新输入偷偷纳入交付。
		if (captured) captured = { ...captured, baseSHA: files[path]!.sha256 };
	}
	const draft = captured ?? state.documents[path];
	if (!draft) return true;
	cancel(path);
	const operation = (async () => {
		try {
			const result: File = await window.prototypeInvoke("save", {
				path,
				content: draft.content,
				expectedSHA: draft.baseSHA,
			});
			files[path] = result;
			state = savedDocument(state, path, result.content, result.sha256);
			delete failures[path];
			report(`已保存到候选：${path.split("/").at(-1)}；没有提交 Canon。`);
			return true;
		} catch (error) {
			failures[path] = String(error);
			cancel(path);
			report(`保存受阻：${path.split("/").at(-1)}。草稿保留，处理前不自动重试。`);
			return false;
		}
	})();
	pending.set(path, operation);
	notify();
	try {
		return await operation;
	} finally {
		pending.delete(path);
		notify();
	}
}
function schedule(path: string) {
	cancel(path);
	if (mode !== "idle" || failures[path] || composing.has(path)) return;
	timers.set(
		path,
		setTimeout(() => {
			timers.delete(path);
			void save(path);
		}, 1500),
	);
}
function edit(path: string, content: string) {
	state = editDocument(state, path, content, files[path]!);
	schedule(path);
	notify();
}
async function handoff() {
	const targets = [...selected];
	if (!targets.length) return report("请选择交给 Agent 的文件。");
	const snapshots = targets.map((path) => ({ path, draft: state.documents[path] && { ...state.documents[path]! } }));
	// 新的交付失败后，不能保留上一轮可误用的结果。
	agent = [];
	if (mode === "handoff") {
		for (const { path, draft } of snapshots) {
			if (draft && !(await save(path, draft)))
				return report("交付未开始：所选文件没有全部保存成功；已保存的部分仍在候选中。");
		}
	}
	try {
		agent = await window.prototypeInvoke("agentRead", targets);
		reads++;
		report(
			`Agent 已读取 ${targets.length} 个磁盘文件。${targets.some((path) => state.documents[path]) ? "仍有草稿未交付。" : ""}`,
		);
	} catch (error) {
		report(String(error));
	}
}
async function finish() {
	try {
		await window.prototypeInvoke("agentWrite", agent);
		for (const file of await window.prototypeInvoke("files")) files[file.path] = file;
		report("Agent 已写入候选；检查与提交仍是独立动作。");
	} catch (error) {
		report(`Agent 写入被拒：${String(error)}`);
	}
}
async function inspect() {
	const result = await window.prototypeInvoke("inspect");
	report(`Checker ${result.passed ? "通过" : "拒绝"} · 候选变更 ${result.changed} · Canon ${result.revisions} 个版本`);
}
async function commit() {
	try {
		const result = await window.prototypeInvoke("commit");
		report(`实验提交：${result.created ? "已推进 Canon" : "没有候选变更"}。提交范围是整个 checkout。`);
	} catch (error) {
		report(`提交被拒：${String(error)}`);
	}
}
window.lab = {
	setMode,
	snapshot: () => ({
		mode,
		active,
		documents: state.documents,
		files,
		failures,
		agent,
		reads,
		pending: [...pending.keys()],
		timers: [...timers.keys()],
		composing: [...composing],
		status,
	}),
};
function App() {
	const [, refresh] = useReducer((n) => n + 1, 0);
	notify = refresh;
	return (
		<>
			<header>
				<div>
					<strong>保存时机实验</strong>
					<small>隔离原型 · 公共样例 · 不改变生产设置</small>
				</div>
				<select aria-label="保存方式" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
					{Object.entries(labels).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</header>
			<main>
				<aside>
					<h2>作品文件</h2>
					{paths.map((path) => (
						<div key={path} className="file-row">
							<input
								type="checkbox"
								aria-label={`交付 ${path}`}
								checked={selected.has(path)}
								onChange={(e) => {
									selected = new Set(selected);
									e.target.checked ? selected.add(path) : selected.delete(path);
									notify();
								}}
							/>
							<button
								aria-pressed={active === path}
								onClick={() => {
									active = path;
									notify();
								}}
							>
								{path.split("/").at(-1)}
								{state.documents[path] ? " ●" : ""}
							</button>
						</div>
					))}
					<p>
						勾选控制交付范围。
						<br />
						原型不保存对话或草稿到日常数据。
					</p>
				</aside>
				<section className="document">
					<div className="toolbar">
						<span>{active}</span>
						<button onClick={() => void save(active)}>保存当前文件</button>
					</div>
					{paths.map((path) => (
						<div
							key={path}
							hidden={active !== path}
							className="editor"
							onCompositionStart={() => {
								composing.add(path);
								cancel(path);
							}}
							onCompositionEnd={() => {
								composing.delete(path);
								schedule(path);
							}}
						>
							<CodeEditor
								path={path}
								content={state.documents[path]?.content ?? files[path]!.content}
								onChange={(content) => edit(path, content)}
								autoFocus={false}
							/>
						</div>
					))}
				</section>
				<aside className="agent">
					<h2>Agent 操作</h2>
					<p>固定动作便于三组对照；这里不调用真实模型。</p>
					<button className="primary" disabled={pending.size > 0} onClick={() => void handoff()}>
						{mode === "handoff" ? "同步所选文件并交给 Agent" : "交给 Agent（读取磁盘）"}
					</button>
					<button disabled={!agent.length} onClick={() => void finish()}>
						执行读取后准备的修改
					</button>
					<button onClick={() => void inspect()}>检查候选</button>
					<button onClick={() => void commit()}>提交候选（实验）</button>
					<details>
						<summary>Agent 实际读到的内容</summary>
						{agent.map((f) => (
							<pre key={f.path}>
								{f.path}
								{"\n"}
								{f.content}
							</pre>
						))}
					</details>
					<details>
						<summary>操作记录</summary>
						<ol>
							{log.map((line, index) => (
								<li key={index}>{line}</li>
							))}
						</ol>
					</details>
				</aside>
			</main>
			<footer role="status">{status}</footer>
		</>
	);
}
createRoot(document.getElementById("root")!).render(<App />);
