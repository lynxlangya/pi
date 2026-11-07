# pi-ai README 中英对照（阶段 1 精选）

原文：`packages/ai/README.md`（pi-ai v1.5.0，2026-11-07 版本）。

只收录阶段 1 要读的章节。跳过的章节：Supported Providers 列表、Image Input/Generation、Classification、Telemetry、Browser Usage、Bundling、OAuth、Migrating、Development。客户需要时再回原文读。

格式：英文原文在上，`> 译：` 是对应的中文翻译。代码块保留原样，代码里的英文注释在下一行用 `// 译：` 给出翻译。

---

# @earendil-works/pi-ai

Unified LLM API with provider collections, automatic auth resolution, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

> 译：统一的 LLM API。提供 provider 集合、自动认证解析、token 与成本统计，并且上下文容易持久化，会话中途可以交给其他模型继续。

**Note**: The chat catalog only includes models that support tool calling (function calling), as this is essential for agentic workflows. Image and classifier catalogs use their operation-specific capabilities.

> 译：**注意**：对话模型目录只收录支持工具调用（function calling）的模型，因为这是 Agent 工作流的必要能力。图片和分类器目录按各自操作的能力收录。

## Installation

```bash
npm install @earendil-works/pi-ai
```

Tool parameters are JSON Schema. The examples build them with `@earendil-works/pi-schema`, which also types the arguments (`npm install @earendil-works/pi-schema`); TypeBox schemas and plain JSON Schema objects work as well.

> 译：工具参数用 JSON Schema 描述。示例用 `@earendil-works/pi-schema` 构建，它还能推导出参数的 TS 类型（`npm install @earendil-works/pi-schema`）；TypeBox schema 或手写的 JSON Schema 对象也可以。

## Quick Start

