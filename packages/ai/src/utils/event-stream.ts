// 注：本文件是 pi-ai 的"流"原语。所有 provider 返回的都是 AssistantMessageEventStream。
// 注：它同时是两样东西：
// 注：1. 一个 AsyncIterable，可以 `for await (const event of s)` 逐个消费事件；
// 注：2. 一个"最终结果"的 Promise，`await s.result()` 直接拿最终的 AssistantMessage。
// 注：生产者（各协议适配器）只做两件事：push(event) 推事件，end(result) 结束。
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// 注：先进先出队列，用两个栈实现（经典的"双栈队列"）。
// 注：为什么不直接用数组的 shift()？shift 是 O(n)，事件多时会变慢；双栈的出队均摊 O(1)。
class FifoQueue<T> {
	// 注：入队的元素先进 incoming 栈
	private incoming: T[] = [];
	// 注：出队从 outgoing 栈弹出；outgoing 空了才把 incoming 整体倒过来
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		// 注：outgoing 为空时，把 incoming 逐个弹出压入 outgoing，顺序就被反转成先进先出
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
// 译：通用的事件流类，支持异步迭代
// 注：T 是事件类型，R 是最终结果类型。
// 注：核心是两个队列配合：
// 注：- queue：生产者推得比消费者快时，事件先在这里排队；
// 注：- waiting：消费者比生产者快时，消费者的 resolve 函数在这里排队，等事件来了直接交给它。
export class EventStream<T, R = T> implements AsyncIterable<T> {
	// 注：已产生但还没被消费的事件
	private queue = new FifoQueue<T>();
	// 注：正在等待下一个事件的消费者（存的是 Promise 的 resolve）
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	// 注：流是否已结束。protected：子类 AssistantMessageEventStream 也要读
	protected done = false;
	// 注：最终结果的 Promise，result() 返回的就是它
	private finalResultPromise: Promise<R>;
	// 注：上面那个 Promise 的 resolve，构造时取出来留着用
	private resolveFinalResult!: (result: R) => void;
	// 注：判断某个事件是不是"终止事件"（对 assistant 流来说是 done 或 error）
	private isComplete: (event: T) => boolean;
	// 注：从终止事件里取出最终结果
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		// 注：先建一个挂起的 Promise，把 resolve 存下来，等终止事件到达时再调用
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	// 注：生产者推送一个事件
	push(event: T): void {
		// 注：流已结束后再推的事件直接丢弃（保证终止事件之后不会再有事件）
		if (this.done) return;

		// 注：如果是终止事件：标记结束，并立刻 resolve 最终结果。
		// 注：注意终止事件本身仍会继续往下走，被投递给消费者（迭代时能看到 done/error 事件）。
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		// 译：有消费者在等就直接交给它，否则放进队列
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	// 注：生产者结束流。result 可选：没有经过终止事件就结束时（比如转发流），用它补上最终结果。
	// 注：Promise 只能 resolve 一次，如果之前终止事件已经 resolve 过，这里再 resolve 不会生效。
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		// 译：通知所有在等待的消费者：流已结束
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	// 注：让 `for await (const e of stream)` 可用。每次循环取一个事件。
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				// 注：队列里有积压的事件，直接取出。即使流已 done，也要先把积压的事件吐完
				yield this.queue.dequeue()!;
			} else if (this.done) {
				// 注：队列空了且流已结束，迭代结束
				return;
			} else {
				// 注：队列空、流未结束：把自己的 resolve 挂到 waiting 上，等 push 或 end 唤醒
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	// 注：返回最终结果。可以和迭代同时使用，也可以不迭代直接 await。
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * Event stream of one assistant response. It also times the response: the final message (`done` or `error` event, or
 * the result passed to `end()`) gets `durationMs`, measured with a monotonic clock from the stream's creation, unless
 * the message already has one or its `timestamp` predates the stream. A stream that forwards a response which started
 * elsewhere, such as a deferred result fetched later, therefore leaves it untimed.
 *
 * 译：一次 assistant 响应的事件流。它还会给响应计时：最终消息（`done` 或 `error` 事件里的消息，或传给 `end()`
 * 的结果）会得到 `durationMs`，用单调时钟从流创建时开始计时；但如果消息已经有 `durationMs`，或者它的 `timestamp`
 * 早于流的创建时间，就不计时。因此，一个转发"在别处开始的响应"的流（比如之后才取回的延迟结果）不会给它计时。
 */
// 注：这是 EventStream 的具体化：事件类型是 AssistantMessageEvent，最终结果是 AssistantMessage。
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	// 注：墙上时钟的创建时间，用来和消息的 timestamp 比较
	readonly #startedAt = Date.now();
	// 注：单调时钟的创建时间，用来算耗时（不受系统时间调整影响）
	readonly #startedAtMonotonic = performance.now();

	constructor() {
		super(
			// 注：终止事件 = done 或 error
			(event) => event.type === "done" || event.type === "error",
			// 注：最终结果：done 取 message，error 取 error（error 字段本身也是一条 AssistantMessage）
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	// 注：推送终止事件之前先给最终消息打上耗时
	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.#time(event.message);
		else if (event.type === "error") this.#time(event.error);
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}

	// 注：给消息写入 durationMs。三种情况跳过：
	// 注：流已结束（已经计过时）；消息自带耗时；消息的 timestamp 早于本流创建（说明是转发别处开始的响应）
	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
/** 译：AssistantMessageEventStream 的工厂函数（供扩展使用） */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
