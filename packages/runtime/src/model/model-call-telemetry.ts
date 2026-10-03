import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { ModelBindingSnapshot } from "./model-gateway.js";

function recordResult(span: TelemetrySpan, message: AssistantMessage): void {
	span.setAttributes({
		"gen_ai.response.model": message.responseModel ?? message.model,
		"gen_ai.usage.input_tokens": message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
		"langfuse.observation.usage_details": JSON.stringify({
			input: message.usage.input,
			output: message.usage.output,
			input_cache_read: message.usage.cacheRead,
			input_cache_write: message.usage.cacheWrite,
			total: message.usage.totalTokens,
		}),
		"gen_ai.usage.output_tokens": message.usage.output,
		"suiming.model.cache_read_tokens": message.usage.cacheRead,
		"suiming.model.cache_write_tokens": message.usage.cacheWrite,
		"suiming.model.cost_total_usd": message.usage.cost.total,
		// Langfuse 等后端按 gen_ai.usage.cost 显示金额；模型不在后端价格表里时它就是唯一来源。
		"gen_ai.usage.cost": message.usage.cost.total,
		"suiming.model.stop_reason": message.stopReason,
	});
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		span.setStatus({
			status: "error",
			error: {
				name: message.stopReason === "aborted" ? "ModelCallAborted" : "ModelCallError",
				message: `Model call ended with ${message.stopReason}`,
			},
		});
	}
}

export function traceModelCall(
	telemetryContext: TelemetryContext,
	binding: ModelBindingSnapshot,
	callback: (span: TelemetrySpan) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	return telemetryContext.startSpan(
		{
			name: "suiming.model.call",
			attributes: {
				"langfuse.observation.type": "generation",
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": binding.provider,
				"gen_ai.request.model": binding.model,
				"langfuse.observation.model.parameters": JSON.stringify(
					Object.fromEntries(
						["temperature", "topP", "maxTokens", "reasoningEffort"].flatMap((key) => {
							const value = binding.options[key];
							return typeof value === "number" || typeof value === "boolean" || typeof value === "string"
								? [[key, value]]
								: [];
						}),
					),
				),
				"suiming.model.api": binding.api,
				"suiming.model.profile_id": binding.modelProfileId,
				"suiming.model.routing_version": binding.routingVersion,
			},
		},
		async (span) => {
			const message = await callback(span);
			recordResult(span, message);
			return message;
		},
	);
}
