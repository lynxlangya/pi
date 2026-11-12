// 注：本文件定义四层结构中的上面两层：
// 注：  Models（集合）：注册多个 provider；对外提供 getModel / stream / complete 等入口；负责认证解析和 header 合并。
// 注：  Provider（单个服务商）：持有模型目录、认证方式、协议实现；createProvider() 用零件拼出一个 Provider。
// 注：请求链路：models.stream() → normalizeContext() → lazyStream(后台: requireChatProvider → applyAuth → provider.stream())
// 注：         → createProvider 里的 dispatch() → 协议实现（如 openai-completions.ts 的 stream()）。
// 注：建议阅读顺序：Provider 接口 → Models 接口 → applyAuth → stream/streamSimple → createProvider → calculateCost。
// 注：refresh / login / 动态目录相关的私有方法可以先跳过。
import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import {
	type AuthResolutionOverrides,
	ModelsError,
	refreshStoredOAuthCredential,
	resolveProviderAuth,
} from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
import { observeModelRequest } from "./telemetry.ts";
import type {
	AnyModel,
	Api,
	ApiStreamOptions,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
	ProviderClassifier,
	ProviderHeaders,
	ProviderImages,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { operationSignal, raceWithAbortSignal } from "./utils/abort.ts";
import { learnLog, learnMaskHeaders } from "./utils/diagnostics.ts";
import { type ClientIdentity, getOpenCodeSessionHeaders, mergeClientIdentity } from "./utils/identity.ts";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	getModelType,
	imageErrorResult,
	isModelType,
} from "./utils/model-operations.ts";
import { normalizeContext } from "./utils/transcript.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";
export { AI_TELEMETRY_SCHEMA } from "./telemetry.ts";
export { getModelType, isModelType } from "./utils/model-operations.ts";

export interface ModelsPublication {
	// 注：动态目录"发布"的参数（provider 刷新模型列表后，通过 publish 写入存储和内存）。阶段 1 可跳过。
	/** Provider-selected persisted catalog. Omit to leave storage unchanged; null deletes it. */
	/** 译：provider 选择持久化的目录。省略表示不改存储；null 表示删除。 */
	persist?: ModelsStoreEntry | null;
	/** Optional synchronous update of provider-private in-memory catalog state. */
	/** 译：可选：同步更新 provider 私有的内存目录状态。 */
	update?: () => void;
}

