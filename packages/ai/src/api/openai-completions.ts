// 注：本文件是 "openai-completions" 这个 Api 的实现：把 pi 的 Context 翻译成 OpenAI Chat Completions 请求，
// 注：再把 SSE 流式 chunk 翻译回 pi 的 AssistantMessageEvent。DeepSeek、OpenRouter、Moonshot 等"OpenAI 兼容"服务都走这里。
// 注：阅读顺序：stream（主流程）→ streamSimple → createClient → buildParams → convertMessages → convertTools
// 注：→ parseChunkUsage → mapStopReason → detectCompat / getCompat（兼容层：同一协议下各家差异的开关表）。
// 注：可跳过：grammar/custom 工具、reasoning_details、cache_control、chat-template 等细节，第一遍知道"有这回事"即可。
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { learnLog, learnVerbose } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import {
	applyOpenRouterReportedCost,
	isOpenRouterModel,
	type OpenRouterUsageAccounting,
} from "../utils/openrouter-cost.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	closeGrammarToolInputJson,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	buildBaseOptions,
	clampThinkingBudgetToAnswerRoom,
	resolveSamplingParams,
	thinkingBudgetForLevel,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 * 译：检查对话消息中是否含工具调用或工具结果。之所以需要，是因为（经代理的）Anthropic
 * 要求：消息里有 tool_calls 或 tool 角色消息时，必须同时带上 tools 参数。
 */
// 注：上面那段注释描述的其实是下方的 hasToolHistory；hasHeader 只是大小写不敏感地检查某个请求头是否存在且非空。
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

// 注：取 API key。没有 key 但调用方自带 Authorization 头（如 Cloudflare AI Gateway）时，
// 注：用占位值 "unused" 通过 SDK 的必填检查，真正的认证走请求头。
function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

// 注：对话历史里是否出现过工具调用/结果。配合 compat.requiresToolsWithToolHistory 使用。
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

// 注：本 Api 专属选项 = 通用 StreamOptions + toolChoice + reasoningEffort（思考强度）+ thinkingBudgets。
export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Token budgets per thinking level. Used when `compat.thinkingTokenBudgetField` or `compat.supportsThinkingTokenBudget` is set, or by `{ "$var": "thinking.budget" }`. */
	/** 译：每个思考等级对应的 token 预算。设置了 compat.thinkingTokenBudgetField 或 supportsThinkingTokenBudget，或使用 { "$var": "thinking.budget" } 时生效。 */
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

