/** The model providers Grill can call: who they are, their defaults, what each can do,
 * and the config a call is made with. No requests here (see transport.ts). */

import type { ImageInput } from "./images";
import { cloudEnabled } from "./cloud";

export type ProviderId = "anthropic" | "openai" | "gemini" | "deepseek" | "ollama" | "custom" | "grillcloud";

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
		// Sonnet 5.5 (2026-09-28) replaces Sonnet 5 as the current Sonnet, same slot.
		defaultModel: "claude-sonnet-5-5",
		keyPlaceholder: "sk-ant-...",
		keyUrl: "console.anthropic.com",
		needsKey: true,
		fallbackModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"],
	},
	openai: {
		label: "OpenAI (ChatGPT)",
		// gpt-5-mini/gpt-5/gpt-4o are all past their replacement date on OpenAI's own
		// deprecation schedule (shutdown 2026-12-11, gpt-5-mini's listed successor is
		// gpt-5.6-terra) — the naming moved from size tiers (mini/nano) to codenames
		// (sol/terra/luna) for the 5.6 generation. Terra is the direct mini replacement:
		// balances intelligence and cost, same slot gpt-5-mini held.
		defaultModel: "gpt-5.6-terra",
		keyPlaceholder: "sk-...",
		keyUrl: "platform.openai.com",
		needsKey: true,
		fallbackModels: ["gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-luna"],
	},
	gemini: {
		label: "Google (Gemini)",
		// 3.8 Flash went GA 2026-09-02 and replaces 3.7 Flash as the current stable
		// fast model. gemini-2.5-flash is on Google's retirement path.
		defaultModel: "gemini-3.8-flash",
		keyPlaceholder: "AIza...",
		keyUrl: "aistudio.google.com",
		needsKey: true,
		fallbackModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-2.5-pro"],
	},
	deepseek: {
		label: "DeepSeek",
		// deepseek-flash is V4.1 Flash (2026-09-10). deepseek-v4-flash and deepseek-chat
		// are legacy names DeepSeek only "temporarily" routes to it.
		defaultModel: "deepseek-flash",
		keyPlaceholder: "sk-...",
		keyUrl: "platform.deepseek.com",
		needsKey: true,
		fallbackModels: ["deepseek-flash", "deepseek-v4-pro"],
	},
	ollama: {
		label: "Ollama (local)",
		defaultModel: "qwen3:8b",
		keyPlaceholder: "",
		keyUrl: "ollama.com",
		needsKey: false,
		fallbackModels: [],
	},
	custom: {
		label: "Custom (OpenAI-compatible)",
		defaultModel: "",
		keyPlaceholder: "sk-...",
		keyUrl: "",
		// Base URL is the binding requirement (enforced in llmConfig); a blank key
		// is allowed so local servers like LM Studio work without one.
		needsKey: false,
		fallbackModels: [],
	},
	grillcloud: {
		label: "Grill Cloud (no API key)",
		// The server picks the model; this name is only what the screen calls it.
		defaultModel: "Grill Cloud",
		keyPlaceholder: "grill_...",
		keyUrl: "",
		needsKey: true, // a Grill Cloud key, made on this device, not an API key
		fallbackModels: ["Grill Cloud"],
	},
};

/** The providers to offer in a picker. Grill Cloud only once it has somewhere to
 * talk to (see cloud.ts). */
export function offeredProviders(): Array<[ProviderId, ProviderInfo]> {
	return (Object.entries(PROVIDERS) as Array<[ProviderId, ProviderInfo]>).filter(
		([id]) => id !== "grillcloud" || cloudEnabled(),
	);
}

/** Every model a provider's default has ever been, before the current one. Settings
 * store the whole models map, so an install keeps whatever was the default when it
 * was set up. migrateLegacyModels moves exactly these onto the current default once;
 * any model the user picked themselves is left alone. Append on every default change. */
export const LEGACY_DEFAULTS: Partial<Record<ProviderId, string[]>> = {
	anthropic: ["claude-sonnet-5"],
	openai: ["gpt-5-mini"],
	gemini: ["gemini-2.5-flash", "gemini-3.7-flash"],
	deepseek: ["deepseek-chat", "deepseek-v4-flash"],
};

