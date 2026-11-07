// 学习用调试脚本：用真实 DeepSeek 跑一遍 pi-ai 的完整链路，配合源码里的 learnLog 打点观察每一步。
//
// 运行（在仓库根目录）：
//   node learning/debug/deepseek-debug.ts                # basic：一问一答，带思考
//   node learning/debug/deepseek-debug.ts tool           # tool：工具调用 + 第二轮回传思考
//   PI_LEARN_DEBUG=verbose node learning/debug/deepseek-debug.ts   # 额外打印每个原始 chunk 和完整请求体
//
// 在 Chrome DevTools 里调试：
//   node --inspect-brk learning/debug/deepseek-debug.ts tool
//   然后 Chrome 打开 chrome://inspect → 点 "inspect"，在 Sources 里打开 packages/ai/src 下的文件打断点
//
// key 从仓库根目录的 .deepseek.env 读取（该文件已被 git 忽略）。脚本不会打印 key。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "../../packages/ai/src/models.ts";
import { deepseekProvider } from "../../packages/ai/src/providers/deepseek.ts";
import type { AssistantMessageEventStream, Context, Tool } from "../../packages/ai/src/types.ts";

// ---------- 第 0 步：读 key，打开调试开关 ----------

const KEY_FILE = join(import.meta.dirname, "..", "..", ".deepseek.env");

function loadDeepSeekKey(): string {
	const text = readFileSync(KEY_FILE, "utf8");
	const line = text.split("\n").find((l) => l.trim().startsWith("DEEPSEEK_API_KEY="));
	const key = line?.slice(line.indexOf("=") + 1).trim() ?? "";
	if (!key) {
		console.error(`还没有填 key：请打开 ${KEY_FILE}，在 DEEPSEEK_API_KEY= 后面填入你的 DeepSeek key。`);
		process.exit(1);
	}
	return key;
}

// 没设置时默认打开关键步骤日志；想看每个 chunk 用 PI_LEARN_DEBUG=verbose
process.env.PI_LEARN_DEBUG ??= "1";
// deepseekProvider 的认证会读这个环境变量（见 providers/deepseek.ts 的 envApiKeyAuth）
process.env.DEEPSEEK_API_KEY = loadDeepSeekKey();

// ---------- 第 1 步：组装 Models（只注册 DeepSeek 一个 provider） ----------

const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-flash");
if (!model) throw new Error("找不到 deepseek/deepseek-flash，确认已执行过 npm run build（会生成 providers/data）");

// ---------- 第 2 步：消费者视角打印事件 ----------
// 源码里的 [pi-ai:*] 日志是"生产者视角"；这里是调用方 for await 拿到的事件，两者对照着看。

async function printEvents(s: AssistantMessageEventStream): Promise<void> {
	let inDelta = false;
	for await (const event of s) {
		if (event.type === "thinking_delta" || event.type === "text_delta") {
			if (!inDelta) process.stdout.write(event.type === "thinking_delta" ? "\n  [思考] " : "\n  [正文] ");
			inDelta = true;
			process.stdout.write(event.delta);
			continue;
		}
		if (event.type === "toolcall_delta") continue; // 参数碎片太多，看 toolcall_end 的最终值即可
		if (inDelta) process.stdout.write("\n");
		inDelta = false;
		const extra =
			event.type === "done"
				? ` reason=${event.reason}`
				: event.type === "error"
					? ` reason=${event.reason} message=${event.error.errorMessage}`
					: event.type === "toolcall_end"
						? ` ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`
						: "";
		console.log(`[consumer] ${event.type}${extra}`);
	}
}

// 公共请求选项：限制输出长度省钱；maxRetries=2 才会走 provider-retry 的重试分支（默认是 0）
const requestOptions = {
	reasoning: "low",
	maxTokens: 1024,
	maxRetries: 2,
	// onResponse 钩子：不改源码就能拿到 HTTP 状态和响应头
	onResponse: (response: { status: number; headers: Record<string, string> }) => {
		console.log(`[hook] onResponse status=${response.status} content-type=${response.headers["content-type"]}`);
	},
} as const;

// ---------- 场景 basic：一问一答 ----------

async function runBasic(): Promise<void> {
	const context: Context = {
		systemPrompt: "你是一个简洁的助手，回答不超过两句话。",
		messages: [{ role: "user", content: "TCP 三次握手为什么不是两次？", timestamp: Date.now() }],
	};
	const s = models.streamSimple(model!, context, requestOptions);
	await printEvents(s);
	const message = await s.result();
	console.log("\n[result] stopReason=%s usage=%o cost=%o", message.stopReason, message.usage, message.usage.cost);
}

// ---------- 场景 tool：工具调用两轮 ----------
// 第 1 轮：模型调用 get_weather → stopReason "toolUse"
// 第 2 轮：把工具结果放回 context 再请求，观察 convertMessages 日志里 assistant 是否带 reasoning_content

const tools: Tool[] = [
	{
		name: "get_weather",
		description: "查询某个城市当前的天气",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "城市名，例如 杭州" } },
			required: ["city"],
		},
	},
];

async function runTool(): Promise<void> {
	const context: Context = {
		systemPrompt: "你是天气助手。需要天气数据时必须调用工具。",
		messages: [{ role: "user", content: "杭州现在适合跑步吗？", timestamp: Date.now() }],
		tools,
	};

	console.log("\n========== 第 1 轮 ==========");
	const first = models.streamSimple(model!, context, requestOptions);
	await printEvents(first);
	const firstMessage = await first.result();
	context.messages.push(firstMessage);

	const toolCalls = firstMessage.content.filter((b) => b.type === "toolCall");
	if (toolCalls.length === 0) {
		console.log("[script] 模型这次没有调用工具，换个问法再试一次");
		return;
	}
	for (const call of toolCalls) {
		// 假的工具实现：直接返回固定天气
		context.messages.push({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: `${String(call.arguments.city)}：晴，22°C，湿度 55%，AQI 40` }],
			isError: false,
			timestamp: Date.now(),
		});
	}

	console.log("\n========== 第 2 轮（带工具结果） ==========");
	const second = models.streamSimple(model!, context, requestOptions);
	await printEvents(second);
	const secondMessage = await second.result();
	console.log("\n[result] stopReason=%s usage=%o", secondMessage.stopReason, secondMessage.usage);
}

// ---------- 入口 ----------

const scenario = process.argv[2] ?? "basic";
if (scenario === "tool") await runTool();
else await runBasic();
