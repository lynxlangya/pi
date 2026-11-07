// 注：阶段 1 只需理解用途，不必读解析器内部：工具调用参数是 JSON 字符串碎片，例如依次到达
// 注：'{"pa'、'th": "src/a'、'.ts"}'。UI 想在流式过程中就显示 {path: "src/a"}，这就需要"容错的增量解析"。
// 注：重点看：模块注释的规则、StreamingJsonParser.append/snapshot 的契约、文件末尾的 ToolCallArgumentsStream。
/**
 * Incremental, tolerant parsing of JSON text that arrives in pieces, such as streamed tool-call arguments.
 *
 * `StreamingJsonParser.append()` reads each piece once, so a stream costs time and memory linear in its length, and
 * `snapshot()` returns the value of the text read so far. Snapshots are plain JSON values and never change once
 * returned: the parser copies the containers that are still open (the "open path") into every new snapshot and shares
 * completed containers and strings. The rules for incomplete text follow `parseStreamingJson()`:
 *
 * - An unterminated string shows the characters read so far; an unterminated escape is held back until complete.
 * - An unterminated container shows the members and elements read so far.
 * - A member whose key or value has not started is omitted.
 * - An unterminated literal shows its value once it is a prefix of `true`, `false` or `null`; an unterminated number
 *   shows its value when the digits read so far form a number (an exponent without digits is ignored).
 *
 * 译：对分段到达的 JSON 文本（如流式工具调用参数）做增量、容错的解析。
 * append() 每段只读一次，所以整条流的时间和内存与长度成线性；snapshot() 返回目前已读文本对应的值。
 * 快照是普通 JSON 值，返回后永不改变：解析器把仍未闭合的容器（"开放路径"）复制进每个新快照，
 * 已完成的容器和字符串则共享。未完成文本的规则与 parseStreamingJson() 一致：
 * - 未结束的字符串显示已读到的字符；未结束的转义先扣住，直到完整。
 * - 未闭合的容器显示已读到的成员和元素。
 * - 键或值还没开始的成员被省略。
 * - 未结束的字面量，在它是 true/false/null 的前缀时显示其值；未结束的数字在已读位数构成数字时显示（缺数字的指数被忽略）。
 *
 * Malformed text is read leniently, the way `repairJson()` and `parseStreamingJson()` treat it: raw control characters
 * in strings are kept, an invalid escape such as `\d` stays literal text, missing commas and colons are tolerated,
 * values in invalid positions and unknown words are dropped, and text after the root value is ignored. The parser never
 * throws. Callers that need the exact value of the finished text parse it once, e.g. with `parseToolCallArguments()`.
 *
 * 译：格式错误的文本按 repairJson()/parseStreamingJson() 的方式宽松读取：保留字符串里的原始控制字符，
 * 无效转义（如 \d）保持字面文本，容忍缺失的逗号和冒号，丢弃位置不合法的值和未知单词，忽略根值之后的文本。
 * 解析器永不抛异常。需要完整文本精确值的调用方，最后自己完整解析一次，例如用 parseToolCallArguments()。
 *
 * Differences from `parseStreamingJson()` on incomplete text: trailing whitespace inside an unterminated string is
 * kept (it was trimmed), a string that contains a raw control character or an invalid escape stays visible while it
 * streams (it was dropped until the document was complete), and `NaN` and `Infinity` words are dropped.
 *
 * `append()` also returns the changes the piece made, for a writer that keeps its own copy of the value and applies
 * them instead of re-assigning snapshots: `set` when a key, an array item or a finished value appears (a new string is
 * set once with its first text, a container empty), `append` when the piece extended an open string. Unterminated
 * numbers and literals are not reported until they end. A container nested more than 32 levels deep is reported as one
 * `set` of its whole value when it closes, so paths stay short.
 *
 * Cost: copying the open path costs its member and element count. Each `append()` earns copy credit proportional to its
 * length plus a constant; `snapshot()` spends it and returns the previous snapshot while the open path costs more than
 * the credit. So a document that keeps a very large container open (thousands of elements) shows a preview that lags
 * a little behind the text, and no input makes the total work grow faster than the text.
 *
 * 译：append() 还返回这段文本造成的变化（set / append），给自己维护一份值副本的写入方增量应用。
 * 代价：复制开放路径的开销等于其成员和元素数。每次 append() 按长度挣得"复制额度"，snapshot() 花掉它；
 * 额度不够时返回上一个快照。所以一个保持超大容器开放（上千元素）的文档，预览会略微滞后于文本，
 * 但任何输入都不会让总工作量增长得比文本更快。
 */

