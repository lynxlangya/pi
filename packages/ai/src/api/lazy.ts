// 注：本文件实现"错误不抛异常、进事件流"这条契约的关键一环。
// 注：问题：调用 stream() 时需要先做异步准备（解析认证、动态 import SDK 模块），
// 注：但 stream() 本身必须同步返回一个流对象。准备阶段失败了怎么办？
// 注：解决：lazyStream 先同步返回一个空的外层流，后台跑准备工作；
// 注：成功就把内层流的事件转发过去，失败就往外层流推一个 error 事件。调用方永远拿到流，永远不会收到异常。
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

// 注：准备阶段失败时，构造一条"空内容 + 零用量"的 assistant 错误消息。
// 注：字段和正常消息完全一样，所以上层不需要区分"准备失败"和"生成中失败"，统一看 stopReason。
function createSetupErrorMessage(
	model: Model<Api>,
	error: unknown,
	timestamp: number,
	stopReason: "error" | "aborted",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		// 注：还没发出请求，所以 token 和费用都是 0
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp,
	};
}

// 注：判断内层源是否自带 result()（即它本身就是 EventStream）。
// 注：内层可能只是一个普通的 AsyncIterable（比如自定义 provider 返回的生成器），那就没有 result()。
function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/** Synchronous, read-only observation of the stream's existing forwarding path. */
/** 译：对流的现有转发路径做同步、只读的观察。 */
// 注：观察者钩子：每个事件、以及最终结果都会通知一次。用于遥测、日志等旁路逻辑，不能改事件。
export interface LazyStreamObserver {
	onEvent?(event: AssistantMessageEvent): void;
	onResult?(result: AssistantMessage | undefined): void;
}

// 注：把内层源（source）的事件逐个转发到外层流（target）。
async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	observer: LazyStreamObserver | undefined,
	observeResult: (result: AssistantMessage | undefined) => void,
): Promise<void> {
	let result: AssistantMessage | undefined;
	for await (const event of source) {
		target.push(event);
		observer?.onEvent?.(event);
		// 注：边转发边记下终止事件携带的消息，作为最终结果的候选
		if (event.type === "done") result = event.message;
		else if (event.type === "error") result = event.error;
	}
	// 注：如果内层源自带 result()，以它为准（更权威）
	if (hasResult(source)) result = await source.result();
	target.end(result);
	observeResult(result);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 *
 * 译：同步返回一个流，同时在背后执行异步准备工作（认证解析、惰性加载模块）。
 * 准备失败时，以一个 error 事件结束这个流。
 */
export function lazyStream(
	model: Model<Api>,
	// 注：异步准备函数，返回真正干活的内层流
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	observer?: LazyStreamObserver,
	// 注：用于区分失败原因：如果失败时 signal 已经 abort，就报 "aborted"，否则报 "error"
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const startedAt = Date.now();
	// 注：外层流：立即返回给调用方
	const outer = new AssistantMessageEventStream();
	// 注：保证 observer.onResult 只被调用一次
	let observedResult = false;
	const observeResult = (result: AssistantMessage | undefined): void => {
		if (observedResult) return;
		observedResult = true;
		observer?.onResult?.(result);
	};

	// 注：故意不 await：后台执行。注意 .catch 也会捕获 forwardStream 内部抛出的异常
	setup()
		.then((inner) => forwardStream(outer, inner, observer, observeResult))
		.catch((error) => {
			// 注：任何失败都转成 error 事件推给外层流，这就是"错误进流不抛出"的实现
			const reason = signal?.aborted ? "aborted" : "error";
			const message = createSetupErrorMessage(model, error, startedAt, reason);
			const event: AssistantMessageEvent = { type: "error", reason, error: message };
			outer.push(event);
			observer?.onEvent?.(event);
			outer.end(message);
			observeResult(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 *
 * 译：把一个动态导入的 API 实现模块包装成 `ProviderStreams`。
 * 模块在第一次调用 stream 时才加载；宿主的 import 缓存会对多次加载去重。
 * 加载失败时，以一个 error 事件结束返回的流。
 */
// 注：下面这个接口声明 API 是否支持"延迟响应"（deferred，类似异步批处理：先提交，稍后取结果）。阶段 1 可以忽略。
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

// 注：provider 工厂里的 `openAICompletionsApi()` 最终就是调这个函数。
// 注：load 是 `() => import("./openai-completions.ts")` 这样的动态导入，所以 openai SDK 只在第一次请求时才加载。
export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		// 注：stream 和 streamSimple 都包进 lazyStream：先 load 模块，再调用模块里真正的实现
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options), undefined, options?.signal),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => (await load()).streamSimple(model, context, options),
				undefined,
				options?.signal,
			),
	};

	// 注：只有声明了能力，才挂上对应方法
	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
					return implementation.fetchDeferred(model, handle, options);
				},
				undefined,
				options?.signal,
			);
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
