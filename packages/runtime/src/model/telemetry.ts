import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanOptions,
	type SpanStatus,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import {
	type Attributes,
	type Context as OtelContext,
	ROOT_CONTEXT,
	type Span,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

/**
 * pi-telemetry 的 TelemetryContext 是 Suiming 所有观测的契约；这里是它到 OpenTelemetry 的桥（ADR-0008 决定 5）。
 * 后端可替换：Langfuse 只是一个 OTLP HTTP 接收端；测试用 InMemorySpanExporter。
 * 不注册全局 provider、不依赖全局 context manager：父子关系由回调作用域显式传递。
 */

/** 带 trace 定位信息的 span；Langfuse 等后端按 traceId 定位整棵调用树。 */
export interface SuimingTelemetrySpan extends TelemetrySpan {
	readonly traceId: string;
	readonly spanId: string;
}

export interface SuimingTelemetry {
	context: TelemetryContext;
	/** 短命进程退出前有界等待导出；超时也返回，不阻塞退出。 */
	flush(timeoutMs?: number): Promise<void>;
	/** 导出已结束 span 并关闭 provider，共用一个等待上限；退出时无需先 flush。 */
	shutdown(timeoutMs?: number): Promise<void>;
}

function otelAttributes(attributes: SpanAttributes | undefined): Attributes {
	const result: Attributes = {};
	if (attributes === undefined) return result;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) result[name] = (Array.isArray(value) ? [...value] : value) as Attributes[string];
	}
	return result;
}

/** 仅传播关联维度；模型参数、正文、用量和状态属于当前 observation。 */
const correlationKeys = new Set([
	"langfuse.session.id",
	"langfuse.trace.name",
	"langfuse.trace.tags",
	"langfuse.environment",
	"suiming.project.id",
	"suiming.session.id",
	"suiming.turn.id",
	"suiming.task.id",
]);
function spanAttributes(attributes: SpanAttributes = {}): Attributes {
	const result = otelAttributes(attributes);
	for (const key of correlationKeys) {
		if (key.startsWith("suiming.") && result[key] !== undefined)
			result[`langfuse.observation.metadata.${key.slice(8).replaceAll(".", "_")}`] = result[key];
	}
	return result;
}
function correlation(attributes: Attributes): Attributes {
	return Object.fromEntries(
		Object.entries(attributes).filter(
			([key]) => correlationKeys.has(key) || key.startsWith("langfuse.observation.metadata."),
		),
	);
}

function errorDetails(error: unknown): { name: string; message: string } | undefined {
	try {
		if (error instanceof Error) return { name: error.name, message: "Operation failed" };
	} catch {
		// 与 pi-telemetry 的 in-memory 实现一致：观测是被动的，读不出错误详情就不记。
	}
	return undefined;
}

class OpenTelemetryContext implements TelemetryContext {
	readonly #tracer: Tracer;
	readonly #parent: OtelContext;
	readonly #inherited: Attributes;

	constructor(tracer: Tracer, parent: OtelContext = ROOT_CONTEXT, inherited: Attributes = {}) {
		this.#tracer = tracer;
		this.#parent = parent;
		this.#inherited = inherited;
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		let span: Span;
		const attributes = { ...this.#inherited, ...spanAttributes(options.attributes) };
		try {
			span = this.#tracer.startSpan(options.name, { attributes }, this.#parent);
		} catch {
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		}
		const inherited = correlation(attributes);
		const child = new OpenTelemetryContext(this.#tracer, trace.setSpan(this.#parent, span), inherited);
		let ended = false;
		let explicitStatus = false;
		const spanContext = span.spanContext();
		const handle: SuimingTelemetrySpan = {
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
			startSpan: (childOptions, childCallback) => child.startSpan(childOptions, childCallback),
			addEvent(name, attributes) {
				if (!ended) span.addEvent(name, otelAttributes(attributes));
			},
			setAttributes(attributes) {
				if (!ended) {
					const mapped = spanAttributes(attributes);
					span.setAttributes(mapped);
					Object.assign(inherited, correlation(mapped));
				}
			},
			setStatus(status: SpanStatus) {
				if (ended) return;
				explicitStatus = true;
				span.setStatus(
					status.status === "ok"
						? { code: SpanStatusCode.OK }
						: {
								code: SpanStatusCode.ERROR,
								...(status.error === undefined ? {} : { message: status.error.message }),
							},
				);
				if (status.status === "error" && status.error !== undefined) {
					span.setAttributes({ "error.type": status.error.name });
				}
			},
		};
		const settle = (failed: boolean, error?: unknown): void => {
			if (ended) return;
			ended = true;
			if (failed && !explicitStatus) {
				const details = errorDetails(error);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					...(details === undefined ? {} : { message: details.message }),
				});
				if (details !== undefined) span.setAttributes({ "error.type": details.name });
			}
			span.end();
		};
		let result: T | Promise<T>;
		try {
			result = callback(handle);
		} catch (error) {
			settle(true, error);
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				settle(false);
				return value;
			},
			(error: unknown) => {
				settle(true, error);
				throw error;
			},
		);
	}
}