import type { JsonValue, ToolCall } from "../types.ts";
import { parseToolCallArguments } from "./json-parse.ts";

type JsonContainer = { [key: string]: JsonValue } | JsonValue[];

/** Where a value sits in its parent; absent for a value in an invalid position, which is read but dropped. */
type Slot =
	| { readonly kind: "root" }
	| { readonly kind: "member"; readonly key: string }
	| { readonly kind: "element"; readonly index: number };

/** A path from the root value: member keys and array indices. */
export type JsonPath = readonly (string | number)[];

/** One change a piece of text made to the value; see the module comment. */
export type JsonChange =
	| { readonly kind: "set"; readonly path: JsonPath; readonly value: JsonValue }
	| { readonly kind: "append"; readonly path: JsonPath; readonly text: string };

/** A change still being extended by the piece being read. */
type OpenChange =
	| { kind: "set"; readonly path: JsonPath; value: JsonValue }
	| { kind: "append"; readonly path: JsonPath; text: string };

/** An open object or array. Its `container` is never handed out while open; snapshots get copies. */
type Frame = {
	readonly container: JsonContainer;
	readonly slot: Slot | undefined;
	/** Where the container sits, when its changes are reported. */
	readonly path: JsonPath | undefined;
	/** Whether changes inside it are reported; when not, its whole value is reported as it closes. */
	readonly reportsInside: boolean;
	/** Members or elements; what a copy of the container costs. */
	size: number;
	/** Objects: the key read last, where the member value goes. */
	key: string | undefined;
	phase: "key" | "colon" | "value" | "comma";
};

/** An unterminated string. */
type OpenString = {
	readonly target: "key" | "value";
	readonly slot: Slot | undefined;
	text: string;
	/** Escape read so far: "" for none, otherwise a backslash and up to five more characters. */
	escape: string;
	/** Where a value string sits, when its changes are reported. */
	readonly path: JsonPath | undefined;
	/** The change this string extends, while it is the newest change of the piece. */
	change: OpenChange | undefined;
};

// Changes are reported at most this deep, so a path costs O(1) to build.
const MAX_REPORTED_DEPTH = 32;

const ROOT_SLOT: Slot = { kind: "root" };
// Copy credit per append and per appended character. The floor keeps small documents fresh at every snapshot.
const CREDIT_PER_APPEND = 256;
const CREDIT_PER_CHARACTER = 8;
// An unterminated number longer than this is not shown until it ends, so `snapshot()` stays cheap.
const MAX_PENDING_SCALAR_LENGTH = 64;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_WITHOUT_EXPONENT_DIGITS = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)[eE][+-]?$/;
const LITERALS: readonly [string, JsonValue][] = [
	["true", true],
	["false", false],
	["null", null],
];

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Incremental, tolerant JSON parser; see the module comment for its rules and costs. */
/** 译：增量、容错的 JSON 解析器；规则和代价见模块注释。 */
export class StreamingJsonParser {
	#root: JsonValue | undefined = undefined;
	#done = false;
	readonly #stack: Frame[] = [];
	#string: OpenString | undefined = undefined;
	#scalar = "";
	#scalarSlot: Slot | undefined = undefined;
	/** Sum of `size + 1` over the open path: what a fresh snapshot copies. */
	#pathCost = 0;
	#credit = 0;
	#dirty = false;
	#snapshot: JsonValue | undefined = undefined;
	/** Changes of the piece being read. */
	#changes: OpenChange[] = [];

