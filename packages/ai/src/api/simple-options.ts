// 注：streamSimple 的公共工具：把统一的 SimpleStreamOptions 变成各 Api 都能用的 StreamOptions，
// 注：并处理 maxTokens 与上下文窗口、思考预算与回答空间之间的"抢地盘"问题。
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
// OpenRouter counts the input with its own tokenizer and rejects input + max_tokens above the
// window before routing. It counted prose up to 12% above the provider's count (#10497).
// 译：OpenRouter 用自己的分词器计算输入，路由前就会拒绝 input + max_tokens 超过窗口的请求。
// 译：它对普通文本的计数比服务方最多高出 12%（#10497）。
const CONTEXT_SAFETY_RATIO = 0.15;
// The 15% margin is kept only while it leaves at least this much output. Otherwise (a nearly full
// large window, or any small window such as a 32k local model) only the fixed margin is kept, and
// output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
// 译：只有在留下至少这么多输出空间时，才保留 15% 的余量。否则（大窗口快满了，或任何小窗口，如 32k 的本地模型）
// 译：只保留固定余量，并把输出上限设为这个值，让 OpenRouter 多算的部分在触发压缩前还能撑一阵。
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
const MIN_MAX_TOKENS = 1;

/** Fit maxTokens into the context window, leaving room for the input being counted higher than estimated. */
/** 译：把 maxTokens 塞进上下文窗口，并为"输入实际计数比估算高"留出余量。 */
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	// 注：例：窗口 128k，估算输入 100k → 余量 max(4096, 15k)=15k → room=13k < 32768
	// 注：→ 改用 min(32768, 128k-100k-4096)=23904。最终 maxTokens = min(请求值, room)，且至少为 1。
	const input = estimateContextTokens(context).tokens;
	const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
	let room = model.contextWindow - input - margin;
	if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
		room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
	}
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
}

// 注：采样参数（temperature/top_p 等）合并：模型默认 < 按思考等级的默认 < 本次请求，后者覆盖前者。
export function resolveSamplingParams(
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams
		? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: undefined;
}

// 注：SimpleStreamOptions → StreamOptions 的通用部分。几乎是逐字段透传，只有 maxTokens 被夹紧、samplingParams 被合并。
// 注：reasoning（思考等级）不在这里处理，因为每家的思考参数不同，由各 Api 的 streamSimple 自己翻译。
export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetry: options?.telemetry,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		disableContinuation: options?.disableContinuation,
		headers: options?.headers,
		identity: options?.identity,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
/** 译：思考预算与回答共享输出上限时，始终给回答留下的 token 数。 */
export const MIN_ANSWER_TOKENS = 1024;

// 注：各思考等级的默认 token 预算（用于需要显式预算的 API，如 Anthropic 的 budget_tokens）。
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

// 注：只支持到 high 的 API，把 xhigh/max 降为 high。
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const level = clampReasoning(reasoningLevel)!;
	return budgets[level]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
/** 译：给思考预算封顶，保证在共享的输出上限内至少还剩 MIN_ANSWER_TOKENS 给回答。 */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	// 译：undefined 表示调用方没有显式上限，此时用模型上限，并把思考装进其中。
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	// 注：调用方给了上限时，maxTokens = 上限 + 思考预算（思考另算，不挤占回答），但不超过模型上限。
	// 注：若总量连思考预算都装不下，就压缩思考预算，给回答留出 MIN_ANSWER_TOKENS。
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
