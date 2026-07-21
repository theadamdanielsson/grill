/** Multi-provider LLM layer via Obsidian's requestUrl (native request, no CORS).
 *
 * Every provider is called with a JSON-schema-constrained request where the API
 * supports it (Anthropic output_config, OpenAI json_schema strict, Gemini
 * responseSchema); DeepSeek gets json_object mode + the schema in the prompt.
 */

import { requestUrl } from "obsidian";

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
}

export type Verdict = "correct" | "partial" | "incorrect";

export interface Grade {
	verdict: Verdict;
	feedback: string;
	misconceptionTag: string;
}

// ------------------------------------------------------------------ transport

interface HttpCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	extract: (json: any) => string | undefined;
}

function apiError(status: number, json: any, text: string): Error {
	const detail =
		json?.error?.message ?? json?.error?.status ?? (typeof text === "string" ? text.slice(0, 200) : "");
	return new Error(`API error ${status}${detail ? `: ${detail}` : ""}`);
}

/** Gemini's responseSchema is an OpenAPI-style subset: uppercase type enums,
 * no additionalProperties. Convert a JSON Schema recursively. */
function toGeminiSchema(schema: any): any {
	if (Array.isArray(schema)) return schema.map(toGeminiSchema);
	if (schema && typeof schema === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(schema)) {
			if (k === "additionalProperties") continue;
			if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
			else out[k] = toGeminiSchema(v);
		}
		return out;
	}
	return schema;
}

