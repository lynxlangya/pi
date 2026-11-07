// 注：本文件是 pi-ai 的类型契约，也是整个仓库（agent-core、coding-agent、durable）的地基。
// 注：阅读顺序建议：先跳到下面这几个类型读懂，其余的用到再查：
// 注：  1. 消息：TextContent / ThinkingContent / ToolCall → UserMessage / AssistantMessage / ToolResultMessage / SystemMessage → Message
// 注：  2. 上下文：Context（对外）与 TranscriptContext（对内）
// 注：  3. 事件：AssistantMessageEvent（流里的每一个事件）
// 注：  4. 模型：Model<TApi>
// 注：  5. 选项与契约：StreamOptions / SimpleStreamOptions / StreamFunction / ProviderStreams
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SystemOneCompat,
} from "./providers/compat-schema.ts";
import type {
	CacheRetention,
	ModelCost,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";
import type { ClientIdentity } from "./utils/identity.ts";

export type {
	AnthropicAllowedFallbackModel,
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	SessionAffinityFormat,
	SystemOneCompat,
	ThinkingTokenBudgetField,
	VercelGatewayRouting,
} from "./providers/compat-schema.ts";
export type {
	CacheRetention,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	ModelImageInputLimits,
	ModelImageResizeOptions,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// 注：Api = 线上协议（wire protocol）的标识。多个 provider 可以共用一个协议，
// 注：例如 deepseek、xai、groq、openrouter 都用 "openai-completions"。
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

// 注：`(string & {})` 是 TS 的小技巧：既允许任意字符串（自定义协议），又保留已知字面量的自动补全。
export type Api = KnownApi | (string & {});

// 注：图片生成和分类器的协议，阶段 1 可以跳过。
export type KnownImageApi = "openrouter-images";

export type ImageApi = KnownImageApi | (string & {});

export type KnownClassifierApi =
	| "typesafe-system-one"
	| "cloudflare-workers-ai-system-one"
	| "llama-cpp-classify"
	| "openai-decisions";

export type ClassifierApi = KnownClassifierApi | (string & {});

// 注：provider = 一个"服务商 + 认证 + 模型目录"。同一家公司可能有多个 provider（如 zai 和 zai-coding-cn）。
export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure"
	| "openai-codex"
	| "radius"
	| "typesafe"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "qwen-token-plan-individual-cn"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type ToolChoice = "auto" | "none";
export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;
/** Token budgets for each thinking level (token-based providers only) */
/** 译：每个思考级别对应的 token 预算（仅适用于按 token 控制思考的 provider） */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
// 译：所有 provider 共享的基础选项
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
/** 译：provider 范围的环境变量覆盖，优先于 process.env。 */
export type ProviderEnv = Record<string, string>;
// 注：header 值可以是 null：表示"删除下层的同名默认 header"。
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
/** 译：provider 请求共享的认证、HTTP 传输和生命周期回调。 */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** Explicit parent span for telemetry produced by this logical request. */
	/** 译：这次逻辑请求产生的遥测数据所挂靠的父 span。 */
	telemetry?: TelemetrySpan;
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 *
	 * 译：可选的 fetch 实现，用于 provider 的 HTTP 请求。
	 * 默认 `globalThis.fetch`。无法注入自定义实现的适配器可能拒绝它。不影响 WebSocket 传输。
	 * 注：可以用它加代理、记录原始 HTTP 请求、做录制回放测试。
	 */
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 *
	 * 译：provider 范围的环境变量值。对区域设置、端点占位符、代理变量等 provider 配置，优先于 process.env。
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 *
	 * 译：发送前检查或替换 provider 请求体的回调。返回 undefined 表示不改动。
	 * 注：调试私有化模型时最常用的钩子：打印实际发出的 JSON。返回新对象则会替换请求体。
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	/** 译：收到 HTTP 响应后调用的可选回调（可以读到状态码和响应头，例如限流相关的 header）。 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 *
	 * 译：请求中附加的自定义 HTTP headers，与 provider 默认值合并，调用方的值覆盖默认值。
	 * 在 AWS Bedrock 上，它们通过 Smithy `build` 阶段的中间件注入，从而被 SigV4 签名覆盖；
	 * 保留的 header（`x-amz-*`、`authorization`、`host`）会被静默忽略，以免破坏 SigV4 或 bearer 认证。
	 * 值为 null 时，会去掉 provider/API 的同名默认 header。
	 */
	headers?: ProviderHeaders;
	/**
	 * How the request identifies the calling app: `User-Agent` and provider attribution headers.
	 * Absent fields use pi-ai's defaults: a detailed `User-Agent` and no attribution.
	 *
	 * 译：请求如何表明调用方应用的身份：`User-Agent` 和 provider 的来源归属 headers。
	 * 未设置的字段使用 pi-ai 默认值：详细的 `User-Agent`，不带来源归属。
	 */
	identity?: ClientIdentity;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 *
	 * 译：HTTP 请求超时（毫秒），仅对支持的 provider/SDK 生效。例如 OpenAI 和 Anthropic 的 SDK 客户端默认 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 *
	 * 译：客户端重试的最大次数，仅对支持的 provider/SDK 生效。例如 OpenAI 和 Anthropic 的 SDK 客户端默认 2 次。
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 *
	 * 译：服务端要求等很久再重试时，最多等待的毫秒数。
	 * 如果服务端要求的等待超过这个值，请求立即失败，错误信息里带上服务端要求的等待时间，
	 * 交给更上层的重试逻辑处理，让用户能看到。默认 60000（60 秒），设为 0 表示不设上限。
	 * 注：这是一个分层设计：底层不偷偷长时间等待，把决定权交给上层（如 coding-agent 的自动重试）。
	 */
	maxRetryDelayMs?: number;
}

// 注：StreamOptions = 各协议通用的流式请求选项。各协议的专属选项（如 AnthropicOptions）在它基础上扩展。
export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 *
	 * 译：收到 HTTP 响应后、开始消费响应体流之前调用的可选回调。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional observer for each parsed provider stream event before Pi normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 * Adapter support is explicit; unsupported adapters do not invoke it.
	 *
	 * 译：在 pi 归一化之前，观察每个已解析的 provider 流事件。事件数据归适配器所有，必须只读。
	 * 适配器需要显式支持；不支持的适配器不会调用它。
	 */
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * Arbitrary sampling parameters merged into the request body as-is, after the named request
	 * fields, so keys here override them. Lets custom OpenAI-compatible servers (llama.cpp, vLLM,
	 * SGLang, ...) receive parameters pi does not model, e.g. `top_p`, `top_k`, `min_p`,
	 * `repetition_penalty`. Merged over `Model.samplingParams` per key. Only applied by
	 * OpenAI-compatible adapters (completions, responses, Azure responses); other APIs ignore it.
	 *
	 * 译：任意采样参数，原样合并进请求体，放在具名字段之后，所以这里的键会覆盖具名字段。
	 * 让自定义的 OpenAI 兼容服务器（llama.cpp、vLLM、SGLang 等）能收到 pi 没有建模的参数，
	 * 例如 `top_p`、`top_k`、`min_p`、`repetition_penalty`。按键覆盖 `Model.samplingParams`。
	 * 只有 OpenAI 兼容的适配器（completions、responses、Azure responses）使用它，其他协议忽略。
	 * 注：私有化部署调参（如 Qwen 推荐的 top_p/top_k）就靠这个字段。
	 */
	samplingParams?: SamplingParams;
	maxTokens?: number;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	// 注：传输方式（SSE/WebSocket）。只有部分 provider（如 OpenAI Codex）支持 WebSocket。
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 *
	 * 译：提示词缓存保留时长偏好，provider 会映射到自己支持的值。默认 "short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 *
	 * 译：可选的会话标识，供支持基于会话缓存的 provider 使用。provider 可以用它开启提示词缓存、
	 * 做请求路由（把同一会话的请求发到同一台机器，提高缓存命中）或其他会话相关功能。不支持的 provider 忽略它。
	 */
	sessionId?: string;
	/**
	 * Do not use or record server-side continuation state for this request (for example
	 * Anthropic message threads). Set this for replays such as cache warming, which must not
	 * replace the state of the real conversation. Providers that do not keep continuation
	 * state ignore it.
	 *
	 * 译：本次请求不使用、也不记录服务端的续接状态（例如 Anthropic 消息线程）。
	 * 用于缓存预热这类重放请求，它们不能覆盖真实对话的状态。不保存续接状态的 provider 忽略它。
	 */
	disableContinuation?: boolean;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 *
	 * 译：WebSocket 连接超时（毫秒），只覆盖建立连接的握手；连接后的流空闲超时用 timeoutMs。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 *
	 * 译：请求中附带的可选元数据。provider 提取自己认识的字段，忽略其余。
	 * 例如 Anthropic 用 `user_id` 做滥用追踪和限流。
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

// 注：Deferred（延迟响应）：先提交请求拿到一个 handle，稍后再取结果。阶段 1 可以跳过。
export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Maximum provider long-poll duration in milliseconds.
	 * Defaults to 0, which performs one status check.
	 */
	wait?: number;
}

