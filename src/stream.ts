/**
 * A reply read as it is written, for Chat.
 *
 * Everything else Grill asks a model for is one JSON object, fetched whole. A Chat reply
 * is prose, and prose that appears as it is written is read sooner than prose that
 * arrives all at once after a wait. This asks for plain text with streaming on and
 * hands back what has been heard so far each time more arrives.
 *
 * It uses `fetch`, the only request Obsidian offers that can be read in pieces. Where a
 * stream can't be opened at all (a server that refuses a request made from Obsidian's
 * pane, a provider that is down), it throws `StreamUnavailable` before anything has been
 * written, and the caller asks the old way instead.
 */
import type { LLMConfig } from "./llm";

export type StreamKind = "anthropic" | "chat" | "gemini" | "ollama";

export interface StreamCall {
	kind: StreamKind;
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export interface StreamPrompt {
	system: string;
	/** What is the same from one message to the next; Anthropic is told to cache it. */
	cacheable: string;
	rest: string;
	maxTokens: number;
}

export interface StreamOptions {
	/** Whether this Anthropic model takes an effort setting. */
	takesEffort?: boolean;
	/** Grill Cloud's address, when its server has said it streams; without it Grill
	 * Cloud is asked the old way. */
	cloudUrl?: string | null;
}

/** Nothing was written and nothing can be: ask without streaming. */
export class StreamUnavailable extends Error {
	constructor(why: string) {
		super(why);
		this.name = "StreamUnavailable";
	}
}

/** The request that streams a reply from this provider, or null when it can't be asked
 * for one this way. */
export function streamCall(cfg: LLMConfig, p: StreamPrompt, o: StreamOptions = {}): StreamCall | null {
	const flat = p.cacheable ? `${p.cacheable}\n\n${p.rest}` : p.rest;
	const messages = [
		{ role: "system", content: p.system },
		{ role: "user", content: flat },
	];
	const json = { "content-type": "application/json" };
	switch (cfg.provider) {
		case "anthropic": {
			const content: unknown[] = [];
			if (p.cacheable) content.push({ type: "text", text: p.cacheable, cache_control: { type: "ephemeral" } });
			content.push({ type: "text", text: p.rest });
			return {
				kind: "anthropic",
				url: "https://api.anthropic.com/v1/messages",
				headers: {
					...json,
					"x-api-key": cfg.apiKey,
					"anthropic-version": "2023-06-01",
					// The key is the user's own and stays on their machine; this is how
					// Anthropic is told a request from a browser-like pane is meant.
					"anthropic-dangerous-direct-browser-access": "true",
				},
				body: {
					model: cfg.model,
					max_tokens: p.maxTokens,
					stream: true,
					system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
					messages: [{ role: "user", content }],
					...(o.takesEffort ? { output_config: { effort: "medium" } } : {}),
				},
			};
		}
		case "openai": {
			const body: Record<string, unknown> = { model: cfg.model, max_completion_tokens: p.maxTokens, stream: true, messages };
			if (/^(gpt-[5-9]|o\d)/.test(cfg.model)) body.reasoning_effort = "medium";
			return { kind: "chat", url: "https://api.openai.com/v1/chat/completions", headers: { ...json, authorization: `Bearer ${cfg.apiKey}` }, body };
		}
		case "deepseek":
			return {
				kind: "chat",
				url: "https://api.deepseek.com/chat/completions",
				headers: { ...json, authorization: `Bearer ${cfg.apiKey}` },
				body: { model: cfg.model, max_tokens: p.maxTokens, stream: true, messages },
			};
		case "custom":
			if (!cfg.baseUrl) return null;
			return {
				kind: "chat",
				url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
				headers: { ...json, authorization: `Bearer ${cfg.apiKey}` },
				body: { model: cfg.model, max_tokens: p.maxTokens, stream: true, messages },
			};
		case "grillcloud":
			if (!o.cloudUrl) return null;
			return {
				kind: "chat",
				url: `${o.cloudUrl.replace(/\/$/, "")}/chat/completions`,
				headers: { ...json, authorization: `Bearer ${cfg.apiKey}` },
				body: { model: cfg.model, max_tokens: p.maxTokens, stream: true, messages },
			};
		case "gemini":
			return {
				kind: "gemini",
				url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse`,
				headers: { ...json, "x-goog-api-key": cfg.apiKey },
				body: {
					systemInstruction: { parts: [{ text: p.system }] },
					contents: [{ role: "user", parts: [{ text: flat }] }],
					generationConfig: { maxOutputTokens: p.maxTokens },
				},
			};
		case "ollama":
			return {
				kind: "ollama",
				url: `${(cfg.baseUrl ?? "http://localhost:11434").replace(/\/$/, "")}/api/chat`,
				headers: json,
				body: { model: cfg.model, stream: true, think: false, messages, options: { num_predict: p.maxTokens } },
			};
	}
}

/** A tool the model asks to have used: which one, with what. */
export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/** Part of a tool call as it arrives: which call it belongs to, and what it adds. */
interface CallPart {
	index: number;
	id?: string;
	name?: string;
	args?: string;
}

/** A tool the model may ask for, described once for every provider. */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema of its input. */
	input: Record<string, unknown>;
}

/** One step of a conversation in which tools are used, in no provider's shape. */
export type ToolMsg =
	| { role: "assistant"; text: string; calls: ToolCall[] }
	| { role: "tool"; results: Array<{ id: string; content: string; failed?: boolean }> };

/** The request for the next step of a conversation that may use tools: the prompt as
 * `streamCall` sends it, then the steps so far. Null for a provider that isn't asked
 * this way; the caller then answers without tools. */
export function toolStreamCall(cfg: LLMConfig, p: StreamPrompt, steps: ToolMsg[], tools: ToolSpec[], o: StreamOptions = {}): StreamCall | null {
	const call = streamCall(cfg, p, o);
	if (!call || (call.kind !== "anthropic" && call.kind !== "chat")) return null;
	const messages = call.body.messages as unknown[];
	if (call.kind === "anthropic") {
		call.body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));
		for (const step of steps) {
			if (step.role === "assistant") {
				messages.push({
					role: "assistant",
					content: [...(step.text ? [{ type: "text", text: step.text }] : []), ...step.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))],
				});
			} else {
				messages.push({
					role: "user",
					content: step.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.failed ? { is_error: true } : {}) })),
				});
			}
		}
		return call;
	}
	call.body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input } }));
	for (const step of steps) {
		if (step.role === "assistant") {
			messages.push({
				role: "assistant",
				content: step.text || null,
				tool_calls: step.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
			});
		} else {
			for (const r of step.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
		}
	}
	return call;
}

/** What one piece of a stream said. */
export interface StreamPiece {
	text?: string;
	callParts?: CallPart[];
	truncated?: boolean;
	/** The provider reported a failure inside the stream. */
	error?: string;
	/** Grill Cloud's closing line: the balance and what the reply cost. */
	credits?: number;
	cost?: number;
}

type Loose = Record<string, unknown> | null | undefined;
const obj = (v: unknown): Loose => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Read one decoded payload of a stream (or a whole reply from a server that ignored the
 * request to stream) in the provider's own shape. */
export function readPiece(kind: StreamKind, payload: unknown): StreamPiece {
	const j = obj(payload);
	if (!j) return {};
	const piece: StreamPiece = {};
	const err = j.error;
	if (err) piece.error = str(err) || str(obj(err)?.message) || "The provider reported an error.";
	const grill = obj(j.grill);
	if (grill) {
		if (typeof grill.credits === "number") piece.credits = grill.credits;
		if (typeof grill.cost === "number") piece.cost = grill.cost;
	}
	switch (kind) {
		case "anthropic": {
			const delta = obj(j.delta);
			if (j.type === "content_block_delta" && delta?.type === "text_delta") piece.text = str(delta.text);
			const index = typeof j.index === "number" ? j.index : 0;
			const block = obj(j.content_block);
			if (j.type === "content_block_start" && block?.type === "tool_use") piece.callParts = [{ index, id: str(block.id), name: str(block.name) }];
			if (j.type === "content_block_delta" && delta?.type === "input_json_delta") piece.callParts = [{ index, args: str(delta.partial_json) }];
			if (j.type === "message_delta") {
				if (delta?.stop_reason === "max_tokens") piece.truncated = true;
				if (delta?.stop_reason === "refusal") piece.error = "The model declined this request (safety refusal).";
			}
			// Not streamed after all: the whole message.
			if (j.type === "message" && Array.isArray(j.content)) {
				piece.text = j.content.map((b) => (obj(b)?.type === "text" ? str(obj(b)?.text) : "")).join("");
				const uses = j.content.map(obj).filter((b) => b?.type === "tool_use");
				if (uses.length) piece.callParts = uses.map((b, i) => ({ index: i, id: str(b?.id), name: str(b?.name), args: JSON.stringify(b?.input ?? {}) }));
				if (j.stop_reason === "max_tokens") piece.truncated = true;
			}
			break;
		}
		case "chat": {
			const choice = obj(Array.isArray(j.choices) ? j.choices[0] : null);
			const text = str(obj(choice?.delta)?.content) || str(obj(choice?.message)?.content);
			if (text) piece.text = text;
			if (choice?.finish_reason === "length") piece.truncated = true;
			const asked = obj(choice?.delta)?.tool_calls ?? obj(choice?.message)?.tool_calls;
			if (Array.isArray(asked)) {
				piece.callParts = asked.map((c, i) => {
					const call = obj(c);
					const fn = obj(call?.function);
					const part: CallPart = { index: typeof call?.index === "number" ? call.index : i };
					if (str(call?.id)) part.id = str(call?.id);
					if (str(fn?.name)) part.name = str(fn?.name);
					if (str(fn?.arguments)) part.args = str(fn?.arguments);
					return part;
				});
			}
			break;
		}
		case "gemini": {
			const cand = obj(Array.isArray(j.candidates) ? j.candidates[0] : null);
			const parts = obj(cand?.content)?.parts;
			if (Array.isArray(parts)) piece.text = parts.map((part) => str(obj(part)?.text)).join("");
			if (cand?.finishReason === "MAX_TOKENS") piece.truncated = true;
			break;
		}
		case "ollama": {
			const text = str(obj(j.message)?.content);
			if (text) piece.text = text;
			if (j.done_reason === "length") piece.truncated = true;
			break;
		}
	}
	return piece;
}

/** Split what has arrived into whole lines, keeping the unfinished last one for the
 * next read. Returns the payload of each line that carries one: the text after `data:`
 * in an event stream, the line itself where every line is an object. */
export function takeLines(pending: string, kind: StreamKind): { payloads: string[]; pending: string } {
	const lines = pending.split(/\r?\n/);
	const rest = lines.pop() ?? "";
	const payloads: string[] = [];
	for (const line of lines) {
		if (kind === "ollama") {
			if (line.trim()) payloads.push(line.trim());
		} else if (line.startsWith("data:")) {
			const data = line.slice(5).trim();
			if (data && data !== "[DONE]") payloads.push(data);
		}
	}
	return { payloads, pending: rest };
}

/** A local reasoning model that thinks out loud despite being asked not to: what it
 * thought is not part of the reply, finished or not. */
export function withoutThinking(text: string): string {
	return text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trimStart();
}

export interface StreamResult {
	text: string;
	truncated: boolean;
	/** The tools the model asked for, in order. Empty for a plain reply. */
	calls: ToolCall[];
}

/** Put the parts of each tool call together. A call whose arguments don't parse is
 * kept with none, so the model is told its request was unreadable instead of the turn
 * being lost. */
function assemble(parts: Map<number, { id: string; name: string; args: string }>): ToolCall[] {
	return [...parts.entries()]
		.sort((a, b) => a[0] - b[0])
		.filter(([, c]) => c.name)
		.map(([index, c]) => {
			let input: Record<string, unknown> = {};
			try {
				const parsed: unknown = c.args.trim() ? JSON.parse(c.args) : {};
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
			} catch {
				input = { __unreadable: c.args.slice(0, 200) };
			}
			return { id: c.id || `call_${index}`, name: c.name, input };
		});
}

export interface StreamRun {
	/** Called with all of the reply heard so far, each time more arrives. */
	onText(soFar: string): void;
	/** How long the stream may stay silent before it is given up on. */
	idleMs: number;
	/** Stops the request: the user left the conversation. */
	signal?: AbortSignal;
	onCloud?(credits: number | undefined, cost: number | undefined): void;
	fetch?: typeof fetch;
}

/** Ask, and read the reply as it is written. Throws `StreamUnavailable` while nothing
 * has been written; after that, an ordinary error saying the reply broke off. */
export async function streamText(call: StreamCall, run: StreamRun): Promise<StreamResult> {
	const send = run.fetch ?? fetch;
	const stop = new AbortController();
	let timedOut = false;
	let timer = 0;
	const alive = (): void => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timedOut = true;
			stop.abort();
		}, run.idleMs);
	};
	const left = (): void => stop.abort();
	run.signal?.addEventListener("abort", left);
	let text = "";
	let truncated = false;
	const parts = new Map<number, { id: string; name: string; args: string }>();
	const note = (piece: StreamPiece): void => {
		for (const part of piece.callParts ?? []) {
			const call = parts.get(part.index) ?? { id: "", name: "", args: "" };
			if (part.id) call.id = part.id;
			if (part.name) call.name = part.name;
			if (part.args) call.args += part.args;
			parts.set(part.index, call);
		}
	};
	const shown = (): string => (call.kind === "ollama" ? withoutThinking(text) : text);
	const take = (payload: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return; // a keep-alive or a line cut in a way no provider should cut it
		}
		const piece = readPiece(call.kind, parsed);
		if (piece.credits !== undefined || piece.cost !== undefined) run.onCloud?.(piece.credits, piece.cost);
		if (piece.error) throw new Error(piece.error);
		if (piece.truncated) truncated = true;
		note(piece);
		if (piece.text) {
			text += piece.text;
			run.onText(shown());
		}
	};
	try {
		alive();
		let resp: Response;
		try {
			resp = await send(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(call.body), signal: stop.signal });
		} catch (e) {
			if (run.signal?.aborted) throw e;
			throw new StreamUnavailable(timedOut ? "no answer in time" : "could not be reached");
		}
		// A refusal is told properly by the request that doesn't stream: it knows each
		// provider's errors and which are worth waiting out.
		if (!resp.ok) {
			await resp.text().catch(() => "");
			throw new StreamUnavailable(`status ${resp.status}`);
		}
		const type = resp.headers.get("content-type") ?? "";
		if (!resp.body || !/event-stream|ndjson/.test(type)) {
			// Answered, but whole. It has been paid for, so it is used, not asked again.
			const whole = readPiece(call.kind, await resp.json().catch(() => null));
			if (whole.error) throw new Error(whole.error);
			note(whole);
			if (!whole.text && !parts.size) throw new StreamUnavailable("an empty reply");
			text = whole.text ?? "";
			if (text) run.onText(shown());
			return { text: shown(), truncated: !!whole.truncated, calls: assemble(parts) };
		}
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				alive();
				if (done) break;
				const lines = takeLines(pending + decoder.decode(value, { stream: true }), call.kind);
				pending = lines.pending;
				lines.payloads.forEach(take);
			}
			// A last line with no newline after it.
			takeLines(`${pending}\n`, call.kind).payloads.forEach(take);
		} catch (e) {
			if (run.signal?.aborted) throw e;
			if (!shown() && !parts.size) throw new StreamUnavailable(timedOut ? "no answer in time" : "broke off before it began");
			if (e instanceof Error && e.name !== "AbortError" && !(e instanceof TypeError)) throw e;
			throw new Error(timedOut ? "The reply stopped arriving part way through. Try again." : "The reply broke off part way through. Try again.");
		}
		const calls = assemble(parts);
		if (!shown() && !calls.length) throw new StreamUnavailable("an empty reply");
		return { text: shown(), truncated, calls };
	} finally {
		window.clearTimeout(timer);
		run.signal?.removeEventListener("abort", left);
	}
}