// 注：兼容开关"解析后"的完整版本：每个字段都有确定值（自动探测值被 model.compat 覆盖后的结果），见文件末尾 getCompat。
type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "promptCacheKeyMode"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	promptCacheKeyMode?: OpenAICompletionsCompat["promptCacheKeyMode"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

type ResolvedChatTemplateKwargValue = string | number | boolean | null;

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

// 注：缓存保留策略：显式参数优先，其次环境变量 PI_CACHE_RETENTION=long，默认 "short"。
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

// 注：主流程。结构和 lazy.ts 一样：同步返回 stream，真正的工作在下面的 async IIFE 里后台执行，
// 注：所有失败都在 catch 里转成 error 事件，绝不 throw 给调用方。
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	// 注：把 TranscriptContext 规整成消息列表（服务不支持对话中途的 system 消息时，会折叠处理）。
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
	// 注：[调试] 不支持中途 system 消息的服务，这里前后的角色序列会不同（多条 system 被折叠）
	learnLog("openai", "resolveTranscript 前后的消息角色", {
		before: context.messages.map((m) => m.role),
		after: normalizedContext.messages.map((m) => m.role),
	});
	const learnStartedAt = Date.now();

	// 注：async IIFE：立即执行但不 await，让 stream 先返回给调用方。
	(async () => {
		// 注：output 是"正在生长的"最终消息。每个事件的 partial 都指向它；stopReason 先置为 "pending"，结束时再定。
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		// `reasoning_details` are replay metadata, not user-visible stream deltas.
		// Keep them in memory during streaming and serialize once when the block is finalized.
		// 译：reasoning_details 是用于回放的元数据，不是给用户看的流式增量。流式期间先放内存，块结束时一次性序列化。
		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			if (streamedReasoningDetails !== undefined) {
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		try {
			// 注：===== 第 1 步：准备请求 =====
			// 注：取 key → 解析兼容开关 → 建 SDK 客户端 → 拼请求体。任何一步抛错都会落到下面的 catch。
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			// 注：[调试] 兼容层的关键开关：决定思考参数格式、max_tokens 字段名、是否回传 reasoning_content 等
			learnLog("openai", "compat（兼容开关，DeepSeek 由 detectCompat/catalog 决定）", {
				thinkingFormat: compat.thinkingFormat,
				maxTokensField: compat.maxTokensField,
				requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages,
				supportsFinishReason: compat.supportsFinishReason,
				supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
				supportsDeveloperRole: compat.supportsDeveloperRole,
			});
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			// 注：缓存策略为 none 时不传 sessionId，也就不发会话亲和头。
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.identity,
				options?.fetch,
				cacheSessionId,
				compat,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				cacheRetention,
				grammarToolInputProperties,
			);
			// 注：onPayload 钩子：调用方能看到（甚至替换）最终请求体。调试"到底发了什么"就靠它。
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			// 注：[调试] 最终请求体摘要：messages 和 tools 只显示概况，其余字段原样打印（思考参数、max_tokens 都在这里）
			const { messages: learnMessages, tools: learnTools, ...learnRest } = params;
			learnLog("openai", "buildParams 完成，请求体摘要", {
				...learnRest,
				messages: learnMessages.map((m) => m.role),
				tools: learnTools?.map((t) => (t.type === "function" ? t.function.name : t.type)),
			});
			learnVerbose(
				"openai",
				"完整请求体 messages（convertMessages 的输出）",
				JSON.stringify(learnMessages, null, 2),
			);
			// 注：SDK 自带重试关掉（maxRetries: 0），统一交给 pi 的 retryProviderRequest，所有 provider 的重试策略一致。
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			// 注：onResponse 钩子：拿到 HTTP 状态码和响应头（比如限流相关的头）。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			learnLog(
				"openai",
				`HTTP 已连通: status=${response.status} (+${Date.now() - learnStartedAt}ms，即首包前的等待)`,
			);
			// 注：===== 第 2 步：HTTP 已连通，发出 start 事件，开始消费 SSE 流 =====
			stream.push({ type: "start", partial: output });

			// Stream state of a tool call, kept off the content block so it never reaches partials: JSON arguments, or
			// the input of a grammar (custom) tool.
			// 译：工具调用的流式状态，故意不挂在内容块上，这样永远不会泄漏进 partial：要么是 JSON 参数，要么是 grammar（custom）工具的输入。
			type ToolCallInput =
				| { readonly kind: "json"; readonly arguments: ToolCallArgumentsStream }
				| { readonly kind: "custom"; readonly property: string; readonly buffer: GrammarToolInputJsonBuffer };
			type ToolCallState = { streamIndex: number | undefined; input: ToolCallInput };
			type StreamingBlock = TextContent | ThinkingContent | ToolCall;
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			// 注：当前正在写的 text / thinking 块（同一时刻各最多一个）。
			// 注：工具调用块可能有多个并行，所以用 Map 按 chunk 里的 index 和 id 两种方式查找。
			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, ToolCall>();
			const toolCallBlocksById = new Map<string, ToolCall>();
			const toolCallStates = new Map<ToolCall, ToolCallState>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const customInput = (property: string): ToolCallInput => ({
				kind: "custom",
				property,
				buffer: { input: "", started: false, closed: false },
			});
			// 注：结束一个内容块：按类型发出 text_end / thinking_end / toolcall_end。工具调用在这里才拿到最终解析好的参数。
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					const input = toolCallStates.get(block)!.input;
					toolCallStates.delete(block);
					if (input.kind === "custom") {
						const delta = closeGrammarToolInputJson(input.buffer, input.property, undefined);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						// 注：JSON 参数流结束：做最终解析，把结果写回 block.arguments。
						Object.assign(block, input.arguments.finish());
					}
					// 注：[调试] 工具参数在流式过程中是"尽力解析的部分对象"，这里是 finish() 后的最终值
					learnLog("openai", `toolcall_end: ${block.name}`, { id: block.id, arguments: block.arguments });
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			// 注：ensureXxxBlock：块不存在就创建、推入 content、发出 *_start 事件；已存在就直接返回。保证 start 只发一次。
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					learnLog("openai", `text_start（第一个正文增量到达，+${Date.now() - learnStartedAt}ms）`);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					// 注：[调试] thinkingSignature 记录思考来自哪个字段，DeepSeek 应是 reasoning_content
					learnLog(
						"openai",
						`thinking_start（思考字段 "${thinkingSignature}"，+${Date.now() - learnStartedAt}ms）`,
					);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			// 注：找到（或新建）这个 delta 所属的工具调用块。优先按 index 找，其次按 id 找。
			// 注：原因：不同服务的 chunk 有的只带 index、有的只在首个 chunk 带 id，两种都要兼容。
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					// Note: the "input" fallback here should/must not be taken.  in case the LLM makes up
					// a tool we don't knwo about, we at least have a place to stash our stuff.
					// 译：注意：这里的 "input" 兜底分支按理不该走到。万一 LLM 编造了一个我们不认识的工具，至少有个地方存放它的数据。
					const customInputProperty =
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: customInputProperty !== undefined ? { [customInputProperty]: "" } : {},
					};
					toolCallStates.set(block, {
						streamIndex,
						input:
							customInputProperty !== undefined
								? customInput(customInputProperty)
								: { kind: "json", arguments: new ToolCallArgumentsStream() },
					});
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					learnLog("openai", `toolcall_start: name="${name}" id="${toolCall.id ?? ""}" index=${streamIndex}`);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				const state = toolCallStates.get(block)!;
				if (streamIndex !== undefined && state.streamIndex === undefined) {
					state.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				if (toolCall.custom && !toolCall.function && state.input.kind !== "custom") {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					state.input = customInput(customInputProperty);
				}
				return { block, state };
			};

			// 注：===== 第 3 步：逐个消费 SSE chunk =====
			// 注：每个 chunk 可能带：usage（通常在最后一个）、finish_reason、思考增量、文本增量、工具调用增量。
			let learnChunkCount = 0;
			for await (const chunk of openaiStream) {
				learnChunkCount++;
				// 注：[调试] verbose 模式下打印每个原始 SSE chunk，对照下面的解析逻辑看
				learnVerbose("openai", `chunk #${learnChunkCount}`, JSON.stringify(chunk));
				await options?.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				// 译：OpenAI 文档说明 ChatCompletionChunk.id 是本次补全的唯一标识，同一次流式补全的每个 chunk 都带同一个 id。
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				// 注：用量通常在最后一个 chunk 里（前提是请求带了 stream_options.include_usage）。
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
					// 注：[调试] 对照原始 usage 和解析结果：cached tokens 会从 prompt_tokens 里拆出来变成 cacheRead
					learnLog("openai", "usage 原始值 → parseChunkUsage 结果", { raw: chunk.usage, parsed: output.usage });
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// Fallback: some providers (e.g., Moonshot) return usage
				// in choice.usage instead of the standard chunk.usage
				// 译：兜底：有些服务（如 Moonshot）把 usage 放在 choice.usage，而不是标准的 chunk.usage。
				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				// 注：finish_reason 到达 = 模型说"我说完了"。映射成 pi 的 StopReason，原始值保留在 rawStopReason 便于排查。
				if (choice.finish_reason) {
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					learnLog(
						"openai",
						`finish_reason "${choice.finish_reason}" → stopReason "${finishReasonResult.stopReason}"`,
					);
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					// Handle reasoning before content: some proxies (e.g. LiteLLM) aggregate reasoning and
					// answer into one delta, and the thinking block must precede the text block.
					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					// Use the first non-empty reasoning field to avoid duplication
					// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
					// 译：先处理思考再处理正文：有些代理（如 LiteLLM）会把思考和回答合并进同一个 delta，而思考块必须排在文本块之前。
					// 译：有的端点把思考放在 reasoning_content（llama.cpp），有的放在 reasoning（其他 OpenAI 兼容端点）。
					// 译：只取第一个非空的思考字段，避免重复（例如 chutes.ai 会同时返回内容相同的 reasoning_content 和 reasoning）。
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							// 注：thinkingSignature 记下"思考来自哪个字段"，下一轮回放历史时按同名字段发回去（见 convertMessages）。
							const thinkingSignature =
								model.provider === "opencode-go" && foundReasoningField === "reasoning"
									? "reasoning_content"
									: foundReasoningField;
							const block = ensureThinkingBlock(thinkingSignature);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							ensureThinkingBlock("");
							streamedReasoningDetails ??= [];
							// Keep provider replay data in the existing signature slot. OpenRouter streams
							// reasoning_details as deltas: consecutive text/summary deltas are merged into
							// logical entries, while encrypted entries remain opaque and discrete.
							// 译：把服务方的回放数据放进现有的 signature 槽位。OpenRouter 以增量形式流式发送 reasoning_details：
							// 译：连续的 text/summary 增量合并成逻辑条目，加密条目保持不透明、各自独立。
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}

					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						// 注：普通文本增量：追加到文本块，并发出 text_delta。
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// 注：工具调用增量：参数 JSON 以字符串碎片到达，ToolCallArgumentsStream 边累积边尽量解析，
					// 注：所以流式过程中 block.arguments 是"尽力解析出的部分对象"，最终值在 finishBlock 里确定。
					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const { block, state } = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							const input = state.input;
							if (toolCall.function?.arguments && input.kind === "json") {
								delta = toolCall.function.arguments;
								block.arguments = input.arguments.append(delta);
							} else if (toolCall.custom?.input && input.kind === "custom") {
								delta =
									appendGrammarToolInputJsonDelta(input.buffer, input.property, toolCall.custom.input) ?? "";
								block.arguments = { [input.property]: input.buffer.input };
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}
				}
			}

			// 注：===== 第 4 步：流结束，收尾并判定结果 =====
			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			// 注：有的服务从不发 finish_reason（compat.supportsFinishReason=false），只能按"有没有工具调用"推断。
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			// 注：本该有 finish_reason 却没有，说明连接中途断了。按错误处理，避免把半截回答当成功。
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			// 注：成功路径：done 事件 + end()。
			learnLog(
				"openai",
				`成功结束: stopReason=${output.stopReason}，共 ${learnChunkCount} 个 chunk，+${Date.now() - learnStartedAt}ms`,
				{
					content: output.content.map((b) =>
						b.type === "text"
							? `text(${b.text.length} 字符)`
							: b.type === "thinking"
								? `thinking(${b.thinking.length} 字符, signature=${b.thinkingSignature})`
								: `toolCall(${b.name})`,
					),
					usage: output.usage,
				},
			);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
			}
			// 注：===== 失败路径 =====：已流出的内容保留在 output 里，stopReason 定为 aborted 或 error，
			// 注：错误信息规范化后推 error 事件。调用方从 stopReason / errorMessage 判断，而不是 try/catch。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// Some providers via OpenRouter give additional information in this field.
			// normalizeProviderError already stringifies the parsed body (error.error)
			// into errorMessage, so only append the raw metadata when it is not already
			// present to avoid double-printing it.
			// 译：有些经 OpenRouter 的服务会在这个字段给出额外信息。normalizeProviderError 已把解析后的 body（error.error）
			// 译：字符串化进 errorMessage，所以只有原始 metadata 还没出现时才追加，避免重复打印。
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			learnLog("openai", `失败结束: stopReason=${output.stopReason}`, output.errorMessage);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	// 注：同步返回。此时 IIFE 可能还没发出任何请求。
	return stream;
};