	/**
	 * Read the next piece of text; returns the changes it made, in order. Costs time linear in `text.length`.
	 * 译：读入下一段文本；按顺序返回它造成的变化。耗时与 text.length 成线性。
	 */
	append(text: string): readonly JsonChange[] {
		// 注：一个字符一个字符地推进状态机：在字符串里、在数字/字面量里、或在结构字符（{}[],:）上。
		this.#credit += CREDIT_PER_APPEND + CREDIT_PER_CHARACTER * text.length;
		this.#changes = [];
		if (this.#string !== undefined) this.#string.change = undefined;
		let index = 0;
		while (index < text.length && !this.#done) {
			const open = this.#string;
			if (open !== undefined) index = this.#readString(open, text, index);
			else if (this.#scalar !== "") index = this.#readScalar(text, index);
			else this.#structural(text[index++]!);
		}
		return this.#changes;
	}

	/**
	 * The value of the text read so far: `undefined` before a value starts, otherwise a plain JSON value that never
	 * changes afterwards. Returns the previous snapshot while the text read since did not change the value, or while a
	 * fresh copy of the open path is not yet paid for (see the module comment).
	 * 译：已读文本的值：值开始之前是 undefined，之后是一个此后不再改变的普通 JSON 值。
	 * 若自上次以来值没有变化，或复制开放路径的额度还不够（见模块注释），返回上一个快照。
	 */
	snapshot(): JsonValue | undefined {
		if (!this.#dirty) return this.#snapshot;
		const pending = this.#pendingScalar();
		const cost = this.#pathCost + (pending === undefined ? 0 : 1);
		if (cost > this.#credit) return this.#snapshot;
		this.#credit -= cost;
		this.#dirty = false;
		this.#snapshot = this.#copyOpenPath(pending);
		return this.#snapshot;
	}

	/** Read string characters from `start` until the string ends or the text does; returns the next index. */
	#readString(open: OpenString, text: string, start: number): number {
		let runStart = start;
		for (let index = start; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (open.escape !== "") {
				if (this.#continueEscape(open, text[index]!)) {
					runStart = index + 1;
					continue;
				}
				// Not part of the escape: read it as a normal string character below.
				runStart = index;
			}
			if (code === QUOTE) {
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				this.#endString(open);
				return index + 1;
			}
			if (code === BACKSLASH) {
				if (index > runStart) this.#appendString(open, text.slice(runStart, index));
				open.escape = "\\";
				runStart = index + 1;
			}
		}
		if (text.length > runStart) this.#appendString(open, text.slice(runStart));
		return text.length;
	}

	/** Read number or literal characters from `start` up to the next delimiter; returns the delimiter's index. */
	#readScalar(text: string, start: number): number {
		let end = start;
		while (end < text.length && !isDelimiter(text[end]!)) end++;
		if (end > start) {
			this.#scalar += text.slice(start, end);
			if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
		if (end < text.length) this.#endScalar();
		return end;
	}

	/** Handle one character outside strings. */
	#structural(char: string): void {
		switch (char) {
			case " ":
			case "\t":
			case "\n":
			case "\r":
				return;
			case '"':
				this.#startString();
				return;
			case "{":
			case "[":
				this.#openContainer(char === "{" ? {} : []);
				return;
			case "}":
			case "]":
				this.#closeContainer();
				return;
			case ":": {
				const frame = this.#stack.at(-1);
				if (frame !== undefined && !Array.isArray(frame.container) && frame.phase === "colon")
					frame.phase = "value";
				return;
			}
			case ",": {
				const frame = this.#stack.at(-1);
				if (frame !== undefined) frame.phase = Array.isArray(frame.container) ? "value" : "key";
				return;
			}
			default:
				this.#scalar = char;
				this.#scalarSlot = this.#valueSlot();
				if (this.#scalarSlot !== undefined) this.#dirty = true;
		}
	}

	/** Where a value starting now goes, or `undefined` when this position takes no value. */
	#valueSlot(): Slot | undefined {
		const frame = this.#stack.at(-1);
		if (frame === undefined) return this.#root === undefined ? ROOT_SLOT : undefined;
		if (Array.isArray(frame.container)) return { kind: "element", index: frame.container.length };
		// A missing colon is tolerated: `{"a" 1}` reads as `{"a": 1}`.
		if ((frame.phase === "value" || frame.phase === "colon") && frame.key !== undefined) {
			return { kind: "member", key: frame.key };
		}
		return undefined;
	}

	#startString(): void {
		const frame = this.#stack.at(-1);
		// A missing comma is tolerated: `{"a": 1 "b": 2}` reads the second member.
		if (
			frame !== undefined &&
			!Array.isArray(frame.container) &&
			(frame.phase === "key" || frame.phase === "comma")
		) {
			this.#string = { target: "key", slot: undefined, text: "", escape: "", path: undefined, change: undefined };
			return;
		}
		const slot = this.#valueSlot();
		const path = this.#reportedPath(slot);
		this.#string = { target: "value", slot, text: "", escape: "", path, change: undefined };
		this.#place(slot, "");
		if (path !== undefined) this.#string.change = this.#report({ kind: "set", path, value: "" });
	}

	/** The path of a value at `slot` in the innermost open container, when its changes are reported. */
	#reportedPath(slot: Slot | undefined): JsonPath | undefined {
		if (slot === undefined) return undefined;
		if (slot.kind === "root") return [];
		const frame = this.#stack.at(-1)!;
		if (!frame.reportsInside) return undefined;
		return [...frame.path!, slot.kind === "member" ? slot.key : slot.index];
	}