// 注：provider.refreshModels() 收到的上下文。阶段 1 可跳过。
export interface RefreshModelsContext {
	/** Effective configured credential. OAuth credentials are refreshed before network access. */
	/** 译：生效的已配置凭据。OAuth 凭据在访问网络前会先刷新。 */
	credential?: Credential;
	/** Immutable provider-scoped catalog snapshot captured before this refresh phase. */
	/** 译：本次刷新阶段开始前捕获的、provider 范围的只读目录快照。 */
	stored?: Readonly<ModelsStoreEntry>;
	/**
	 * Generation-checked publication. Persistence policy remains provider-owned;
	 * the update runs synchronously only after the selected persistence mutation.
	 *
	 * 译：带代次检查的发布。持久化策略仍由 provider 决定；update 只在选定的持久化修改完成后同步执行。
	 */
	publish(publication: ModelsPublication): Promise<boolean>;
	/** False during offline/cache-only initialization. */
	/** 译：离线/仅缓存初始化期间为 false。 */
	allowNetwork: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	/** Always present, including when the public refresh caller omits its optional signal. */
	/** 译：总是存在，即使公开的 refresh 调用方没传可选的 signal。 */
	signal: AbortSignal;
	/**
	 * Base URL of the registered provider, including configuration overrides that wrappers apply
	 * outside the provider receiving this context.
	 *
	 * 译：已注册 provider 的 base URL，包括包装层在接收此上下文的 provider 之外施加的配置覆盖。
	 */
	baseUrl?: string;
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** Restrict refresh to these provider IDs. Unknown and static providers are ignored. */
	/** 译：只刷新这些 provider ID。未知的和静态的 provider 会被忽略。 */
	providers?: readonly string[];
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsRequestTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	/** 译：在分派给 provider 之前，对已经组装完的模型/认证/请求 headers 做变换。 */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

// 注：Models 层的选项 = 协议选项 + transformHeaders。transformHeaders 只属于 Models，不会传到 Provider。
export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsRequestTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms;
export type ModelsDeferredFetchOptions = DeferredFetchOptions & ModelsRequestTransforms;
export type ModelsDeferredCancelOptions = DeferredCancelOptions & ModelsRequestTransforms;
export type ModelsImagesOptions = ImagesOptions & ModelsRequestTransforms;
export type ModelsClassifierOptions = ClassifierOptions & ModelsRequestTransforms;

const KNOWN_MODEL_TYPES: Record<ModelType, true> = { chat: true, image: true, classifier: true };

/** Models from stores and remote sources may have types that only newer versions know. */
/** 译：来自存储和远端的模型，可能带有只有更新版本才认识的类型。 */
function hasKnownModelType(model: AnyModel): boolean {
	return Object.hasOwn(KNOWN_MODEL_TYPES, getModelType(model));
}

/** Drops stored models whose type this version does not know. */
/** 译：丢弃本版本不认识类型的已存储模型。 */
function withKnownModelTypes(entry: ModelsStoreEntry): ModelsStoreEntry {
	return { ...entry, models: entry.models.filter(hasKnownModelType) };
}

/** Any model a provider with chat APIs `TApi` can list. */
/** 译：使用对话协议 `TApi` 的 provider 能列出的任何模型。 */
type ProviderModel<TApi extends Api> = Model<TApi> | ImageModel<ImageApi> | ClassifierModel<ClassifierApi>;

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * auth methods, model listing, and the operations its models support
 * (streaming, image generation, classification).
 *
 * `TApi` lets concrete provider factories declare which chat APIs their models
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * giving typed chat model lists to direct factory users. Other model types use
 * their operation-specific API unions. Inside a `Models` collection providers
 * are held as `Provider<Api>`.
 *
 * 译：provider 是具体的运行时单元。它拥有 id/name/基础元数据、认证方式、模型列表，
 * 以及它的模型所支持的操作（流式对话、图片生成、分类）。
 *
 * `TApi` 让具体的 provider 工厂声明它的模型使用哪些对话协议
 * （例如 `openaiProvider(): Provider<"openai-responses" | "openai-completions">`），
 * 从而让直接使用工厂的人拿到带类型的对话模型列表。其他模型类型用各自操作的协议联合类型。
 * 在 `Models` 集合内部，provider 统一以 `Provider<Api>` 持有。
 * 注：一般不手写这个接口，而是用下面的 createProvider() 生成。
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * whose `resolve()` reports whether the provider is configured.
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 *
	 * 译：必填：`apiKey`/`oauth` 至少一个。每个 provider 都有认证语义，即使是只有环境凭据（环境变量、
	 * AWS profile、ADC 文件）的 provider，或者不需要 key 的本地服务器，也要提供 `apiKey` 认证，
	 * 由它的 `resolve()` 报告 provider 是否已配置。provider 未配置时 `Models.getAuth()` 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * Current known chat models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()` (empty
	 * before the first). Must not throw; `Models` treats a throwing
	 * implementation as having no models.
	 *
	 * 译：当前已知的对话模型，同步返回。静态 provider 返回自己的目录；动态 provider 返回最近一次
	 * `refreshModels()` 后的列表（第一次刷新前为空）。不能抛异常；`Models` 把抛异常的实现当作没有模型。
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * Current known models of every type, sync, with the same contract as
	 * `getModels()`. Providers with only chat models may omit it; `Models` then
	 * uses `getModels()`. Model ids are unique within each type; one upstream
	 * model may have separate entries for different operations.
	 *
	 * 译：当前已知的所有类型的模型，同步返回，契约与 `getModels()` 相同。只有对话模型的 provider 可以省略，
	 * 这时 `Models` 用 `getModels()`。模型 id 在每种类型内唯一；同一个上游模型可能因操作不同而有多条记录。
	 */
	getAllModels?(): readonly ProviderModel<TApi>[];

	/**
	 * Dynamic providers only: restore `context.stored` and optionally fetch a newer list using
	 * the effective credential. Implementations retain their previous list on failure, publish
	 * persistence and synchronous state changes through `context.publish()`, and honor the
	 * shared abort signal for blocking work.
	 *
	 * 译：仅动态 provider：恢复 `context.stored`，并可以用生效的凭据拉取更新的列表。实现在失败时保留之前的列表，
	 * 通过 `context.publish()` 发布持久化和同步状态变更，阻塞性工作要响应共享的 abort signal。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * What the network phase of `refreshModels` needs. "credential" (the default) receives the
	 * effective credential, so an expired OAuth token is refreshed first. "configured" is for catalogs
	 * served by a source other than the provider, such as pi.dev: the phase still runs only when the
	 * provider is configured, but OAuth is never refreshed for it and `context.credential` is undefined.
	 */
	readonly refreshModelsAuth?: "credential" | "configured";

	/**
	 * Optional provider policy for credential-specific model availability.
	 * `getModels()` remains the complete synchronous chat catalog; `Models.getAvailable()`
	 * applies this filter after confirming that provider auth is configured.
	 *
	 * 译：可选：按凭据决定哪些模型可用的 provider 策略。`getModels()` 仍是完整的同步对话目录；
	 * `Models.getAvailable()` 在确认 provider 认证已配置后应用这个过滤。
	 * 注：例如同一个 provider，不同订阅档位的 key 能用的模型不同。
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	/**
	 * Optional credential-specific availability policy across every model type.
	 * Without it, `Models.getAllAvailable()` applies `filterModels` to chat models
	 * and keeps every other model.
	 *
	 * 译：可选：覆盖所有模型类型的、按凭据决定可用性的策略。没有它时，`Models.getAllAvailable()`
	 * 对对话模型应用 `filterModels`，其他模型全部保留。
	 */
	filterAllModels?(
		models: readonly ProviderModel<TApi>[],
		credential: Credential | undefined,
	): readonly ProviderModel<TApi>[];

	/** Stream a normalized transcript. `Models` normalizes the caller's `Context` before dispatching here. */
	/** 译：对归一化后的对话记录发起流式请求。`Models` 在分派到这里之前，会先把调用方的 `Context` 归一化。 */
	// 注：到 Provider 这一层，options 里已经带上了解析好的 apiKey/headers（见 Models 的 applyAuth）。
	stream<T extends TApi>(
		model: Model<T>,
		context: TranscriptContext,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(
		model: Model<TApi>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<TApi>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<TApi>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;

	/** Present when the provider supports dedicated image models. Never rejects. */
	/** 译：provider 支持专门的图片模型时才有。永不 reject。 */
	generateImages?(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;

	/** Present when the provider supports structured classifier models. Never rejects. */
	/** 译：provider 支持结构化分类器模型时才有。永不 reject。 */
	classify?(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

/**
 * Runtime collection of providers plus auth application and request
 * convenience. Providers own request behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 *
 * Read accessors come in three flavors: the unqualified ones (`getModels`,
 * `getModel`, `getAvailable`) return chat models, the `*OfType` accessors
 * return one model type, and `getAllModels`/`getAllAvailable` return every type.
 *
 * 译：provider 的运行时集合，加上认证的应用和请求的便捷方法。请求行为由 provider 负责；
 * `Models` 负责解析认证，并把每个请求委托给拥有该模型的 provider。
 *
 * 读取方法有三种：不带限定的（`getModels`、`getModel`、`getAvailable`）返回对话模型，
 * `*OfType` 系列返回指定类型的模型，`getAllModels`/`getAllAvailable` 返回所有类型。
 * 注：Models 是你的应用代码直接打交道的对象。上层 agent-core、coding-agent 都持有一个 Models。
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * Sync read of last-known chat models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 *
	 * 译：同步读取一个或全部 provider 最近已知的对话模型。尽力而为：`getModels()` 抛异常的 provider 视为没有模型。
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * Sync runtime chat model lookup against last-known lists. Dynamic model lists
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 *
	 * 译：在最近已知的列表中同步查找对话模型。动态模型列表的类型是 `Model<Api>`；用 `hasApi()` 类型守卫收窄。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/** Sync read of last-known models of one type from one provider or all providers. */
	/** 译：同步读取一个或全部 provider 最近已知的、指定类型的模型。 */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][];

	/** Sync runtime lookup of a model of one type against last-known lists. */
	/** 译：在最近已知的列表中同步查找指定类型的模型。 */
	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined;

	/** Sync read of last-known models of every type from one provider or all providers. */
	/** 译：同步读取一个或全部 provider 最近已知的、所有类型的模型。 */
	getAllModels(provider?: string): readonly AnyModel[];

	/**
	 * Refresh selected configured dynamic providers concurrently (all when `providers` is omitted).
	 * Provider errors and cancellation are returned without rejecting; static, unknown, and
	 * unconfigured providers are skipped.
	 *
	 * 译：并发刷新选定的、已配置的动态 provider（不传 `providers` 时刷新全部）。
	 * provider 的错误和取消会作为结果返回，不会 reject；静态的、未知的、未配置的 provider 会被跳过。
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** Check whether a provider has complete auth configuration without refreshing OAuth. */
	/** 译：检查 provider 的认证配置是否完整，不刷新 OAuth。 */
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;

	/** Return chat models whose providers have complete auth configuration. */
	/** 译：返回认证配置完整的 provider 的对话模型。注：做"模型选择下拉框"时用它，只列出能用的。 */
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;

	/** Return models of one type whose providers have complete auth configuration. */
	/** 译：返回认证配置完整的 provider 的指定类型模型。 */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]>;

	/** Return models of every type whose providers have complete auth configuration. */
	/** 译：返回认证配置完整的 provider 的所有类型模型。 */
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]>;

	/**
	 * Resolve provider-scoped auth by provider id, or provider auth plus static
	 * model headers when passed a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors.
	 *
	 * 译：传 provider id 时解析 provider 范围的认证；传模型时还会加上模型的静态 headers。
	 * 结果带一个来源标签，供状态 UI 显示。provider 未知或未配置时返回 `undefined`。
	 * 以 `ModelsError` reject 的情况：code "oauth" 表示 token 刷新失败（已存储的凭据保留以便重试，重新登录可修复）；
	 * code "auth" 表示 api key 解析或凭据存储失败。在请求路径上，这些 reject 会以流错误的形式出现。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** Run a provider-owned login flow and persist its returned credential. */
	/** 译：执行 provider 自己的登录流程，并持久化它返回的凭据。 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;

	/** Remove the stored credential for a provider. */
	/** 译：删除某个 provider 已存储的凭据。 */
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;

	// 注：四个核心入口：
	// 注：  stream / complete：用协议专属选项（如 Anthropic 的 thinkingBudgetTokens）；complete = stream().result()
	// 注：  streamSimple / completeSimple：用统一的 reasoning 级别；上层 Agent 用这一对
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	// 注：Deferred（延迟响应）系列，阶段 1 跳过。
	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream;
	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;

	/**
	 * Generate images through the owning provider with auth resolved like
	 * `stream()`. Never rejects: unknown providers, unconfigured auth, and
	 * providers without `generateImages` return an error `AssistantImages`.
	 *
	 * 译：通过所属 provider 生成图片，认证解析方式与 `stream()` 相同。永不 reject：未知 provider、
	 * 认证未配置、没有 `generateImages` 的 provider 都返回一个错误的 `AssistantImages`。
	 */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages>;

	/** Classify structured state through the owning provider. Never rejects. */
	/** 译：通过所属 provider 对结构化状态做分类。永不 reject。 */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	/** 译：按 provider.id 插入或替换。provider id 唯一。 */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
	/** Default identity of every request; a request's `identity` overrides it field by field. */
	/** 译：每个请求的默认身份；请求自己的 `identity` 逐字段覆盖它。 */
	identity?: ClientIdentity;
}

// 注：合并两组 headers，override 优先。header 名大小写不敏感：
// 注：例如 base 里有 "Authorization"，override 里有 "authorization"，结果只保留 override 的那个。
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		// 注：先删掉 base 中所有同名（忽略大小写）的 header，再写入 override 的值（值可能是 null，表示删除）
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

// 注：Models 接口的唯一实现。通过 createModels() 创建。
class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	// 注：provider id → Provider
	private credentials: CredentialStore;
	// 注：凭据存储（API key、OAuth token）。默认内存实现；生产环境注入持久化实现（如按租户读 DB/KMS）
	private modelsStore: ModelsStore;
	// 注：动态模型目录的持久化存储
	private authContext: AuthContext;
	// 注：认证上下文：读取环境变量、文件等的抽象（便于在浏览器或测试中替换）
	private identity: ClientIdentity | undefined;
	private refreshGenerations = new Map<string, number>();
	// 注：下面三个 Map 用于动态目录刷新的并发控制：每次刷新有一个"代次"号，旧代次的结果会被丢弃
	private refreshControllers = new Map<string, AbortController>();
	private publicationChains = new Map<string, Promise<unknown>>();

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
		this.identity = options?.identity;
	}

	// 注：注册 provider。同 id 会替换；替换前先取消该 provider 正在进行的刷新
	setProvider(provider: Provider): void {
		this.supersedeProviderRefresh(provider.id);
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.supersedeProviderRefresh(id);
		this.providers.delete(id);
	}

	clearProviders(): void {
		for (const id of new Set([...this.providers.keys(), ...this.refreshControllers.keys()])) {
			this.supersedeProviderRefresh(id);
		}
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	// 注：同步读模型。注意每次调用都会遍历 provider，不做缓存
	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	// 注：getAllModels 与 getModels 相同，只是包含图片、分类器等所有类型
	getAllModels(provider?: string): readonly AnyModel[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getAllModels?.() ?? entry.getModels();
			} catch {
				return [];
			}
		}

		const models: AnyModel[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...(entry.getAllModels?.() ?? entry.getModels()));
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.getAllModels(provider).filter((model): model is ModelTypeMap[TType] => isModelType(model, type));
	}

	// 注：按 provider + id 精确查找。找不到返回 undefined（不抛异常）
	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		return this.getModelsOfType(type, provider).find((model) => model.id === id);
	}

	// 注：======== 以下到 checkAuth 之前是动态目录刷新的实现，阶段 1 可以跳过 ========
	// 注：作废某个 provider 正在进行的刷新：代次号 +1，并 abort 旧的刷新
	private supersedeProviderRefresh(providerId: string): number {
		const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
		this.refreshGenerations.set(providerId, generation);
		const previous = this.refreshControllers.get(providerId);
		if (previous) {
			this.refreshControllers.delete(providerId);
			previous.abort();
		}
		return generation;
	}

	private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
		const generation = this.supersedeProviderRefresh(providerId);
		const controller = new AbortController();
		this.refreshControllers.set(providerId, controller);
		return { generation, controller };
	}

	// 注：把刷新结果串行地发布出去（同一 provider 的发布排成一条链），发布前后都检查代次，过期则放弃
	private publishProviderModels(
		providerId: string,
		generation: number,
		signal: AbortSignal,
		publication: ModelsPublication,
	): Promise<boolean> {
		const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;

			if (publication.persist === null) {
				await this.modelsStore.delete(providerId, { signal });
			} else if (publication.persist !== undefined) {
				await this.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
			}

			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
			publication.update?.();
			return true;
		})();
		const tail = queued.catch(() => {});
		this.publicationChains.set(providerId, tail);
		void tail.then(() => {
			if (this.publicationChains.get(providerId) === tail) this.publicationChains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	private async runProviderRefreshPhase(
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		credential: Credential | undefined,
		allowNetwork: boolean,
		force: boolean | undefined,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const stored = await this.modelsStore.read(provider.id, { signal });
		await provider.refreshModels({
			credential,
			stored: stored ? withKnownModelTypes(structuredClone(stored)) : undefined,
			publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
			allowNetwork,
			force: allowNetwork ? force : undefined,
			signal,
			baseUrl: provider.baseUrl,
		});
	}

	// 注：刷新流程（每个动态 provider 并发执行）：
	// 注：  1. 读已存储的凭据；2. 先用缓存恢复目录（不联网）；3. 解析凭据；4. 联网拉取最新目录
	// 注：任何 provider 的失败都收集到 errors 里返回，不会让整个 refresh reject
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const callerSignal = operationSignal(options.signal);
		const errors = new Map<string, Error>();
		if (callerSignal.aborted) return { aborted: true, errors };
		const selected = options.providers ? new Set(options.providers) : undefined;
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
		);

		const refresh = Promise.all(
			refreshable.map(async (provider) => {
				const { generation, controller } = this.beginProviderRefresh(provider.id);
				const signal = AbortSignal.any([callerSignal, controller.signal]);
				const operation = (async () => {
					let storedCredential: Credential | undefined;
					let credentialError: unknown;
					try {
						storedCredential = await this.readCredential(provider.id, signal);
					} catch (error) {
						credentialError = error;
					}

					// Restore cached provider state before auth resolution or network access.
					// 译：在解析认证或访问网络之前，先恢复缓存的 provider 状态。
					await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
					if (credentialError !== undefined) throw credentialError;
					if (!allowNetwork || signal.aborted) return;

					const network = await this.resolveNetworkRefresh(provider, storedCredential, signal);
					if (!network) return;
					await this.runProviderRefreshPhase(
						provider,
						network.credential,
						true,
						options.force,
						generation,
						signal,
					);
				})();

				try {
					await raceWithAbortSignal(operation, signal);
				} catch (error) {
					if (!signal.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
				} finally {
					if (this.refreshControllers.get(provider.id) === controller) {
						this.refreshControllers.delete(provider.id);
					}
				}
			}),
		);

		try {
			await raceWithAbortSignal(refresh, callerSignal);
		} catch (error) {
			if (!callerSignal.aborted) throw error;
		}

		return { aborted: callerSignal.aborted, errors: new Map(errors) };
	}

	/** The credential for the network refresh phase, or undefined when the provider is not configured. */
	private async resolveNetworkRefresh(
		provider: Provider,
		stored: Credential | undefined,
		signal: AbortSignal,
	): Promise<{ credential?: Credential } | undefined> {
		if (provider.refreshModelsAuth === "configured") {
			return (await this.checkProviderAuth(provider, stored, signal)) ? {} : undefined;
		}
		const credential = await this.resolveRefreshCredential(provider, stored, signal);
		return credential ? { credential } : undefined;
	}

	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		signal: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (Date.now() < stored.expires) return stored;
			if (signal.aborted) return undefined;
			// A refresh that has started survives cancellation or a superseding model refresh, so a
			// rotated refresh token is always persisted. A newer refresh then sees the fresh credential.
			// 译：已经开始的刷新不会因为取消或被新的模型刷新取代而中断，这样轮换后的 refresh token 一定会被持久化。
			// 译：之后更新的刷新就能看到新的凭据。
			return refreshStoredOAuthCredential(
				this.credentials,
				provider.id,
				oauth,
				(current) => Date.now() >= current.expires,
				signal,
			);
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential, signal });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	// 注：读凭据，存储层的异常统一包装成 ModelsError("auth")
	private async readCredential(providerId: string, signal: AbortSignal): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId, { signal });
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	// 注：======== 认证检查 ========
	// 注：只检查"是否已配置"，不刷新 OAuth：有 OAuth 凭据就算配置了；否则用 apiKey.check 或完整解析一次
	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
					signal,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext, { signal });
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const check = (async () => {
			signal.throwIfAborted();
			const provider = this.providers.get(providerId);
			if (!provider) return undefined;
			return this.checkProviderAuth(provider, await this.readCredential(providerId, signal), signal);
		})();
		return raceWithAbortSignal(check, signal);
	}

	private async getAuthenticatedProviders(providerId: string | undefined, signal: AbortSignal) {
		signal.throwIfAborted();
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id, signal);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential, signal) };
			}),
		);
		return checks.filter((entry) => entry.auth !== undefined);
	}

	// 注：只返回"认证已配置"的 provider 的模型，再经过 provider 的 filterModels 过滤
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			return providers.flatMap(({ provider, credential }) => {
				const models = provider.getModels();
				return provider.filterModels?.(models, credential) ?? models;
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return (await this.getAllAvailable(providerId, options)).filter((model): model is ModelTypeMap[TType] =>
			isModelType(model, type),
		);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			return providers.flatMap(({ provider, credential }) => {
				const models = provider.getAllModels?.() ?? provider.getModels();
				if (provider.filterAllModels) return provider.filterAllModels(models, credential);
				if (!provider.filterModels) return models;
				const availableChatIds = new Set(
					provider.filterModels(provider.getModels(), credential).map((model) => model.id),
				);
				return models.filter((model) => !isModelType(model, "chat") || availableChatIds.has(model.id));
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	// 注：解析认证的公开方法。真正的解析逻辑在 auth/resolve.ts 的 resolveProviderAuth：
	// 注：  显式传入的 apiKey > 已存储的凭据（含 OAuth 自动刷新）> 环境变量等环境来源
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const signal = operationSignal(overrides?.signal);
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		// 注：传入的是模型、且模型带有静态 headers 时，把它们合并到认证 headers 之上
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	// 注：登录流程（OAuth 或交互式输入 API key），阶段 1 可以跳过。
	// 注：难点在取消处理：一旦凭据写入已经开始，就不再响应取消，避免凭据写了一半
	async login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		signal.throwIfAborted();
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const loginOperation: Promise<Credential> = method.login({ ...interaction, signal }, options);
		const credential = await raceWithAbortSignal(loginOperation, signal);
		let mutationStarted = false;
		let markMutationStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markMutationStarted = resolve;
		});
		const mutation = this.credentials.modify(
			providerId,
			async () => {
				mutationStarted = true;
				markMutationStarted?.();
				return credential;
			},
			{ signal },
		);
		void mutation.catch(() => {});
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					if (!mutationStarted) reject(signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				void Promise.race([started, mutation]).then(
					() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					},
					(error: unknown) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
				if (signal.aborted) onAbort();
			});
			await mutation;
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options?.signal);
		signal.throwIfAborted();
		try {
			await this.credentials.delete(providerId, { signal });
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	// 注：找不到 provider 时抛异常。这些异常都发生在 lazyStream 的 setup 里，所以最终会变成流的 error 事件
	private requireProvider(model: AnyModel): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private requireChatProvider(model: Model<Api>): Provider {
		assertChatModel(model);
		return this.requireProvider(model);
	}

	// 注：======== 重点：把认证和 headers 合并进请求 ========
	// 注：输入：模型 + 调用方的选项。输出：可能被改了 baseUrl 的模型 + 最终发给 provider 的选项。
	// 注：header 合并顺序（后者覆盖前者）：OpenCode 会话 header → 认证 header（含 model.headers）→ options.headers → transformHeaders
	private async applyAuth<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		requestModel: TModel;
		requestOptions: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		this.requireProvider(model);
		// 注：第 1 步：解析认证。把调用方显式传的 apiKey/env 作为覆盖项传进去
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		// 注：未配置认证直接抛异常 → lazyStream 捕获 → 流里出现 error 事件，stopReason "error"
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		// 译：显式的请求选项逐字段优先；只属于 Models 的 transform 最后执行。
		const apiKey = options?.apiKey ?? auth.apiKey;
		const requestModel: TModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		// 注：认证可以改写 baseUrl（例如 Cloudflare 按账号拼出端点）。注意是复制一份新模型，不修改原对象
		const sessionId =
			options && "sessionId" in options && typeof options.sessionId === "string" ? options.sessionId : undefined;
		let headers = mergeHeaders(
			mergeHeaders(getOpenCodeSessionHeaders(requestModel, sessionId), auth.headers),
			options?.headers,
		);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		// 注：env 合并：认证解析出的 env 在下，调用方显式传的 env 在上
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const identity = mergeClientIdentity(this.identity, options?.identity);
		// 注：把 transformHeaders 从选项中剔除：它只属于 Models 层，Provider 永远看不到它
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = {
			...providerOptions,
			apiKey,
			headers,
			env,
			...(identity === undefined ? {} : { identity }),
		} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;

		// 注：[调试] 认证解析和请求头合并的结果。apiKey 只显示前 3 位和长度。
		// 注：OpenAI 兼容服务的 key 不在 headers 里，而是之后由 OpenAI SDK 放进 Authorization 头。
		learnLog("models", `applyAuth 完成: ${model.provider}/${model.id}`, {
			baseUrl: requestModel.baseUrl,
			apiKey: apiKey ? `${apiKey.slice(0, 3)}…(${apiKey.length} chars)` : "(none)",
			headers: learnMaskHeaders(headers ?? {}),
		});
		return { requestModel, requestOptions };
	}

	// 注：======== 重点：请求入口 ========
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		// 注：第 1 步：同步把 Context（systemPrompt/tools 简写）归一化成 TranscriptContext（只有 messages）
		// 注：第 2 步：用 lazyStream 立刻返回流，后台执行：找 provider → 解析认证 → 调 provider.stream()
		// 注：后台任何一步抛异常，都会变成流里的 error 事件，调用方不会收到异常
		const transcript = normalizeContext(context);
		learnLog("models", `stream 入口: ${model.provider}/${model.id}`, {
			messages: transcript.messages.map((m) => m.role),
		});
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				const { requestModel, requestOptions } = await this.applyAuth(
					model,
					options as ModelsApiStreamOptions<Api> | undefined,
				);
				return provider.stream(requestModel, transcript, requestOptions as ApiStreamOptions<TApi>);
			},
			observeModelRequest(model, options, false),
			options?.signal,
		);
	}

	// 注：complete 只是 stream 的语法糖：不迭代事件，直接等最终消息。同样永不 reject，失败看 stopReason
	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	// 注：与 stream 完全对称，区别只在最后调用 provider.streamSimple（统一的 reasoning 选项）
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		// 注：[调试] normalizeContext 之后只剩 messages：systemPrompt 和 tools 已经折叠成 system 消息
		learnLog("models", `streamSimple 入口: ${model.provider}/${model.id}`, {
			messages: transcript.messages.map((m) => m.role),
			reasoning: options?.reasoning,
		});
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				return provider.streamSimple(requestModel, transcript, requestOptions as SimpleStreamOptions);
			},
			observeModelRequest(model, options, false),
			options?.signal,
		);
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				const provider = this.requireChatProvider(model);
				if (!provider.fetchDeferred) {
					throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
				}
				const { requestModel, requestOptions } = await this.applyAuth(model, options);
				return provider.fetchDeferred(requestModel, handle, requestOptions as DeferredFetchOptions);
			},
			observeModelRequest(model, options, true),
			options?.signal,
		);
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.requireChatProvider(model);
		if (!provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}

	// 注：图片生成和分类不是流式的，所以用 try/catch 把异常转成错误结果，同样保证"永不 reject"。阶段 1 跳过
	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const provider = this.requireProvider(model);
			if (!provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.generateImages(requestModel, context, requestOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			assertClassifierInputSupported(model, context);
			const provider = this.requireProvider(model);
			if (!provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.classify(requestModel, context, requestOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	// 注：创建一个空的 Models 集合。之后用 setProvider() 注册 provider。
	return new ModelsImpl(options);
}

// 注：createProvider 的参数。对照 providers/deepseek.ts 看：id + name + baseUrl + auth + models + api 就是一个 provider。
export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	/** 译：显示名称。默认等于 `id`。 */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	/** 译：必填：每个 provider 都有认证语义，即使是环境凭据或不需要 key 的 provider。 */
	auth: ProviderAuth;
	/**
	 * Static baseline models of every type (empty for purely dynamic providers).
	 * Models without `type` are chat models.
	 *
	 * 译：静态的基础模型，可以是任意类型（纯动态 provider 传空数组）。没有 `type` 的模型是对话模型。
	 */
	models: readonly ProviderModel<TApi>[];
	/**
	 * Fetch a dynamic model overlay of every type. createProvider restores and
	 * publishes it transactionally and drops models of unknown types.
	 *
	 * 译：拉取动态模型覆盖层（任意类型）。createProvider 以事务方式恢复和发布它，并丢弃未知类型的模型。
	 * 注：例如从 vLLM 的 /v1/models 动态拉取模型列表
	 */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly ProviderModel<TApi>[]>;
	/** Credential-specific chat model availability. See `Provider.filterModels`. */
	/** 译：按凭据决定对话模型的可用性。见 `Provider.filterModels`。 */
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** Credential-specific availability across every model type. See `Provider.filterAllModels`. */
	/** 译：按凭据决定所有类型模型的可用性。见 `Provider.filterAllModels`。 */
	filterAllModels?: (
		models: readonly ProviderModel<TApi>[],
		credential: Credential | undefined,
	) => readonly ProviderModel<TApi>[];
	/**
	 * Chat implementation: a single one for all chat models, or a map keyed by
	 * `model.api` for mixed-API providers. Optional when `images` or
	 * `classifiers` is given.
	 *
	 * 译：对话实现：可以是一个实现服务所有对话模型，也可以是以 `model.api` 为键的映射（混合协议 provider）。
	 * 提供了 `images` 或 `classifiers` 时可以省略。
	 */
	api?: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
	/** Image-generation implementations keyed by `model.api`. */
	/** 译：以 `model.api` 为键的图片生成实现。 */
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** Classifier implementations keyed by `model.api`. */
	/** 译：以 `model.api` 为键的分类器实现。 */
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all chat
 * models; an `api` map dispatches on `model.api`, and a model whose api has
 * no entry produces a stream error. One-shot operation maps dispatch on
 * `model.api` the same way. At least one concrete implementation across
 * `api`/`images`/`classifiers` is required; empty maps are rejected.
 *
 * 译：用零件构建一个 provider。内置 provider 工厂和 models.json 里的自定义 provider 都走这里。
 * 单个 `api` 服务所有对话模型；`api` 映射按 `model.api` 分派，没有对应条目的模型会产生流错误。
 * 一次性操作（图片、分类）的映射也按 `model.api` 分派。`api`/`images`/`classifiers` 中至少要有一个具体实现；
 * 空映射会被拒绝。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	// 注：第 1 步：判断 api 是"单个实现"还是"按协议的映射"。有 stream 函数的就是单个实现
	const single =
		input.api && typeof (input.api as ProviderStreams).stream === "function"
			? (input.api as ProviderStreams)
			: undefined;
	const byApi = single || !input.api ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);
	const images = input.images as Partial<Record<string, ProviderImages>> | undefined;
	const classifiers = input.classifiers as Partial<Record<string, ProviderClassifier>> | undefined;
	const streams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
	const imageImplementations = Object.values(images ?? {}).filter((entry) => entry !== undefined);
	const classifierImplementations = Object.values(classifiers ?? {}).filter((entry) => entry !== undefined);
	if (streams.length === 0 && imageImplementations.length === 0 && classifierImplementations.length === 0) {
		throw new Error(`Provider ${input.id}: at least one of "api", "images", or "classifiers" is required.`);
	}
	// 注：注意这是 createProvider 里少数会直接抛异常的地方：配置错误应该在启动时就暴露，而不是等到请求时

	const baselineModels = input.models;
	// 注：第 2 步：模型目录 = 静态基础模型 + 动态拉取的模型（同类型同 id 时动态的覆盖静态的）
	let dynamicModels: readonly ProviderModel<TApi>[] = [];
	const fetchModels = input.fetchModels;
	const currentModels = (): readonly ProviderModel<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex(
				(entry) => getModelType(entry) === getModelType(model) && entry.id === model.id,
			);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];
	// 注：（上一行）为模型找到协议实现：单个实现直接用；映射则按 model.api 查

	// 注：第 3 步：分派。找不到协议实现时不抛异常，而是返回一个只含 error 事件的流（又一次"错误进流"）
	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
		signal?: AbortSignal,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(
				model,
				async () => {
					throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
				},
				undefined,
				signal,
			);
		}
		return run(streams);
	};

	// 注：第 4 步：组装 Provider 对象
	const provider: Provider<TApi> = {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => currentModels().filter((model): model is Model<TApi> => isModelType(model, "chat")),
		getAllModels: currentModels,
		refreshModels: fetchModels
			? async (context) => {
					// 注：只有传了 fetchModels 才是动态 provider。先用存储恢复（context.stored），再联网拉取并持久化
					if (context.stored) {
						const restored = context.stored.models
							.filter((model) => model.provider === input.id)
							.map((model) => model as ProviderModel<TApi>);
						if (
							!(await context.publish({
								update: () => {
									dynamicModels = restored;
								},
							}))
						) {
							return;
						}
					}
					if (!context.allowNetwork || context.signal.aborted) return;
					const fetched = await fetchModels(context);
					if (context.signal.aborted) return;
					const refreshed = fetched.filter(hasKnownModelType);
					await context.publish({
						persist: { models: refreshed, checkedAt: Date.now() },
						update: () => {
							dynamicModels = refreshed;
						},
					});
				}
			: undefined,
		filterModels: input.filterModels,
		filterAllModels: input.filterAllModels,
		// 注：stream/streamSimple 就是"找到协议实现，然后原样转调"。provider 本身不做协议转换
		stream: (model, context, options) =>
			dispatch(model, (streams) => streams.stream(model, context, options), options?.signal),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options), options?.signal),
	};

	// 注：第 5 步：按协议实现的能力，可选地挂上 deferred / 图片 / 分类方法。阶段 1 可跳过
	if (streams.some((entry) => entry.fetchDeferred !== undefined)) {
		provider.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = apiFor(model);
					if (!implementation?.fetchDeferred) {
						throw new ModelsError(
							"provider",
							`Provider ${input.id} does not support deferred responses for "${model.api}"`,
						);
					}
					return implementation.fetchDeferred(model, handle, options);
				},
				undefined,
				options?.signal,
			);
	}
	if (streams.some((entry) => entry.cancelDeferred !== undefined)) {
		provider.cancelDeferred = async (model, handle, options) => {
			const implementation = apiFor(model);
			if (!implementation?.cancelDeferred) {
				throw new ModelsError(
					"provider",
					`Provider ${input.id} cannot cancel deferred responses for "${model.api}"`,
				);
			}
			await implementation.cancelDeferred(model, handle, options);
		};
	}
	if (images && imageImplementations.length > 0) {
		provider.generateImages = async (model, context, options) => {
			const implementation = images[model.api];
			if (!implementation) {
				return imageErrorResult(
					model,
					new ModelsError(
						"provider",
						`Provider ${input.id} has no image generation implementation for "${model.api}"`,
					),
				);
			}
			return implementation.generateImages(model, context, options);
		};
	}
	if (classifiers && classifierImplementations.length > 0) {
		provider.classify = async (model, context, options) => {
			const implementation = classifiers[model.api];
			if (!implementation) {
				return classifierErrorResult(
					model,
					new ModelsError("provider", `Provider ${input.id} has no classifier implementation for "${model.api}"`),
				);
			}
			return implementation.classify(model, context, options);
		};
	}

	return provider;
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * Non-chat models never match, even when their api id equals `api`.
 *
 * 译：对动态查到的模型做运行时检查的类型收窄（见上面的示例）。
 * 非对话模型永远不会匹配，即使它的 api id 等于 `api`。
 */
export function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi> {
	return isModelType(model, "chat") && model.api === api;
}

// 注：======== 成本计算 ========
// 注：按模型目录单价（每百万 token 的价格）算出各分项成本，直接写回 usage.cost。
// 注：协议适配器在解析完 provider 返回的 usage 后调用它。
export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 注：阶梯定价：有些模型输入超过某个 token 数后单价更高（如长上下文档位）。选中满足条件的最高档
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	// 译：Anthropic 对 1 小时缓存写入收取 2 倍的基础输入价格。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	usage.cost.totalFromProvider = false;
	// 注：这里算的是目录估算值；如果 provider 报告了真实计费（如 OpenRouter），适配器会在之后覆盖 total
	return usage.cost;
}

// 注：======== 思考级别 ========
// 注：从低到高排列。clampThinkingLevel 依赖这个顺序
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// 注：模型支持哪些思考级别：不支持推理只有 "off"；thinkingLevelMap 里为 null 的不支持；
// 注：xhigh/max 必须在 map 里显式写出才支持（需要显式启用）
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

// 注：把请求的级别"夹"到模型支持的级别上：支持就原样返回；
// 注：不支持时先向上找最近的支持级别，再向下找。例如模型只支持 off 和 high，请求 medium → high
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing their type, id, and provider.
 * Returns false if either model is null or undefined.
 *
 * 译：比较类型、id 和 provider 判断两个模型是否相等。任一为 null 或 undefined 时返回 false。
 */
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	if (!a || !b) return false;
	return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
