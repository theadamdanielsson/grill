/** Calling a provider for one JSON answer through Obsidian's requestUrl (native request,
 * no CORS), with retries, timeouts and errors worded for the student.
 *
 * Every provider is called with a JSON-schema-constrained request where the API
 * supports it (Anthropic output_config, OpenAI json_schema strict, Gemini
 * responseSchema); DeepSeek gets json_object mode + the schema in the prompt.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { ImageInput } from "./images";
import { cloud, heardFromCloud } from "./cloud";
import { anthropicAuth, API_BASE, capabilities, CUT_OFF, isOpenAIReasoning, ollamaUrl, who, type LLMConfig, type ProviderId } from "./providers";

/** How long an agent program is given for one answer: it has to start first. */
const AGENT_TIMEOUT_MS = 240_000;

interface HttpCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	extract: (json: unknown) => string | undefined;
	/** True when the provider stopped because it ran out of output tokens: the JSON is
	 * cut off (or empty, when a thinking model spent the whole budget reasoning). */
	truncated: (json: unknown) => boolean;
}

interface ApiErrorBody {
	// Most providers send an object; Ollama sends the sentence itself.
	error?: { message?: string; status?: string } | string;
}

/** An error from Grill Cloud: its own wording, and a code the screen can act on
 * (offer to top up, for one). */
export class CloudError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, json: unknown) {
		const err = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
		super(typeof err?.message === "string" ? err.message : `Grill Cloud answered with an error (${status}).`);
		this.status = status;
		this.code = typeof err?.code === "string" ? err.code : "";
	}
	/** Whether buying credits would fix it. */
	get needsCredits(): boolean {
		return this.status === 402 || this.code === "free_paused";
	}
}

/** An error a provider answered with: the status, so a busy server can be told from a
 * wrong key, and a sentence that says what to do about it. */
export class ApiError extends Error {
	readonly status: number;
	/** How long the provider asked to be left alone, when it said. */
	readonly retryAfterMs: number | null;
	constructor(status: number, message: string, retryAfterMs: number | null = null) {
		super(message);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
	/** Busy or briefly broken, not refused: asking again in a moment can work. */
	get transient(): boolean {
		return [429, 500, 502, 503, 529].includes(this.status);
	}
}

/** A `retry-after` given in seconds. (A date is ignored: nothing Grill calls sends one.) */
function retryAfter(headers: Record<string, string> | undefined): number | null {
	const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === "retry-after");
	const seconds = key ? Number(headers?.[key]) : NaN;
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** The provider's error as a sentence the student can act on. `model` is the one that
 * was asked for, when the request was for a model at all. */
export function apiError(provider: ProviderId, model: string | null, resp: { status: number; text: string; headers?: Record<string, string> }, json: unknown): ApiError {
	const { status } = resp;
	const err = (json as ApiErrorBody | null)?.error;
	const said = (typeof err === "string" ? err : (err?.message ?? err?.status ?? resp.text ?? "")).slice(0, 160).trim();
	const name = who(provider);
	// Their own words, for the cases where the status alone doesn't say which thing it is.
	const theirs = said ? ` ${name} said: "${said}"` : "";
	let message: string;
	if (status === 401) message = `${name} rejected the API key. Check it in Grill's settings.`;
	else if (status === 403) message = `${name} refused this request. The key may not have access to ${model ? `'${model}'` : "it"}.${theirs}`;
	else if (status === 404 && provider === "ollama" && model) message = `Ollama doesn't have '${model}' yet. Run: ollama pull ${model}`;
	else if (status === 404 && model && provider !== "custom") message = `${name} has no model called '${model}'. Pick another in Grill's settings.`;
	else if (status === 404) message = `${name} answered "not found". Check the address${model ? " and the model name" : ""}.`;
	else if (status === 429) message = `${name} is rate-limiting this key, or its quota is used up. Wait a minute and try again.${theirs}`;
	else if (status >= 500) message = `${name} is having trouble right now (${status}). Try again in a moment.`;
	else message = `${name} answered with an error (${status}).${theirs}`;
	return new ApiError(status, message, retryAfter(resp.headers));
}

/** The request never got an answer: offline, a wrong address, or a local server that
 * isn't running. */
export function unreachable(provider: ProviderId, url: string): Error {
	let at = "";
	try {
		at = new URL(url).origin;
	} catch {
		/* not an address at all: say so without one */
	}
	if (provider === "ollama") return new Error(`Couldn't reach Ollama${at ? ` at ${at}` : ""}. Check that it's running.`);
	if (provider === "custom") return new Error(`Couldn't reach your endpoint${at ? ` at ${at}` : ""}. Check the base URL and that it's running.`);
	return new Error(`Couldn't reach ${who(provider)}. Check your connection and try again.`);
}

/** Gemini's responseSchema is an OpenAPI-style subset: uppercase type enums,
 * no additionalProperties. Convert a JSON Schema recursively. */
function toGeminiSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(toGeminiSchema);
	if (schema && typeof schema === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
			if (k === "additionalProperties") continue;
			if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
			else out[k] = toGeminiSchema(v);
		}
		return out;
	}
	return schema;
}