	#report(change: OpenChange): OpenChange {
		this.#changes.push(change);
		return change;
	}

	/** Continue an escape with `char`; returns false when `char` is not part of it and must be read normally. */
	#continueEscape(open: OpenString, char: string): boolean {
		if (open.escape === "\\") {
			const decoded = SIMPLE_ESCAPES[char];
			if (decoded !== undefined) {
				open.escape = "";
				this.#appendString(open, decoded);
				return true;
			}
			if (char === "u") {
				open.escape = "\\u";
				return true;
			}
			// Invalid escape: keep the backslash as text and read the character normally, as repairJson() does.
			open.escape = "";
			this.#appendString(open, "\\");
			return false;
		}
		if (isHexDigit(char)) {
			open.escape += char;
			if (open.escape.length < 6) return true;
			const decoded = String.fromCharCode(Number.parseInt(open.escape.slice(2), 16));
			open.escape = "";
			this.#appendString(open, decoded);
			return true;
		}
		// `\u` without four hex digits: keep it as text and read the character normally, as repairJson() does.
		const literal = open.escape;
		open.escape = "";
		this.#appendString(open, literal);
		return false;
	}

	#appendString(open: OpenString, text: string): void {
		open.text += text;
		if (open.target !== "value") return;
		this.#place(open.slot, open.text);
		if (open.path === undefined) return;
		// Extend this string's newest change while nothing came after it; otherwise report an append.
		const change = open.change;
		if (change !== undefined && this.#changes.at(-1) === change) {
			if (change.kind === "set") change.value = (change.value as string) + text;
			else change.text += text;
			return;
		}
		open.change = this.#report({ kind: "append", path: open.path, text });
	}

	#endString(open: OpenString): void {
		this.#string = undefined;
		const frame = this.#stack.at(-1);
		if (open.target === "key") {
			if (frame === undefined) return;
			frame.key = open.text;
			frame.phase = "colon";
			return;
		}
		this.#valueEnded(frame);
	}

	#endScalar(): void {
		const token = this.#scalar;
		const slot = this.#scalarSlot;
		this.#scalar = "";
		this.#scalarSlot = undefined;
		const value = scalarValue(token);
		if (value !== undefined) {
			this.#place(slot, value);
			const path = this.#reportedPath(slot);
			if (path !== undefined) this.#report({ kind: "set", path, value });
		}
		this.#valueEnded(this.#stack.at(-1));
	}

	/** The value of the unterminated scalar at the end of the text, if it shows. */
	#pendingScalar(): { readonly slot: Slot; readonly value: JsonValue } | undefined {
		const slot = this.#scalarSlot;
		const token = this.#scalar;
		if (slot === undefined || token === "" || token.length > MAX_PENDING_SCALAR_LENGTH) return undefined;
		const value = pendingScalarValue(token);
		return value === undefined ? undefined : { slot, value };
	}

	#openContainer(container: JsonContainer): void {
		const slot = this.#valueSlot();
		const path = this.#reportedPath(slot);
		this.#place(slot, container);
		this.#stack.push({
			container,
			slot,
			path,
			reportsInside: path !== undefined && path.length < MAX_REPORTED_DEPTH,
			size: 0,
			key: undefined,
			phase: Array.isArray(container) ? "value" : "key",
		});
		this.#pathCost += 1;
		this.#dirty = true;
		// A fresh container: the working one keeps changing, and a change never does.
		if (path !== undefined) this.#report({ kind: "set", path, value: Array.isArray(container) ? [] : {} });
	}

	#closeContainer(): void {
		const frame = this.#stack.pop();
		// A stray closer outside any container is ignored.
		if (frame === undefined) return;
		this.#pathCost -= frame.size + 1;
		this.#dirty = true;
		// Too deep to report inside: the whole value, final now that it is closed.
		if (frame.path !== undefined && !frame.reportsInside) {
			this.#report({ kind: "set", path: frame.path, value: frame.container });
		}
		this.#valueEnded(this.#stack.at(-1));
	}

	/** A value in `frame`, or the root value when there is no frame, has ended. */
	#valueEnded(frame: Frame | undefined): void {
		if (frame === undefined) {
			// Text after the root value is ignored, but only once a root value exists.
			if (this.#root !== undefined) this.#done = true;
			return;
		}
		frame.phase = "comma";
	}

	/** Set the value at `slot` in the open path; nothing for a value in an invalid position. */
	#place(slot: Slot | undefined, value: JsonValue): void {
		if (slot === undefined) return;
		this.#dirty = true;
		if (slot.kind === "root") {
			this.#root = value;
			return;
		}
		const frame = this.#stack.at(-1)!;
		if (slot.kind === "element") {
			const elements = frame.container as JsonValue[];
			if (slot.index === elements.length) {
				frame.size++;
				this.#pathCost++;
			}
			elements[slot.index] = value;
			return;
		}
		const members = frame.container as { [key: string]: JsonValue };
		if (!Object.hasOwn(members, slot.key)) {
			frame.size++;
			this.#pathCost++;
		}
		setMember(members, slot.key, value);
	}

	/** A fresh snapshot: copies of the open containers, innermost first, each holding the copy of its open child. */
	#copyOpenPath(pending: { readonly slot: Slot; readonly value: JsonValue } | undefined): JsonValue | undefined {
		if (this.#stack.length === 0) return pending?.slot.kind === "root" ? pending.value : this.#root;
		let child: JsonValue | undefined;
		let childSlot: Slot | undefined;
		for (let depth = this.#stack.length - 1; depth >= 0; depth--) {
			const frame = this.#stack[depth]!;
			const copy: JsonContainer = Array.isArray(frame.container) ? frame.container.slice() : { ...frame.container };
			if (depth === this.#stack.length - 1 && pending !== undefined) setSlot(copy, pending.slot, pending.value);
			if (child !== undefined && childSlot !== undefined) setSlot(copy, childSlot, child);
			child = copy;
			childSlot = frame.slot;
		}
		// The outermost open container is the root unless it sits in an invalid position.
		return childSlot?.kind === "root" ? child : this.#root;
	}
}