/** Request options for best-effort deferred-response cancellation. */
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe.
 *
 * 译：把已知协议映射到它们完整的、provider 专属的流选项类型。
 * 从 API 实现模块的 type-only 导入在编译时会被擦除，所以不影响 tree-shaking。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 *
 * 译：某个协议的完整流选项。已知协议解析为具体选项类型；自定义协议字符串回退到通用形状。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports `stream` and `streamSimple`; capable modules may also
 * export deferred-response methods. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 *
 * 译：API 实现模块统一的流式契约：`src/api/` 下的每个模块都导出 `stream` 和 `streamSimple`；
 * 有能力的模块还可以导出延迟响应相关的方法。惰性包装（`lazyApi()`）和 provider 工厂把它们当作值传来传去。
 * 这是不带具体类型的分派形状；各协议的选项类型定义在实现模块自己身上，以及通过 `ApiStreamOptions` 定义在 `Provider.stream()` 上。
 * 注：createProvider({ api }) 里的 api 就是一个 ProviderStreams。想给所有请求加一层逻辑（多租户、审计），就包装它。
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and
 * `createProvider({ images })` pass these around as values.
 */
// 注：下面几个是图片生成和分类器的契约，阶段 1 可以跳过，直接看 SimpleStreamOptions。
export interface ProviderImages {
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/** The uniform contract implemented by classifier API modules. */
export interface ProviderClassifier {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	/**
	 * Divides the answer logits by this value before they are normalized into probabilities.
	 * Values above 1 soften the distribution; values below 1 sharpen it. Must be positive.
	 * APIs that cannot apply it ignore it.
	 */
	temperature?: number;
}

export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
// 译：传给 streamSimple() 和 completeSimple() 的统一选项，包含推理级别
// 注：Simple 版本的价值：用一个 reasoning 级别屏蔽各家不同的推理参数。上层（agent-core）只用这个。
export interface SimpleStreamOptions extends StreamOptions {
	/** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */
	/** 译：与 provider 无关的工具选择。不设时，适配器按各 provider 的默认行为。 */
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	// 注：统一的思考级别：minimal | low | medium | high | xhigh | max。不设表示关闭思考。
	/** Ask a capable provider to return a durable handle and continue the request asynchronously. */
	/** 译：请求有能力的 provider 返回一个持久的 handle，并异步继续处理请求。 */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** Custom token budgets for thinking levels (token-based providers only) */
	/** 译：自定义各思考级别的 token 预算（仅适用于按 token 控制思考的 provider） */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Receives a normalized transcript: the system prompt and tools live in the
//   leading system message, never on the context itself.
// - Must return an AssistantMessageEventStream.
// - Direct streamSimple() calls may throw synchronously when request auth is
//   missing. Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
// 译：带选项类型的通用 StreamFunction。
// 译：契约：
// 译：- 收到的是归一化后的 transcript：系统提示词和工具放在开头的 system 消息里，绝不放在 context 本身上。
// 译：- 必须返回一个 AssistantMessageEventStream。
// 译：- 直接调用 streamSimple() 时，如果缺少请求认证，可以同步抛异常。一旦返回了流，
// 译：  请求、模型、运行时的失败都应该编码进这个流里。
// 译：- 以错误终止时，必须通过流协议发出一条 stopReason 为 "error" 或 "aborted"、带 errorMessage 的 AssistantMessage。
// 注：这是协议层最核心的契约。自己写一个新协议适配器时，必须遵守这四条。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export type ClassifierFunction<TOptions extends ClassifierOptions = ClassifierOptions> = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: TOptions,
) => Promise<ClassifierResult>;

// 注：======== 以下是消息的内容块（content blocks） ========
// 注：一条消息的 content 是一个块数组，每块有 type 字段区分：text / thinking / image / toolCall。
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
	// 译（上一行）：例如 OpenAI Responses 的消息元数据（旧版是 id 字符串，新版是 TextSignatureV1 的 JSON）
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // Provider-specific opaque or serialized reasoning replay data
	// 译（上一行）：provider 特有的不透明数据或序列化的推理回放数据
	// 注：签名只对产生它的模型有效。换模型时 transform-messages.ts 会丢弃整个 thinking 块。
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	/** 译：为 true 时，表示思考内容被安全过滤器脱敏了。不透明的加密数据存放在 `thinkingSignature` 里，
	 *  以便多轮对话时回传给 API，保持连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	// 译（上两行）：data 是 base64 编码的图片数据；mimeType 如 "image/jpeg"、"image/png"
}

// 注：模型发起的一次工具调用。id 用来和后面的 ToolResultMessage.toolCallId 配对。
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	// 译（上一行）：Google 专属：用于复用思考上下文的不透明签名
	/** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
	/** 译：OpenAI Responses 中，调用动态加载或带命名空间的工具时使用的命名空间。 */
	namespace?: string;
	/**
	 * Set when the model's complete arguments text was not a valid JSON object. `arguments` is then `{}`.
	 * Describes the problem and includes the text the model sent; tool argument validation fails with it.
	 *
	 * 译：当模型发来的完整参数文本不是合法的 JSON 对象时设置，此时 `arguments` 为 `{}`。
	 * 内容描述问题并包含模型发送的原文；工具参数校验会以它为理由失败。
	 * 注：这里也体现了"不抛异常"：坏 JSON 不会让流崩掉，而是变成一次可以回给模型的校验失败。
	 */
	argumentsError?: string;
}

