/** Multi-provider LLM layer via Obsidian's requestUrl (native request, no CORS).
 *
 * Every provider is called with a JSON-schema-constrained request where the API
 * supports it (Anthropic output_config, OpenAI json_schema strict, Gemini
 * responseSchema); DeepSeek gets json_object mode + the schema in the prompt.
 */

import { requestUrl } from "obsidian";
import type { ImageInput } from "./images";
import type { SessionDebrief, TagAssignment } from "./debrief";

export type ProviderId = "anthropic" | "openai" | "gemini" | "deepseek" | "ollama";

export interface ProviderInfo {
	label: string;
	defaultModel: string;
	keyPlaceholder: string;
	keyUrl: string;
	needsKey: boolean;
	/** Shown when the live model list cannot be fetched. */
	fallbackModels: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
	anthropic: {
		label: "Anthropic (Claude)",
		defaultModel: "claude-sonnet-5",
		keyPlaceholder: "sk-ant-...",
		keyUrl: "console.anthropic.com",
		needsKey: true,
		fallbackModels: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
	},
	openai: {
		label: "OpenAI (ChatGPT)",
		defaultModel: "gpt-5-mini",
		keyPlaceholder: "sk-...",
		keyUrl: "platform.openai.com",
		needsKey: true,
		fallbackModels: ["gpt-5-mini", "gpt-5", "gpt-4o"],
	},
	gemini: {
		label: "Google (Gemini)",
		defaultModel: "gemini-2.5-flash",
		keyPlaceholder: "AIza...",
		keyUrl: "aistudio.google.com",
		needsKey: true,
		fallbackModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
	},
	deepseek: {
		label: "DeepSeek",
		defaultModel: "deepseek-chat",
		keyPlaceholder: "sk-...",
		keyUrl: "platform.deepseek.com",
		needsKey: true,
		fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
	},
	ollama: {
		label: "Ollama (local)",
		defaultModel: "qwen3:8b",
		keyPlaceholder: "",
		keyUrl: "ollama.com",
		needsKey: false,
		fallbackModels: [],
	},
};

export interface LLMConfig {
	provider: ProviderId;
	apiKey: string;
	model: string;
	/** Ollama server URL, e.g. http://localhost:11434 */
	baseUrl?: string;
}

export interface Question {
	node: string;
	question: string;
	difficulty: "easy" | "medium" | "hard";
	modelAnswer: string;
	acceptableAnswers: string[];
	commonErrors: { pattern: string; misconception: string }[];
	hints: { tier1: string; tier2: string; tier3: string };
	/** Canonical misconception tag this question deliberately re-probes, or "".
	 * Answering it correctly resolves that misconception. */
	targetsMisconception?: string;
	/** The concept this question tests, assigned by construction (not inferred).
	 * Drives concept-level scheduling. */
	conceptId?: string;
}

export type Verdict = "correct" | "partial" | "incorrect";

export interface Grade {
	verdict: Verdict;
	feedback: string;
	misconceptionTag: string;
}

/** Whether this provider and model can read image inputs. */
export function supportsVision(provider: ProviderId, model: string): boolean {
	switch (provider) {
		case "anthropic":
		case "gemini":
			return true;
		case "openai":
			return /^(gpt-4o|gpt-4\.1|gpt-5|chatgpt|o[0-9])/i.test(model);
		case "ollama":
			return /(llava|vision|-vl\b|moondream|bakllava|minicpm-v|gemma3|llama3\.2-vision|qwen2(\.5)?-?vl)/i.test(model);
		case "deepseek":
			return false;
	}
}

// ------------------------------------------------------------------ transport

interface HttpCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	extract: (json: unknown) => string | undefined;
}

interface ApiErrorBody {
	error?: { message?: string; status?: string };
}

