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

/** What one piece of a stream said. */
export interface StreamPiece {
	text?: string;
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
			if (j.type === "message_delta") {
				if (delta?.stop_reason === "max_tokens") piece.truncated = true;
				if (delta?.stop_reason === "refusal") piece.error = "The model declined this request (safety refusal).";
			}
			// Not streamed after all: the whole message.
			if (j.type === "message" && Array.isArray(j.content)) {
				piece.text = j.content.map((b) => (obj(b)?.type === "text" ? str(obj(b)?.text) : "")).join("");
				if (j.stop_reason === "max_tokens") piece.truncated = true;
			}
			break;
		}
		case "chat": {
			const choice = obj(Array.isArray(j.choices) ? j.choices[0] : null);
			const text = str(obj(choice?.delta)?.content) || str(obj(choice?.message)?.content);
			if (text) piece.text = text;
			if (choice?.finish_reason === "length") piece.truncated = true;
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
			if (!whole.text) throw new StreamUnavailable("an empty reply");
			text = whole.text;
			run.onText(shown());
			return { text: shown(), truncated: !!whole.truncated };
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
			if (!shown()) throw new StreamUnavailable(timedOut ? "no answer in time" : "broke off before it began");
			if (e instanceof Error && e.name !== "AbortError" && !(e instanceof TypeError)) throw e;
			throw new Error(timedOut ? "The reply stopped arriving part way through. Try again." : "The reply broke off part way through. Try again.");
		}
		if (!shown()) throw new StreamUnavailable("an empty reply");
		return { text: shown(), truncated };
	} finally {
		window.clearTimeout(timer);
		run.signal?.removeEventListener("abort", left);
	}
}