// 注：token 用量与成本。每条 AssistantMessage 都带一份。
// 注：input = 非缓存输入 token；cacheRead = 命中缓存的输入；cacheWrite = 写入缓存的输入；output 包含 reasoning。
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	/** 译：`cacheWrite` 中以 1 小时保留时长写入的部分。只有 Anthropic 报告这个拆分。 */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 *
	 * 译：推理/思考 token 数（provider 报告时才有）。它是 `output` 的子集：`output` 已经包含这些 token。
	 * 提供推理拆分的 provider 会设置为数字（可能是 0）；不提供的 provider 保持 undefined。
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		/** Catalog-derived input cost. */
		/** 译：按目录单价算出的输入成本。下面三个同理：输出、缓存读、缓存写。 */
		input: number;
		/** Catalog-derived output cost. */
		output: number;
		/** Catalog-derived cache-read cost. */
		cacheRead: number;
		/** Catalog-derived cache-write cost. */
		cacheWrite: number;
		/** Best available total: provider-reported billed cost when supported, otherwise the catalog estimate. */
		/** 译：能拿到的最准确总额：provider 支持时用其报告的计费金额，否则用目录估算。 */
		total: number;
		/** True when `total` is the billed cost reported by the provider. False when it is a catalog estimate; absent also means false. */
		/** 译：`total` 是 provider 报告的计费金额时为 true；是目录估算时为 false；缺省也视为 false。 */
		totalFromProvider?: boolean;
	};
}

