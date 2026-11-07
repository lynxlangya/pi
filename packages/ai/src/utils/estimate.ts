// 注：上下文 token 估算（不调用分词器，只按字符数粗估）。用于 maxTokens 夹紧（simple-options.ts）和判断何时压缩历史。
// 注：思路：最近一条有效 assistant 消息的 usage 是服务端报的真实值，最准；它之后新增的消息再按"字符数 / 3.5"估算。
import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	/** 译：估算的上下文总 token 数。 */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	/** 译：最近一条可用的 assistant 消息 usage 报告的 token 数（真实值）。 */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	/** 译：那条消息之后的消息的估算 token 数。 */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	/** 译：提供 usage 的那条消息的下标；没有则为 null。 */
	lastUsageIndex: number | null;
}

// 注：经验值：约 3.5 字符 ≈ 1 token；一张图按 4800 字符（约 1371 token）估算。中文实际会偏差较大，只用于留余量。
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

// 注：单条消息估算：system 算文本 + 增删的工具定义；user/toolResult 算文本和图片；assistant 算文本、思考、工具名和参数 JSON。
export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			// 译：这条响应之后又插入了更新的前缀消息（例如压缩摘要），所以它的 usage 不能描述当前的前缀。
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

// 注：总估算 = 最近有效 usage 的真实值 + 之后消息的估算值；没有任何 usage 时全部按字符估算。
// 注：error/aborted 的消息、或被压缩摘要"过时"的消息，其 usage 不采用。
export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