You build a `Models` collection of providers and stream through it. The quickest start registers every built-in provider; apps that care about bundle size register individual providers instead (see [Provider Factories](#provider-factories) and [Bundling and Tree Shaking](#bundling-and-tree-shaking)).

> 译：先构建一个由 provider 组成的 `Models` 集合，再通过它发起流式请求。最快的起步方式是注册所有内置 provider；在意打包体积的应用改为逐个注册需要的 provider（见 Provider Factories 和 Bundling and Tree Shaking 两节）。

```typescript
import { type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { obj, opt, str } from '@earendil-works/pi-schema';

// A Models collection with every built-in provider registered
// 译：注册了全部内置 provider 的 Models 集合
const models = builtinModels();

// Sync lookup against the collection
// 译：在集合里同步查找模型
const model = models.getModel('openai', 'gpt-4o-mini')!;

// Define tools with JSON Schema; pi-schema's builders also type the arguments
// 译：用 JSON Schema 定义工具；pi-schema 的构建函数同时给出参数类型
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: obj({
    timezone: opt(str({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
// 译：构建对话上下文（容易序列化，也能在不同模型之间传递）
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (OPENAI_API_KEY from the environment here).
// 译：方式 1：流式请求，处理所有事件类型。
// 译：认证由 provider 解析（这里从环境变量读取 OPENAI_API_KEY）。
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      // 译：工具参数正在以片段形式流式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
// 译：流结束后取最终消息，追加到上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
// 译：如果有工具调用，逐个处理
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  // 译：把工具结果追加到上下文（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
// 译：如果有工具调用，再请求一轮让模型继续
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
// 译：方式 2：不走流式，直接拿完整响应
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

> 学习提示：上面"手动处理 toolCall → 追加 toolResult → 再请求一轮"就是 Agent 循环的最小形态。pi-agent-core 的 `agent-loop.ts` 把这件事自动化了。

`usage.cost.totalFromProvider` is `true` when `usage.cost.total` is the billed cost reported by the provider and `false` when it is estimated from the model's catalog rates. A missing value, as in sessions recorded before this field existed, also means `false`.

> 译：如果 `usage.cost.total` 是 provider 报告的实际计费金额，`usage.cost.totalFromProvider` 为 `true`；如果是按模型目录单价估算的，则为 `false`。没有这个字段（比如该字段出现之前录下的会话）也视为 `false`。

Snippets in the rest of this README assume a `models` collection set up like this (with the relevant providers registered).

> 译：本 README 后面的代码片段都假设已经按上面的方式建好了 `models` 集合（并注册了相关 provider）。

`usage.cost.total` is the best available total cost. For OpenRouter chat responses, it uses the cost reported by OpenRouter, including both the OpenRouter charge and upstream inference cost for BYOK requests. When provider accounting is unavailable or invalid, it falls back to the model's catalog rates. The `input`, `output`, `cacheRead`, and `cacheWrite` cost components remain catalog estimates and may not sum to a provider-reported total.

> 译：`usage.cost.total` 是能拿到的最准确的总成本。OpenRouter 的对话响应使用 OpenRouter 报告的费用，对 BYOK（自带 key）请求，这个费用同时包含 OpenRouter 的收费和上游推理费用。provider 没有给出计费数据或数据无效时，回退到模型目录单价。`input`、`output`、`cacheRead`、`cacheWrite` 这几个分项始终是按目录估算的，加起来不一定等于 provider 报告的总额。

## Providers and Models

A **provider** is the runtime unit: it owns its model catalog, its auth (API key resolution, OAuth flows), and its stream behavior. A `Models` collection holds providers and routes every request to the provider that owns the model.

> 译：**provider** 是运行时的基本单元：它拥有自己的模型目录、认证（API key 解析、OAuth 流程）和流式请求行为。`Models` 集合持有多个 provider，并把每个请求路由给拥有该模型的 provider。

Providers internally share **API implementations** (the wire protocols): Anthropic models use `anthropic-messages`, OpenAI uses `openai-responses`, while xAI, Groq, Cerebras, OpenRouter, and most others share `openai-completions`. Mixed-API providers (GitHub Copilot, OpenCode Zen) dispatch per model.

> 译：provider 内部共享 **API 实现**（即线上协议）：Anthropic 模型用 `anthropic-messages`，OpenAI 用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 和大多数其他 provider 共用 `openai-completions`。混合协议的 provider（GitHub Copilot、OpenCode Zen）按模型分派到不同协议。

### Provider Factories

For apps that only need specific providers, there is one factory per built-in provider, each a subpath import that pulls only that provider's catalog:

> 译：只需要部分 provider 的应用，可以使用每个内置 provider 各自的工厂函数。每个工厂是一个子路径导入，只会引入该 provider 的模型目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ...one module per provider in the Supported Providers list
// 译：……Supported Providers 列表里每个 provider 对应一个模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider factories import their model catalog and a lazy API wrapper. They do not import other providers. With bundler code splitting, SDK implementations (`@anthropic-ai/sdk`, `openai`, `@google/genai`, etc.) stay in lazy chunks loaded on the first request to a model of that API.

> 译：provider 工厂只导入自己的模型目录和一个惰性加载的 API 包装，不会导入其他 provider。配合打包器的代码分割，各家 SDK（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会留在惰性 chunk 里，直到第一次请求该协议的模型时才加载。

### All Built-in Providers

For apps that want everything (as in Quick Start):

> 译：需要全部 provider 的应用（就像 Quick Start 里那样）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // a Models collection with every built-in provider registered
                                // 译：注册了全部内置 provider 的 Models 集合
```

This imports all catalogs and every built-in provider factory. It is the heavy, explicit entrypoint. `builtinModels()` accepts the same options as `createModels()` (`credentials`, `authContext`); `builtinProviders()` returns the provider array if you want to register them on your own collection.

> 译：这会导入所有模型目录和全部内置 provider 工厂，是一个"重"且需要显式选择的入口。`builtinModels()` 接受和 `createModels()` 相同的选项（`credentials`、`authContext`）；如果想把它们注册到自己的集合上，`builtinProviders()` 会返回 provider 数组。

### Querying Models

Reads are synchronous and return the last-known lists:

> 译：读取操作都是同步的，返回最近一次已知的列表：

```typescript
const providers = models.getProviders();           // registered Provider objects
                                                   // 译：已注册的 Provider 对象
const provider = models.getProvider('anthropic');  // one provider
                                                   // 译：单个 provider

const all = models.getModels();                    // every chat model across providers
                                                   // 译：所有 provider 的全部对话模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

The unqualified reads `getModels()`/`getModel()`/`getAvailable()` return chat models (`Model<Api>`) usable with `stream()`. The `*OfType` reads return one model type, and `getAllModels()`/`getAllAvailable()` return every type as `AnyModel`:

> 译：不带类型限定的读取方法 `getModels()`/`getModel()`/`getAvailable()` 返回可用于 `stream()` 的对话模型（`Model<Api>`）。`*OfType` 系列返回指定类型的模型，`getAllModels()`/`getAllAvailable()` 以 `AnyModel` 返回所有类型：

```typescript
const images = models.getModelsOfType('image', 'openrouter');           // ImageModel[]
const flux = models.getModelOfType('image', 'openrouter', 'black-forest-labs/flux.2-pro');
const jev = models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const availableImages = await models.getAvailableOfType('image');
const everything = models.getAllModels();                               // AnyModel[]
```

The model's `type` decides which operation accepts it: chat models stream, `type: "image"` models generate images, and `type: "classifier"` models classify structured state. `type` is optional on chat models, so a model without `type` is a chat model. Do not compare `type` directly; narrow mixed lists with `isModelType()` or read the effective type with `getModelType()`:

> 译：模型的 `type` 决定了哪种操作能接受它：对话模型用于流式对话，`type: "image"` 的模型生成图片，`type: "classifier"` 的模型对结构化状态做分类。对话模型的 `type` 是可选的，没有 `type` 的模型就是对话模型。不要直接比较 `type`；对混合列表用 `isModelType()` 收窄类型，或用 `getModelType()` 读取实际类型：

```typescript
import { isModelType } from '@earendil-works/pi-ai';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'image')) {
    // model: ImageModel<ImageApi>
  }
}
```

IDs are unique within each provider and type; one upstream model may have separate entries for different operations. On a provider, `getModels()` returns chat models and the optional `getAllModels()` returns every type; providers with only chat models can omit it.

> 译：ID 在同一 provider、同一类型内唯一；同一个上游模型可能因操作不同而有多条记录。在 provider 上，`getModels()` 返回对话模型，可选的 `getAllModels()` 返回所有类型；只有对话模型的 provider 可以不实现它。

Dynamically listed chat models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

> 译：动态列出的对话模型类型是 `Model<Api>`。需要某个协议专属的选项类型时，用 `hasApi()` 类型守卫收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream options fully typed
  // 译：m 的类型是 Model<'anthropic-messages'>，stream 选项有完整类型
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

For tooling that wants the generated built-in catalog with full literal typing (provider and model IDs auto-complete), independent of any collection:

> 译：适用于需要带完整字面量类型（provider 和模型 ID 可自动补全）的内置生成目录、且不依赖任何集合的工具：

```typescript
import {
  getAllBuiltinModels,
  getBuiltinClassifierModel,
  getBuiltinClassifierModels,
  getBuiltinImageModel,
  getBuiltinImageModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // typed Model<'openai-responses'>
const radius = getBuiltinModel('radius', 'balanced');   // typed Model<'pi-messages'>
const flux = getBuiltinImageModel('openrouter', 'black-forest-labs/flux.2-pro');
const jev = getBuiltinClassifierModel('typesafe', 'jev-latest');
const providers = getBuiltinProviders();
const openrouterChat = getBuiltinModels('openrouter');        // Model[]
const openrouterImages = getBuiltinImageModels('openrouter'); // ImageModel[]
const typesafeClassifiers = getBuiltinClassifierModels('typesafe'); // ClassifierModel[]
const openrouterAll = getAllBuiltinModels('openrouter');      // AnyModel[]
```

### Dynamic Providers

Providers may have dynamic model lists (a llama.cpp server, a live OpenRouter listing). Reads stay sync; fetching is an explicit async verb:

> 译：provider 的模型列表可能是动态的（比如 llama.cpp 服务器、实时的 OpenRouter 列表）。读取仍然是同步的；拉取是一个显式的异步操作：

```typescript
// getModels() returns the last-known list (empty before the first refresh)
// 译：getModels() 返回最近一次已知的列表（第一次 refresh 之前为空）
await models.refresh({ providers: ['llamacpp'] }); // refresh one provider
                                                   // 译：刷新单个 provider
await models.refresh();                            // refresh all providers concurrently, best-effort
                                                   // 译：并发刷新所有 provider，尽力而为
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

Static built-in providers are no-ops for `refresh()`. Radius is both static and dynamic: it ships the public `radius.pi.dev` catalog for synchronous API lookup, then overlays cached and freshly fetched `/v1/config` models when refreshed with configured auth. See [createProvider()](#createprovider) for building a dynamic provider.

> 译：对静态的内置 provider 调用 `refresh()` 什么也不做。Radius 既是静态的也是动态的：它自带公开的 `radius.pi.dev` 目录供同步查找，配置了认证后刷新时，再叠加缓存的和新拉取的 `/v1/config` 模型。如何构建动态 provider 见 createProvider() 一节。

## Auth

Every provider owns its auth: how API keys resolve (stored credentials, environment variables, ambient sources like AWS profiles or gcloud ADC) and, where supported, OAuth login/refresh flows.

> 译：每个 provider 自己负责认证：API key 怎么解析（已存储的凭据、环境变量、AWS profile 或 gcloud ADC 这类环境凭据），以及在支持的情况下，OAuth 登录和刷新流程。

### How Auth Resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

> 译：调用 `models.stream()` 时，集合会通过拥有该模型的 provider 解析认证，并把结果合并进请求。单次请求显式传入的值永远优先：

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
// 译：通过 provider 解析（环境变量、已存储的凭据、OAuth token）：
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
// 译：显式传入的 key 优先于 provider 解析出的任何值：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

> 译：不发请求也能查看解析结果。传 provider ID 得到 provider 级别的认证；传模型则额外包含它的静态 `model.headers`：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
                                                     // 译：例如 "ANTHROPIC_API_KEY"、"OAuth"、"stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
                                                    // 译：provider 认证 headers + model.headers
} else {
  console.log('not configured');
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when something is actually broken (`"oauth"`: token refresh failed, credential preserved for re-login; `"auth"`: key resolution or credential store failure). Request paths surface the same failures as stream errors.

> 译：两种重载都会解析凭据，必要时刷新过期的 OAuth，可能返回由认证派生的 `apiKey`、`headers` 或 `baseUrl`。provider 未配置时 `getAuth()` 返回 `undefined`；真正出错时以 `ModelsError` 拒绝（`"oauth"`：token 刷新失败，凭据保留以便重新登录；`"auth"`：key 解析或凭据存储失败）。在请求路径上，同样的失败会以流错误的形式出现。

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

> 译：`getAuth()`、`checkAuth()`、`getAvailable()`、登录和登出都可以通过已有的选项或交互对象接收调用方的取消信号；不传 signal 时不设上限。provider 的 `login`、`ApiKeyAuth.check`、`ApiKeyAuth.resolve`、`OAuthAuth.refresh` 实现总会收到一个具体的 signal，阻塞性工作必须响应它。

### Transforming Request Headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a Models-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, but before provider dispatch:

> 译：`Models.stream()`、`complete()`、`streamSimple()`、`completeSimple()` 接受一个只属于 Models 层的 `transformHeaders` 选项。它在 provider 认证、`model.headers`、显式 `options.headers` 合并之后、分派给 provider 之前执行一次：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

The ordering is:

> 译：顺序是：

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names are merged case-insensitively. Explicit headers override auth/model headers, and the transform has final control; returning `null` for a header suppresses lower-level defaults that support deletion.

> 译：header 名称按大小写不敏感合并。显式 headers 覆盖认证和模型 headers，transform 拥有最终控制权；对某个 header 返回 `null`，可以去掉底层支持删除的默认值。

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation must consume it and remove it before calling `Provider.stream*()`. Provider implementations continue receiving ordinary `ApiStreamOptions` or `SimpleStreamOptions` and never handle the transform themselves. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve request auth twice.

> 译：`transformHeaders` 属于 `Models`，不属于 `Provider`。`Models` 的实现必须消费它，并在调用 `Provider.stream*()` 之前把它移除。provider 实现收到的仍是普通的 `ApiStreamOptions` 或 `SimpleStreamOptions`，从不自己处理 transform。用这个选项代替"在 `stream*()` 之前先调 `getAuth(model)`"，后者会把请求认证解析两次。

> 学习提示：给客户做多租户网关时，注入租户 header、trace id 就用 `transformHeaders`。

### Client Identity

`identity` controls how requests identify the calling app to providers. Set it on `createModels()` as a default, or per request; a request's fields override the `Models` default field by field:

> 译：`identity` 控制请求如何向 provider 表明调用方应用的身份。可以在 `createModels()` 上设为默认值，也可以按请求设置；请求里的字段逐个覆盖 `Models` 的默认值：

```typescript
const models = createModels({
  identity: {
    userAgent: 'detailed',
    version: '2.1.0',
    attribution: { name: 'my-app', url: 'https://my-app.example', categories: ['cloud-agent'] },
  },
});

await models.completeSimple(model, context, { identity: { attribution: null } });
```

- `userAgent`: `"detailed"` (default) sends `pi/<version> (<platform>; <runtime>; <arch>)`, `"short"` sends `pi`, and `{ custom: "..." }` sends the given value. On Bedrock the value is appended to the AWS SDK user agent.
- `version`: the version in the detailed `User-Agent`. Default: the pi-ai version.
- `attribution`: provider attribution headers. Absent (default) or `null` sends none; `null` also turns off attribution from a merged identity. `{ name, url, categories? }` maps to each provider's headers:
  - OpenRouter: `HTTP-Referer: <url>` (the app's identity in OpenRouter's rankings, grouped by origin), `X-OpenRouter-Title: <name>`, and `X-OpenRouter-Categories` (comma-separated).
  - NVIDIA NIM: `X-BILLING-INVOKE-ORIGIN: <name>` with its first letter upper-cased.
  - OpenCode: `x-opencode-client: <name>`.

  `PI_ATTRIBUTION` is pi's: `{ name: "pi", url: "https://pi.dev", categories: ["cli-agent"] }`.

> 译：
> - `userAgent`：`"detailed"`（默认）发送 `pi/<版本> (<平台>; <运行时>; <架构>)`，`"short"` 发送 `pi`，`{ custom: "..." }` 发送指定值。在 Bedrock 上，这个值会追加到 AWS SDK 的 user agent 后面。
> - `version`：detailed `User-Agent` 里的版本号。默认是 pi-ai 的版本。
> - `attribution`：provider 的来源归属 headers。不设（默认）或设为 `null` 都不发送；`null` 还会关闭合并来的 identity 里的 attribution。`{ name, url, categories? }` 映射到各 provider 的 headers：
>   - OpenRouter：`HTTP-Referer: <url>`（应用在 OpenRouter 排行榜里的身份，按来源分组）、`X-OpenRouter-Title: <name>`、`X-OpenRouter-Categories`（逗号分隔）。
>   - NVIDIA NIM：`X-BILLING-INVOKE-ORIGIN: <name>`，首字母大写。
>   - OpenCode：`x-opencode-client: <name>`。
>
>   `PI_ATTRIBUTION` 是 pi 自己的：`{ name: "pi", url: "https://pi.dev", categories: ["cli-agent"] }`。

Identity headers are defaults below provider, model, and request headers, so configured headers win and a `null` request header removes one. Providers that send a fixed client identity, such as GitHub Copilot and Anthropic OAuth, keep it. `withClientIdentity(models, identity)` returns a wrapper of a `Models` (or `MutableModels`) whose requests use `identity` over the one the `Models` was created with, for libraries that receive a `Models` from their host. `identity` is plain JSON, so it can be persisted with other request options.

> 译：identity headers 是默认值，优先级低于 provider、模型和请求 headers，所以配置过的 headers 优先，请求里设为 `null` 的 header 会被移除。发送固定客户端身份的 provider（如 GitHub Copilot 和 Anthropic OAuth）保持不变。`withClientIdentity(models, identity)` 返回一个 `Models`（或 `MutableModels`）的包装，它的请求使用传入的 `identity`，覆盖创建 `Models` 时的那个；适合从宿主拿到 `Models` 的库使用。`identity` 是纯 JSON，可以和其他请求选项一起持久化。

### Credential Store

Stored credentials (API keys entered interactively, OAuth tokens) live in a `CredentialStore` — one type-tagged credential per provider. pi-ai ships an in-memory default; apps inject persistent storage:

> 译：已存储的凭据（交互式输入的 API key、OAuth token）放在 `CredentialStore` 中，每个 provider 一条带类型标签的凭据。pi-ai 自带一个内存实现作为默认；应用可以注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// 译：builtinModels() 接受相同的选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

The contract is small: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` (the only write path — a serialized read-modify-write), and `delete(providerId)`. Each operation accepts optional cancellation options. Enumeration must not resolve secrets or execute configured key commands. OAuth token refresh runs inside `modify`, so concurrent requests and processes cannot double-refresh a rotated token. A stored credential *owns* its provider: environment variables are only consulted when nothing is stored, and a failed refresh never silently falls back to an env key.

> 译：契约很小：`read(providerId)`；`list()` 列出不含密钥的 `{ providerId, type }` 元数据；`modify(providerId, fn)`（唯一的写入路径，串行化的读-改-写）；`delete(providerId)`。每个操作都接受可选的取消选项。枚举时不得解析密钥，也不得执行配置的取 key 命令。OAuth token 刷新在 `modify` 内部执行，所以并发请求和多个进程不会对已轮换的 token 重复刷新。已存储的凭据对其 provider 拥有*所有权*：只有什么都没存时才查环境变量，刷新失败也绝不会悄悄回退到环境变量里的 key。

> 学习提示：客户多租户场景，`CredentialStore` 就是你要实现的接口（比如按租户从 DB/KMS 读 key）。

API-key credentials use the same discriminator as pi's `auth.json` and can carry provider-scoped env/config values:

> 译：API key 凭据使用和 pi 的 `auth.json` 相同的类型标识字段，还可以携带 provider 范围内的环境变量或配置值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### Environment Variables

Built-in providers resolve these env vars (Node.js; in browsers pass `apiKey` explicitly):

> 译：内置 provider 会解析下面这些环境变量（Node.js 环境；浏览器里要显式传 `apiKey`）。下表只摘录与国内和常用场景相关的几行，完整表格见原文。

| Provider | Environment Variable(s) |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |

Stored credentials remain provider-scoped, so save the key under the provider ID you register.

> 译：已存储的凭据按 provider 划分，所以要把 key 存在你注册时使用的 provider ID 下。

## Tools

Tools enable LLMs to interact with external systems. A tool's `parameters` is a JSON Schema object: built with `@earendil-works/pi-schema`'s builders (which also type the arguments through its `Static`), with TypeBox, or written by hand. `validateToolCall()` and `validateToolArguments()` validate with pi-schema, coercing loosely typed arguments first (numeric strings, `"true"`, a single value for an array, `null` for an omitted optional property). Schemas are plain JSON, so they serialize with the rest of a context.

> 译：工具让 LLM 能和外部系统交互。工具的 `parameters` 是一个 JSON Schema 对象：可以用 `@earendil-works/pi-schema` 的构建函数生成（它还能通过 `Static` 推导参数类型），也可以用 TypeBox，或者手写。`validateToolCall()` 和 `validateToolArguments()` 用 pi-schema 校验，校验前会先对类型宽松的参数做转换（数字字符串、`"true"`、本该是数组却只给了单个值、省略的可选属性给了 `null`）。schema 是纯 JSON，可以和上下文的其他部分一起序列化。

### Defining Tools

```typescript
import { type Tool, StringEnum } from '@earendil-works/pi-ai';
import { arr, obj, str } from '@earendil-works/pi-schema';

// Define tool parameters with pi-schema's builders
// 译：用 pi-schema 的构建函数定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: obj({
    location: str({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: StringEnum gives { type: "string", enum: [...] }, which every provider accepts,
// including Google's, which rejects anyOf/const patterns
// 译：注意：StringEnum 生成 { type: "string", enum: [...] }，所有 provider 都接受，
// 译：包括会拒绝 anyOf/const 写法的 Google

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: obj({
    title: str({ minLength: 1 }),
    startTime: str({ format: 'date-time' }),
    endTime: str({ format: 'date-time' }),
    attendees: arr(str({ format: 'email' }), { minItems: 1 })
  })
};
```

### Constrained Sampling for Tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` uses provider-side strict schema enforcement when supported and otherwise falls back to normal tool calling. `strict: 'require'` fails the request when the active provider/model cannot honor it. Set `constrainedSampling: false` to explicitly opt out; it behaves the same as omitting the field.

> 译：工具可以选择启用 provider 端的约束采样（constrained sampling）。对 JSON Schema 工具，`strict: 'prefer'` 在 provider 支持时使用严格 schema 约束，不支持则回退为普通工具调用。`strict: 'require'` 在当前 provider 或模型做不到时直接让请求失败。设置 `constrainedSampling: false` 表示显式不启用，效果和不写这个字段一样。

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: obj({ path: str(), content: str() }), // obj() is closed: additionalProperties: false
                                                    // 译：obj() 是封闭的：additionalProperties: false
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

Strict JSON-schema constrained sampling is supported for OpenAI, Anthropic, supported Amazon Bedrock Converse models, Mistral, and Gemini 3 tool calls through the Google Generative AI and Vertex adapters. (… the rest of this paragraph covers OpenAI grammar tools: Lark/regex variants, `compat.supportsOpenAIGrammarTools`, and why it stays off for gateways such as OpenRouter.)

> 译：严格 JSON Schema 约束采样支持以下场景：OpenAI、Anthropic、部分 Amazon Bedrock Converse 模型、Mistral，以及通过 Google Generative AI 和 Vertex 适配器的 Gemini 3 工具调用。（本段其余部分讲 OpenAI 的 grammar 工具：Lark/regex 变体、`compat.supportsOpenAIGrammarTools`，以及为什么在 OpenRouter 这类网关上默认关闭。阶段 1 可以跳过，用到时读原文。）

### Handling Tool Calls

Tool results use content blocks and can include both text and images:

> 译：工具结果使用内容块（content blocks），可以同时包含文本和图片：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
// 译：检查响应里有没有工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    // 译：用参数执行你的工具
    // 译：参数校验见 "Validating Tool Arguments" 一节
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    // 译：追加文本形式的工具结果
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
// 译：工具结果也可以包含图片（用于支持视觉的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

> 译：流式过程中，工具调用参数会随着到达被逐步解析。这样在参数完整之前就能实时更新 UI：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    // 译：流式过程中 toolCall.arguments 是部分解析的 JSON
    // 译：可以据此渐进式更新 UI
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      // 译：要做防御：参数可能不完整
      // 译：例如：在文件内容还没传完时，先显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        // 译：内容可能只有一部分，也可能还没有
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    // 译：到这里 toolCall.arguments 已经完整（但还没有校验）
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**
- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON
- Fields may be missing or incomplete - always check for existence before use
- String values may be truncated mid-word
- Arrays may be incomplete
- Nested objects may be partially populated
- At minimum, `arguments` will be an empty object `{}`, never `undefined`
- The Google provider does not support function call streaming. Instead, you will receive a single `toolcall_delta` event with the full arguments.

> 译：**关于部分工具参数的要点：**
> - 在 `toolcall_delta` 事件中，`arguments` 是对不完整 JSON 尽力解析的结果
> - 字段可能缺失或不完整，使用前一定要检查是否存在
> - 字符串值可能在单词中间被截断
> - 数组可能不完整
> - 嵌套对象可能只填充了一部分
> - `arguments` 最少也是空对象 `{}`，绝不会是 `undefined`
> - Google provider 不支持函数调用的流式传输，你只会收到一个带完整参数的 `toolcall_delta` 事件

### Validating Tool Arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools. It coerces loosely typed arguments with pi-schema (`compile(schema, { coerce: true }).parse()`), returns the coerced arguments, and throws an error listing pi-schema's errors (`path: message`) followed by the arguments it received:

> 译：自己实现工具执行循环时，在把参数交给工具之前，先用 `validateToolCall` 校验。它用 pi-schema 转换类型宽松的参数（`compile(schema, { coerce: true }).parse()`），返回转换后的参数；校验失败时抛出错误，错误信息先列出 pi-schema 的错误（`path: message`），再附上收到的参数：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      // 译：按工具的 schema 校验参数（参数无效时抛异常）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
      // 译：……把工具结果追加到上下文
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      // 译：校验失败：把错误作为工具结果返回，让模型可以重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

> 学习提示：注意这里的设计：校验失败不是终止循环，而是把错误当成工具结果回给模型，让它自己修正。这是 Agent 系统的通用做法。

### Complete Event Reference

Successful generation follows `start → updates* → done`. A failure after generation starts follows `start → updates* → error`. Request setup may fail before generation starts, in which case the stream contains only `error`; `done` and update events are invalid before `start`. Direct API `streamSimple()` calls throw synchronously when request auth is missing.

> 译：成功的生成遵循 `start → 若干更新事件 → done`。生成开始后失败遵循 `start → 若干更新事件 → error`。请求准备阶段可能在生成开始前就失败，这时流里只有一个 `error`；在 `start` 之前出现 `done` 或更新事件是不合法的。直接调用协议层的 `streamSimple()` 时，如果缺少请求认证，会同步抛出异常。

Every non-terminal event's `partial` is the shared live response-so-far helper. It is intentionally not an event-time snapshot: providers may mutate the same message and content blocks as generation advances, including while older events wait in the stream queue. Inspect it when handling an event instead of retaining it as historical state. Text and ordinary thinking blocks are empty when their `*_start` event is emitted and grow only through matching `*_delta` events until the authoritative `*_end`; redacted thinking may be complete at start and emit no deltas. Tool-call arguments at `toolcall_start` are provider-specific; `toolcall_delta` carries subsequent JSON updates.

> 译：每个非终止事件的 `partial` 都指向同一个"到目前为止的响应"实时对象。它刻意不是事件发生时的快照：随着生成推进，provider 可能修改同一条消息和同一批内容块，即使旧事件还在流的队列里等待消费。处理事件时当场读取它，不要把它当历史状态保存。文本块和普通 thinking 块在 `*_start` 事件发出时是空的，只通过对应的 `*_delta` 事件增长，直到权威的 `*_end`；脱敏的（redacted）thinking 可能在 start 时就已完整，不发 delta。`toolcall_start` 时工具调用参数的内容取决于 provider；后续 JSON 更新由 `toolcall_delta` 携带。

> 学习提示：`partial` 是同一个可变对象，这是一个容易踩的坑。如果你在 UI 层把每个事件的 `partial` 存进数组，最后会发现它们全都一样。

All streaming events emitted during assistant message generation:

> 译：生成 assistant 消息过程中会发出的全部流事件：

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | Stream begins 流开始 | `partial`: Initial assistant message structure 初始的 assistant 消息结构 |
| `text_start` | Text block starts 文本块开始 | `contentIndex`: Position in content array 在 content 数组中的位置 |
| `text_delta` | Text chunk received 收到文本片段 | `delta`: New text 新文本, `contentIndex`: Position 位置 |
| `text_end` | Text block complete 文本块完成 | `content`: Full text 完整文本, `contentIndex`: Position 位置 |
| `thinking_start` | Thinking block starts 思考块开始 | `contentIndex`: Position in content array 位置 |
| `thinking_delta` | Thinking chunk received 收到思考片段 | `delta`: New text 新文本, `contentIndex`: Position 位置 |
| `thinking_end` | Thinking block complete 思考块完成 | `content`: Full thinking 完整思考内容, `contentIndex`: Position 位置 |
| `toolcall_start` | Tool call begins 工具调用开始 | `contentIndex`: Position in content array 位置 |
| `toolcall_delta` | Tool arguments streaming 工具参数流式传输中 | `delta`: JSON chunk JSON 片段, `partial.content[contentIndex].arguments`: Partial parsed args 部分解析的参数 |
| `toolcall_end` | Tool call complete 工具调用完成 | `toolCall`: Complete, but not schema-validated, tool call with `id`, `name`, `arguments` 完整但未经 schema 校验的工具调用 |
| `done` | Stream complete 流完成 | `reason`: Stop reason ("stop", "length", "toolUse") 停止原因, `message`: Final assistant message 最终 assistant 消息 |
| `error` | Error occurred 发生错误 | `reason`: Error type ("error" or "aborted") 错误类型, `error`: AssistantMessage with partial content 带部分内容的 AssistantMessage |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and pi may surface corresponding events interleaved, for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`. Consumers must use `contentIndex` to associate each delta/end event with its block and must not assume that a block's `*_start`/`*_delta`/`*_end` sequence is uninterrupted by events for other blocks.

> 译：不同内容块的流事件不保证连续。provider 可能在同一个上游 chunk 里同时给出文本、thinking 和工具调用的增量，pi 可能把对应的事件交错发出，例如 `text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。消费方必须用 `contentIndex` 把每个 delta/end 事件对应到它的块，不能假设一个块的 `*_start`/`*_delta`/`*_end` 序列中间不会插入其他块的事件。

## Thinking/Reasoning

Many models support thinking/reasoning capabilities where they can show their internal thought process. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

> 译：很多模型支持思考/推理能力，可以展示内部的思考过程。通过 `reasoning` 属性判断模型是否支持推理。给不支持推理的模型传推理选项，会被静默忽略。

### Unified Interface (streamSimple/completeSimple)

> 译：统一接口（streamSimple/completeSimple）

```typescript
// Many models across providers support thinking/reasoning
// 译：各家 provider 的很多模型都支持思考/推理
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('google', 'gemini-2.5-flash');
// or models.getModel('xai', 'grok-4.7');

// Check if model supports reasoning
// 译：检查模型是否支持推理
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
// 译：使用简化后的推理选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
// 译：读取 thinking 块和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` and `max` are model-specific, opt-in levels. Use `getSupportedThinkingLevels(model)` to determine whether a concrete model exposes either level; models such as GPT-5.6 can expose both.

> 译：`xhigh` 和 `max` 是按模型区分、需要显式启用的级别。用 `getSupportedThinkingLevels(model)` 判断某个具体模型是否提供这两个级别；GPT-5.6 这类模型两个都有。

### Provider-Specific Options (stream/complete)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

> 译：`models.stream()`/`complete()` 接受模型所属协议的全部选项。用 `hasApi()` 把动态查到的模型收窄到它的协议，以获得完整的选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // OpenAI Responses API only
                                  // 译：仅 OpenAI Responses API 支持
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // Optional token limit
                                // 译：可选的 token 上限
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 for dynamic, 0 to disable
                          // 译：-1 表示动态，0 表示关闭
    }
  });
}
```

> 学习提示：`stream`/`complete` 用的是各协议自己的选项（字段名各不相同）；`streamSimple`/`completeSimple` 用统一的 `reasoning` 级别。上层（agent-core、coding-agent）一律用 Simple 版本。

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

> 译：流式请求时，思考内容通过专门的事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
                                          // 译：流式输出思考内容
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

> 译：每条 `AssistantMessage` 都有一个 `stopReason` 字段，说明生成是如何结束的：

- `"pending"` - Only present in partial messages when we do not know what the stop reason will be
- `"stop"` - This is the final message the model will produce this turn
- `"length"` - Output hit the maximum token limit
- `"toolUse"` - Model is calling tools and expects tool results
- `"error"` - An error occurred during generation
- `"aborted"` - Request was cancelled via abort signal

> 译：
> - `"pending"`：只出现在未完成的消息里，表示还不知道最终的停止原因
> - `"stop"`：这是模型本轮产生的最后一条消息
> - `"length"`：输出达到了最大 token 上限
> - `"toolUse"`：模型在调用工具，等待工具结果
> - `"error"`：生成过程中出错
> - `"aborted"`：请求被 abort signal 取消

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.

> 译：如果底层 API 提供，`AssistantMessage` 还可能带有 `responseId`，即 provider 特有的上游响应或消息标识。不要假设所有 provider 都有它。

> 学习提示：源码里 `StopReason` 还有一个 `"deferred"`（用于异步/批量响应，稍后再取结果），README 没提。阶段 1 可以先忽略。

## Error Handling

Request failures after a stream is returned never throw: when a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event and the final message carries the details. Setup failures may emit `error` without `start`; failures after generation begins emit `start`, any observed updates, then `error`. Direct API `streamSimple()` calls throw synchronously when request auth is missing:

> 译：拿到 stream 之后，请求失败永远不会抛异常：请求以错误结束时（包括中断和工具调用校验错误），流式 API 会发出一个 error 事件，最终消息里带着详细信息。准备阶段的失败可能只发 `error` 而没有 `start`；生成开始后的失败会先发 `start`、已经收到的更新，然后是 `error`。直接调用协议层 `streamSimple()` 时，缺少请求认证会同步抛异常：

```typescript
// In streaming
// 译：在流式处理中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    // 译：event.reason 是 "error" 或 "aborted"
    // 译：event.error 是带有部分内容的 AssistantMessage
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
// 译：最终消息里带有错误详情
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
  // 译：message.content 包含出错前已收到的部分内容
  // 译：message.usage 包含已产生的部分 token 数和费用
}
```

When using a provider collection, auth failures (OAuth refresh failed, unknown provider) surface as a stream error with `stopReason: "error"`. Direct API `streamSimple()` calls instead throw synchronously when their required auth is absent.

> 译：通过 provider 集合调用时，认证失败（OAuth 刷新失败、未知 provider）以流错误的形式出现，`stopReason: "error"`。直接调用协议层 `streamSimple()` 时，缺少必需的认证则同步抛异常。

> 学习提示：这是 pi-ai 最重要的契约之一。上层判断失败看 `stopReason`，不写 try/catch。源码见 `src/api/lazy.ts`。

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

> 译：abort signal 用于取消进行中的请求。被中断的请求 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// Abort after 2 seconds
// 译：2 秒后中断
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    // 译：event.reason 告诉你是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
// 译：获取结果（如果被中断，可能只有一部分）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

> 译：被中断的消息可以加入对话上下文，在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
// 译：第一个请求 2 秒后被中断
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
// 译：把部分响应加入上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
// 译：继续对话
const continuation = await models.complete(model, context);
```