// 注：生成如何结束。上层判断成败只看这个字段，不用 try/catch：
// 注：pending=还在生成；stop=正常结束；length=撞到 maxTokens；toolUse=要调工具；
// 注：error=出错；aborted=被取消；deferred=延迟响应，结果稍后再取。
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

// 注：下面这一段是类型体操：保证 ToolResultMessage.details 只能放 JSON 兼容的数据。
// 注：目的是让消息永远能被 JSON.stringify 无损持久化。读不懂可以跳过。
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

/** The JSON representation of a typed in-memory value. Optional object properties remain optional. */
/** 译：某个有类型的内存值的 JSON 表示。可选的对象属性仍然是可选的。 */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

// 注：延迟响应的句柄，阶段 1 跳过。
export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	/** Provider token, such as a response id or batch id plus row id. */
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	/** Provider conversion data required to reconstruct the final assistant message. */
	data?: JsonValue;
}

/**
 * System instructions and tool declarations at one point in the transcript.
 *
 * The leading system message is the system prompt. Later system messages change it:
 * `content` adds instructions from that point on, `sections` replace or remove named
 * prompt sections, and `toolsAdded`/`toolsRemoved` change the tool set. Replaying
 * every system message in order yields the current prompt and tools. Providers that
 * accept system messages mid-conversation send each one in place; other providers
 * rebuild the leading system message from the replayed state.
 *
 * 译：对话记录中某一位置的系统指令和工具声明。
 *
 * 开头的 system 消息就是系统提示词。后面的 system 消息会修改它：`content` 从这一刻起追加指令，
 * `sections` 按名字替换或删除提示词段落，`toolsAdded`/`toolsRemoved` 修改工具集。
 * 按顺序回放所有 system 消息，就得到当前的提示词和工具。能在对话中途接受 system 消息的 provider
 * 原位发送每一条；其他 provider 用回放后的状态重建开头那条 system 消息。
 * 注：这样设计是为了提示词缓存：改工具不用重写开头，缓存前缀不失效。
 */
