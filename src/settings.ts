/** Grill's settings: what each one is, its default, how it is read back from data.json,
 * and what Restore defaults keeps. */

import { examDay, type Exam } from "./exams";
import { isCloudKey } from "./cloud";
import { localEmbedModel } from "./embed-local";
import type { ColorMode, NumberMode } from "./mapview";
import { OLLAMA_DEFAULT_URL, PROVIDERS, type ProviderId } from "./providers";
import { DEFAULT_FOLDER } from "./recordpaths";
import { CLAUDE_MODEL_ALIASES, CLAUDE_MODELS } from "./selection";
import type { StudyIntensity } from "./settingstools";
import { readLegacyFlags, RERUN_ON_RESTORE } from "./migrations";

export interface GrillSettings {
	provider: ProviderId;
	apiKeys: Record<ProviderId, string>;
	models: Record<ProviderId, string>;
	ollamaUrl: string;
	/** Base URL for the custom OpenAI-compatible provider, e.g. https://openrouter.ai/api/v1 */
	customBaseUrl: string;
	questionsPerSession: number;
	/** Vault folder holding mastery.json and session notes. Lives in the Tuning block:
	 * "Grill" is right for essentially everyone, and moving it is a rename, not a
	 * preference. */
	folder: string;
	/** In-session progress bar. On, and no longer a control — hiding your own progress
	 * isn't a choice worth a row. Kept as a field so an install that turned it off
	 * stays off; the same applies to `linkSessions` and `sessionDebrief` below. */
	showProgress: boolean;
	/** Wiki-link session transcripts to the quizzed notes. On; see `showProgress`. */
	linkSessions: boolean;
	/** Write each studied note's record (status, due, last tested, confusions) into
	 * its own properties, for Bases views and other agents in the vault. Off: it
	 * edits the user's notes. See props.ts. */
	noteProperties: boolean;
	/** Vault folders to exclude from sessions (relative paths). */
	excludedFolders: string[];
	/** Folders that ARE Grill's study material + graph (relative paths). Empty = the
	 * whole vault. Chosen on first run; the universe of the learning graph. */
	includedFolders: string[];
	/** Folders with an exam date: their notes are scheduled to be ready by then (see
	 * exams.ts). Set in Settings, Study, Exams; empty means no exams. */
	exams: Exam[];
	/** Notes outside an exam: studied like one (the default, as before), or kept to
	 * remember what was read, on a gentler schedule (KEEP_RETENTION, KEEP_NEW_PER_DAY). */
	everythingElse: "study" | "keep";
	/** One-time flag: the first-run "what's Grill's" onboarding has been completed. */
	onboarded: boolean;
	/** Ids of point-of-use offers the user has turned down (see SessionView's
	 * renderOffers). Two of Grill's features are off until asked for, not because
	 * they're a matter of taste but because each downloads a model file the first time
	 * it runs — so the ask happens where the feature would have helped, once, instead of
	 * as a toggle in a settings page that assumes the reader already knows what image
	 * occlusion or embedding-ranked context is. Declining is remembered here. */
	dismissedOffers: string[];
	/** Grill Cloud keys this vault used before the current one, newest first. A key is
	 * a balance, so replacing one never throws the old one away. */
	retiredCloudKeys: string[];
	/** What this vault's last few Grill Cloud sessions cost, in credits, oldest first.
	 * Shown back as a receipt ("your last session used 11"), never sent anywhere. */
	cloudUsage: number[];
	/** What the credits ring measures against: the balance after the last top-up
	 * (`full`), and the balance last seen (`last`), by which a top-up is noticed. */
	cloudRing: { full: number; last: number };
	/** Account ids (hashes, never keys) of Grill Cloud keys deleted from this vault, so a
	 * stale copy on another device can't bring one back. */
	cloudGone: string[];
	/** Send embedded images to the model when it supports vision. No longer a control:
	 * the capability gate (supportsVision) is the whole decision, and a text-only model
	 * never receives them either way. Kept as a field so an install that deliberately
	 * turned it off stays off. Independent of image occlusion (`enableOcclusion` below):
	 * that runs local OCR, not a model call. */
	sendImages: boolean;
	/** Image occlusion: redact a legible region of a note-embedded image (found via
	 * local OCR, no AI key needed — see ocr.ts) and quiz on what's hidden there. Off
	 * until asked for, because the first run is a real (~10MB, one-time, cached) engine
	 * download; the asking happens at the end of a session whose own notes had diagrams
	 * (see view.ts's renderOffers), not as a settings toggle. Desktop-only for now (see
	 * view.ts's appendOcclusionConcepts). */
	enableOcclusion: boolean;
	/** Question formats: plain free-response only, or a mix that also includes
	 * multiple-choice and fill-in-the-blank. "Mixed" costs a bit more prompt (AI mode)
	 * per generation call, so it's a real toggle, not baked in unconditionally. */
	questionFormats: "write" | "mixed" | "mc";
	/** End-of-session AI debrief (one extra call per session). On; see `showProgress`.
	 * Off falls back to a deterministic summary. Ignored for no-key sessions (always
	 * deterministic). */
	sessionDebrief: boolean;
	/** Play short synthesized sound cues on each answer + at session end, with a
	 * confetti burst on a perfect session. On by default. */
	sounds: boolean;
	/** Offer the hints written with each question while it is being answered. Off: a
	 * test is a test, and help is asked for in words, which is recorded as help. */
	testHints: boolean;
	/** False for someone who came from the mode without AI (removed in 8.0) with a key
	 * saved, until they have said the model may be used: nothing of theirs is sent to a
	 * provider they had chosen not to use, just because the plugin was updated. */
	modelAgreed: boolean;
	/** What answers in Chat: the model chosen for questions and grading, or the Claude
	 * Code installed on this computer, which can read and change the vault. */
	chatEngine: "model" | "claudecode" | "codex" | "opencode";
	/** Where Claude Code is, when it isn't in one of the usual places. */
	claudePath: string;
	/** Which of Claude Code's models answers in Chat; "" leaves it to Claude Code. */
	claudeModel: string;
	/** Where Codex is, when it isn't in one of the usual places. */
	codexPath: string;
	codexModel: string;
	/** The offer to bring in questions asked in other AI chats has been answered. */
	importAsked: boolean;
	/** What another AI tool knows about the student, pasted by them. */
	aboutMe: string;
	/** Where opencode is, when it isn't Grill's own install or in one of the usual places. */
	opencodePath: string;
	/** Which of opencode's models answers in Chat, by its id; "" leaves it to opencode. */
	opencodeModel: string;
	/** Claude Code's permission level in Chat. */
	agentLevel: "safe" | "plan" | "auto";
	/** MCP servers for Chat on Grill Cloud or a key of one's own, as `.mcp.json` writes
	 * them. "" is none. Kept here only where Obsidian has no keychain: they can carry
	 * tokens, and this file travels with the vault (see `mcpConfig`). */
	mcpServers: string;
	/** Whether Chat on Grill Cloud or a key of one's own may load skills. */
	useSkills: boolean;
	/** Chat may find notes by meaning, with a small model run on this device. */
	searchByMeaning: boolean;
	/** Chat may read web pages, and search the web where the provider can. */
	useWeb: boolean;
	/** Read-aloud voice language: "" auto-detects per question from its text, an
	 * explicit code (e.g. "it") always uses that language regardless of the question. */
	ttsLanguage: string;
	/** Read-aloud voice: "" auto-picks the best-quality installed voice for the
	 * resolved language, a specific voiceURI always uses that exact voice. */
	ttsVoiceURI: string;
	/** Read aloud in a natural AI voice where one is to be had (Grill Cloud, or an
	 * OpenAI key), instead of the device's own. On unless switched off. Nothing is sent
	 * until a speaker button is pressed; then the text being read goes to the speech
	 * provider, which the privacy policy and the Start free panel both say. */
	naturalVoice: boolean;
	/** Missing-link finder: surface a "these two notes should be linked" question in
	 * AI sessions and offer to write the link. On, and no longer a control — it's a
	 * headline feature, and the semantic half of it now turns itself on wherever the
	 * configured provider has an embeddings API (see view.ts's appendBridgeTargets).
	 * Kept as a field so an install that deliberately turned it off stays off. How many show
	 * up isn't a count the student dials in — it's however many pairs the adjudicator
	 * confirms are genuinely related this session (see view.ts's appendBridgeTargets
	 * and BRIDGE_TARGET_CAP), naturally zero on a session with no real connections. */
	graphInsights: boolean;
	/** Rank a long note's content by on-device embedding similarity to its own concepts
	 * (see generate-local.ts's selectRelevantTextSemantic) instead of exact-substring
	 * matching, when deciding what survives into the AI prompt. Off by default: the
	 * lexical ranker it upgrades already works, and this one fetches a ~130MB
	 * model file from Hugging Face on first use. That download is worth asking about, so
	 * it is — at the end of a session that actually had to trim something (see view.ts's
	 * renderOffers), where the reader can see what it would have bought them. Falls
	 * straight back to the lexical ranker on any failure either way. */
	localEmbedContext: boolean;
	/** The model localEmbedContext was accepted for. An acceptance given for another
	 * model (the 25MB bge-micro-v2, before the 130MB multilingual one) is dropped on
	 * load, so the offer asks again with the new size. */
	localEmbedModel: string;
	/** What the graph's node colour encodes: the default 4-state mastery colour, or a
	 * green-to-red gradient over a continuous metric. */
	graphColorMode: ColorMode;
	/** Numeric grade overlay on graph nodes: off, or a display scale. */
	graphNumberMode: NumberMode;
	/** How much a note's grade score weighs coverage (how much of the note is
	 * confirmed) vs mastery (how well you'd currently recall the parts you've
	 * studied), 0-100. */
	graphCoverageWeight: number;
	/** FSRS "desired retention", as a percent (70-97): the recall probability the
	 * scheduler aims for at each concept's due date. Lower = shorter intervals =
	 * things come due more often = progress feels faster, at the cost of more
	 * reviews. Higher = longer intervals, fewer but higher-stakes reviews. */
	desiredRetention: number;
	/** This vault's own personalized FSRS-6 weights, fit by optimizer.ts from its
	 * logged review history (concepts.ts's `reviewLog`) instead of the library's
	 * pooled-population defaults — the way Anki's own optimizer personalizes per
	 * user. null = library defaults (also the state until there's enough review
	 * history to fit from — see MIN_REVIEWS_FOR_OPTIMIZATION). */
	fsrsPersonalization: {
		weights: number[];
		fitAt: string;
		reviewCount: number;
		/** Percent reduction in prediction loss vs the library defaults, on this
		 * vault's own data at fit time — shown so "personalized" isn't a black box. */
		improvementPct: number;
	} | null;
	/** How many trainable reviews existed the last time a fit was ATTEMPTED, successful
	 * or not. Distinct from `fsrsPersonalization.reviewCount`, which only records a fit
	 * that produced weights: a run that finds no improvement leaves that null, so without
	 * this the automatic pass would have no memory of having tried and would re-run a
	 * heavy optimization after every single session forever. 0 = never attempted. */
	fsrsLastFitAttemptReviews: number;
	/** Weekdays (0=Sunday..6=Saturday) fuzzInterval steers reviews AWAY from when an
	 * equally-uncrowded alternative day exists in its jitter window — "I don't want to
	 * study much on Sundays" without a hard cap that would just push the backlog
	 * elsewhere. Empty = no preference, matching every existing vault's behavior. */
	easyDays: number[];
	/** Cap on how many never-before-tested concepts a session will introduce per
	 * calendar day, independent of questionsPerSession (which governs one sitting, not
	 * the day). Once hit, sessions fill remaining slots from
	 * due/review material instead, so the due backlog can't balloon from unlimited
	 * new material outrunning how fast it can actually be reviewed. 0 = no cap. */
	newConceptsPerDay: number;
	/** Ceiling on new/untested material's share of ONE session (0-100%), whenever it's
	 * allowed to claim any room at all — see FreshContentPolicy in mastery.ts. Modeled on
	 * Anki's real v3 scheduler, not an arbitrary number: this is the analogue of Anki's
	 * new-card daily limit acting as a ceiling within whatever room the backlog leaves. */
	freshContentShare: number;
	/** Anki calls the equivalent toggle "New cards ignore review limit." Off (default,
	 * matching Anki's own default): a due/struggling backlog that already fills a session
	 * leaves no room for new material — reviews win, same as any real SRS tool when
	 * you're genuinely behind. On: new material always gets its full freshContentShare
	 * regardless of backlog size — this plugin's old, only, silent behavior, now an
	 * explicit opt-in instead of the default. */
	freshContentAlwaysGuarantee: boolean;
	/** Which preset the four scheduling numbers above (`desiredRetention`,
	 * `newConceptsPerDay`, `freshContentShare`, `freshContentAlwaysGuarantee`) currently
	 * express. The presets are the only thing the settings tab asks about; the raw
	 * numbers are still what every scheduling call site reads, so nothing downstream
	 * changes. "custom" means the numbers were hand-edited in the Tuning block and
	 * match no preset — it is never offered as a choice, only reflected back. */
	studyIntensity: StudyIntensity;
	/** Sorted basenames `warnOnDuplicateBasenames` last actually warned about, so the
	 * same unresolved duplicate list doesn't re-notify on every single plugin load —
	 * only a CHANGE in the duplicate set (a new collision, or an old one resolved)
	 * warns again. The underlying check stays on: this only silences repeating
	 * yourself, not the warning itself. */
	lastWarnedDuplicateBasenames: string[];
	/** The one-time upgrades that have run on this install (see migrations.ts). */
	migrated: string[];
}