export interface CreateOpenTelemetryOptions {
	spanProcessors: SpanProcessor[];
	serviceName?: string;
	tracerName?: string;
	onDiagnostic?: (code: string) => void;
}

/** 用给定的 span processor 建一个独立的 provider；不注册为全局。 */
export function createOpenTelemetry(options: CreateOpenTelemetryOptions): SuimingTelemetry {
	const provider = new TracerProvider({
		resource: resourceFromAttributes({ "service.name": options.serviceName ?? "suiming" }),
		spanProcessors: options.spanProcessors,
	});
	const tracer = provider.getTracer(options.tracerName ?? "suiming");
	return {
		context: new OpenTelemetryContext(tracer),
		flush: (timeoutMs = 5000) => bounded(() => provider.forceFlush(), timeoutMs, options.onDiagnostic),
		shutdown: (timeoutMs = 5000) => bounded(() => provider.shutdown(), timeoutMs, options.onDiagnostic),
	};
}

async function bounded(
	operation: () => Promise<void>,
	timeoutMs: number,
	onDiagnostic?: (code: string) => void,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			diagnose(onDiagnostic, "telemetry_timeout");
			resolve();
		}, timeoutMs);
	});
	try {
		await Promise.race([
			Promise.resolve()
				.then(operation)
				.catch(() => diagnose(onDiagnostic, "telemetry_failed")),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function diagnose(listener: ((code: string) => void) | undefined, code: string): void {
	try {
		listener?.(code);
	} catch {
		/* 诊断不得影响执行 */
	}
}

export interface LangfuseTelemetryOptions {
	onDiagnostic?: (code: string) => void;
	baseUrl: string;
	publicKey: string;
	secretKey: string;
	serviceName?: string;
}

/** Langfuse 的 OTLP HTTP 接收端：`<baseUrl>/api/public/otel/v1/traces`，Basic auth 是 `publicKey:secretKey`。 */
export function langfuseExportOptions(options: LangfuseTelemetryOptions): {
	url: string;
	headers: Record<string, string>;
} {
	const base = options.baseUrl.trim().replace(/\/+$/u, "");
	return {
		url: `${base}/api/public/otel/v1/traces`,
		headers: {
			"x-langfuse-ingestion-version": "4",
			Authorization: `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`, "utf8").toString("base64")}`,
		},
	};
}

export function createLangfuseTelemetry(options: LangfuseTelemetryOptions): SuimingTelemetry {
	const target = new OTLPTraceExporter({ ...langfuseExportOptions(options), timeoutMillis: 1500 });
	const onDiagnostic = options.onDiagnostic ?? ((code: string) => console.error(`[Suiming telemetry] ${code}`));
	let failed = false;
	const exporter: SpanExporter = {
		export(spans, done) {
			target.export(spans, (result) => {
				if (result.code !== 0 && !failed) diagnose(onDiagnostic, "langfuse_export_failed");
				if (result.code === 0 && failed) diagnose(onDiagnostic, "langfuse_export_recovered");
				failed = result.code !== 0;
				done(result);
			});
		},
		shutdown: () => target.shutdown(),
	};
	return createOpenTelemetry({
		spanProcessors: [new BatchSpanProcessor({ exporter, exportTimeoutMillis: 2000 })],
		onDiagnostic,
		...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
	});
}

/** 没有后端时的 telemetry：NOOP context，flush / shutdown 立即返回。 */
export const NOOP_TELEMETRY: SuimingTelemetry = Object.freeze({
	context: NOOP_TELEMETRY_CONTEXT,
	flush: async () => undefined,
	shutdown: async () => undefined,
});

const LANGFUSE_DEFAULT_BASE_URL = "https://cloud.langfuse.com";

/**
 * 从环境决定观测后端：配置了 LANGFUSE_PUBLIC_KEY 与 LANGFUSE_SECRET_KEY 就发到 Langfuse
 * （LANGFUSE_BASE_URL 缺省为 Langfuse Cloud），否则 NOOP。观测不是模型调用的前置条件。
 */
export function telemetryFromEnvironment(environment: Readonly<Record<string, string | undefined>>): SuimingTelemetry {
	const publicKey = environment.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = environment.LANGFUSE_SECRET_KEY?.trim();
	if (publicKey === undefined || publicKey.length === 0 || secretKey === undefined || secretKey.length === 0) {
		return NOOP_TELEMETRY;
	}
	const baseUrl = environment.LANGFUSE_BASE_URL?.trim();
	return createLangfuseTelemetry({
		baseUrl: baseUrl === undefined || baseUrl.length === 0 ? LANGFUSE_DEFAULT_BASE_URL : baseUrl,
		publicKey,
		secretKey,
	});
}