function apiError(status: number, json: unknown, text: string): Error {
	const body = json as ApiErrorBody | null;
	const detail = body?.error?.message ?? body?.error?.status ?? text.slice(0, 200);
	return new Error(`API error ${status}${detail ? `: ${detail}` : ""}`);
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
	choices?: Array<{ message?: { content?: string } }>;
}
interface GeminiGenerateResponse {
	candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
interface OllamaChatResponse {
	message?: { content?: string };
}

function buildCall(
	cfg: LLMConfig,
	system: string,
	user: string,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[],
): HttpCall {
	switch (cfg.provider) {
		case "anthropic": {
			const content: unknown = images.length
				? [
						...images.map((im) => ({
							type: "image",
							source: { type: "base64", media_type: im.mediaType, data: im.dataBase64 },
						})),
						{ type: "text", text: user },
					]
				: user;
			return {
				url: "https://api.anthropic.com/v1/messages",
				headers: {
					"content-type": "application/json",
					"x-api-key": cfg.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: {
					model: cfg.model,
					max_tokens: maxTokens,
					system,
					messages: [{ role: "user", content }],
					output_config: { format: { type: "json_schema", schema } },
				},
				extract: (json) => {
					const j = json as AnthropicMessageResponse;
					if (j.stop_reason === "refusal") throw new Error("The model declined this request (safety refusal).");
					return j.content?.find((b) => b.type === "text")?.text;
				},
			};
		}
		case "openai": {
			const content: unknown = images.length
				? [
						{ type: "text", text: user },
						...images.map((im) => ({
							type: "image_url",
							image_url: { url: `data:${im.mediaType};base64,${im.dataBase64}` },
						})),
					]
				: user;
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
			// Reasoning models spend max_completion_tokens on thinking; keep it shallow.
			if (/^(gpt-5|o\d)/.test(cfg.model)) body.reasoning_effort = "low";
			return {
				url: "https://api.openai.com/v1/chat/completions",
				headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
				body,
				extract: (json) => (json as ChatCompletionResponse).choices?.[0]?.message?.content,
			};
		}
		case "gemini":
			return {
				url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`,
				headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
				body: {
					systemInstruction: { parts: [{ text: system }] },
					contents: [
						{
							role: "user",
							parts: [
								{ text: user },
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
			};
		case "ollama": {
			const userMessage: Record<string, unknown> = { role: "user", content: user };
			if (images.length) userMessage.images = images.map((im) => im.dataBase64);
			return {
				url: `${(cfg.baseUrl ?? "http://localhost:11434").replace(/\/$/, "")}/api/chat`,
				headers: { "content-type": "application/json" },
				body: {
					model: cfg.model,
					stream: false,
					messages: [{ role: "system", content: system }, userMessage],
					format: schema,
					options: { num_predict: maxTokens },
				},
				extract: (json) => (json as OllamaChatResponse).message?.content,
			};
		}
		case "deepseek":
			return {
				url: "https://api.deepseek.com/chat/completions",
				headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
				body: {
					model: cfg.model,
					max_tokens: maxTokens,
					messages: [
						{ role: "system", content: system },
						{
							role: "user",
							content:
								user +
								"\n\nRespond ONLY with a json object matching this JSON Schema exactly:\n" +
								JSON.stringify(schema),
						},
					],
					response_format: { type: "json_object" },
				},
				extract: (json) => (json as ChatCompletionResponse).choices?.[0]?.message?.content,
			};
	}
}

async function callJSON(
	cfg: LLMConfig,
	system: string,
	user: string,
	schema: Record<string, unknown>,
	maxTokens: number,
	images: ImageInput[] = [],
): Promise<unknown> {
	const call = buildCall(cfg, system, user, schema, maxTokens, images);
	const resp = await requestUrl({
		url: call.url,
		method: "POST",
		throw: false,
		headers: call.headers,
		body: JSON.stringify(call.body),
	});
	let json: unknown = null;
	try {
		json = resp.json as unknown;
	} catch {
		/* non-JSON error body */
	}
	if (resp.status >= 400) throw apiError(resp.status, json, resp.text);
	const text = call.extract(json);
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

/** Belt-and-suspenders: strip em/en dashes from model output regardless of prompt compliance. */
function cleanText(t: string): string {
	return t.replace(/\s*[—–]\s*/g, ", ");
}

interface AnthropicModelListResponse {
	data?: Array<{ id: string; capabilities?: { structured_outputs?: { supported?: boolean } } }>;
}
interface OpenAIModelListResponse {
	data?: Array<{ id: string }>;
}
interface GeminiModelListResponse {
	models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}
interface OllamaTagsResponse {
	models?: Array<{ name: string }>;
}

/** Fetch the live model list from a provider. Returns [] on any failure;
 * callers fall back to PROVIDERS[p].fallbackModels. */
export async function listModels(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<string[]> {
	try {
		switch (provider) {
			case "anthropic": {
				const r = await requestUrl({
					url: "https://api.anthropic.com/v1/models?limit=100",
					throw: false,
					headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
				});
				const anthropicModels = (r.json as AnthropicModelListResponse | undefined)?.data ?? [];
				return anthropicModels
					.filter((m) => m.capabilities?.structured_outputs?.supported !== false)
					.map((m) => m.id)
					.filter(Boolean);
			}
			case "openai": {
				const r = await requestUrl({
					url: "https://api.openai.com/v1/models",
					throw: false,
					headers: { authorization: `Bearer ${apiKey}` },
				});
				const bad = /(audio|realtime|tts|transcribe|whisper|image|embed|moderation|dall-e|davinci|babbage|search|computer-use|codex|chat-latest|gpt-3\.5|o1-mini|o1-preview)/;
				const openaiModels = (r.json as OpenAIModelListResponse | undefined)?.data ?? [];
				return openaiModels
					.map((m) => m.id)
					.filter((id) => /^(gpt-|o[0-9])/.test(id) && !bad.test(id))
					.sort()
					.reverse();
			}
			case "gemini": {
				const r = await requestUrl({
					url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
					throw: false,
					headers: { "x-goog-api-key": apiKey },
				});
				const geminiModels = (r.json as GeminiModelListResponse | undefined)?.models ?? [];
				return geminiModels
					.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
					.map((m) => (m.name ?? "").replace(/^models\//, ""))
					.filter((n) => n.startsWith("gemini") && !/(image|tts|live|audio|embedding|aqa|learnlm|thinking-exp)/.test(n));
			}
			case "deepseek": {
				const r = await requestUrl({
					url: "https://api.deepseek.com/models",
					throw: false,
					headers: { authorization: `Bearer ${apiKey}` },
				});
				const deepseekModels = (r.json as OpenAIModelListResponse | undefined)?.data ?? [];
				return deepseekModels.map((m) => m.id).filter(Boolean);
			}
			case "ollama": {
				const r = await requestUrl({
					url: `${(baseUrl ?? "http://localhost:11434").replace(/\/$/, "")}/api/tags`,
					throw: false,
				});
				const ollamaModels = (r.json as OllamaTagsResponse | undefined)?.models ?? [];
				return ollamaModels.map((m) => m.name).filter(Boolean);
			}
		}
	} catch {
		/* network/parse failure -> [] */
	}
	return [];
}

/** Cheap end-to-end check that a model is callable with schema output.
 * Returns null on success, or a human-readable error. */
export async function testModel(cfg: LLMConfig): Promise<string | null> {
	try {
		const out = (await callJSON(
			cfg,
			"You are a connectivity test. Follow the schema.",
			"Reply with ok set to true.",
			{
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
			600,
		)) as { ok?: boolean };
		return out && typeof out.ok === "boolean" ? null : "Model replied but not in the expected format";
	} catch (e) {
		return (e as Error).message;
	}
}

// ------------------------------------------------------------------ question generation

const TUTOR_SYSTEM = `You are a tutor running an active-recall session over a student's personal notes.

Targeting rules:
- You are given a specific list of CONCEPTS to test, one question each, in the given order. Write a question that tests exactly that concept, grounded in the student's notes.
- Aim for each concept's stated difficulty.
- When a concept is marked to re-probe a known confusion, deliberately write the question so that confusion would trip a student who still holds it.

Difficulty tiers:
- easy: recall and recognition. A student who read the note once should be able to answer.
- medium: application. Apply a concept to a straightforward scenario.
- hard: analysis and synthesis. Multi-step reasoning or a novel scenario. Still fair and answerable from the notes; never obscure trivia or trick questions.

Question craft:
- Answerable from the student's own notes, specific, and requiring genuine recall: never yes/no, never 'what does the note say'.
- Self-contained: the student sees only the question text. Inline any data the question needs.
- If a note contradicts your general knowledge, the note wins; ground questions in the note.
- Math is welcome: use $...$ or $$...$$ LaTeX where it helps.
- Use plain punctuation and never use em dashes.

Using note relationships:
- When a LINKS section is provided, treat it as prerequisite structure. For a 'hard' concept you may write a synthesis question that connects it to a linked note, provided both are grounded in the notes above and answerable from them.

Return exactly one question per concept, in the same order as the concept list. For every question also produce, in the same object:
- modelAnswer: the answer you would accept as fully correct, 1-3 sentences.
- acceptableAnswers: up to 3 short alternative phrasings that also count as correct.
- commonErrors: up to 3 likely wrong answers, each with a short 'pattern' (what the student might say) and a snake_case 'misconception' tag naming the underlying confusion.
- hints: tier1 a one-sentence conceptual nudge, tier2 the underlying concept, tier3 a partial step toward the answer. No tier may reveal the answer.
- targetsMisconception: if the concept was marked to re-probe a confusion, set this to that exact canonical tag. Otherwise set it to an empty string.`;

/** One concept the scheduler picked for this session; the LLM writes a question
 * for it. The concept id is assigned by construction, never inferred. */
export interface ConceptTarget {
	conceptId: string;
	note: string;
	label: string;
	context: string;
	targetDifficulty: "easy" | "medium" | "hard";
	/** Canonical misconception tag to deliberately re-probe, if any. */
	activeMisconception?: string;
}

function questionsSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			questions: {
				type: "array",
				items: {
					type: "object",
					properties: {
						n: { type: "integer" },
						question: { type: "string" },
						difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
						modelAnswer: { type: "string" },
						acceptableAnswers: { type: "array", items: { type: "string" } },
						commonErrors: {
							type: "array",
							items: {
								type: "object",
								properties: {
									pattern: { type: "string" },
									misconception: { type: "string" },
								},
								required: ["pattern", "misconception"],
								additionalProperties: false,
							},
						},
						hints: {
							type: "object",
							properties: {
								tier1: { type: "string" },
								tier2: { type: "string" },
								tier3: { type: "string" },
							},
							required: ["tier1", "tier2", "tier3"],
							additionalProperties: false,
						},
						targetsMisconception: { type: "string" },
					},
					required: [
						"n",
						"question",
						"difficulty",
						"modelAnswer",
						"acceptableAnswers",
						"commonErrors",
						"hints",
						"targetsMisconception",
					],
					additionalProperties: false,
				},
			},
		},
		required: ["questions"],
		additionalProperties: false,
	};
}

export async function generateQuestions(
	cfg: LLMConfig,
	notesText: string,
	targets: ConceptTarget[],
	images: ImageInput[] = [],
	instructions = "",
	linksBlock = "",
): Promise<Question[]> {
	const conceptList = targets
		.map((t, i) => {
			const reprobe = t.activeMisconception ? ` [re-probe confusion: ${t.activeMisconception}]` : "";
			return `${i + 1}. [note "${t.note}"] concept: "${t.label}" (aim: ${t.targetDifficulty})${reprobe}\n   source: ${t.context.slice(0, 500)}`;
		})
		.join("\n");
	const user =
		`Below are the student's notes for this session, for grounding.\n\n${notesText}\n\n` +
		(linksBlock ? `LINKS\n${linksBlock}\n\n` : "") +
		`Write exactly one recall question for each of these ${targets.length} concepts. ` +
		`In each question object set 'n' to the concept's number below. ` +
		`Test that specific concept, aim for its stated difficulty, and ground every question in the notes above.\n\n` +
		`CONCEPTS:\n${conceptList}` +
		(instructions
			? "\n\nThe student wrote these preferences for how they want to be quizzed. Honour them unless they " +
				"conflict with the rules above.\n" +
				`<preferences>\n${instructions}\n</preferences>`
			: "");
	type RawQ = Omit<Question, "node" | "conceptId"> & { n?: number };
	const data = (await callJSON(cfg, TUTOR_SYSTEM, user, questionsSchema(), 8000, images)) as { questions: RawQ[] };
	const raw = data.questions ?? [];
	const out: Question[] = [];
	const used = new Set<number>();
	for (let i = 0; i < raw.length; i++) {
		const q = raw[i];
		if (!q?.question) continue;
		// Map by the echoed concept number; fall back to position. This guards
		// against the model reordering questions vs the concept list, and dedups.
		let idx = typeof q.n === "number" && q.n >= 1 && q.n <= targets.length ? q.n - 1 : i;
		if (idx >= targets.length || used.has(idx)) idx = i;
		if (idx >= targets.length || used.has(idx)) continue;
		used.add(idx);
		const t = targets[idx];
		out.push({
			node: t.note,
			conceptId: t.conceptId,
			question: cleanText(q.question ?? ""),
			// Grade against the difficulty we asked for, not the model's self-report.
			difficulty: t.targetDifficulty,
			modelAnswer: cleanText(q.modelAnswer ?? ""),
			acceptableAnswers: q.acceptableAnswers ?? [],
			commonErrors: q.commonErrors ?? [],
			hints: {
				tier1: cleanText(q.hints?.tier1 ?? ""),
				tier2: cleanText(q.hints?.tier2 ?? ""),
				tier3: cleanText(q.hints?.tier3 ?? ""),
			},
			targetsMisconception: (q.targetsMisconception ?? "").trim() || (t.activeMisconception ?? ""),
		});
	}
	if (!out.length) throw new Error("Model returned no usable questions");
	return out;
}

// ------------------------------------------------------------------ grading

const GRADER_SYSTEM = `You grade a student's answer to a recall question about their own notes. Be generous on wording, strict on substance.

Verdict bands:
- More than 90% of the key idea demonstrated: verdict 'correct'.
- 60-90%: verdict 'correct' (note the minor gap in feedback).
- 40-60% (a near miss showing meaningful understanding): verdict 'partial'.
- Under 40%, off-topic, or a restated question: verdict 'incorrect'.

Citation before claim: before alleging a specific error, you must be able to point at the specific wrong step or value in the student's answer. If you cannot, do not claim it. Work that is actually correct end to end must be graded 'correct', never 'partial'.

Feedback: at most 2 lines and 30 words total. Line 1: what the answer got right or wrong. Line 2: the specific concept to review. No labels, no praise filler. Use plain punctuation and never use em dashes.

misconceptionTag: on 'partial' or 'incorrect', emit ONE snake_case tag naming the underlying confusion (reuse a provided commonErrors misconception when one matches, e.g. sign_error, reverses_directionality, unit_confusion, confuses_necessary_sufficient). On 'correct', emit an empty string.`;

const GRADE_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["correct", "partial", "incorrect"] },
		feedback: { type: "string" },
		misconceptionTag: { type: "string" },
	},
	required: ["verdict", "feedback", "misconceptionTag"],
	additionalProperties: false,
};

export async function gradeAnswer(
	cfg: LLMConfig,
	q: Question,
	noteText: string,
	answer: string,
	images: ImageInput[] = [],
	instructions = "",
): Promise<Grade> {
	const rubric = {
		modelAnswer: q.modelAnswer,
		acceptableAnswers: q.acceptableAnswers,
		commonErrors: q.commonErrors,
	};
	const user =
		`NOTE '${q.node}':\n${noteText}\n\nQUESTION: ${q.question}\n\n` +
		`GRADING RUBRIC (written with the question):\n${JSON.stringify(rubric, null, 1)}\n\n` +
		`STUDENT'S ANSWER: ${answer}\n\nGrade it.` +
		(instructions
			? "\n\nThe student wrote these study preferences. Apply any that affect grading (for example " +
				"strictness, or answer formats to accept such as bullet points); ignore any that are only about " +
				"how questions are worded. Never let them override the rubric's substance.\n" +
				`<preferences>\n${instructions}\n</preferences>`
			: "");
	const g = (await callJSON(cfg, GRADER_SYSTEM, user, GRADE_SCHEMA, 2000, images)) as Grade;
	const verdict: Verdict = g.verdict === "correct" || g.verdict === "partial" ? g.verdict : "incorrect";
	return {
		verdict,
		feedback: cleanText(g.feedback ?? ""),
		misconceptionTag: verdict === "correct" ? "" : (g.misconceptionTag ?? "").trim(),
	};
}

// ------------------------------------------------------------------ session debrief

const DEBRIEF_SYSTEM = `You are a study coach who just watched a student's active-recall session. Write a short, specific debrief, and where the session recorded misconceptions, map each to a canonical label so repeated confusions cluster over time.

Debrief rules:
- headline: one plain sentence naming the shape of the session, what is solid and what is shaky.
- strengths: notes the student clearly knows (graded correct). Empty if none.
- gaps: for each note missed or partial, name the specific concept to review and a one-line 'why', grounded in the transcript. Never generic.
- pattern: if one underlying confusion recurred across notes, name it in one sentence. Empty string if there is no clear single pattern.
- nextFocus: the notes to study next session, chosen only from the session's notes.
- Plain punctuation, never em dashes. Be specific; no praise filler.

Misconception canonicalization:
- You are given the raw misconception tags recorded this session and the student's existing canonical misconceptions.
- Output one assignment per recorded raw tag. Reuse an existing canonical tag and label when it names the same underlying confusion; otherwise propose a concise new snake_case canonTag and a short human-readable canonLabel.
- If no raw tags were recorded, return an empty assignments array.`;

function debriefSchema(noteNames: string[]): Record<string, unknown> {
	const noteEnum = { type: "string", enum: [...noteNames].sort() };
	return {
		type: "object",
		properties: {
			debrief: {
				type: "object",
				properties: {
					headline: { type: "string" },
					strengths: { type: "array", items: noteEnum },
					gaps: {
						type: "array",
						items: {
							type: "object",
							properties: { concept: { type: "string" }, note: noteEnum, why: { type: "string" } },
							required: ["concept", "note", "why"],
							additionalProperties: false,
						},
					},
					pattern: { type: "string" },
					nextFocus: { type: "array", items: noteEnum },
				},
				required: ["headline", "strengths", "gaps", "pattern", "nextFocus"],
				additionalProperties: false,
			},
			assignments: {
				type: "array",
				items: {
					type: "object",
					properties: {
						rawTag: { type: "string" },
						canonTag: { type: "string" },
						canonLabel: { type: "string" },
						note: noteEnum,
					},
					required: ["rawTag", "canonTag", "canonLabel", "note"],
					additionalProperties: false,
				},
			},
		},
		required: ["debrief", "assignments"],
		additionalProperties: false,
	};
}

export async function debriefSession(
	cfg: LLMConfig,
	transcript: string,
	noteNames: string[],
	existingCanon: { tag: string; label: string }[],
	rawTags: { note: string; tag: string }[],
): Promise<{ debrief: SessionDebrief; assignments: TagAssignment[] }> {
	const canonList = existingCanon.length
		? existingCanon.map((c) => `- ${c.tag}: "${c.label}"`).join("\n")
		: "none yet";
	const tagList = rawTags.length ? rawTags.map((t) => `- ${t.note} -> ${t.tag}`).join("\n") : "none";
	const user =
		`SESSION TRANSCRIPT:\n${transcript}\n\n` +
		`NOTES IN THIS SESSION: ${noteNames.join(", ")}\n\n` +
		`RAW MISCONCEPTION TAGS RECORDED THIS SESSION (note -> tag):\n${tagList}\n\n` +
		`EXISTING CANONICAL MISCONCEPTIONS (reuse these when a raw tag means the same thing):\n${canonList}`;
	const data = (await callJSON(cfg, DEBRIEF_SYSTEM, user, debriefSchema(noteNames), 2000)) as {
		debrief: SessionDebrief;
		assignments: TagAssignment[];
	};
	const d = data.debrief;
	return {
		debrief: {
			headline: cleanText(d?.headline ?? ""),
			strengths: d?.strengths ?? [],
			gaps: (d?.gaps ?? []).map((g) => ({ concept: g.concept, note: g.note, why: cleanText(g.why ?? "") })),
			pattern: cleanText(d?.pattern ?? ""),
			nextFocus: d?.nextFocus ?? [],
		},
		assignments: data?.assignments ?? [],
	};
}