/** How a setting is kept: its default, how a stored value is read (undefined keeps the
 * default), and whether Restore defaults keeps the user's value. Restore keeps
 * credentials, folders and one-time records, and resets preferences. */
interface Field<T> {
	default: () => T;
	read: (raw: unknown) => T | undefined;
	keep?: true;
}

const bool = (d: boolean, keep?: true): Field<boolean> => ({ default: () => d, read: (v) => (typeof v === "boolean" ? v : undefined), keep });
const num = (d: number, keep?: true): Field<number> => ({ default: () => d, read: (v) => (typeof v === "number" ? v : undefined), keep });
const text = (d = "", keep?: true): Field<string> => ({ default: () => d, read: (v) => (typeof v === "string" ? v : undefined), keep });
const oneOf = <T extends string>(d: T, values: readonly T[], keep?: true): Field<T> => ({
	default: () => d,
	read: (v) => (values.includes(v as T) ? (v as T) : undefined),
	keep,
});
const strings = (keep?: true): Field<string[]> => ({
	default: () => [],
	read: (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined),
	keep,
});
const keyed = (d: () => Record<ProviderId, string>): Field<Record<ProviderId, string>> => ({
	default: d,
	read: (v) => (v && typeof v === "object" ? { ...d(), ...(v as Record<ProviderId, string>) } : undefined),
	keep: true,
});

