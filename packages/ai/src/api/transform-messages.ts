// 注：跨 provider 的消息清洗。每个 Api 实现发请求前都会调 transformMessages，保证历史消息能被"当前模型"接受。
// 注：典型场景：前几轮用 Claude，这一轮切到 DeepSeek，历史里 Claude 的思考签名、超长工具 id、图片都要处理。
// 注：两遍处理：第一遍逐条改内容（图片降级、丢别家思考、规范化工具 id）；第二遍补齐"孤儿工具调用"的结果。

import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { learnLog } from "../utils/diagnostics.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image attached after the tool results)";

/** An error tool result split into a text-only result and the images to send after the tool results. */
export interface SplitErrorToolResult {
	/** The result content with each run of images replaced by a note. */
	content: TextContent[];
	/** Text naming the tool call, to send before `images`. */
	caption: string;
	images: ImageContent[];
}

/**
 * Split the images out of an error tool result, for APIs that reject images in error results
 * (Anthropic, and Claude on Bedrock). Send the returned content as the tool result and the caption and
 * images after all tool results of the turn, in the same user message. Returns undefined for results
 * that need no split (#10794).
 * 译：把错误工具结果里的图片拆出来，用于不接受"错误结果里带图片"的 API（Anthropic、Bedrock 上的 Claude）。
 * 返回的 content 作为工具结果发送；caption 和 images 放在本轮所有工具结果之后、同一条 user 消息里发送。
 * 不需要拆分的结果返回 undefined（#10794）。
 */
export function splitErrorToolResultImages(msg: ToolResultMessage): SplitErrorToolResult | undefined {
	if (!msg.isError) return undefined;
	const images = msg.content.filter((block): block is ImageContent => block.type === "image");
	if (images.length === 0) return undefined;
	return {
		content: replaceImagesWithPlaceholder(msg.content, ERROR_TOOL_IMAGE_PLACEHOLDER),
		caption: `Images from the error result of tool call ${msg.toolCallId} (${msg.toolName}):`,
		images,
	};
}

// 注：把图片替换成占位文本；连续多张图只放一个占位，避免刷屏。
function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

// 注：模型不支持图片输入时，把 user 和 toolResult 里的图片换成占位文本，否则请求会被服务端拒绝。
function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 * 译：为跨 provider 兼容规范化工具调用 ID。
 * OpenAI Responses API 生成的 ID 长达 450+ 字符，且含 `|` 等特殊字符；
 * Anthropic API 要求 ID 匹配 ^[a-zA-Z0-9_-]+$（最长 64 字符）。
 * 注：normalizeToolCallId 由各 Api 实现自己传入（各家规则不同），这里只负责"改了 id 之后，对应的 toolResult 也要同步改"。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	// 译：建立"原始工具调用 ID → 规范化 ID"的映射，第一遍改 assistant 里的 id 时登记，改 toolResult 时查表。
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	// 译：把来自无类型调用方（自定义工具、手拼的历史、旧会话文件）的 null/undefined content 规整成 []，
	// 译：这样下游代码可以放心依赖类型契约。
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	// 译：第一遍：逐条转换消息（不支持的图片降级、思考块处理、工具调用 ID 规范化）。
	const transformed = imageAwareMessages.map((msg) => {
		// System and user messages pass through unchanged
		// 译：system 和 user 消息原样通过。
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		// 译：处理 toolResult：如果映射表里有，就把 toolCallId 换成规范化后的 ID。
		// 注：能查到是因为 assistant 消息总在它的工具结果之前，map 是按顺序一边遍历一边填的。
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		// 译：assistant 消息需要检查是否要转换。
		// 注：判断依据是"这条消息是不是当前这个模型生成的"（provider + api + model 三者都相同）。
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Thinking from another model is dropped. Signatures and encrypted reasoning are
					// only valid for the model that produced them, and sending readable thinking as
					// plain text makes the new model treat it as part of the visible reply.
					// 译：别的模型产生的思考直接丢弃。签名和加密推理只对产生它的模型有效；
					// 译：而把可读的思考当普通文本发过去，新模型会把它当成可见回复的一部分。
					if (!isSameModel) {
						learnLog("transform", `丢弃别家模型的思考块（来自 ${assistantMsg.provider}/${assistantMsg.model}）`);
						return [];
					}
					// Keep redacted and signed blocks even if the thinking text is empty
					// (OpenAI encrypted reasoning); they are needed for replay.
					// 译：即使思考文本为空，也保留 redacted 和带签名的块（OpenAI 加密推理），回放时需要它们。
					if (block.redacted || block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					return block;
				}

				// 注：文本块：别家模型的文本只保留 type 和 text，去掉 textSignature 等只对原模型有意义的字段。
				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					// 注：工具调用：别家模型的 thoughtSignature（Google 专用的思考签名）去掉；id 按当前 Api 的规则规范化并登记映射。
					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							learnLog("transform", `工具调用 id 规范化: ${toolCall.id} → ${normalizedId}`);
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	// 译：第二遍：给"孤儿"工具调用（没有对应结果的调用）插入合成的工具结果。
	// 译：这样既保留思考签名，又满足 API 的要求（多数 API 要求每个 tool_call 后面必须有对应的 tool 结果）。
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	// System messages are transparent to tool-call accounting: one that lands between a tool
	// call and its results is held back and emitted after the results (synthetic ones
	// included), so it never causes a duplicate result for a call that is answered later.
	// 译：system 消息对工具调用的配对是"透明"的：如果它落在工具调用和其结果之间，就先扣下，
	// 译：等结果（包括合成的结果）发完再放出来，这样不会给稍后才被回答的调用产生重复结果。
	const heldSystemMessages: Message[] = [];
	// 注：结算待定的工具调用：没有结果的补一条 isError 的 "No result provided"，再放出扣下的 system 消息。
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					learnLog("transform", `孤儿工具调用 ${tc.name}(${tc.id}) → 补一条合成结果 "No result provided"`);
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			// 译：如果上一条 assistant 还有未配对的孤儿工具调用，现在插入合成结果。
			closePendingToolCalls();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			// 译：完全跳过出错/被中止的 assistant 消息。它们是不完整的轮次，不应回放：
			// 译：- 可能只有部分内容（有思考没正文、工具调用不完整）
			// 译：- 回放它们可能导致 API 报错（例如 OpenAI 的 "reasoning without following item"）
			// 译：- 模型应该从最后一个有效状态重试
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				learnLog("transform", `跳过 stopReason=${assistantMsg.stopReason} 的 assistant 消息（不回放不完整的轮次）`);
				continue;
			}

			// Track tool calls from this assistant message
			// 译：记录这条 assistant 消息发起的工具调用，等待后续的结果来配对。
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) {
				heldSystemMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else if (msg.role === "user") {
			// A new user turn interrupts tool flow - insert synthetic results for orphaned calls
			// 译：新的 user 轮次打断了工具流程，给孤儿调用插入合成结果。
			closePendingToolCalls();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	// 译：如果对话以未解决的工具调用结尾，现在合成结果。
	closePendingToolCalls();

	learnLog(
		"transform",
		`transformMessages: ${messages.length} 条 → ${result.length} 条`,
		result.map((m) => m.role),
	);
	return result;
}