> 学习提示：对照 `transform-messages.ts` 的第二遍处理：`stopReason` 为 error/aborted 的 assistant 消息在发给模型前会被**整条跳过**。所以"继续"时模型其实看不到被中断的那段内容，它看到的是用户的 "Please continue"。

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

> 译：用 `onPayload` 回调查看发给 provider 的请求体。排查请求格式问题或 provider 校验错误时很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

> 译：`stream`、`complete`、`streamSimple`、`completeSimple` 都支持这个回调。

> 学习提示：接私有化模型时第一件事就是打开 `onPayload` 看实际发出了什么。源码里 `onPayload` 还可以返回一个新的 payload 来替换原请求体（见 openai-completions.ts 的 `stream()`）。

### Observing Provider Stream Events

Use `onProviderStreamEvent` to inspect provider-specific fields that Pi does not include in `AssistantMessage`. The callback receives the parsed event available to the adapter before Pi normalizes it. Treat the event as read-only because mutations can affect normalization. This is not guaranteed to be the original HTTP bytes or SSE frame.

> 译：用 `onProviderStreamEvent` 查看 pi 没放进 `AssistantMessage` 的 provider 特有字段。回调收到的是适配器在 pi 归一化之前拿到的已解析事件。把它当只读对象，修改它可能影响归一化结果。它不保证是原始的 HTTP 字节或 SSE 帧。

