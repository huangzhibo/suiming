import type { Context, Message } from "@earendil-works/pi-ai";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

/** 进程内观测策略，不写入作品、checkpoint 或模型请求。默认不采集内容。 */
export interface TelemetryContentPolicy {
	captureContent?: boolean;
	redactValues?: readonly string[];
}
const policies = new WeakMap<TelemetryContext, TelemetryContentPolicy>();
export function registerTelemetryContent(span: TelemetrySpan, policy: TelemetryContentPolicy): void {
	policies.set(span, policy);
}
const MAX_CONTENT_BYTES = 64 * 1024;
const privateKey =
	/^(?:authorization|cookie|set-cookie|api[-_]?key|.*secret.*|.*password.*|.*credential.*|access[-_]?token|refresh[-_]?token|.*signature|encrypted.*|data)$/iu;

/** 工具参数内的凭据字段与常见文本凭据做尽力过滤；不能保证识别自由文本里的所有私密内容。 */
function sanitize(value: unknown, policy: TelemetryContentPolicy): string {
	return (
		JSON.stringify(value, (key, item: unknown) => {
			if (privateKey.test(key)) return "[REDACTED]";
			if (typeof item !== "string") return item;
			// OpenAI tool_calls 的 arguments 是 JSON 字符串，仍按字段过滤后再保留这一显示格式。
			if (key === "arguments") {
				try {
					return sanitize(JSON.parse(item), policy);
				} catch {
					/* 非 JSON 继续按文本处理 */
				}
			}
			let text = item;
			for (const secret of policy.redactValues ?? [])
				if (secret.length >= 8) text = text.replaceAll(secret, "[REDACTED]");
			return text
				.replace(/\bBearer\s+[\w.+/=-]+/giu, "Bearer [REDACTED]")
				.replace(/\b(?:sk|pk)-(?:[\w-]{8,})/gu, "[REDACTED]")
				.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[REDACTED]")
				.replace(
					/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']+/giu,
					"$1[REDACTED]",
				);
		}) ?? "null"
	);
}

/** 惰性构造副本；关闭采集时不读取内容，序列化失败也不影响执行。 */
export function captureTelemetryContent(
	context: TelemetryContext,
	field: "input" | "output",
	read: () => unknown,
): void {
	const policy = policies.get(context);
	if (!policy?.captureContent) return;
	const span = context as TelemetrySpan;
	try {
		const json = sanitize(read(), policy);
		const bytes = Buffer.byteLength(json);
		const truncated = bytes > MAX_CONTENT_BYTES;
		// JSON 包装与转义可能放大字符串，因此取较小预览，最终属性仍小于上限。
		const value = truncated
			? JSON.stringify({
					truncated: true,
					originalBytes: bytes,
					preview: Buffer.from(json)
						.subarray(0, MAX_CONTENT_BYTES / 8)
						.toString("utf8"),
				})
			: json;
		span.setAttributes({
			[`langfuse.observation.${field}`]: value,
			[`langfuse.observation.metadata.${field}_truncated`]: truncated,
			[`langfuse.observation.metadata.${field}_bytes`]: bytes,
		});
	} catch {
		span.setAttributes({ [`langfuse.observation.metadata.${field}_capture_failed`]: true });
	}
}

/** 只投影模型可读内容：不发送 provider 签名、图片二进制、诊断、认证或原始错误。 */
export function telemetryMessages(messages: readonly Message[]): unknown[] {
	return messages.map((message) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.flatMap((part) => {
							if (part.type === "text") return [part.text];
							if (part.type === "image") return ["[image omitted]"];
							return [];
						})
						.join("\n");
		if (message.role === "assistant")
			return {
				role: "assistant",
				content,
				reasoning_content: message.content
					.filter((p) => p.type === "thinking")
					.map((p) => p.thinking)
					.join("\n"),
				tool_calls: message.content
					.filter((p) => p.type === "toolCall")
					.map((p) => ({
						id: p.id,
						type: "function",
						function: { name: p.name, arguments: JSON.stringify(p.arguments) },
					})),
			};
		if (message.role === "toolResult")
			return {
				role: "tool",
				content,
				tool_call_id: message.toolCallId,
				name: message.toolName,
				isError: message.isError,
			};
		if (message.role === "system")
			return {
				role: "system",
				content,
				sections: message.sections,
				toolsAdded: message.toolsAdded,
				toolsRemoved: message.toolsRemoved,
			};
		return { role: "user", content };
	});
}
export function telemetryInput(context: Context): unknown {
	return {
		messages: [
			...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []),
			...telemetryMessages(context.messages),
		],
		tools: context.tools,
	};
}