function buildCall(
	cfg: LLMConfig,
	system: string,
	user: string,
	schema: Record<string, unknown>,
	maxTokens: number,
): HttpCall {
	switch (cfg.provider) {
		case "anthropic":
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
					messages: [{ role: "user", content: user }],
					output_config: { format: { type: "json_schema", schema } },
				},
				extract: (j) => {
					if (j.stop_reason === "refusal") throw new Error("The model declined this request (safety refusal).");
					return j.content?.find((b: any) => b.type === "text")?.text;
				},
			};
		case "openai": {
			const body: Record<string, unknown> = {
				model: cfg.model,
				max_completion_tokens: maxTokens,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
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
				extract: (j) => j.choices?.[0]?.message?.content,
			};
		}
		case "gemini":
			return {
				url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`,
				headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
				body: {
					systemInstruction: { parts: [{ text: system }] },
					contents: [{ role: "user", parts: [{ text: user }] }],
					generationConfig: {
						maxOutputTokens: maxTokens,
						responseMimeType: "application/json",
						responseSchema: toGeminiSchema(schema),
					},
				},
				extract: (j) => j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join(""),
			};
		case "ollama":
			return {
				url: `${(cfg.baseUrl ?? "http://localhost:11434").replace(/\/$/, "")}/api/chat`,
				headers: { "content-type": "application/json" },
				body: {
					model: cfg.model,
					stream: false,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					format: schema,
					options: { num_predict: maxTokens },
				},
				extract: (j) => j.message?.content,
			};
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
				extract: (j) => j.choices?.[0]?.message?.content,
			};
	}
}

async function callJSON(
	cfg: LLMConfig,
	system: string,
	user: string,
	schema: Record<string, unknown>,
	maxTokens: number,
): Promise<unknown> {
	const call = buildCall(cfg, system, user, schema, maxTokens);
	const resp = await requestUrl({
		url: call.url,
		method: "POST",
		throw: false,
		headers: call.headers,
		body: JSON.stringify(call.body),
	});
	let json: any = null;
	try {
		json = resp.json;
	} catch {
		/* non-JSON error body */
	}
	if (resp.status >= 400) throw apiError(resp.status, json, resp.text);
	const text = call.extract(json);
	if (!text) throw new Error("Empty model response");
	try {
		return JSON.parse(text);
	} catch {
		// Some models wrap JSON in a code fence despite instructions.
		const m = text.match(/\{[\s\S]*\}/);
		if (m) return JSON.parse(m[0]);
		throw new Error("Model returned unparseable output");
	}
}

/** Belt-and-suspenders: strip em/en dashes from model output regardless of prompt compliance. */
function cleanText(t: string): string {
	return t.replace(/\s*[—–]\s*/g, ", ");
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
				return ((r.json?.data ?? []) as any[])
					.filter((m) => m?.capabilities?.structured_outputs?.supported !== false)
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
				return ((r.json?.data ?? []) as any[])
					.map((m) => m.id as string)
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
				return ((r.json?.models ?? []) as any[])
					.filter((m) => ((m.supportedGenerationMethods ?? []) as string[]).includes("generateContent"))
					.map((m) => ((m.name ?? "") as string).replace(/^models\//, ""))
					.filter((n) => n.startsWith("gemini") && !/(image|tts|live|audio|embedding|aqa|learnlm|thinking-exp)/.test(n));
			}
			case "deepseek": {
				const r = await requestUrl({
					url: "https://api.deepseek.com/models",
					throw: false,
					headers: { authorization: `Bearer ${apiKey}` },
				});
				return ((r.json?.data ?? []) as any[]).map((m) => m.id).filter(Boolean);
			}
			case "ollama": {
				const r = await requestUrl({
					url: `${(baseUrl ?? "http://localhost:11434").replace(/\/$/, "")}/api/tags`,
					throw: false,
				});
				return ((r.json?.models ?? []) as any[]).map((m) => m.name).filter(Boolean);
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
- Concentrate questions on material the student has NOT yet demonstrated they know (status 'untested' or 'struggling', or 'known' notes listed as due for review).
- Respect prerequisite order where the notes imply it: quiz foundations before material that builds on them.
- Each note's mastery entry includes 'target_difficulty'; match it. If it lists 'recurring_misconceptions', write a question that deliberately re-probes that exact confusion.

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

For every question also produce, in the same object:
- modelAnswer: the answer you would accept as fully correct, 1-3 sentences.
- acceptableAnswers: up to 3 short alternative phrasings that also count as correct.
- commonErrors: up to 3 likely wrong answers, each with a short 'pattern' (what the student might say) and a snake_case 'misconception' tag naming the underlying confusion.
- hints: tier1 a one-sentence conceptual nudge, tier2 the underlying concept, tier3 a partial step toward the answer. No tier may reveal the answer.`;

function questionsSchema(nodeNames: string[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			questions: {
				type: "array",
				items: {
					type: "object",
					properties: {
						node: { type: "string", enum: [...nodeNames].sort() },
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
					},
					required: ["node", "question", "difficulty", "modelAnswer", "acceptableAnswers", "commonErrors", "hints"],
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
	masteryBlock: string,
	nodeNames: string[],
	count: number,
): Promise<Question[]> {
	const user =
		`Below are the student's notes for this session.\n\n${notesText}\n\n` +
		`Per-note mastery state from all previous sessions:\n${masteryBlock}\n\n` +
		`Generate exactly ${count} recall questions. Each question targets exactly one note, named in 'node'.`;
	const data = (await callJSON(cfg, TUTOR_SYSTEM, user, questionsSchema(nodeNames), 8000)) as {
		questions: Question[];
	};
	const valid = new Set(nodeNames);
	const qs = (data.questions ?? []).filter((q) => valid.has(q.node));
	if (!qs.length) throw new Error("Model returned no usable questions");
	return qs.slice(0, count).map((q) => ({
		...q,
		question: cleanText(q.question ?? ""),
		modelAnswer: cleanText(q.modelAnswer ?? ""),
		acceptableAnswers: q.acceptableAnswers ?? [],
		commonErrors: q.commonErrors ?? [],
		hints: {
			tier1: cleanText(q.hints?.tier1 ?? ""),
			tier2: cleanText(q.hints?.tier2 ?? ""),
			tier3: cleanText(q.hints?.tier3 ?? ""),
		},
	}));
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

export async function gradeAnswer(cfg: LLMConfig, q: Question, noteText: string, answer: string): Promise<Grade> {
	const rubric = {
		modelAnswer: q.modelAnswer,
		acceptableAnswers: q.acceptableAnswers,
		commonErrors: q.commonErrors,
	};
	const user =
		`NOTE '${q.node}':\n${noteText}\n\nQUESTION: ${q.question}\n\n` +
		`GRADING RUBRIC (written with the question):\n${JSON.stringify(rubric, null, 1)}\n\n` +
		`STUDENT'S ANSWER: ${answer}\n\nGrade it.`;
	const g = (await callJSON(cfg, GRADER_SYSTEM, user, GRADE_SCHEMA, 2000)) as Grade;
	const verdict: Verdict = g.verdict === "correct" || g.verdict === "partial" ? g.verdict : "incorrect";
	return {
		verdict,
		feedback: cleanText(g.feedback ?? ""),
		misconceptionTag: verdict === "correct" ? "" : (g.misconceptionTag ?? "").trim(),
	};
}