```typescript
const openRouterModel = models.getModel('openrouter', 'openrouter/auto')!;
const response = await models.complete(openRouterModel, context, {
  headers: { "X-OpenRouter-Metadata": "enabled" },
  onProviderStreamEvent: (data) => {
    const chunk = data as Record<string, unknown>;
    if (chunk.openrouter_metadata) {
      console.log(chunk.openrouter_metadata);
    }
  },
});
```

Callbacks are awaited in stream order, so slow callbacks delay stream consumption and thrown errors fail the request. SDK-backed adapters can expose only fields retained by their SDK.

> 译：回调按流的顺序被 await，所以慢的回调会拖慢流的消费，回调抛出的错误会让请求失败。基于 SDK 的适配器只能暴露 SDK 保留下来的字段。

## Custom Providers

> 译：自定义 provider（阶段 1 最重要的一节：给客户接模型就是做这件事）

### createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and an API implementation (`api` for chat models, `images` for image generation, `classifiers` for classification; at least one is required, see [Image Generation](#image-generation)). Use it for local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint:

> 译：`createProvider()` 用几个部件拼出一个 provider：身份、认证、模型列表、API 实现（对话模型用 `api`，图片生成用 `images`，分类用 `classifiers`；至少要有一个，见 Image Generation 一节）。用于本地推理服务器、代理，或任何兼容 OpenAI/Anthropic 的端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  // 译：每个 provider 都要声明 auth；不需要 key 的本地服务器解析为"已配置但没有 key"。
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

