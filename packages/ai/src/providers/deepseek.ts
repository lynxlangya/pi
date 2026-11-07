// 注：一个完整的 provider 定义只有这么几行，这就是 pi-ai 分层的好处：
// 注：DeepSeek 走 OpenAI 兼容协议，所以直接复用 openai-completions 这个 Api；差异全部由 detectCompat 自动识别。
// 注：想接入一家新的 OpenAI 兼容服务（比如公司内部网关），照抄这个文件，改 id/baseUrl/auth/models 即可。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

export function deepseekProvider(): Provider<"openai-completions"> {
	// 注：createProvider 把 catalog（模型列表）、auth（认证）、api（协议实现）组装成一个 Provider（见 models.ts）。
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		// 注：认证：优先用已存储的凭据（login 时交互输入），否则读环境变量 DEEPSEEK_API_KEY；第一个参数是登录提示里显示的名字。
		auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
		// 注：模型列表来自生成的 deepseek.models.ts（由 packages/ai/catalog 生成，不要手改）。
		models: Object.values(DEEPSEEK_MODELS),
		// 注：openAICompletionsApi() 内部是 lazyApi(() => import("./openai-completions.ts"))：首次请求时才加载 openai SDK。
		api: openAICompletionsApi(),
	});
}