export interface SystemMessage {
	role: "system";
	/** Instruction text. On the leading message this is the base prompt; later, additional instructions. */
	/** 译：指令文本。开头那条消息里是基础提示词；后面的消息里是追加的指令。 */
	content: string | TextContent[];
	/**
	 * Named, ordered prompt sections rendered verbatim after `content`. The leading message
	 * declares them; later messages replace sections by name, and `null` removes one. Keep
	 * each section self-delimiting (a tag, a heading) so the model can relate an update to
	 * the original. Avoid integer-like names; JSON objects reorder those.
	 *
	 * 译：具名、有序的提示词段落，原样渲染在 `content` 之后。开头的消息声明它们；后面的消息按名字替换，
	 * `null` 表示删除。每段最好自带边界（一个标签、一个标题），让模型能把更新和原文对应起来。
	 * 避免用像整数的名字，因为 JSON 对象会把这类键重新排序。
	 */
	sections?: Record<string, string | null>;
	/** Complete definitions of tools that become available at this point. */
	/** 译：从这一刻起可用的工具的完整定义。 */
	toolsAdded?: Tool[];
	/** Tools that stop being available at this point. */
	/** 译：从这一刻起不再可用的工具。 */
	toolsRemoved?: ToolReference[];
	timestamp: number; // Unix timestamp in milliseconds
}

// 注：用户消息。content 可以是纯字符串，也可以是文本块和图片块的数组。
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

// 注：======== 最重要的类型 ========
// 注：模型的一次回复。它不只是内容，还带着"是谁生成的"（api/provider/model）、用量、停止原因、错误信息。
// 注：成功和失败用同一个类型表示：失败时 stopReason 是 error/aborted，content 里是已经收到的部分内容。
// 注：记录 api/provider/model 是为了跨模型切换：transform-messages.ts 据此判断 thinking 能不能原样回放。
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string; // Concrete model reported by the provider, when reported. May equal the requested `model`
	// 译（上一行）：provider 报告的实际模型（如果有）。可能和请求的 `model` 相同。注：网关路由（如 openrouter/auto）时会不同
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	// 译（上一行）：上游 API 提供时，provider 特有的响应或消息标识
	/** Exact provider-native effort level used for this response. Absent for legacy or unmanaged responses. */
	/** 译：本次响应实际使用的 provider 原生推理强度值。旧数据或不受管理的响应没有这个字段。 */
	providerThinkingLevel?: string;
	/** Pi thinking level the agent loop requested for this response. Absent outside the agent loop and for legacy responses. */
	/** 译：agent 循环为本次响应请求的 pi 思考级别。agent 循环之外和旧数据里没有。 */
	thinkingLevel?: ModelThinkingLevel;
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	// 译（上一行）：失败和恢复时的 provider/运行时诊断信息（已脱敏）
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	// 注：errorMessage 只在 error/aborted 时有；rawStopReason 是 provider 原始的停止原因字符串（如 "end_turn"、"tool_calls"）
	/**
	 * Provider indication of whether the model explicitly ended its turn.
	 * Preserved for debugging and does not currently affect agent control flow.
	 *
	 * 译：provider 给出的"模型是否明确结束了本轮"的指示。保留用于调试，目前不影响 agent 的控制流程。
	 */
	endTurn?: boolean;
	/** Unix timestamp in milliseconds when the request started. */
	/** 译：请求开始时的 Unix 时间戳（毫秒）。 */
	timestamp: number;
	/**
	 * Milliseconds from `timestamp` until the response ended, measured with a monotonic clock. Set by
	 * `AssistantMessageEventStream` on the final message of a response it saw start; absent for legacy messages and
	 * for deferred results fetched later.
	 *
	 * 译：从 `timestamp` 到响应结束的毫秒数，用单调时钟测量。由 `AssistantMessageEventStream` 在它看到开始的
	 * 响应的最终消息上设置；旧消息和之后才取回的延迟结果没有这个字段。
	 */
	durationMs?: number;
}