> 译：对需要真实 key 的 provider，`envApiKeyAuth(显示名, 环境变量列表)` 提供标准行为（已存储的凭据优先，其次是第一个设置了值的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

> 译：混合协议的 provider 传入一个以 `model.api` 为键的映射；每个模型分派到其协议对应的实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
          // 译：api 为 'anthropic-messages' 或 'openai-responses' 的模型
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. The Cloudflare providers do this to materialize account/gateway endpoint placeholders from the resolved provider env:

> 译：作用于整个 provider 的端点或请求变换，应该放在 provider 的 API 实现里：把作为 `api` 传入的 `ProviderStreams` 包一层，让每个请求在分派前都经过变换。Cloudflare 的 provider 就是这样做的：用解析出的 provider 环境变量，填充账号和网关端点里的占位符：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

> 学习提示：这是"装饰器"模式。给客户做多租户路由、请求审计、限流，都可以这样包一层 `ProviderStreams`，不需要改 pi-ai 源码。

Dynamic model lists use `fetchModels`, which can return models of every type. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

> 译：动态模型列表用 `fetchModels`，它可以返回任意类型的模型。`Models.refresh()` 刷新所有已配置的动态 provider，并传入其生效的 API key 或刷新后的 OAuth 凭据。`ModelsStore` 用于持久化动态目录；两种 store（凭据和模型）默认都是内存实现。它的 `read`、`write`、`delete` 接受可选的取消参数，`Models` 会把这些等待绑定到 provider 的刷新信号上。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