// 注：streamSimple：统一的"简单选项"入口（reasoning: "low" | "high" ...），翻译成本 Api 的专属选项后调 stream。
// 注：上层（agent）一般只用 streamSimple，不必知道每家 provider 的参数差异。
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// 注：提前校验 key，没有就直接抛错。这里在 stream 外面，是少数会 throw 的地方；经 lazyApi 调用时由 lazyStream 转成 error 事件。
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	// 注：buildBaseOptions 处理通用项：maxTokens 按上下文窗口夹紧、temperature、signal、headers 等（见 simple-options.ts）。
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	// 注：把请求的思考等级夹到模型支持的范围内（先向上找，再向下找）；"off" 表示不传 reasoningEffort。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};

// 注：构造 OpenAI SDK 客户端。重点是请求头的合并顺序：
// 注：身份头 + model.headers → Copilot 动态头 → 会话亲和头 → 调用方 headers（最后合并，优先级最高）。
function createClient(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	const headers: ProviderHeaders = { ...getIdentityHeaders(model, identity), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	// 注：会话亲和：让同一会话的请求尽量落到同一后端，提高前缀缓存命中率。OpenRouter 用 x-session-id，其他用 session_id 等。
	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	// 译：最后合并调用方传入的 headers，使其能覆盖默认值。
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	// 注：dangerouslyAllowBrowser：pi-ai 也要在浏览器里跑，所以显式允许。fetch 可注入，便于测试和代理。
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

// 注：拼 Chat Completions 请求体。顺序：消息转换 → 基础字段 → maxTokens/temperature → tools → 缓存标记
// 注：→ 各家思考参数 → 路由偏好 → 采样参数（放最后，优先级最高）。
function buildParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? "additions"
			: "none",
	);
	// 注：pi 的消息 → OpenAI 格式消息，核心转换见下方 convertMessages。
	const messages = convertMessages(model, context, compat, {
		grammarToolInputProperties,
	});
	const cacheControl = getCompatCacheControl(compat, cacheRetention);
	// 注：prompt_cache_key：OpenAI 前缀缓存的路由键。auto 模式下只对 api.openai.com 或长缓存开启。
	const promptCacheKeyMode = compat.promptCacheKeyMode ?? "auto";
	const supportsPromptCacheKey =
		promptCacheKeyMode === "enabled" ||
		(promptCacheKeyMode === "auto" &&
			(model.baseUrl.includes("api.openai.com") ||
				(cacheRetention === "long" && compat.supportsLongCacheRetention)));

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			cacheRetention !== "none" && supportsPromptCacheKey
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	// 注：要求流式返回 usage，否则拿不到 token 用量和费用。
	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	// 注：store=false：不让 OpenAI 存储本次对话。非标准服务不认这个字段，所以由 compat 控制。
	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			// Deprecated by OpenAI, but some OpenAI-compatible providers only accept max_tokens.
			// 译：OpenAI 已弃用 max_tokens，但有些 OpenAI 兼容服务只认 max_tokens。
			(params as { max_tokens?: number }).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	// 注：有工具就转换成 OpenAI tools；没有工具、但历史里有工具调用且服务要求时，传空数组 tools: []。
	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertTools(transcriptTools.requestTools, compat);
		if (compat.zaiToolStream) {
			(params as any).tool_stream = true;
		}
	} else if (compat.requiresToolsWithToolHistory && hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (compat.vllmPriority !== undefined) {
		(params as any).priority = compat.vllmPriority;
	}

	// 注：===== 思考参数：各家写法完全不同，由 compat.thinkingFormat 选分支 =====
	// 注：deepseek: thinking:{type}；zai: thinking + reasoning_effort；qwen: enable_thinking；openrouter: reasoning:{effort}；
	// 注：默认 openai: reasoning_effort。model.thinkingLevelMap 把 pi 的等级映射成该模型认的值（null 表示不支持）。
	// 注：第一遍只看 deepseek 分支和最后的 OpenAI 默认分支即可。
	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		(params as any).enable_thinking = !!options?.reasoningEffort;
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			if (typeof effort === "string") {
				(params as any).reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as any).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		if (chatTemplateKwargs) {
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			reasoning_effort?: string;
		};
		const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
		if (chatTemplateArgs) {
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		if (compat.supportsReasoningEffort) {
			const requestedEffort = options?.reasoningEffort;
			const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			if (typeof effort === "string") {
				basetenParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		// 注：DeepSeek：开思考发 thinking:{type:"enabled"}；关思考时，除非 thinkingLevelMap.off 为 null（不可关），否则显式发 disabled。
		if (options?.reasoningEffort) {
			(params as any).thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			(params as any).thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			(params as any).reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		// 译：OpenAI 风格的 reasoning_effort。
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	// Cap reasoning with a top-level budget field. Independent of thinkingFormat: the
	// same server can serve zai, qwen or chat-template models. Reasoning and the answer
	// share max_tokens here, so an uncapped reasoning phase can consume the whole
	// response and leave no answer and no tool call.
	// 译：用一个顶层预算字段给思考封顶。这与 thinkingFormat 无关：同一台服务器可能同时服务 zai、qwen 或 chat-template 模型。
	// 译：这里思考和回答共用 max_tokens，不封顶的话思考阶段可能吃光全部额度，最后既没有回答也没有工具调用。
	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	// OpenRouter provider routing preferences
	// 译：OpenRouter 的上游服务路由偏好。
	if (model.compat?.openRouterRouting) {
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	// 译：Vercel AI Gateway 的上游服务路由偏好。
	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	// Last so model and request sampling parameters override named request fields.
	// 译：放在最后，让模型和请求级别的采样参数覆盖前面的具名字段。
	const samplingParams = resolveSamplingParams(model, options?.reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function resolveThinkingTokenBudgetField(
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

// 注：思考预算 = 等级对应的预算，再夹紧到给回答留出空间（不能让思考占满 max_tokens）。
function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

// 注：chat-template / baseten 格式：把配置里的 { $var: "thinking.enabled" } 之类占位符解析成实际值（vLLM/SGLang 自部署模型常用）。可跳过。
function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}

	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

// 注：以下几个函数给"走 OpenAI 兼容协议的 Anthropic 模型"（如 OpenRouter 上的 anthropic/*）打 cache_control 标记。可跳过。
function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

// 注：打三处缓存断点：system 提示、最后一个工具、最后一条对话消息，与 Anthropic 原生 API 的缓存策略一致。
function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionToolMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

// 注：===== 消息转换：pi 的 Message[] → OpenAI 的 ChatCompletionMessageParam[] =====
// 注：pi 的消息是与 provider 无关的统一格式；这里负责翻译成 Chat Completions 的形状，并处理各家怪癖：
// 注：tool call id 的长度/字符限制、思考内容如何回放、工具结果里的图片、空 assistant 消息等。
export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const params: ChatCompletionMessageParam[] = [];

	// 注：工具调用 id 规范化：别的 API（如 Responses）产生的 id 可能带 "|"、超长，而 OpenAI 要求 ≤40 字符且字符受限。
	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		// Multiple tool calls in the same turn can share call_id but differ by item_id.
		// Preserve item-level uniqueness when replaying into Chat Completions, which
		// requires distinct tool call ids.
		// 译：处理来自 OpenAI Responses API 的竖线分隔 id。
		// 译：格式：{call_id}|{id}，其中 {id} 可能长达 400+ 字符，且含特殊字符（+、/、=）。
		// 译：这类 id 来自 github-copilot、openai-codex、opencode 等服务。只取 call_id 部分并规范化。
		// 译：同一轮里的多个工具调用可能共享 call_id 但 item_id 不同。回放进 Chat Completions 时要保留条目级唯一性，
		// 译：因为它要求工具调用 id 互不相同。
		if (id.includes("|")) {
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			// 译：只保留允许的字符，并截断到 40 字符（OpenAI 的限制）。
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	// 注：先走跨 provider 的通用转换（transform-messages.ts）：丢掉别家模型的思考、补齐孤儿工具调用的结果、降级图片等。
	const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? "additions"
			: "none",
	);
	// 注：推理模型在服务支持时用 developer 角色承载系统提示（OpenAI 推理模型的约定），否则用 system。
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	let lastRole: string | null = null;
	let systemIndex = 0;

	// 注：逐条转换。注意 toolResult 分支会一次吃掉连续的多条工具结果（在内部推进 i）。
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		// 译：有些服务不允许 user 消息紧跟在工具结果后面，插入一条合成的 assistant 消息来衔接。
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "system") {
			// transformMessages keeps system messages in order, so their position matches the transcript.
			// 译：transformMessages 会保持 system 消息的顺序，所以它们的位置与 transcript 一致。
			const addedTools = systemIndex++ >= transcriptTools.foldedSystemMessages ? (msg.toolsAdded ?? []) : [];
			if (addedTools.length > 0) {
				const kimiToolMessage: KimiToolSystemMessageParam = {
					role: "system",
					tools: convertTools(addedTools, compat),
				};
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}
			// 注：第一条是真正的系统提示；对话中途的 system 消息渲染成"更新说明"文本。
			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) {
				params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		} else if (msg.role === "user") {
			// 注：user：纯字符串直接发；多模态数组里，图片转成 data URL 形式的 image_url，空文本块过滤掉。
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content
					.filter((item) => item.type !== "text" || item.text.length > 0)
					.map((item): ChatCompletionContentPart => {
						if (item.type === "text") {
							return {
								type: "text",
								text: sanitizeSurrogates(item.text),
							} satisfies ChatCompletionContentPartText;
						} else {
							return {
								type: "image_url",
								image_url: {
									url: `data:${item.mimeType};base64,${item.data}`,
								},
							} satisfies ChatCompletionContentPartImage;
						}
					});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// 注：assistant：文本合并为字符串；思考按 thinkingSignature 记下的字段名回放（如 reasoning_content）；工具调用转 tool_calls。
			// Some providers don't accept null content, use empty string instead
			// 译：有些服务不接受 null 的 content，改用空字符串。
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult || compat.requiresNonNullAssistantContent ? "" : null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					// 译：把思考块转成纯文本（不加标签，避免模型模仿标签格式）。
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// Always send assistant content as a plain string (OpenAI Chat Completions
					// API standard format). Sending as an array of {type:"text", text:"..."}
					// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
					// NVIDIA NIM) to mirror the content-block structure literally in their
					// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
					// 译：assistant 的 content 始终以纯字符串发送（OpenAI Chat Completions 的标准格式）。以 {type:"text", text:"..."}
					// 译：对象数组发送不标准，会让某些模型（如经 NVIDIA NIM 的 DeepSeek V3.2）在输出里照抄这种结构，产生递归嵌套。
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// reasoning_details is the structured alternative to a raw reasoning field.
					// 译：reasoning_details 是原始 reasoning 字段的结构化替代方案。
					if (!preservedReasoningDetails) {
						// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
						// 译：如有，使用第一个思考块的 signature（用于 llama.cpp server + gpt-oss）。
						// 注：signature 就是流式时记下的字段名。这里用它把思考原样塞回同名字段，DeepSeek 等服务要求回传 reasoning_content。
						let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (model.provider === "opencode-go" && signature === "reasoning") {
							signature = "reasoning_content";
						}
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				// 译：同上：assistant 的 content 始终以纯字符串发送，避免某些模型照抄内容块结构、产生递归嵌套。
				assistantMsg.content = assistantText;
			}

			// 注：工具调用：参数对象重新 JSON.stringify 成字符串（OpenAI 协议要求 arguments 是字符串）。
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}
			// Skip assistant messages that have no content and no tool calls.
			// Some providers require "either content or tool_calls, but not none".
			// Other providers also don't accept empty assistant messages.
			// This handles aborted assistant responses that got no content.
			// 译：跳过既没内容也没工具调用的 assistant 消息。有些服务要求"content 或 tool_calls 至少有一个"，
			// 译：还有些服务不接受空的 assistant 消息。这也处理了被中止、没产生内容的 assistant 回复。
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// 注：toolResult：Chat Completions 的 tool 消息只能放文本，所以图片单独收集，之后作为一条 user 消息附上。
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				// 译：提取文本和图片内容。
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// Always send tool result with text (or placeholder if only images)
				// 译：工具结果总要带文本（只有图片时用占位文本）。
				const hasText = textResult.trim().length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// Some providers require the 'name' field in tool results
				// 译：有些服务要求工具结果带 'name' 字段。
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			// 注：跳过已一并处理的连续工具结果。
			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			continue;
		}

		lastRole = msg.role;
	}

	// 注：[调试] 看历史里的 assistant 消息有没有带上 reasoning_content（DeepSeek 多轮时必须回传思考）
	learnLog(
		"openai",
		"convertMessages 输出",
		params.map((m) =>
			m.role === "assistant"
				? `assistant(reasoning_content=${"reasoning_content" in m ? "有" : "无"}, tool_calls=${m.tool_calls?.length ?? 0})`
				: m.role,
		),
	);
	return params;
}

// 注：pi 的 Tool（JSON Schema 参数）→ OpenAI tools。普通工具走 function；声明了 grammar 且服务支持时走 custom 工具（可跳过）。
function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// Only include strict if provider supports it. Some reject unknown fields.
				// 译：只有服务支持时才带 strict 字段，有些服务会拒绝未知字段。
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

// 注：把各家 usage 字段统一成 pi 的 Usage，并计算费用。
// 注：关键：pi 的 input 是"未命中缓存的输入"，要从 prompt_tokens 里扣掉缓存读和缓存写。
function parseChunkUsage(
	// OpenRouter adds billing fields to streamed usage at runtime,
	// although the OpenAI SDK does not type those fields.
	// 译：OpenRouter 会在运行时往流式 usage 里加计费字段，尽管 OpenAI SDK 没有为这些字段声明类型。
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
		reasoning_tokens?: number;
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
	// tokens (hits). Providers disagree on placement: OpenAI/OpenRouter use
	// prompt_tokens_details.cached_tokens, DeepSeek uses prompt_cache_hit_tokens,
	// and Kimi documents top-level usage.cached_tokens on the final usage chunk.
	// OpenAI does not document or emit cache_write_tokens, but
	// OpenRouter-compatible providers can include it as a separate write count.
	// OpenRouter's own provider/tests affirm the separate mapping:
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// Do not subtract writes from cached_tokens, otherwise spec-compliant
	// providers are under-reported. DS4 mirrors this contract too:
	// https://github.com/antirez/ds4/pull/29
	// 译：遵循 OpenAI/OpenRouter 的文档语义：cached_tokens 是缓存读取（命中）的 token。各家放的位置不同：
	// 译：OpenAI/OpenRouter 用 prompt_tokens_details.cached_tokens，DeepSeek 用 prompt_cache_hit_tokens，
	// 译：Kimi 在最后一个 usage chunk 的顶层 usage.cached_tokens。OpenAI 不记录也不返回 cache_write_tokens，
	// 译：但兼容 OpenRouter 的服务可能单独给出写入数（OpenRouter 自己的 provider 和测试也确认了这种分开映射）。
	// 译：不要从 cached_tokens 里减去写入数，否则符合规范的服务会被少算。DS4 也遵循这一约定。
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens already includes reasoning_tokens.
	// 译：OpenAI 的 completion_tokens 已经包含 reasoning_tokens（所以 output 不再另加）。
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || rawUsage.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// 注：按模型价格表算费用；OpenRouter 若返回了实际计费，用实际值覆盖。
	calculateCost(model, usage);
	if (isOpenRouterModel(model)) {
		applyOpenRouterReportedCost(usage, rawUsage as typeof rawUsage & OpenRouterUsageAccounting);
	}
	return usage;
}

// 注：OpenAI 的 finish_reason → pi 的 StopReason。stop/length/toolUse 是正常结束；content_filter 等一律算 error 并带上原因。
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Auto-detect compatibility settings from provider name and baseUrl.
 * Used as the base when model.compat is not set; explicit model.compat
 * entries override these detected values.
 * 译：根据 provider 名称和 baseUrl 自动探测兼容设置。model.compat 未设置时作为基础值；
 * 显式的 model.compat 条目会覆盖这些探测值。
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	// 注："非标准"服务：不认 store、developer 角色等 OpenAI 专有字段。
	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	// 注：这些服务只认旧字段 max_tokens，不认 max_completion_tokens。
	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	// 注：探测结果。以 DeepSeek 为例：supportsStore=false、supportsDeveloperRole=false、maxTokensField="max_tokens"、
	// 注：thinkingFormat="deepseek"、requiresReasoningContentOnAssistantMessages=true（回放历史时 assistant 必须带 reasoning_content）。
	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresNonNullAssistantContent: false,
		requiresToolsWithToolHistory: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		// OpenAI compatibility alone does not imply strict JSON-schema tool support.
		// 译：仅仅"兼容 OpenAI"并不意味着支持严格 JSON Schema 的工具参数。
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: isOpenRouter,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Auto-detects from provider/URL then overrides with explicit model.compat.
 * 译：获取模型解析后的兼容设置：先按 provider/URL 自动探测，再用显式的 model.compat 覆盖。
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	// 注：逐字段"显式配置 ?? 探测值"。自定义一个 OpenAI 兼容服务时，只需在 model.compat 里写要改的字段。
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresNonNullAssistantContent:
			model.compat.requiresNonNullAssistantContent ?? detected.requiresNonNullAssistantContent,
		requiresToolsWithToolHistory: model.compat.requiresToolsWithToolHistory ?? detected.requiresToolsWithToolHistory,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		supportsMidConvoSystemMessages:
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions:
			model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		promptCacheKeyMode: model.compat.promptCacheKeyMode,
		vllmPriority: model.compat.vllmPriority,
	};
}