/**
 * The arguments of one streaming tool call: the raw text, for the one full parse when the call ends, and a
 * `StreamingJsonParser` for the partial arguments in between. Providers keep one per call in their own stream state,
 * never on the content block, so the raw text never reaches partial messages or transcripts.
 * 译：一次流式工具调用的参数：保存原始文本（调用结束时做唯一一次完整解析），以及一个 StreamingJsonParser
 * （提供中途的部分参数）。provider 在自己的流状态里为每个调用保存一个，绝不挂在内容块上，
 * 所以原始文本永远不会进入 partial 消息或对话记录。
 * 注：openai-completions.ts 里：append() 对应 toolcall_delta，finish() 在 finishBlock 里调用。
 */
export class ToolCallArgumentsStream {
	#text = "";
	#parser = new StreamingJsonParser();
	#snapshot: JsonValue | undefined = undefined;
	#arguments: ToolCall["arguments"] = {};

	/** The raw argument text received so far. */
	/** 译：目前收到的原始参数文本。 */
	get text(): string {
		return this.#text;
	}

	/** Append a piece of argument text; returns the partial arguments, a new object whenever they changed. */
	/** 译：追加一段参数文本；返回部分参数，只要有变化就是一个新对象（没变化则返回同一个对象，方便 UI 判断是否重绘）。 */
	append(delta: string): ToolCall["arguments"] {
		this.#text += delta;
		this.#parser.append(delta);
		return this.#partial();
	}