interface AnthropicMessageResponse {
	stop_reason?: string;
	content?: Array<{ type: string; text?: string }>;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

interface GeminiGenerateResponse {
	candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

interface OllamaChatResponse {
	message?: { content?: string };
	done_reason?: string;
}

const chatTruncated = (json: unknown): boolean =>
	(json as ChatCompletionResponse | null)?.choices?.[0]?.finish_reason === CUT_OFF.chat;

/** A user prompt split into a large, repeat-across-calls prefix (e.g. a note's full
 * text, sent again on every batch/grade call within a session) and a small varying
 * suffix (the actual question/instructions). Only the Anthropic path in `buildCall`
 * turns `cacheable` into a real prompt-cache breakpoint; every other provider just
 * concatenates the two, so passing this instead of a plain string is always safe. */
interface SplitUser {
	cacheable: string;
	rest: string;
}

/** Flatten a `SplitUser` (or pass a plain string through) for providers that don't
 * get special caching treatment below. */
function flattenUser(user: string | SplitUser): string {
	return typeof user === "string" ? user : `${user.cacheable}\n\n${user.rest}`;
}

function buildCall(
	cfg: LLMConfig,
	system: string,
	user: string | SplitUser,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[],
	effort: "low" | "medium" = "medium",
): HttpCall {
	// Every provider except Anthropic (handled specially below, for real cache
	// breakpoints) just gets the flattened string — same request shape as before.
	const flatUser = flattenUser(user);
	switch (cfg.provider) {
		case "anthropic": {
			// Prompt caching: the system prompt (persona + fixed engine rules) is
			// identical across every call this session (and most calls ever, since the
			// default persona is rarely changed) — always worth marking. When the caller
			// split its user prompt, the "cacheable" half (typically a note's full text)
			// gets its own breakpoint too, placed BEFORE the images/variable part so a
			// cache hit doesn't depend on whether this particular call happens to carry
			// images. No caching support here is provider-specific to Anthropic; every
			// other branch below just flattens SplitUser back to a plain string.
			const imageBlocks = images.map((im) => ({
				type: "image",
				source: { type: "base64", media_type: im.mediaType, data: im.dataBase64 },
			}));
			let content: unknown;
			if (typeof user === "string") {
				content = imageBlocks.length ? [...imageBlocks, { type: "text", text: user }] : user;
			} else {
				const blocks: unknown[] = [
					{ type: "text", text: user.cacheable, cache_control: { type: "ephemeral" } },
					...imageBlocks,
				];
				if (user.rest) blocks.push({ type: "text", text: user.rest });
				content = blocks;
			}
			return {
				url: `${API_BASE.anthropic}/messages`,
				headers: {
					"content-type": "application/json",
					...anthropicAuth(cfg.apiKey),
				},
				body: {
					model: cfg.model,
					max_tokens: maxTokens,
					system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
					messages: [{ role: "user", content }],
					// Sonnet 5 / Opus 5 think adaptively by default, and that thinking spends
					// max_tokens. Passing the call's effort keeps it proportionate instead of
					// letting a 2000-token grade run out mid-JSON.
					output_config: capabilities(cfg).effort
						? { format: { type: "json_schema", schema }, effort }
						: { format: { type: "json_schema", schema } },
				},
				extract: (json) => {
					const j = json as AnthropicMessageResponse;
					if (j.stop_reason === "refusal") throw new Error("The model declined this request (safety refusal).");
					return j.content?.find((b) => b.type === "text")?.text;
				},
				truncated: (json) => (json as AnthropicMessageResponse | null)?.stop_reason === CUT_OFF.anthropic,
			};
		}
		case "openai": {
			const content: unknown = images.length
				? [
						{ type: "text", text: flatUser },
						...images.map((im) => ({
							type: "image_url",
							image_url: { url: `data:${im.mediaType};base64,${im.dataBase64}` },
						})),
					]
				: flatUser;
			const body: Record<string, unknown> = {
				model: cfg.model,
				max_completion_tokens: maxTokens,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content },
				],
				response_format: {
					type: "json_schema",
					json_schema: { name: "result", strict: true, schema },
				},
			};
			// Reasoning models spend max_completion_tokens on thinking. Default to "medium" —
			// grading and explanations are exactly the output quality users judge Grill by,
			// and "low" was cutting corners there. A caller with a genuine latency reason
			// (none currently) can still pass "low" explicitly.
			if (isOpenAIReasoning(cfg.model)) body.reasoning_effort = effort;
			return {
				url: `${API_BASE.openai}/chat/completions`,
				headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
				body,
				extract: (json) => (json as ChatCompletionResponse).choices?.[0]?.message?.content,
				truncated: chatTruncated,
			};
		}
		case "gemini":
			return {
				url: `${API_BASE.gemini}/models/${cfg.model}:generateContent`,
				headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
				body: {
					systemInstruction: { parts: [{ text: system }] },
					contents: [
						{
							role: "user",
							parts: [
								{ text: flatUser },
								...images.map((im) => ({ inlineData: { mimeType: im.mediaType, data: im.dataBase64 } })),
							],
						},
					],
					generationConfig: {
						maxOutputTokens: maxTokens,
						responseMimeType: "application/json",
						responseSchema: toGeminiSchema(schema),
					},
				},
				extract: (json) => (json as GeminiGenerateResponse).candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(""),
				truncated: (json) => (json as GeminiGenerateResponse | null)?.candidates?.[0]?.finishReason === CUT_OFF.gemini,
			};
		case "ollama": {
			const userMessage: Record<string, unknown> = { role: "user", content: flatUser };
			if (images.length) userMessage.images = images.map((im) => im.dataBase64);
			return {
				url: `${ollamaUrl(cfg.baseUrl)}/api/chat`,
				headers: { "content-type": "application/json" },
				body: {
					model: cfg.model,
					stream: false,
					// Local reasoning models (Qwen3, DeepSeek-R1, GPT-OSS, ...) default to
					// thinking mode, spending many seconds on hidden tokens before they
					// answer. Grill wants one JSON object, not a chain of thought, so turn
					// it off: ~24x faster on Qwen3 (14s -> 0.6s) and a verified no-op on
					// non-thinking models like Llama and Gemma.
					think: false,
					messages: [{ role: "system", content: system }, userMessage],
					format: schema,
					options: { num_predict: maxTokens },
				},
				// Belt-and-suspenders: if a model ignores think:false and still emits an
				// inline <think> block, strip it so the JSON parse downstream stays clean.
				extract: (json) => {
					const c = (json as OllamaChatResponse).message?.content;
					return c ? c.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : c;
				},
				truncated: (json) => (json as OllamaChatResponse | null)?.done_reason === CUT_OFF.ollama,
			};
		}
		case "deepseek":
			return {
				url: `${API_BASE.deepseek}/chat/completions`,
				headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
				body: {
					model: cfg.model,
					max_tokens: maxTokens,
					messages: [
						{ role: "system", content: system },
						{
							role: "user",
							content:
								flatUser +
								"\n\nRespond ONLY with a json object matching this JSON Schema exactly:\n" +
								JSON.stringify(schema),
						},
					],
					response_format: { type: "json_object" },
				},
				extract: (json) => (json as ChatCompletionResponse).choices?.[0]?.message?.content,
				truncated: chatTruncated,
			};
		case "custom":
		case "grillcloud": {
			// Any OpenAI-compatible endpoint. Use the widest-compatibility shape:
			// json_object mode + schema in the prompt (strict json_schema is not
			// universally supported), and max_tokens (compat layers rarely accept
			// max_completion_tokens). Grill Cloud speaks the same request shape, so the
			// model behind it can change without a plugin release: its server ignores
			// the model field, translates the token limit, and is handed the schema as
			// a schema, which it gives to the provider in whatever form that provider
			// enforces. Vision is off for custom (supportsVision === false), so image
			// parts only ever go to Grill Cloud.
			const hosted = cfg.provider === "grillcloud";
			const base = hosted ? cloud.url : (cfg.baseUrl ?? "");
			const text = hosted
				? flatUser
				: flatUser + "\n\nRespond ONLY with a json object matching this JSON Schema exactly:\n" + JSON.stringify(schema);
			const content: unknown =
				hosted && images.length
					? [
							{ type: "text", text },
							...images.map((im) => ({
								type: "image_url",
								image_url: { url: `data:${im.mediaType};base64,${im.dataBase64}` },
							})),
						]
					: text;
			return {
				url: `${base.replace(/\/$/, "")}/chat/completions`,
				headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
				body: {
					model: cfg.model,
					max_tokens: maxTokens,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content },
					],
					response_format: hosted
						? { type: "json_schema", json_schema: { name: "result", strict: true, schema } }
						: { type: "json_object" },
					// Grill Cloud honours a request for less thinking, never for more.
					...(hosted && effort === "low" ? { effort: "low" } : {}),
				},
				extract: (json) => (json as ChatCompletionResponse).choices?.[0]?.message?.content,
				truncated: chatTruncated,
			};
		}
	}
}

