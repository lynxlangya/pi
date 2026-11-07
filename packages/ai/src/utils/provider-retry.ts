// 注：HTTP 请求层的重试（在拿到响应流之前）。openai-completions.ts 的 stream 里用它包住 client.chat.completions.create。
// 注：为什么不用 SDK 自带重试：SDK 的退避计时器不理会 AbortSignal，用户取消时还会傻等。所以 SDK 设 maxRetries: 0，由这里接管。
import { learnLog } from "./diagnostics.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	/** 译：即使默认策略会重试，也要立即失败的 HTTP 状态码。 */
	noRetryStatuses?: readonly number[];
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

// 注：SDK 抛出的错误是否带 status 和 headers（OpenAI/Anthropic SDK 的 APIError 形状）。
function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
/** 译：照搬当前锁定版本的 OpenAI/Anthropic SDK 重试策略；升级任一 SDK 时要复查。 */
// 注：服务端用 x-should-retry 头明确表态时听它的；否则无状态码（网络错误）、408/409/429/5xx 重试。
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

// 注：服务端要求等待太久（超过 maxRetryDelayMs）时直接报错，而不是让用户卡几分钟。
function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

// 注：延迟来源优先级：retry-after-ms 头 → retry-after 头（秒数或 HTTP 日期）→ 指数退避 0.5s、1s、2s…封顶 8s，再减最多 25% 抖动。
function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 * 译：复刻 OpenAI 和 Anthropic SDK 的重试行为，但让退避等待可以被打断。SDK 内置的重试计时器不理会请求的
 * AbortSignal，所以调用方必须以 maxRetries: 0 调用 SDK，并用这个函数包住请求。服务端要求的延迟超过
 * maxRetryDelayMs（默认 60 秒）时立即失败；设为 0 可取消这个限制。
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			// 译：每次重试都是全新的 SDK 请求，所以 X-Stainless-Retry-Count 始终为 0。
			return await request();
		} catch (error) {
			// 注：已取消 → 立即抛；次数用完、不是 HTTP 错误、不可重试、或在 noRetryStatuses 里 → 原样抛出。
			// 注：抛出的错误会被 stream 的 catch 接住，变成 error 事件。
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) {
				// 注：[调试] 注意 maxRetries 默认是 0，所以不传 maxRetries 时 429/5xx 也会直接失败
				learnLog(
					"retry",
					`HTTP 请求失败，不再重试 (剩余次数=${retriesRemaining}, status=${isProviderError(error) ? error.status : "非 HTTP 错误"})`,
				);
				throw error;
			}
			if (error.status !== undefined && options.noRetryStatuses?.includes(error.status)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			const learnDelayMs = getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs);
			learnLog("retry", `status=${error.status} 可重试 → 第 ${retryIndex + 1} 次重试，等待 ${learnDelayMs}ms`);
			await abortableSleep(learnDelayMs, options.signal);
		}
	}
}