/** Move any provider still on a former shipped default to the current one. Returns
 * whether anything changed. Pure, so it's tested directly. */
export function migrateLegacyModels(models: Partial<Record<ProviderId, string>>): boolean {
	let changed = false;
	for (const [p, old] of Object.entries(LEGACY_DEFAULTS) as Array<[ProviderId, string[]]>) {
		const current = models[p];
		if (current && old.includes(current)) {
			models[p] = PROVIDERS[p].defaultModel;
			changed = true;
		}
	}
	return changed;
}

export interface LLMConfig {
	provider: ProviderId;
	apiKey: string;
	model: string;
	/** Ollama server URL, e.g. http://localhost:11434 */
	baseUrl?: string;
	/** Set when no model is set up and an agent program answers instead (agentjson.ts):
	 * each request goes to it whole, as one JSON answer, with no images. */
	agent?: (system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal, images: ImageInput[]) => Promise<unknown>;
	/** The agent program reads pictures sent with a request (Claude Code and Codex do). */
	agentImages?: boolean;
}

/** Whether this provider and model can read image inputs. */
/** Whether pictures sent with a request reach the model: an agent program that reads
 * them, or a model that does. */
export function readsImages(cfg: LLMConfig): boolean {
	return cfg.agent ? !!cfg.agentImages : supportsVision(cfg.provider, cfg.model);
}

export function supportsVision(provider: ProviderId, model: string): boolean {
	switch (provider) {
		case "anthropic":
		case "gemini":
		case "grillcloud": // the hosted model reads images
			return true;
		case "openai":
			return /^(gpt-4o|gpt-4\.1|gpt-[5-9]|chatgpt|o[0-9])/i.test(model);
		case "ollama":
			return /(llava|vision|-vl\b|moondream|bakllava|minicpm-v|gemma3|llama3\.2-vision|qwen2(\.5)?-?vl)/i.test(model);
		case "deepseek":
		case "custom":
			return false;
	}
}

/** Whether this provider has an embeddings endpoint at all — gates the semantic
 * bridge prefilter (bridges.ts's detectSemanticBridgeCandidates) before a call is
 * ever attempted. Anthropic has no first-party embeddings API (they point users at
 * a separate vendor); DeepSeek has none either. Coverage is real but uneven — the
 * settings UI (main.ts) states this plainly rather than implying it works for
 * every provider. */
export function supportsEmbeddings(provider: ProviderId): boolean {
	return provider === "openai" || provider === "gemini" || provider === "ollama" || provider === "custom";
}

/** What to call a provider in a sentence. */
export function who(provider: ProviderId): string {
	return provider === "custom" ? "Your endpoint" : PROVIDERS[provider].label.replace(/ \(.*$/, "");
}

/** Anthropic models that take `output_config.effort` (Claude 4.5+ Opus/Sonnet 5/Fable).
 * Haiku 4.5 and older Sonnets reject it, so it's only sent where it's accepted. */
export function anthropicTakesEffort(model: string): boolean {
	return /^claude-(opus-(4-[5-9]|5)|sonnet-5|fable)/.test(model);
}

/** Where each provider's API is. Ollama's is the user's own server (see ollamaUrl). */
export const API_BASE = {
	anthropic: "https://api.anthropic.com/v1",
	openai: "https://api.openai.com/v1",
	deepseek: "https://api.deepseek.com",
	gemini: "https://generativelanguage.googleapis.com/v1beta",
} as const;

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/** The Ollama server to call, without a trailing slash. */
export function ollamaUrl(baseUrl: string | undefined): string {
	return (baseUrl ?? OLLAMA_DEFAULT_URL).replace(/\/$/, "");
}

/** The headers every Anthropic request carries. */
export function anthropicAuth(apiKey: string): Record<string, string> {
	return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

/** An OpenAI reasoning model, which takes reasoning_effort. */
export function isOpenAIReasoning(model: string): boolean {
	return /^(gpt-[5-9]|o\d)/.test(model);
}

/** The stop reason that means a reply was cut off by its token budget, by API shape. */
export const CUT_OFF = { anthropic: "max_tokens", chat: "length", gemini: "MAX_TOKENS", ollama: "length" } as const;