async function callJSONOnce(
	cfg: LLMConfig,
	system: string,
	user: string | SplitUser,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[],
	effort: "low" | "medium" = "medium",
): Promise<unknown> {
	if (cfg.agent) {
		// A program given up on is stopped, so it doesn't go on working (and spending) unseen.
		const stop = new AbortController();
		try {
			return await withTimeout(cfg.agent(system, flattenUser(user), schema, stop.signal, cfg.agentImages ? images : []), AGENT_TIMEOUT_MS);
		} finally {
			stop.abort();
		}
	}
	const call = buildCall(cfg, system, user, schema, maxTokens, images, effort);
	const resp = await withTimeout(
		requestUrl({
			url: call.url,
			method: "POST",
			throw: false,
			headers: call.headers,
			body: JSON.stringify(call.body),
		}).catch(() => {
			throw unreachable(cfg.provider, call.url);
		}),
		requestTimeoutMs(cfg),
	);
	let json: unknown = null;
	try {
		json = resp.json as unknown;
	} catch {
		/* non-JSON error body */
	}
	if (cfg.provider === "grillcloud") {
		heardFromCloud(resp.headers);
		// Grill Cloud's errors are already plain sentences written for the student.
		if (resp.status >= 400) throw new CloudError(resp.status, json);
	}
	if (resp.status >= 400) throw apiError(cfg.provider, cfg.model, resp, json);
	// A 2xx with an empty/null body (a local/custom endpoint restarting mid-response, a
	// proxy returning an empty 200) makes every provider's extract() throw a raw
	// TypeError reading a property off null — that never reaches the `!text` check
	// below, so it bypassed callJSON's retry-once safety net entirely and surfaced to
	// the student as a hard crash instead of the intended "Empty model response"
	// retry-then-friendly-error path. Normalize any extraction failure (null body or an
	// unexpected response shape) into that same path instead of letting it escape as an
	// unrelated exception type.
	let truncated = false;
	try {
		truncated = call.truncated(json);
	} catch {
		/* unexpected shape — let the extraction path below handle it */
	}
	if (truncated) throw new Error(TRUNCATED);
	let text: string | null | undefined;
	try {
		text = call.extract(json);
	} catch {
		text = null;
	}
	if (!text) throw new Error("Empty model response");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// Some models wrap JSON in a code fence despite instructions.
		const m = text.match(/\{[\s\S]*\}/);
		if (m) return JSON.parse(m[0]) as unknown;
		throw new Error("Model returned unparseable output");
	}
}