/** How many replaced Grill Cloud keys a vault keeps, in case one still has credits. */
export const RETIRED_KEYS_KEPT = 20;
/** How many deleted keys' ids are remembered. */
export const GONE_KEYS_KEPT = 50;
export const isAccountId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Every setting. The compiler holds this to GrillSettings: a field added there and not
 * here doesn't build. */
const SETTINGS: { [K in keyof GrillSettings]: Field<GrillSettings[K]> } = {
	provider: { default: () => "anthropic", read: (v) => (typeof v === "string" && v in PROVIDERS ? (v as ProviderId) : undefined), keep: true },
	apiKeys: keyed(() => ({ anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "", custom: "", grillcloud: "" })),
	models: keyed(() => Object.fromEntries((Object.keys(PROVIDERS) as ProviderId[]).map((p) => [p, PROVIDERS[p].defaultModel])) as Record<ProviderId, string>),
	ollamaUrl: { default: () => OLLAMA_DEFAULT_URL, read: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined), keep: true },
	customBaseUrl: { default: () => "", read: (v) => (typeof v === "string" ? v.trim() : undefined), keep: true },
	questionsPerSession: num(5),
	folder: { default: () => DEFAULT_FOLDER, read: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined), keep: true },
	showProgress: bool(true),
	linkSessions: bool(true),
	noteProperties: bool(false, true),
	excludedFolders: strings(true),
	includedFolders: strings(true),
	exams: {
		default: () => [],
		read: (v) =>
			Array.isArray(v)
				? (v as unknown[])
						.filter((e): e is { folders: unknown[]; date: string } => {
							const x = e as { folders?: unknown; date?: unknown } | null;
							return !!x && Array.isArray(x.folders) && typeof x.date === "string" && !!examDay(x.date);
						})
						.map((e): Exam => ({ folders: e.folders.filter((x): x is string => typeof x === "string"), date: e.date }))
						.filter((e) => e.folders.length)
				: undefined,
		keep: true,
	},
	everythingElse: oneOf("study", ["study", "keep"], true),
	onboarded: bool(false, true),
	dismissedOffers: strings(true),
	retiredCloudKeys: {
		default: () => [],
		read: (v) => (Array.isArray(v) ? v.filter((k) => typeof k === "string" && isCloudKey(k)).slice(0, RETIRED_KEYS_KEPT) : undefined),
		keep: true,
	},
	cloudUsage: {
		default: () => [],
		read: (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "number" && n > 0 && n < 100_000).slice(-10) : undefined),
		keep: true,
	},
	cloudRing: {
		default: () => ({ full: 0, last: 0 }),
		read: (v) => {
			const r = v as { full?: unknown; last?: unknown } | null;
			return r && typeof r.full === "number" && typeof r.last === "number" ? { full: Math.max(0, r.full), last: Math.max(0, r.last) } : undefined;
		},
		keep: true,
	},
	cloudGone: { default: () => [], read: (v) => (Array.isArray(v) ? v.filter(isAccountId).slice(-GONE_KEYS_KEPT) : undefined), keep: true },
	sendImages: bool(true),
	enableOcclusion: bool(false),
	questionFormats: oneOf("mixed", ["write", "mixed", "mc"]),
	sessionDebrief: bool(true),
	sounds: bool(true),
	testHints: bool(false),
	modelAgreed: bool(true, true),
	chatEngine: oneOf("model", ["model", "claudecode", "codex", "opencode"]),
	claudePath: text(),
	claudeModel: {
		default: () => "",
		read: (v) => {
			if (typeof v !== "string") return undefined;
			const id = CLAUDE_MODEL_ALIASES[v] ?? v;
			return CLAUDE_MODELS.some((m) => m.id === id) ? id : undefined;
		},
	},
	codexPath: text(),
	codexModel: text(),
	importAsked: bool(false),
	aboutMe: text(),
	opencodePath: text(),
	opencodeModel: text(),
	agentLevel: oneOf("safe", ["safe", "plan", "auto"]),
	mcpServers: text(),
	useSkills: bool(true),
	searchByMeaning: bool(false),
	useWeb: bool(true),
	ttsLanguage: text(),
	ttsVoiceURI: text(),
	// Only ever switched off: on is the default.
	naturalVoice: { default: () => true, read: (v) => (v === false ? false : undefined) },
	graphInsights: bool(true),
	// Read with localEmbedModel, below.
	localEmbedContext: bool(false),
	localEmbedModel: text(),
	graphColorMode: oneOf<ColorMode>("mastery", ["mastery", "recency", "dueness", "misconceptions"]),
	graphNumberMode: oneOf<NumberMode>("percent", ["off", "percent", "letter"]),
	graphCoverageWeight: num(15),
	desiredRetention: num(90),
	fsrsPersonalization: {
		default: () => null,
		read: (v) => {
			const p = v as GrillSettings["fsrsPersonalization"];
			return p && Array.isArray(p.weights) && p.weights.every((w) => typeof w === "number") && typeof p.fitAt === "string" ? p : undefined;
		},
	},
	fsrsLastFitAttemptReviews: num(0, true),
	easyDays: { default: () => [], read: (v) => (Array.isArray(v) ? v.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6) : undefined) },
	newConceptsPerDay: num(20),
	freshContentShare: num(30),
	freshContentAlwaysGuarantee: bool(false),
	studyIntensity: oneOf<StudyIntensity>("steady", ["relaxed", "steady", "intense", "custom"]),
	lastWarnedDuplicateBasenames: strings(),
	// Read with the flags older versions kept, below.
	migrated: strings(true),
};