> 译：不传可选的 signal 时，`Models.refresh()` 没有时间上限。provider 总会收到一个具体的 `RefreshModelsContext.signal`，网络请求和其他阻塞工作必须响应它。调用方传了 signal 时，取消后 `Models.refresh()` 会立刻返回 `aborted: true`，即使某个自定义 provider 不配合；但 provider 仍然必须响应 signal，才能真正停止底层工作。

Use `models.refresh({ providers: ['openrouter'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

> 译：用 `models.refresh({ providers: ['openrouter'] })` 只刷新指定 provider；用 `models.refresh({ allowNetwork: false })` 不访问网络、只恢复已持久化的目录；用 `models.refresh({ force: true })` 跳过 provider 的新鲜度检查。模型读取始终是同步的，返回最近一次恢复或刷新的列表。

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. `ModelsStoreEntry.models` contains models of every type. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

> 译：`createProvider()` 会自动处理动态目录的发布和持久化。手写的 `Provider.refreshModels()` 实现会收到只读的 `context.stored` 快照，通过 `context.publish({ persist?, update? })` 发布。不传 `persist` 表示不改存储，传 `ModelsStoreEntry` 表示写入，传 `persist: null` 表示删除。`ModelsStoreEntry.models` 包含所有类型的模型。发布带有代次（generation）检查；同步的内存目录修改应放在 `update` 里，而不是在发布之前直接改状态。

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI Compatibility Settings](#openai-compatibility-settings).

> 译：自定义模型可以带 `headers`（例如位于反爬检测后面的代理）和 `compat` 标志。`Models.getAuth(model)` 会包含这些模型 headers，流式方法在合并显式请求 headers 和执行 `transformHeaders` 之前合并它们。见 OpenAI Compatibility Settings 一节。

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

> 译：一些兼容 OpenAI 的服务器不认识推理模型使用的 `developer` 角色。对这类 provider，把 `compat.supportsDeveloperRole` 设为 `false`，系统提示词就会改为以 `system` 消息发送。如果服务器也不支持 `reasoning_effort`，把 `compat.supportsReasoningEffort` 也设为 `false`。这种情况在 Ollama、vLLM、SGLang 等兼容 OpenAI 的服务器上很常见。

> 学习提示：**客户私有化部署 90% 的报错在这一段**。记住这两个开关。

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

> 译：用模型级别的 `thinkingLevelMap` 描述模型特有的思考控制。键是 pi 的思考级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。`high` 及以下的标准级别如果没写，使用 provider 默认值；`xhigh` 和 `max` 需要显式启用，必须有非 null 的映射项。字符串值会原样发给 provider，`null` 表示不支持该级别，映射可以跳过某些级别。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### Calling API Implementations Directly

The API implementations are importable on their own. Each module exports exactly `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization — pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

> 译：API 实现可以单独导入。每个模块只导出 `stream` 和 `streamSimple`，带有该协议的完整选项类型。直接调用会绕过 provider 认证和上下文归一化，所以要显式传 `apiKey`，并用 `normalizeContext()` 包装上下文：

```typescript
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

> 译：内置 API 实现位于 `./api/<api-id>`：

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./mistral`, `./openai-completions`, ...) were removed; use `@earendil-works/pi-ai/api/<api-id>`.