	/**
	 * Take the provider's complete argument text. When it continues the text so far, returns the missing piece as
	 * `delta`; otherwise starts over with `text`. Either way returns the partial arguments of `text`.
	 * 译：接收服务方给出的完整参数文本。如果它是已有文本的延续，把缺的那段作为 delta 返回；否则从 text 重新开始。
	 * 两种情况都返回 text 的部分参数。（用于每次发送"全量参数"而非增量的服务。）
	 */
	replace(text: string): { readonly delta: string | undefined; readonly arguments: ToolCall["arguments"] } {
		if (text.startsWith(this.#text)) {
			const delta = text.slice(this.#text.length);
			return { delta, arguments: delta === "" ? this.#partial() : this.append(delta) };
		}
		this.#text = "";
		this.#parser = new StreamingJsonParser();
		return { delta: undefined, arguments: this.append(text) };
	}

	/** The final arguments: one full parse of the complete text, which reports malformed arguments. */
	/** 译：最终参数：对完整文本做一次完整解析；参数格式错误时通过 argumentsError 报告，而不是抛异常。 */
	finish(): Pick<ToolCall, "arguments" | "argumentsError"> {
		return parseToolCallArguments(this.#text);
	}

	#partial(): ToolCall["arguments"] {
		const snapshot = this.#parser.snapshot();
		if (snapshot === this.#snapshot) return this.#arguments;
		this.#snapshot = snapshot;
		// Tool arguments are an object; any other partial value shows as no arguments yet.
		// 译：工具参数是对象；其他任何部分值都视为"还没有参数"。
		this.#arguments =
			typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
				? (snapshot as ToolCall["arguments"])
				: {};
		return this.#arguments;
	}
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

function isDelimiter(char: string): boolean {
	return (
		char === " " ||
		char === "\t" ||
		char === "\n" ||
		char === "\r" ||
		char === "," ||
		char === ":" ||
		char === "{" ||
		char === "}" ||
		char === "[" ||
		char === "]" ||
		char === '"'
	);
}

function isHexDigit(char: string): boolean {
	return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

/** The value of a complete number or literal token; `undefined` for anything else, which is dropped. */
function scalarValue(token: string): JsonValue | undefined {
	for (const [literal, value] of LITERALS) if (token === literal) return value;
	return NUMBER.test(token) ? Number(token) : undefined;
}

/** The value an unterminated number or literal token shows. */
function pendingScalarValue(token: string): JsonValue | undefined {
	for (const [literal, value] of LITERALS) if (literal.startsWith(token)) return value;
	if (NUMBER.test(token)) return Number(token);
	const mantissa = NUMBER_WITHOUT_EXPONENT_DIGITS.exec(token);
	return mantissa === null ? undefined : Number(mantissa[1]);
}

function setSlot(container: JsonContainer, slot: Slot, value: JsonValue): void {
	if (slot.kind === "element") (container as JsonValue[])[slot.index] = value;
	else if (slot.kind === "member") setMember(container as { [key: string]: JsonValue }, slot.key, value);
}

function setMember(members: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
	// `__proto__` must become an own member, as in JSON.parse(), not the prototype.
	if (key === "__proto__") {
		Object.defineProperty(members, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		members[key] = value;
	}
}