/** A tool call that another tool made while it ran, for example from a codemode script. */
/** 译：一个工具在运行期间调用的其他工具（例如 codemode 脚本里发起的调用）。阶段 1 可以跳过。 */
export interface NestedToolCallRecord {
	id: string;
	name: string;
	/** Omitted when over the size limits; `argumentsBytes` then gives their size. */
	arguments?: JsonObject;
	/** UTF-8 size of the arguments as JSON, set when `arguments` is omitted. */
	argumentsBytes?: number;
	/** `unfinished`: the call was still running when the calling tool finished. */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** Error text, truncated. */
	error?: string;
}

/** Bounded record of the nested calls a tool made. Results are not recorded. */
/** 译：一个工具发起的嵌套调用的有界记录。不记录结果。 */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** False when calls were dropped, arguments omitted, or calls had not finished. */
	complete: boolean;
}

// 注：工具执行结果，作为一条消息回给模型。toolCallId 必须和 AssistantMessage 里某个 ToolCall.id 对上。
// 注：content 是发给模型看的；details 是给 UI/日志用的结构化数据，不发给模型。
// 注：isError 为 true 时，模型知道工具失败了，可以自己调整重试（Agent 的自我纠错就靠它）。
export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[]; // Supports text and images
			// 译（上一行）：支持文本和图片
			details?: JsonRepresentation<TDetails>;
			/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
			/** 译：工具执行本身的用量（如果有，例如工具内部又调了一次 LLM）。不计入主 LLM 上下文的统计。 */
			usage?: Usage;
			/** Calls this tool made to other tools. Kept for the session record; not sent to the model. */
			/** 译：这个工具对其他工具的调用。保存在会话记录里，不发给模型。 */
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			/** Unix timestamp in milliseconds when the result was created. */
			/** 译：结果创建时的 Unix 时间戳（毫秒）。 */
			timestamp: number;
			/** Milliseconds the tool's execution took, measured with a monotonic clock. Absent for legacy results. */
			/** 译：工具执行耗时（毫秒），用单调时钟测量。旧结果没有这个字段。 */
			durationMs?: number;
		}
	: never;

// 注：一条对话记录就是 Message[]。四种角色：system / user / assistant / toolResult。
// 注：所有字段都是纯 JSON，所以整个对话可以直接存数据库、跨进程恢复、换模型继续。
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// 注：======== 以下到 ConstrainedSamplingConfig 之前是图片生成和分类器的类型，阶段 1 跳过 ========
export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImageApi;
	provider: ProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}

export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierScoreQuestion | ClassifierBoolQuestion;

export interface ClassifierContext {
	state: JsonObject;
	/**
	 * Images judged together with `state`. Only models whose `input` includes `"image"` accept them;
	 * other models return an error result.
	 */
	images?: ImageContent[];
	questions: Record<string, ClassifierQuestion>;
}

export interface ClassifierChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ClassifierScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

export interface ClassifierBoolAnswer {
	type: "bool";
	probability: number;
}

export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierScoreAnswer | ClassifierBoolAnswer;
export type ClassifierStopReason = "stop" | "error" | "aborted";

