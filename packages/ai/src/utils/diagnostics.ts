import type { JsonObject } from "../types.ts";

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

// 注：======== 以下是学习用调试日志（learnLog），仅 feat/learn 分支使用，不进上游 ========
// 注：放在 diagnostics.ts 而不是单独文件：models 入口的依赖图有 20 个文件的上限（scripts/check-entry-graphs.mjs）。
// 注：开关（环境变量 PI_LEARN_DEBUG）：
// 注：  未设置       → 完全不输出，对正常运行零影响
// 注：  1            → 输出关键步骤（认证、请求构造、stopReason、usage、重试……）
// 注：  verbose      → 额外输出每个原始 SSE chunk 和完整请求体 messages（量很大）
// 注：所有打点都调用 learnLog / learnVerbose，以后要清理时 grep "learnLog\|learnVerbose" 即可全部找出。
// 注：在 Chrome DevTools 里调试时，这些日志会同时出现在终端和 DevTools 的 Console 里（对象可展开）。

function learnDebugLevel(): string | undefined {
	return typeof process !== "undefined" ? process.env.PI_LEARN_DEBUG : undefined;
}

/** Learning-only: log one key step when PI_LEARN_DEBUG is set. */
export function learnLog(scope: string, message: string, data?: unknown): void {
	if (!learnDebugLevel()) return;
	if (data === undefined) console.log(`[pi-ai:${scope}] ${message}`);
	else console.log(`[pi-ai:${scope}] ${message}`, data);
}

/** Learning-only: log high-volume details (raw chunks, every event) when PI_LEARN_DEBUG=verbose. */
export function learnVerbose(scope: string, message: string, data?: unknown): void {
	if (learnDebugLevel() !== "verbose") return;
	if (data === undefined) console.log(`[pi-ai:${scope}] ${message}`);
	else console.log(`[pi-ai:${scope}] ${message}`, data);
}

// 注：认证类请求头只显示前 4 位 + 长度，避免 key 出现在终端、截图或日志里。
const SECRET_HEADER = /authorization|api-key|apikey|x-api-key|token|cookie|secret/i;

/** Learning-only: copy headers with credential values masked. */
export function learnMaskHeaders(headers: Record<string, string | null | undefined>): Record<string, string> {
	const masked: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === null || value === undefined) continue;
		masked[name] = SECRET_HEADER.test(name) ? `${value.slice(0, 4)}…(${value.length} chars)` : value;
	}
	return masked;
}