/** A model occasionally returns no content at all, or garbles the JSON, on an otherwise
 * healthy request — known transient flakiness with reasoning models, not something a
 * second identical request usually repeats. Retry once before surfacing it to the
 * student as a failed batch/grade. A refusal (bad key, no such model) throws from
 * callJSONOnce before reaching that catch, so it's never retried into a second billed
 * call for a failure that won't fix itself. */
/** Two kinds of "not now" are waited out quietly here, so one busy moment doesn't end a
 * session.
 *
 * Grill Cloud lets one request through at a time when a balance is nearly spent, and
 * tells the next to wait. Grill grades one answer while writing the next question, so
 * that is ordinary: wait and ask again for up to about a minute.
 *
 * A provider that is rate-limiting or briefly broken (429, 500, 502, 503, 529) is asked
 * again twice, after as long as it said or a few seconds. Nothing was produced by the
 * failed request, so there is no second bill. A wait longer than `longest` isn't sat
 * through: the student is told instead. */
export async function callJSON(
	cfg: LLMConfig,
	system: string,
	user: string | SplitUser,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[] = [],
	effort: "low" | "medium" = "medium",
): Promise<unknown> {
	const pause = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms));
	let waited = 0;
	let retried = 0;
	for (;;) {
		try {
			return await callJSONSettled(cfg, system, user, schema, maxTokens, images, effort);
		} catch (e) {
			if (e instanceof CloudError && e.code === "wait" && waited < 5) {
				await pause(cloudWait.ms * ++waited);
				continue;
			}
			if (e instanceof ApiError && e.transient && retried < providerRetry.ms.length) {
				const ms = e.retryAfterMs ?? providerRetry.ms[retried];
				if (ms <= providerRetry.longest) {
					retried++;
					await pause(ms);
					continue;
				}
			}
			throw e;
		}
	}
}