> 译：导入实现模块会加载对应的 SDK。`./api/<id>.lazy` 包装（provider 工厂使用的就是它）在运行时或打包器支持动态导入分块时，把加载推迟到第一次请求。旧版本的原始 API 子路径（`./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已移除；请用 `@earendil-works/pi-ai/api/<api-id>`。

**Anthropic message threads:** with `sessionId` set and `cacheRetention` not `"none"`, Anthropic requests continue from the previous reply on the server (`message-threads-2026-08-12` beta) and send only the new messages. When anything earlier in the request changed, or the server can't continue, the full request is sent. Token counts and prompt caching are unchanged. On by default only for the `anthropic` provider on `api.anthropic.com`; set `compat.supportsMessageThreads` to change that, for example for gateways that forward the `thread` field. Set `disableContinuation: true` on requests that repeat an earlier one, such as cache warming. Call `cleanupSessionResources(sessionId)` when a session ends.

> 译：**Anthropic 消息线程：** 设置了 `sessionId` 且 `cacheRetention` 不是 `"none"` 时，Anthropic 请求会在服务端从上一条回复继续（`message-threads-2026-08-12` beta），只发送新增的消息。如果请求中之前的任何部分有变化，或服务端无法继续，就发送完整请求。token 计数和提示词缓存不受影响。默认只对 `api.anthropic.com` 上的 `anthropic` provider 开启；可以设置 `compat.supportsMessageThreads` 改变这一点，例如对转发 `thread` 字段的网关。对重复之前请求的情况（如缓存预热）设置 `disableContinuation: true`。会话结束时调用 `cleanupSessionResources(sessionId)`。

### OpenAI Compatibility Settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together AI, zAi, OpenCode, Cloudflare Workers AI, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

> 译：`openai-completions` 协议被很多 provider 实现，彼此有细微差别。默认情况下，库会根据 `baseUrl` 为一小批已知的 OpenAI 兼容 provider 自动识别兼容设置（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）。对自定义代理或未知端点，可以通过 `compat` 字段覆盖这些设置。对 `openai-responses` 模型，compat 字段支持 Responses 专属的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
                                     // 译：是否支持 `store` 字段（默认 true）
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
                                     // 译：是否支持 `developer` 角色（否则用 `system`）（默认 true）
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
                                     // 译：是否支持 `reasoning_effort`（默认 true）
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
                                      // 译：流式时是否支持返回 usage（默认 true）
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable built-in models)
                                     // 译：工具定义里是否支持 `strict`（默认 false；有能力的内置模型在元数据里开启）
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
                                        // 译：是否发送 OpenAI 的 Lark/regex 语法工具；false 时回退为普通函数工具（默认 false）
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started; false folds them into the leading prompt (default: false; the generated catalog enables it for verified models)
                                            // 译：对话开始后是否还能接受 system 消息；false 时合并进开头的提示词（默认 false）
  supportsMidConvoToolAdditions?: boolean; // Whether system messages can add tools mid-conversation via Kimi-style `tools` system messages; requires supportsMidConvoSystemMessages (default: false)
                                           // 译：能否通过 Kimi 风格的 `tools` system 消息在对话中途添加工具；需要 supportsMidConvoSystemMessages（默认 false）
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: true for OpenRouter, false otherwise)
                                        // 译：是否根据 `sessionId` 发送会话亲和数据（OpenRouter 默认 true，其他 false）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Format for session affinity (default: auto-detected)
                                                                       // 译：会话亲和的格式，决定用哪些字段/header（默认自动识别）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
                                                            // 译：用哪个字段名（默认 max_completion_tokens）
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
                                     // 译：工具结果是否必须带 `name` 字段（默认 false）
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
                                              // 译：工具结果后面是否必须跟一条 assistant 消息（默认 false）
  requiresNonNullAssistantContent?: boolean; // Whether replayed assistant messages with no text must send "" instead of null content (default: false)
                                             // 译：回放的无文本 assistant 消息是否必须发 "" 而不是 null（默认 false）
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
                                     // 译：thinking 块是否必须转成文本（默认 false）
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
                                                         // 译：开启推理时，所有回放的 assistant 消息是否都要带空的 reasoning_content（DeepSeek 自动识别）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // Format for reasoning param (default: openai)
                   // 译：推理参数的格式。'openai' 用 reasoning_effort；'openrouter' 用 reasoning: { effort }；
                   // 译：'deepseek' 用 thinking: { type }（支持时再加 reasoning_effort）；'zai' 用 thinking: { type }；
                   // 译：'qwen' 用 enable_thinking；'chat-template' 用可配置的 chat_template_kwargs；
                   // 译：'qwen-chat-template' 用 chat_template_kwargs.enable_thinking 和 preserve_thinking；其余见原文（默认 openai）
  chatTemplateKwargs?: Record<string, ...>; // chat_template_kwargs values; use $var for pi-controlled thinking values
                                            // 译：chat_template_kwargs 的值；用 $var 引用 pi 控制的思考参数
  chatTemplateArgs?: Record<string, ...>;   // chat_template_args values for thinkingFormat: 'baseten'
                                            // 译：thinkingFormat 为 'baseten' 时的 chat_template_args
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
                                                                                                    // 译：限制推理 token 数的顶层字段（vLLM / Qwen / llama.cpp）。默认关闭。
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
                                         // 译：等价于 thinkingTokenBudgetField: 'thinking_token_budget'（vLLM）。优先用前者。默认 false。
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
                                     // 译：在系统提示词、最后一个工具、最后一条 user/assistant 文本上加 Anthropic 风格的 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
                                         // 译：OpenRouter 路由偏好
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
                                               // 译：Vercel AI Gateway 路由偏好
}
```

（`OpenAIResponsesCompat` 接口与阶段 1 关系不大，见原文。）

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

> 译：没有设置 `compat` 时，库回退到基于 URL 的识别。只设置了部分 `compat` 时，未指定的字段使用识别出的默认值。适用场景：
> - **LiteLLM 代理**：可能不支持 `store` 字段
> - **自定义推理服务器**：可能使用非标准的字段名
> - **自托管端点**：支持的功能可能不同

> 学习提示：接 vLLM + Qwen3 的典型配置：`supportsDeveloperRole: false`、`thinkingFormat: 'qwen-chat-template'`（或 `'chat-template'` + `chatTemplateKwargs`）、`maxTokensField: 'max_tokens'`、按需开 `thinkingTokenBudgetField`。源码在 `openai-completions.ts` 的 `detectCompat`/`getCompat`。

## Faux Provider for Tests

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

> 译：`fauxProvider()` 构建一个内存中的 provider，按脚本返回预设响应，用于测试和演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
                      // 译：可选
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
// 译：可选：多个 faux 模型，用于测试模型切换
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:
- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids.

> 译：要点：
> - 响应按请求开始的顺序从队列中取出。
> - 队列空了时，faux provider 返回一条 assistant 错误消息，`errorMessage: "No more faux responses queued"`。
> - 用 `faux.setResponses([...])` 替换剩余队列，用 `faux.appendResponses([...])` 追加响应。
> - `faux.models` 暴露所有 faux 模型。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回指定的那个。
> - 用 `fauxAssistantMessage(...)` 编写脚本化的 assistant 回复。用 `fauxText(...)`、`fauxThinking(...)`、`fauxToolCall(...)` 构建内容块，不用手动填底层字段。
> - usage 按大约 4 个字符 1 个 token 估算。有 `sessionId` 且 `cacheRetention` 不是 `"none"` 时，会自动模拟提示词缓存的读写。
> - 工具调用参数通过 `toolcall_delta` 片段逐步流式输出。
> - 默认每个流片段在各自的微任务里发出。设置 `tokensPerSecond` 可以按真实时间节奏输出。
> - 设计用法是每个 handle 一条确定的脚本流程。需要互相独立的并发流程时，创建多个 `provider` id 不同的 faux provider。