export interface ClassifierResult {
	api: ClassifierApi;
	provider: ProviderId;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	/** Token usage and its cost at the model's catalog price, when the service reports token counts. */
	usage?: Usage;
	stopReason: ClassifierStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

/** OpenAI grammar variants for constrained sampling. */
/** 译：用于约束采样的 OpenAI 语法变体。 */
export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * Optional provider-side constrained sampling configs for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs. Grammar variants let
 * callers provide provider-specific encodings of the same intended language.
 *
 * 译：工具可选的 provider 端约束采样配置。
 *
 * `json_schema` 大致对应各 API 里的 `strict` 概念，API 用 JSON Schema 约束采样来实现它。
 * 语法变体让调用方为同一种目标语言提供不同 provider 的专属编码。
 */
export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

/**
 * A tool the model may call. `parameters` is the JSON Schema of its arguments: pi-schema's builders (which also type
 * the arguments, see `Static` in `@earendil-works/pi-schema`), TypeBox schemas, or any JSON Schema object.
 *
 * 译：模型可以调用的工具。`parameters` 是参数的 JSON Schema：可以用 pi-schema 的构建函数（同时推导参数类型，
 * 见 `@earendil-works/pi-schema` 的 `Static`）、TypeBox schema，或任意 JSON Schema 对象。
 * 注：Tool 只是"声明"（名字、描述、参数 schema），没有 execute 函数。执行是上层（agent-core）的事。
 */
export interface Tool<TParameters extends object = object> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

// 注：只按名字引用工具，用于 SystemMessage.toolsRemoved。
export interface ToolReference {
	name: string;
}

/**
 * Request input accepted by the public stream entry points (`Models.stream()`,
 * `streamSimple()`, ...). `systemPrompt` and `tools` are shorthand for a leading
 * system message; `normalizeContext()` folds them into one before the request
 * reaches a provider.
 *
 * 译：公开流入口（`Models.stream()`、`streamSimple()` 等）接受的请求输入。`systemPrompt` 和 `tools`
 * 是"开头一条 system 消息"的简写；请求到达 provider 之前，`normalizeContext()` 会把它们合并成一条。
 * 注：Context 是给使用者的便捷形式；TranscriptContext 是给 provider 的规范形式。
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;
// 注：品牌类型（branded type）技巧：这个 symbol 只在类型层面存在，运行时没有。
// 注：效果是普通的 { messages } 对象无法直接当成 TranscriptContext 用，必须经过 normalizeContext()。

/**
 * Normalized request context passed to providers and API implementations. The
 * prompt and tool declarations are carried by the transcript's system messages.
 * Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 * provider code by accident.
 *
 * 译：传给 provider 和 API 实现的归一化请求上下文。提示词和工具声明由对话记录中的 system 消息携带。
 * 只有 `normalizeContext()` 能产生这个类型，所以原始的 `Context` 不会意外流到 provider 代码里。
 */
export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Successful streams emit `start` before partial updates and terminate with
 * `done`. A stream may terminate directly with `error` when request setup fails
 * before generation starts; after `start`, failures also terminate with `error`.
 * Direct `streamSimple()` calls throw synchronously when request auth is missing.
 * Updates and `done` must never appear before `start`.
 *
 * `partial` is the shared live response-so-far helper, not an event-time
 * snapshot. Text and thinking blocks are empty when their `*_start` event is
 * emitted and grow only through their corresponding `*_delta` events until the
 * authoritative `*_end`. Redacted thinking may be complete at start and emit no
 * deltas. Tool-call arguments at `toolcall_start` are provider-specific;
 * `toolcall_delta` carries subsequent JSON updates.
 *
 * 译：AssistantMessageEventStream 的事件协议。
 *
 * 成功的流在部分更新之前先发 `start`，最后以 `done` 结束。如果请求准备阶段在生成开始前就失败，
 * 流可以直接以 `error` 结束；`start` 之后的失败也以 `error` 结束。
 * 直接调用 `streamSimple()` 时，缺少请求认证会同步抛异常。更新事件和 `done` 绝不能出现在 `start` 之前。
 *
 * `partial` 是共享的、实时的"到目前为止的响应"对象，不是事件发生时的快照。文本块和 thinking 块在
 * `*_start` 发出时为空，只通过对应的 `*_delta` 增长，直到权威的 `*_end`。脱敏的 thinking 可能在开始时
 * 就已完整，不发 delta。`toolcall_start` 时的工具调用参数取决于 provider；后续 JSON 更新由 `toolcall_delta` 携带。
 */
export type AssistantMessageEvent =
	// 注：contentIndex 指向 partial.content 数组的下标。不同块的事件可能交错，要靠 contentIndex 对应。
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	// 注：error 事件的 error 字段不是 Error 对象，而是一条完整的 AssistantMessage（带部分内容和用量）。
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** Fields shared by every catalog entry, regardless of what you can do with it. */
/** 译：所有目录条目共有的字段，无论它能用来做什么。 */
// 注：baseUrl 在模型上而不在 provider 上：同一 provider 的不同模型可以指向不同端点。
// 注：cost 是每百万 token 的单价，calculateCost() 用它算 usage.cost。
export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ModelInputModality[];
	/** Provider input limits and cache-safe preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
}

/** Chat model: usable with `stream()` and friends. */
/** 译：对话模型：可用于 `stream()` 及相关方法。 */
// 注：Model 是纯数据（没有任何函数），所以可以序列化、可以手写。接私有化模型时，你就是在手写一个 Model 对象。
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	/**
	 * Optional: chat is the default model type, so models without `type` are chat
	 * models. Narrow mixed model lists with `isModelType()` instead of comparing
	 * `type` directly.
	 *
	 * 译：可选：对话是默认的模型类型，所以没有 `type` 的模型就是对话模型。
	 * 混合列表用 `isModelType()` 收窄，不要直接比较 `type`。
	 */
	type?: "chat";
	reasoning: boolean;
	// 注：是否支持思考/推理。为 false 时，传入的推理选项会被忽略。
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 *
	 * 译：把 pi 的思考级别映射到 provider/模型特有的值。缺省的键使用 provider 默认值；null 表示不支持该级别。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown. */
	/** 译：各保留档位的提示词缓存时长。provider 的缓存行为未知时不设置。 */
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	// 注：contextWindow = 输入 + 输出的总上限；maxTokens = 单次输出上限。
	// 注：streamSimple 会按 contextWindow 自动收紧 maxTokens，见 api/simple-options.ts 的 clampMaxTokensToContext。
	/** Default sampling parameters for this model. See {@link StreamOptions.samplingParams}; per-request keys override these. */
	/** 译：这个模型的默认采样参数。见 {@link StreamOptions.samplingParams}；请求里的同名键会覆盖它们。 */
	samplingParams?: SamplingParams;
	/** Sampling parameter overrides selected by the effective pi thinking level. */
	/** 译：按实际生效的 pi 思考级别选择的采样参数覆盖。 */
	samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	/** 译：OpenAI 兼容 API 的兼容性覆盖。不设置时根据 baseUrl 自动识别。 */
	// 注：条件类型：compat 的具体类型随 TApi 变化。openai-completions 的 compat 选项最多，见 openai-completions.ts 的 detectCompat。
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: never;
}

/** Image-generation model: usable with `generateImages()` only. */
/** 译：图片生成模型：只能用于 `generateImages()`。阶段 1 跳过。 */
export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	type: "image";
	/** Output modalities. Always includes `"image"`; `"text"` means the model can also return text blocks. */
	output: ("text" | "image")[];
}

/** Structured classifier model: usable with `classify()` only. */
/** 译：结构化分类器模型：只能用于 `classify()`。阶段 1 跳过。 */
export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	type: "classifier";
	contextWindow: number;
	/** Compatibility overrides for System One APIs. If not set, auto-detected from provider, baseUrl, and id. */
	compat?: TApi extends "typesafe-system-one" | "cloudflare-workers-ai-system-one" ? SystemOneCompat : never;
}

/** Model shape for each model type. */
/** 译：每种模型类型对应的模型形状。 */
export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

/** What a catalog entry is for. Decides which `Models` operation accepts it. */
/** 译：目录条目的用途，决定 `Models` 的哪个操作接受它。 */
export type ModelType = keyof ModelTypeMap;

/** Anything a provider can list. Narrow with `isModelType()`. */
/** 译：provider 能列出的任何模型。用 `isModelType()` 收窄。 */
export type AnyModel = ModelTypeMap[ModelType];
