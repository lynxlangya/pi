# How Pi Works

> Pi 如何工作

Pi coordinates model requests, tool execution, context assembly, and session storage. A session is Pi's record of a conversation, including messages, tool calls and results, model changes, compactions, and other events.

> Pi 协调模型请求、工具执行、上下文组装和会话存储。会话（session）是 Pi 对一次对话的记录，其中包括消息、工具调用及其结果、模型切换、压缩（compaction）以及其他事件。

Messages and events in a session form a tree. Each path through that tree is a branch. The branch ending at the current entry is the active branch and supplies the history for the next model request.

> 会话中的消息和事件构成一棵树。贯穿这棵树的每条路径都是一个分支（branch）。以当前条目结尾的分支是活动分支（active branch），它为下一次模型请求提供历史。

## Agent loop

> Agent 循环

A submitted message is added to the active branch. Pi builds a model request from the system prompt, active branch, available tools, and model settings, then sends it through the selected provider.

> 提交的消息会被追加到活动分支。Pi 根据系统提示、活动分支、可用工具和模型设置构造一次模型请求，然后通过选定的 provider 发送该请求。

The provider streams an assistant response, which can contain text and tool calls. Pi records the response, executes each tool call, and records the results. That completes one turn. If tool results or queued messages require another model request, Pi starts another turn. Otherwise, the run ends.

> provider 以流式方式返回助手响应，响应中可能包含文本和工具调用。Pi 记录该响应，执行每个工具调用，并记录其结果。至此完成一轮（turn）。如果工具结果或排队中的消息需要再次发起模型请求，Pi 会开始下一轮；否则本次运行（run）结束。

Steering messages enter after the current assistant turn. Follow-up messages enter after the agent has finished its pending work. Aborting stops the current run and returns queued messages to the editor.

> Steering 消息在当前助手轮次之后进入。Follow-up 消息在 agent 完成其待处理的工作之后进入。Abort 会停止当前运行，并把已排队的消息退回编辑器。

## Context

> 上下文

The active branch supplies conversation history. Pi converts its session entries into model-compatible user, assistant, and tool-result messages.

> 活动分支提供对话历史。Pi 把其中的会话条目转换成模型可接受的 user、assistant 和 tool-result 消息。

Pi builds the system prompt from its base instructions and discovered context files. The request also carries tool definitions and skill descriptions.

> Pi 由其基础指令和所发现的上下文文件构造系统提示。请求中还会携带工具定义和技能描述。

Full skill instructions are loaded on demand. Extensions can add instructions or transform context.

> 完整的技能指令按需加载。扩展可以添加指令或转换上下文。

Prompt templates expand editor input before it becomes a user message. Selected files, images, pasted text, and shell output can become message content.

> 提示模板在编辑器输入成为用户消息之前展开。选中的文件、图片、粘贴的文本和 shell 输出都可以成为消息内容。

## Sessions

> 会话

Persistent sessions are JSONL files. Each tree entry has an ID and refers to its parent. The current entry identifies the active branch.

> 持久会话是 JSONL 文件。树中的每个条目都有一个 ID，并指向其父条目。当前条目标识活动分支。

Continuing from an earlier entry creates another branch in the same file. Forking and cloning copy selected history into a new session file.

> 从较早的条目继续，会在同一个文件中创建另一个分支。分叉（fork）和克隆（clone）会把选定的历史复制到新的会话文件。

Model context is reconstructed from the active branch. Compaction inserts a summary entry that replaces older messages in subsequent model requests. The original entries remain in the session tree.

> 模型上下文由活动分支重建。压缩会插入一个摘要条目，在后续的模型请求中取代较早的消息。原始条目仍保留在会话树中。

## Interfaces

> 接口

Interactive mode renders session and agent events in the terminal. Print mode runs a prompt and writes the final response. JSON mode writes agent events as JSONL.

> 交互模式在终端中渲染会话事件和 agent 事件。打印模式运行一个提示并写出最终响应。JSON 模式把 agent 事件写成 JSONL。

RPC mode accepts JSONL commands on stdin and writes responses and events to stdout. The TypeScript SDK creates and controls agent sessions in process.

> RPC 模式从 stdin 接收 JSONL 命令，并把响应和事件写到 stdout。TypeScript SDK 在进程内创建并控制 agent 会话。

All interfaces use the same agent and session mechanisms.

> 所有接口都使用同一套 agent 和会话机制。

## Extensions and resources

> 扩展与资源

Extensions are TypeScript modules loaded into the Pi process. Their factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI.

> 扩展是加载进 Pi 进程的 TypeScript 模块。其工厂函数会注册工具、命令、快捷键、provider、事件处理器、渲染器和终端 UI。

Skills provide on-demand instructions and supporting files. Prompt templates provide reusable message text. Themes provide terminal colors. Pi packages distribute these resources through npm or git.

> 技能（skill）提供按需加载的指令和配套文件。提示模板提供可复用的消息文本。主题（theme）提供终端配色。Pi 包（package）通过 npm 或 git 分发这些资源。

## Trust and permissions

> 信任与权限

Pi resolves project trust before loading project settings and resources. After the trust decision and project-resource loading, Pi loads context files. Enabled tools use the operating-system permissions of the Pi process. Extensions execute inside that process.

> Pi 在加载项目设置和项目资源之前，先解析项目信任。在信任决策和项目资源加载完成之后，Pi 加载上下文文件。已启用的工具使用 Pi 进程的操作系统权限。扩展也在该进程内执行。