> 学习提示：练习 E1 就用这个。不花钱、结果确定，适合理解工具调用循环。

## Cross-Provider Handoffs

The library supports seamless handoffs between different LLM providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including text, tool calls, and tool results.

> 译：库支持在同一个对话中在不同 LLM provider 之间无缝切换。这样可以在对话中途换模型，同时保留上下文，包括文本、工具调用和工具结果。

When messages from one provider are sent to a different provider, the library automatically transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider, API, and model** are preserved as-is, including thinking blocks
- **Assistant messages from a different model** have their thinking blocks dropped. Signatures and encrypted reasoning only work with the model that produced them, and readable thinking sent as plain text makes the new model treat it as part of the reply
- **Tool calls and regular text** are preserved unchanged

> 译：把一个 provider 产生的消息发给另一个 provider 时，库会自动转换以保证兼容：
> - **user 消息和工具结果消息**原样传递
> - **来自同一 provider、同一协议、同一模型的 assistant 消息**原样保留，包括 thinking 块
> - **来自不同模型的 assistant 消息**会丢掉 thinking 块。签名和加密的推理内容只对产生它们的模型有效；而把可读的思考内容当普通文本发过去，新模型会把它当成回复的一部分
> - **工具调用和普通文本**原样保留

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// Start with Claude
// 译：先用 Claude
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// Switch to GPT-5 - it sees Claude's answer, but not Claude's thinking
// 译：切到 GPT-5：它能看到 Claude 的回答，但看不到 Claude 的思考过程
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// Switch to Gemini
// 译：再切到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

All providers can handle messages from other providers — text, tool calls and results (including images), thinking blocks (dropped when the model changes), and aborted messages with partial content. This enables flexible workflows: start with a fast model, switch to a more capable one for complex reasoning, or maintain continuity across provider outages.

> 译：所有 provider 都能处理来自其他 provider 的消息：文本、工具调用和结果（包括图片）、thinking 块（换模型时丢弃），以及带部分内容的中断消息。这让工作流更灵活：先用快模型，遇到复杂推理再切到更强的模型，或者在某个 provider 故障时保持对话连续。

> 学习提示：源码在 `src/api/transform-messages.ts`。另外两件 README 没细说的事：tool call id 会被规范化（OpenAI 的 id 很长且带 `|`，Anthropic 要求 `^[a-zA-Z0-9_-]+$` 且不超过 64 字符）；没有结果的"孤儿"工具调用会被补一条 `isError: true` 的合成结果。

## System Messages

`Context.systemPrompt` and `Context.tools` are shorthand for a leading system message. The public entry points (`Models.stream()`, `streamSimple()`, `complete()`, `completeSimple()`) accept a `Context` and call `normalizeContext()` once; everything below them, including `Provider.stream()`, `ProviderStreams`, and the API implementation modules, receives the resulting `TranscriptContext`, which only has `messages`. The transcript can also carry system messages later in the conversation to change the prompt or the tool set without rewriting the history:

> 译：`Context.systemPrompt` 和 `Context.tools` 是"开头一条 system 消息"的简写。公开入口（`Models.stream()`、`streamSimple()`、`complete()`、`completeSimple()`）接受 `Context`，并调用一次 `normalizeContext()`；它们下面的一切，包括 `Provider.stream()`、`ProviderStreams` 和 API 实现模块，收到的都是归一化后的 `TranscriptContext`，里面只有 `messages`。对话记录（transcript）还可以在对话后面放 system 消息，用来修改提示词或工具集，而不用改写历史：

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];             // leading: base prompt; later: added instructions
                                               // 译：开头那条是基础提示词；后面的是追加的指令
  sections?: Record<string, string | null>;    // named prompt sections; later messages patch by name, null removes
                                               // 译：具名的提示词段落；后面的消息按名字修补，null 表示删除
  toolsAdded?: Tool[];                         // tools that become available here
                                               // 译：从这里开始可用的工具
  toolsRemoved?: ToolReference[];              // tools that stop being available here
                                               // 译：从这里开始不再可用的工具
  timestamp: number;
}
```

Sections are opaque text rendered verbatim after `content`, joined by blank lines. Keep each one self-delimiting (a tag, a heading) so the model can relate an update to the original. Replaying every system message in order yields the current prompt and tools; the replay helpers take the message list:

> 译：sections 是不透明的文本，原样渲染在 `content` 后面，用空行连接。每段最好自带边界（一个标签或一个标题），这样模型能把更新和原文对应起来。按顺序回放所有 system 消息，就得到当前的提示词和工具；回放辅助函数接受消息列表：

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const messages: Message[] = [
  { role: "system", content: "You are helpful.", sections: { rules: "<rules>Be brief.</rules>" }, toolsAdded: [readTool], timestamp: 1 },
  { role: "user", content: "hi", timestamp: 2 },
  { role: "system", content: "", sections: { rules: "<rules>Be thorough.</rules>" }, toolsRemoved: [{ name: "read" }], timestamp: 3 },
];
getCurrentSystemPrompt(messages); // "You are helpful.\n\n<rules>Be thorough.</rules>"
getCurrentTools(messages);        // []
```

A custom `Provider` or `ProviderStreams` implementation reads the prompt and tools the same way from `context.messages`; `context.systemPrompt` and `context.tools` do not exist at that layer.

> 译：自定义的 `Provider` 或 `ProviderStreams` 实现也用同样的方式从 `context.messages` 读取提示词和工具；在那一层不存在 `context.systemPrompt` 和 `context.tools`。

Models that accept system messages mid-conversation (`supportsMidConvoSystemMessages` in the model's compat settings, set by the generated catalog for verified models) receive each later system message in place, so the cached prefix stays intact; section changes are framed by name for the model. Every other model receives `collapseSystemMessages(transcript)`: the replayed prompt and current tools as the leading system message, with later system messages dropped. (… the rest of this paragraph describes how Anthropic, OpenAI Responses and Kimi send mid-conversation tool changes natively so the prompt cache is not invalidated.)

> 译：能在对话中途接受 system 消息的模型（模型 compat 设置里的 `supportsMidConvoSystemMessages`，生成的目录为验证过的模型开启）会在原位置收到每条后来的 system 消息，这样缓存的前缀保持不变；section 的变化会按名字向模型说明。其他所有模型收到的是 `collapseSystemMessages(transcript)`：回放后的提示词和当前工具合并为开头的 system 消息，后来的 system 消息被丢弃。（本段其余部分讲 Anthropic、OpenAI Responses、Kimi 如何原生发送对话中途的工具变化，以免提示词缓存失效。阶段 1 了解这个思路即可，源码在 `src/utils/transcript.ts`。）

> 学习提示：为什么要这么设计？因为提示词缓存按"前缀"命中。如果中途改工具就重写开头的 system prompt，整个缓存失效，长会话的成本会暴涨。

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

> 译：`Context` 对象可以直接用标准 JSON 方法序列化和反序列化，因此很容易持久化对话、实现聊天记录，或在服务之间传递上下文：

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
// 译：序列化整个上下文
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
// 译：存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
// 译：之后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
// 译：用任意模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data too — no functions or implementations attached — so persisting "which model was this conversation using" is a `JSON.stringify` away.

> 译：模型本身也是可序列化的纯数据，不附带函数或实现，所以持久化"这个对话用的是哪个模型"也只需要一次 `JSON.stringify`。

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.

> 译：**注意**：如果上下文里有图片（按 Image Input 一节的方式用 base64 编码），图片也会一起被序列化。

> 学习提示：这是 pi 设计上的一个关键取舍：**数据和行为分离**。消息、上下文、模型都是纯 JSON，行为（provider、API 实现）在运行时注册。所以会话能存库、能跨进程恢复，这也是 pi-durable 能做持久化执行的前提。