/** How long to wait before asking again, at first. Tests shorten it. */
export const cloudWait = { ms: 3000 };

/** The waits before each retry of a busy provider, and the longest one worth sitting
 * through when the provider names its own. Tests shorten them. */
export const providerRetry = { ms: [2000, 6000], longest: 20000 };

async function callJSONSettled(
	cfg: LLMConfig,
	system: string,
	user: string | SplitUser,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[] = [],
	effort: "low" | "medium" = "medium",
): Promise<unknown> {
	try {
		return await callJSONOnce(cfg, system, user, schema, maxTokens, images, effort);
	} catch (e) {
		const msg = (e as Error).message;
		// Ran out of output tokens: the same budget would fail the same way, so the one
		// retry gets double the room.
		if (msg === TRUNCATED) {
			try {
				return await callJSONOnce(cfg, system, user, schema, Math.min(maxTokens * 2, 32000), images, effort);
			} catch (e2) {
				if ((e2 as Error).message === TRUNCATED)
					throw new Error("The model ran out of room before finishing its answer. Try again, or pick a faster model.");
				throw e2;
			}
		}
		if (msg !== "Empty model response" && msg !== "Model returned unparseable output") throw e;
		return await callJSONOnce(cfg, system, user, schema, maxTokens, images, effort);
	}
}

const TRUNCATED = "Model response truncated";

/** requestUrl with a timeout, for the short calls (model lists, embeddings). */
export function timedRequest(req: RequestUrlParam, ms = 60_000): Promise<RequestUrlResponse> {
	return withTimeout(requestUrl(req), ms);
}

/** How long one model call may take before Grill gives up on it. Local servers (and
 * custom endpoints, which are often local or a proxy) get far longer: a CPU-bound
 * model can legitimately take minutes. */
export function requestTimeoutMs(cfg: LLMConfig): number {
	return capabilities(cfg).local ? 300_000 : 180_000;
}

/** requestUrl has no timeout of its own, so a hung server used to leave the pane on
 * the loading screen forever. The underlying request isn't cancelled (requestUrl
 * can't be), but Grill stops waiting and the session moves on. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(
			() => reject(new Error(`The model didn't answer within ${Math.round(ms / 1000)}s. Check that it's running, or try again.`)),
			ms,
		);
		p.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}