export function defaultSettings(): GrillSettings {
	return Object.fromEntries(Object.entries(SETTINGS).map(([k, f]) => [k, f.default()])) as unknown as GrillSettings;
}

/** Settings as stored, read field by field over the defaults. What one field can't be
 * read as is its default; nothing else is lost. The one-time upgrades of stored values
 * run after this (see migrations in main.ts). */
export function readSettings(stored: Record<string, unknown>): GrillSettings {
	const settings = defaultSettings() as unknown as Record<string, unknown>;
	for (const [k, f] of Object.entries(SETTINGS) as Array<[string, Field<unknown>]>) {
		const v = f.read(stored[k]);
		if (v !== undefined) settings[k] = v;
	}
	const s = settings as unknown as GrillSettings;
	s.migrated = [...new Set([...s.migrated, ...readLegacyFlags(stored)])];
	// An acceptance given for another model is dropped, so the offer asks again.
	if (stored.localEmbedModel !== localEmbedModel() || typeof stored.localEmbedContext !== "boolean") {
		s.localEmbedContext = false;
		s.localEmbedModel = "";
	}
	return s;
}

/** The defaults, keeping what Restore keeps from `s`. The one-time records are among
 * what is kept: resetting one would run its upgrade again on the next load and undo a
 * choice made after Restore. */
export function restoredSettings(s: GrillSettings): GrillSettings {
	const out = defaultSettings() as unknown as Record<string, unknown>;
	for (const [k, f] of Object.entries(SETTINGS) as Array<[keyof GrillSettings, Field<unknown>]>) if (f.keep) out[k] = s[k];
	out.migrated = s.migrated.filter((id) => !(RERUN_ON_RESTORE as readonly string[]).includes(id));
	return out as unknown as GrillSettings;
}

/** The one way to change settings from a screen: the changes are written and saved
 * together. */
export interface SettingsHandle {
	get(): Readonly<GrillSettings>;
	update(patch: Partial<GrillSettings>): Promise<void>;
}
