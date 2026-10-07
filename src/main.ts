import {
	App,
	Events,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	TFile,
	TFolder,
	WorkspaceLeaf,
	requestUrl,
} from "obsidian";
import { configureFSRSWeights, MasteryMap } from "./mastery";
import { CalPoint, isCalPoint } from "./calibration";
import { LLMConfig, offeredProviders, PROVIDERS, ProviderId, Question, listModels, migrateLegacyModels, synthesizeArc, testModel } from "./llm";
import { cloud, CLOUD_FACTS, CLOUD_PITCH, CloudPack, cloudAccount, cloudBalance, cloudSpeech, cloudCheckoutUrl, cloudDelete, cloudEnabled, cloudStart, creditsInWords, isCloudKey, newCloudKey, packLabel, usageInWords } from "./cloud";
import { ConceptMap, dueConceptCount, migrateResetScheduling, rebalanceDueDates, reconcileConcepts } from "./concepts";
import { pairKey } from "./bridges";
import {
	ACTIVE_DAYS_BETWEEN_ARCS,
	activeDayCount,
	Arc,
	ArcEntry,
	ARC_LOG_CAP,
	isArcEntry,
	logArcEntry,
	MIN_ACTIVE_DAYS_FOR_ARC,
	topMisconceptions,
} from "./debrief";
import { extractConcepts } from "./generate-local";
import { noteStudyText } from "./pdf";
import { terminateOcrWorker } from "./ocr";
import { countTrainableReviews, MIN_REVIEWS_FOR_OPTIMIZATION, optimizeFSRSWeights } from "./optimizer";
import { dueFiles, duplicateBasenames } from "./scope";
import { KeyStash, secretStore, vaultId } from "./secrets";
import { GrillStore } from "./store";
import { SessionView, VIEW_TYPE } from "./view";
import type { ColorMode, NumberMode } from "./mapview";
import { listLanguages, listVoices, listVoicesForLang, onVoicesChanged, speak, speakNatural } from "./tts";

/** How hard the schedule pushes, as one choice instead of four numbers. Each preset is a
 * complete set of the four FSRS/new-material values Grill actually schedules on; picking
 * one writes all four. "custom" is not offered in the picker — it's what the tab reports
 * back when the numbers were hand-edited in the Tuning block to something no preset
 * expresses, so a deliberate hand-tuning is never silently rounded to a preset. */
export type StudyIntensity = "relaxed" | "steady" | "intense" | "custom";

/** The four scheduling numbers each preset stands for. `desiredRetention` is FSRS's
 * target recall probability at the due date; the rest are the Anki-modeled new-material
 * policy (see FreshContentPolicy in mastery.ts). "steady" is the shipped default and is
 * value-identical to the defaults these four settings had as individual sliders, so an
 * untouched install maps onto it exactly and nobody's schedule moves. */
export const INTENSITY_PRESETS: Record<
	Exclude<StudyIntensity, "custom">,
	{ desiredRetention: number; newConceptsPerDay: number; freshContentShare: number; freshContentAlwaysGuarantee: boolean }
> = {
	relaxed: { desiredRetention: 85, newConceptsPerDay: 10, freshContentShare: 25, freshContentAlwaysGuarantee: false },
	steady: { desiredRetention: 90, newConceptsPerDay: 20, freshContentShare: 30, freshContentAlwaysGuarantee: false },
	intense: { desiredRetention: 95, newConceptsPerDay: 40, freshContentShare: 40, freshContentAlwaysGuarantee: true },
};

/** Which preset (if any) a stored set of the four numbers exactly expresses. Exact match
 * only, deliberately: a near-miss is a hand-tuning, and rounding it to the nearest preset
 * would change someone's schedule behind their back on upgrade. */
function intensityOf(s: {
	desiredRetention: number;
	newConceptsPerDay: number;
	freshContentShare: number;
	freshContentAlwaysGuarantee: boolean;
}): StudyIntensity {
	for (const [name, p] of Object.entries(INTENSITY_PRESETS) as [Exclude<StudyIntensity, "custom">, (typeof INTENSITY_PRESETS)["steady"]][]) {
		if (
			s.desiredRetention === p.desiredRetention &&
			s.newConceptsPerDay === p.newConceptsPerDay &&
			s.freshContentShare === p.freshContentShare &&
			s.freshContentAlwaysGuarantee === p.freshContentAlwaysGuarantee
		)
			return name;
	}
	return "custom";
}

interface GrillSettings {
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
	/** Vault folders to exclude from sessions (relative paths). */
	excludedFolders: string[];
	/** Folders that ARE Grill's study material + graph (relative paths). Empty = the
	 * whole vault. Chosen on first run; the universe of the learning graph. */
	includedFolders: string[];
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
	/** Where questions come from: an LLM, or the note's own structure (no key). */
	questionSource: "ai" | "local";
	/** How answers are graded: an LLM, or the user grades themselves (no key). */
	gradingMode: "ai" | "self";
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
	 * lexical ranker it upgrades already works, and this one fetches a small (~25MB)
	 * model file from Hugging Face on first use. That download is worth asking about, so
	 * it is — at the end of a session that actually had to trim something (see view.ts's
	 * renderOffers), where the reader can see what it would have bought them. Falls
	 * straight back to the lexical ranker on any failure either way. */
	localEmbedContext: boolean;
	/** One-time flag: the note→concept scheduling reset has run. */
	conceptsMigrated: boolean;
	/** One-time flag: legacy installs have had their stored old shipped defaults
	 * (graphNumberMode "off", newConceptsPerDay 0) carried to the current defaults.
	 * Guards the migration so it fires exactly once — after it, the user can freely
	 * pick "off" / 0 again without being re-flipped on the next launch. */
	legacyDefaultsMigrated: boolean;
	/** One-time flag: installs where `newConceptsPerDay` was 0 have had it carried to
	 * the shipped default once, the same protective one-shot as legacyDefaultsMigrated
	 * above but for a later semantic change — 0 used to mean "no daily cap" (unlimited
	 * new material every "Get grilled"); it now means what it reads as, zero new
	 * concepts ever, so an untouched 0 needs carrying forward or those installs go
	 * silently from unlimited to none. After this fires once, 0 sticks as a deliberate
	 * choice. */
	newConceptsCapMigrated: boolean;
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
	/** One-time flag: the four raw scheduling numbers above have been mapped onto a
	 * `studyIntensity` preset (or onto "custom" when they match none). Guards the
	 * mapping so it fires exactly once — after it, the preset is whatever the user
	 * last chose, and hand-edited numbers keep reading as "custom". */
	intensityMigrated: boolean;
	/** One-time flag (6.1.0): stored models that are former shipped defaults were
	 * moved to the current defaults (see migrateLegacyModels). */
	modelsMigrated61: boolean;
	modelsMigrated62: boolean;
	/** Sorted basenames `warnOnDuplicateBasenames` last actually warned about, so the
	 * same unresolved duplicate list doesn't re-notify on every single plugin load —
	 * only a CHANGE in the duplicate set (a new collision, or an old one resolved)
	 * warns again. The underlying check stays on: this only silences repeating
	 * yourself, not the warning itself. */
	lastWarnedDuplicateBasenames: string[];
	/** One-time flag: has this vault's arcLog been seeded from its existing session
	 * history yet (see GrillStore.backfillArcLog)? Sticks after the first launch so
	 * a vault with genuinely no session history yet (arcLog legitimately empty)
	 * doesn't get rescanned on every subsequent launch. */
	arcBackfilled: boolean;
}

interface PluginData {
	settings: GrillSettings;
	/** Rolling metacognitive-calibration buffer (confidence vs outcome). */
	calibration: CalPoint[];
	/** Recent session headlines, one per active day (see ArcEntry, logArcEntry).
	 * Doubles as the active-day counter maybeSynthesizeArc gates on. */
	arcLog: ArcEntry[];
	/** Last synthesized arc, plus the active-day count it was generated at, so
	 * maybeSynthesizeArc knows how much new evidence has accumulated since. Null
	 * until the vault has MIN_ACTIVE_DAYS_FOR_ARC of history. */
	arc: { data: Arc; atActiveDays: number } | null;
}

function defaultSettings(): GrillSettings {
	return {
		provider: "anthropic",
		apiKeys: { anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "", custom: "", grillcloud: "" },
		models: Object.fromEntries(
			(Object.keys(PROVIDERS) as ProviderId[]).map((p) => [p, PROVIDERS[p].defaultModel]),
		) as Record<ProviderId, string>,
		ollamaUrl: "http://localhost:11434",
		customBaseUrl: "",
		questionsPerSession: 5,
		folder: "Grill",
		showProgress: true,
		linkSessions: true,
		excludedFolders: [],
		includedFolders: [],
		onboarded: false,
		dismissedOffers: [],
		retiredCloudKeys: [],
		cloudUsage: [],
		cloudGone: [],
		sendImages: true,
		enableOcclusion: false,
		questionSource: "ai",
		gradingMode: "ai",
		questionFormats: "mixed",
		sessionDebrief: true,
		sounds: true,
		ttsLanguage: "",
		ttsVoiceURI: "",
		naturalVoice: true,
		graphInsights: true,
		localEmbedContext: false,
		conceptsMigrated: false,
		graphColorMode: "mastery",
		graphNumberMode: "percent",
		graphCoverageWeight: 15,
		desiredRetention: 90,
		fsrsPersonalization: null,
		fsrsLastFitAttemptReviews: 0,
		easyDays: [],
		newConceptsPerDay: 20,
		freshContentShare: 30,
		freshContentAlwaysGuarantee: false,
		legacyDefaultsMigrated: false,
		newConceptsCapMigrated: false,
		studyIntensity: "steady",
		intensityMigrated: false,
		modelsMigrated61: false,
		modelsMigrated62: false,
		lastWarnedDuplicateBasenames: [],
		arcBackfilled: false,
	};
}

export default class GrillPlugin extends Plugin {
	data: PluginData = { settings: defaultSettings(), calibration: [], arcLog: [], arc: null };
	store!: GrillStore;
	/** In-memory mastery cache; source of truth is <folder>/mastery.json. */
	mastery: MasteryMap = {};
	/** In-memory concept-schedule cache; source of truth is <folder>/concepts.json.
	 * SessionView points this at its own (freshly loaded) map when a session starts,
	 * so in-session rating updates stay visible here without a separate re-sync. */
	concepts: ConceptMap = {};
	/** Per-file debounce timers for `onModify`'s concept refresh, so rapid-fire
	 * autosave/keystroke "modify" events during active editing collapse into one
	 * re-extraction after editing actually pauses, not one per event. */
	private modifyTimers = new Map<string, number>();

	/** Moves API keys between memory, Obsidian's keychain and data.json. */
	keys = new KeyStash(null, "");

	async onload(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		const settings = defaultSettings();
		const s: Partial<GrillSettings> = stored?.settings ?? {};
		if (s.provider && s.provider in PROVIDERS) settings.provider = s.provider;
		if (s.apiKeys) settings.apiKeys = { ...settings.apiKeys, ...s.apiKeys };
		// Keys still sitting in data.json (every install from before 6.2) move to
		// Obsidian's keychain on the persist() further down; from then on they're
		// read back from there. See secrets.ts.
		const keysInData = (Object.keys(settings.apiKeys) as ProviderId[]).some((p) => p !== "grillcloud" && settings.apiKeys[p]);
		cloud.onCredits = (credits) => {
			this.cloudCredits = credits;
			// Credits spent while a purchase is being waited for lower the number the
			// purchase is measured from, so "1000 added" stays 1000.
			if (this.cloudWaitingFrom !== null && credits < this.cloudWaitingFrom) this.cloudWaitingFrom = credits;
		};
		// What the session under way has used: the server says what each reply cost. (The
		// balance can't tell: other requests in flight are held against it.)
		cloud.onCost = (cost) => {
			this.cloudSessionSpent += cost;
		};
		this.keys = new KeyStash(secretStore(this.app), vaultId(this.app));
		settings.apiKeys = this.keys.load(settings.apiKeys);
		if (s.models) settings.models = { ...settings.models, ...s.models };
		if (typeof s.ollamaUrl === "string" && s.ollamaUrl.trim()) settings.ollamaUrl = s.ollamaUrl.trim();
		if (typeof s.customBaseUrl === "string") settings.customBaseUrl = s.customBaseUrl.trim();
		if (typeof s.questionsPerSession === "number") settings.questionsPerSession = s.questionsPerSession;
		if (typeof s.folder === "string" && s.folder.trim()) settings.folder = s.folder.trim();
		if (typeof s.showProgress === "boolean") settings.showProgress = s.showProgress;
		if (typeof s.linkSessions === "boolean") settings.linkSessions = s.linkSessions;
		if (Array.isArray(s.excludedFolders))
			settings.excludedFolders = s.excludedFolders.filter((v): v is string => typeof v === "string");
		if (Array.isArray(s.includedFolders))
			settings.includedFolders = s.includedFolders.filter((v): v is string => typeof v === "string");
		if (typeof s.onboarded === "boolean") settings.onboarded = s.onboarded;
		if (Array.isArray(s.cloudGone)) settings.cloudGone = s.cloudGone.filter(isAccountId).slice(-GONE_KEYS_KEPT);
		if (Array.isArray(s.cloudUsage)) settings.cloudUsage = s.cloudUsage.filter((n) => typeof n === "number" && n > 0 && n < 100_000).slice(-10);
		if (Array.isArray(s.retiredCloudKeys)) settings.retiredCloudKeys = s.retiredCloudKeys.filter((k) => typeof k === "string" && isCloudKey(k)).slice(0, RETIRED_KEYS_KEPT);
		if (Array.isArray(s.dismissedOffers))
			settings.dismissedOffers = s.dismissedOffers.filter((v): v is string => typeof v === "string");
		if (typeof s.sendImages === "boolean") settings.sendImages = s.sendImages;
		if (typeof s.enableOcclusion === "boolean") settings.enableOcclusion = s.enableOcclusion;
		if (s.questionSource === "ai" || s.questionSource === "local") settings.questionSource = s.questionSource;
		if (s.gradingMode === "ai" || s.gradingMode === "self") settings.gradingMode = s.gradingMode;
		if (s.questionFormats === "write" || s.questionFormats === "mixed" || s.questionFormats === "mc") settings.questionFormats = s.questionFormats;
		if (typeof s.sessionDebrief === "boolean") settings.sessionDebrief = s.sessionDebrief;
		if (typeof s.sounds === "boolean") settings.sounds = s.sounds;
		if (typeof s.ttsLanguage === "string") settings.ttsLanguage = s.ttsLanguage;
		if (typeof s.ttsVoiceURI === "string") settings.ttsVoiceURI = s.ttsVoiceURI;
		if (s.naturalVoice === false) settings.naturalVoice = false;
		if (typeof s.graphInsights === "boolean") settings.graphInsights = s.graphInsights;
		if (typeof s.localEmbedContext === "boolean") settings.localEmbedContext = s.localEmbedContext;
		if (typeof s.conceptsMigrated === "boolean") settings.conceptsMigrated = s.conceptsMigrated;
		if (["mastery", "recency", "dueness", "misconceptions"].includes(s.graphColorMode as string)) {
			settings.graphColorMode = s.graphColorMode as ColorMode;
		}
		if (["off", "percent", "letter"].includes(s.graphNumberMode as string)) {
			settings.graphNumberMode = s.graphNumberMode as NumberMode;
		}
		if (typeof s.graphCoverageWeight === "number") settings.graphCoverageWeight = s.graphCoverageWeight;
		// One-time migration: 60 was the only default this setting ever shipped with,
		// before the mastery model rewrite (graph.ts) dropped the shipped default to 15
		// — the old figure was tuned around a lifetime-accuracy score that doesn't exist
		// anymore. A stored 60 is essentially never a deliberate choice on a 0-100
		// slider; carry untouched installs to the new default instead of leaving them
		// stuck weighting coverage 4x heavier than intended against the new score.
		if (s.graphCoverageWeight === 60) settings.graphCoverageWeight = 15;
		if (typeof s.desiredRetention === "number") settings.desiredRetention = s.desiredRetention;
		if (
			s.fsrsPersonalization &&
			Array.isArray(s.fsrsPersonalization.weights) &&
			s.fsrsPersonalization.weights.every((w) => typeof w === "number") &&
			typeof s.fsrsPersonalization.fitAt === "string"
		) {
			settings.fsrsPersonalization = s.fsrsPersonalization;
		}
		if (typeof s.fsrsLastFitAttemptReviews === "number") settings.fsrsLastFitAttemptReviews = s.fsrsLastFitAttemptReviews;
		if (Array.isArray(s.easyDays)) {
			settings.easyDays = s.easyDays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6);
		}
		if (typeof s.newConceptsPerDay === "number") settings.newConceptsPerDay = s.newConceptsPerDay;
		if (typeof s.freshContentShare === "number") settings.freshContentShare = s.freshContentShare;
		if (typeof s.freshContentAlwaysGuarantee === "boolean") settings.freshContentAlwaysGuarantee = s.freshContentAlwaysGuarantee;
		if (typeof s.legacyDefaultsMigrated === "boolean") settings.legacyDefaultsMigrated = s.legacyDefaultsMigrated;
		if (typeof s.newConceptsCapMigrated === "boolean") settings.newConceptsCapMigrated = s.newConceptsCapMigrated;
		if (s.studyIntensity === "relaxed" || s.studyIntensity === "steady" || s.studyIntensity === "intense" || s.studyIntensity === "custom")
			settings.studyIntensity = s.studyIntensity;
		if (typeof s.intensityMigrated === "boolean") settings.intensityMigrated = s.intensityMigrated;
		if (typeof s.modelsMigrated61 === "boolean") settings.modelsMigrated61 = s.modelsMigrated61;
		if (typeof s.modelsMigrated62 === "boolean") settings.modelsMigrated62 = s.modelsMigrated62;
		if (Array.isArray(s.lastWarnedDuplicateBasenames)) {
			settings.lastWarnedDuplicateBasenames = s.lastWarnedDuplicateBasenames.filter((v): v is string => typeof v === "string");
		}
		if (typeof s.arcBackfilled === "boolean") settings.arcBackfilled = s.arcBackfilled;
		// One-time upgrade for legacy installs. persist() writes the whole settings
		// object, so an existing user has the old shipped defaults saved to disk —
		// changing defaultSettings() alone never reaches them. Carry the two changed
		// defaults across exactly once (percentages visible on the graph; a sane
		// new-concepts cap), then set the flag so a deliberate later choice of "off" or
		// 0 sticks instead of being re-flipped every launch. Fresh installs already hold
		// the new defaults, so this is a no-op for them beyond setting the flag.
		if (!settings.legacyDefaultsMigrated) {
			if (settings.graphNumberMode === "off") settings.graphNumberMode = "percent";
			if (settings.newConceptsPerDay === 0) settings.newConceptsPerDay = 20;
			settings.legacyDefaultsMigrated = true;
		}
		// A second, later one-shot: 0 stopped meaning "no daily cap" (unlimited new
		// material in "Get grilled") and started meaning what it reads as, zero, ever.
		// legacyDefaultsMigrated already fired for existing installs before this change
		// existed, so it won't catch them — this carries an untouched 0 forward to the
		// shipped default exactly once, same as above, so nobody upgrades straight from
		// "unlimited" to "none" with no signal. A deliberate 0 chosen after this sticks.
		// Not redundant with the block above, despite applying the same coercion: installs
		// that upgraded BEFORE this second change already hold legacyDefaultsMigrated
		// true, so only a separate flag can still reach them. Both firing on the same
		// load (a fresh install) is a harmless no-op, not a duplicate.
		if (!settings.newConceptsCapMigrated) {
			if (settings.newConceptsPerDay === 0) settings.newConceptsPerDay = 20;
			settings.newConceptsCapMigrated = true;
		}
		// Read the four scheduling numbers (post-migration, so the coercions above are
		// reflected) back into the preset the settings tab now asks about. Exact match or
		// "custom" — an install that hand-tuned any of them keeps its exact numbers and
		// simply reads as Custom, so upgrading to the preset picker never reschedules
		// anyone. Runs once; after this the preset is whatever was last chosen.
		if (!settings.intensityMigrated) {
			settings.studyIntensity = intensityOf(settings);
			settings.intensityMigrated = true;
		}
		// persist() writes the whole models map, so every install still holds the model
		// that was the default when it was set up (gpt-5-mini shuts down 2026-12-11).
		// Move former defaults to the current ones once; a hand-picked model is kept.
		if (!settings.modelsMigrated61) {
			migrateLegacyModels(settings.models);
			settings.modelsMigrated61 = true;
		}
		// Same move for the default that changed in 6.2 (claude-sonnet-5). A separate
		// flag because modelsMigrated61 is already true on every install that ran 6.1.
		if (!settings.modelsMigrated62) {
			migrateLegacyModels(settings.models);
			settings.modelsMigrated62 = true;
		}
		const calibration = Array.isArray(stored?.calibration) ? stored.calibration.filter(isCalPoint) : [];
		const arcLog = Array.isArray(stored?.arcLog) ? stored.arcLog.filter(isArcEntry) : [];
		const storedArc = stored?.arc;
		const arc =
			storedArc && typeof storedArc.atActiveDays === "number" && storedArc.data && typeof storedArc.data.headline === "string"
				? storedArc
				: null;
		this.data = { settings, calibration, arcLog, arc };
		// A Grill Cloud key this device kept but the settings file lost (see
		// restoreCloudKey), or one Grill 6.2.0 moved into the keychain: write it back.
		if ((await this.restoreCloudKey()) || this.keys.rescued) {
			try {
				await this.persist();
				this.keys.dropUnkept();
			} catch (e) {
				console.error("Grill: couldn't save settings while restoring the Grill Cloud key", e);
			}
		}
		// Moving a key is not worth failing to load over: it's retried on every save.
		if (keysInData && this.keys.available) {
			try {
				await this.persist();
			} catch (e) {
				console.error("Grill: couldn't save settings while moving the API key", e);
			}
		}
		// A key edited or deleted on Obsidian's own Keychain page takes effect without
		// a reload.
		const keychain = secretStore(this.app) as (Partial<Events> & object) | null;
		if (keychain && typeof keychain.on === "function") {
			this.registerEvent(
				keychain.on("changed", () => {
					if (this.keys.adopt(this.data.settings.apiKeys)) void this.persist();
				}),
			);
		}
		configureFSRSWeights(settings.fsrsPersonalization?.weights ?? null);

		this.store = new GrillStore(this.app, () => this.data.settings.folder);

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new SessionView(leaf, this));
		this.addRibbonIcon("flame", "Grill", () => void this.activateView());
		this.addCommand({
			id: "start-session",
			name: "Start session",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "review-due",
			name: "Review due notes",
			callback: () => void this.startDueSession(),
		});
		this.addCommand({
			id: "open-dashboard",
			name: "Open progress dashboard",
			callback: () => void this.openDashboard(),
		});
		this.addCommand({
			id: "current-note",
			name: "Study the current note",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.startScoped([f]);
				return true;
			},
		});
		this.addCommand({
			id: "show-setup",
			name: "Show setup again",
			callback: async () => {
				// The same three steps as first run: the way to change how questions get
				// written (Grill Cloud, a key of your own, offline) without hunting in settings.
				await this.activateView();
				const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
				if (view instanceof SessionView) view.showOnboarding();
			},
		});
		this.addCommand({
			id: "open-instructions",
			name: "Open persona & instructions",
			callback: () => void this.openInstructions(),
		});
		this.addCommand({
			id: "optimize-fsrs-parameters",
			name: "Optimize FSRS parameters from your review history",
			callback: () => void this.optimizeFsrsParameters(),
		});
		this.addCommand({
			id: "rebalance-due-dates",
			name: "Rebalance upcoming due dates",
			callback: () => void this.rebalanceSchedule(),
		});
		this.addCommand({
			id: "clear-question-cache",
			name: "Clear cached questions",
			callback: () => void this.clearQuestionCache(),
		});
		this.addCommand({
			id: "export-review-log",
			name: "Export review log as CSV",
			callback: () => void this.exportReviewLog(),
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((i) =>
						i
							.setTitle("Grill this note")
							.setIcon("flame")
							.onClick(() => void this.startScoped([file])),
					);
				} else if (file instanceof TFolder) {
					menu.addItem((i) =>
						i
							.setTitle("Grill this folder")
							.setIcon("flame")
							.onClick(() => {
								const files = this.app.vault
									.getMarkdownFiles()
									.filter((f) => f.path.startsWith(file.path + "/"));
								if (files.length) void this.startScoped(files);
								else new Notice("Grill: no markdown notes in this folder.");
							}),
					);
				}
			}),
		);
		// Multi-selection in the file explorer (shift/cmd-click several notes and/or
		// folders, then right-click) gets its own event, separate from single-file-menu.
		this.registerEvent(
			this.app.workspace.on("files-menu", (menu, files) => {
				const notes = new Map<string, TFile>();
				for (const f of files) {
					if (f instanceof TFile && f.extension === "md") notes.set(f.path, f);
					else if (f instanceof TFolder) {
						for (const md of this.app.vault.getMarkdownFiles()) {
							if (md.path.startsWith(f.path + "/")) notes.set(md.path, md);
						}
					}
				}
				if (!notes.size) return;
				menu.addItem((i) =>
					i
						.setTitle(`Grill these ${notes.size} note${notes.size === 1 ? "" : "s"}`)
						.setIcon("flame")
						.onClick(() => void this.startScoped([...notes.values()])),
				);
			}),
		);
		// Keeps the status bar's due-count honest between sessions, not just after one
		// runs. Evaluated against a full Dataview-style incremental vault index and
		// deliberately scoped down from it: concept extraction is cheap local regex
		// parsing (not Dataview's arbitrary live queries over a whole vault), so there's
		// no case for indexing every note continuously — only the ONE file just edited
		// needs re-extracting, and only to keep the ambient due-count from going stale
		// while you edit a note without starting a session. Debounced per file so
		// active typing (repeated autosave "modify" events) settles before re-parsing.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md" && !this.isExcluded(file.path)) {
					this.scheduleConceptRefresh(file);
				}
			}),
		);
		// A folder move alone leaves the basename unchanged, and everything Grill
		// keys on is the basename — the dashboard's folder-coverage grouping
		// re-resolves live off the current file list on every render, so a pure
		// move needs no migration at all. An actual rename does change the key
		// mastery.json/concepts.json/misconceptions.json all reference, and without
		// this they'd stay attributed to the old, now-nonexistent name until
		// something happened to re-touch the note — a real, possibly long-lived
		// staleness, not just a cosmetic one.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
				if (oldName === file.basename) return;
				// Grill keys history by basename: if another note still carries the old
				// name, that history is (at least partly) its, so leave it where it is.
				if (this.basenameInUse(oldName)) return;
				void this.withViewsSynced(() => this.renameTrackedNote(oldName, file.basename));
			}),
		);
		// A genuine delete (not a rename): every store's records for this basename
		// are pruned outright, not just left orphaned — otherwise a later, entirely
		// unrelated note that happens to reuse the same filename would silently
		// inherit a stranger's mastery/scheduling/misconception history, which is
		// worse than losing it. See removeTrackedNote's own doc comment.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				// Deleting "Archive/Krebs cycle" must not wipe the live "Krebs cycle" note's
				// history, which shares the same basename key.
				if (this.basenameInUse(file.basename)) return;
				void this.withViewsSynced(() => this.removeTrackedNote(file.basename));
			}),
		);
		if (!Platform.isMobile) {
			this.statusBar = this.addStatusBarItem();
			this.statusBar.addClass("mod-clickable");
			// Click goes straight into the due queue when something's due, else opens the panel.
			this.statusBar.onClickEvent(() => void (this.dueCount() > 0 ? this.startDueSession() : this.activateView()));
		}
		this.addSettingTab(new GrillSettingTab(this.app, this));

		// "Redo this quiz" button rendered from the grill-redo block in a session note.
		this.registerMarkdownCodeBlockProcessor("grill-redo", (source, el) => {
			let questions: Question[] = [];
			try {
				const data = JSON.parse(source) as { questions?: Question[] };
				if (Array.isArray(data?.questions)) questions = data.questions;
			} catch {
				el.createEl("p", { cls: "grill-meta", text: "Grill: couldn't read this redo block." });
				return;
			}
			const n = questions.length;
			if (!n) return;
			const box = el.createDiv({ cls: "grill-redo-block" });
			const btn = box.createEl("button", { text: `Redo this quiz (${n} question${n === 1 ? "" : "s"})`, cls: "mod-cta" });
			box.createSpan({
				cls: "grill-meta grill-redo-note",
				text:
					this.data.settings.gradingMode === "ai"
						? "Same questions, no AI to regenerate. AI still grades your answers."
						: "Same questions, and you grade yourself. No cost.",
			});
			btn.onclick = () => void this.startReplay(questions);
		});

		// Upload/remove area for Instructions.md's "## Reference documents" section —
		// same idea as attaching a file in an AI chat, rendered where instructions
		// already live rather than buried in a settings modal. Ignores `source`
		// entirely and re-reads the manifest from disk on every render: the block is
		// rebuilt in place after every add/remove (see renderList below), so trusting
		// the store instead of the stale `source` this callback was invoked with
		// avoids ever showing a list that's one action behind what's on disk.
		this.registerMarkdownCodeBlockProcessor("grill-documents", (_source, el) => {
			const root = el.createDiv({ cls: "grill-doc-area" });
			const listEl = root.createDiv({ cls: "grill-doc-list" });

			const renderList = (files: string[]) => {
				listEl.empty();
				if (!files.length) {
					listEl.createEl("p", { cls: "grill-meta grill-doc-empty", text: "No documents attached yet." });
					return;
				}
				for (const name of files) {
					const row = listEl.createDiv({ cls: "grill-doc-row" });
					row.createSpan({ cls: "grill-doc-name", text: name });
					const remove = row.createEl("button", { cls: "grill-doc-remove clickable-icon", attr: { "aria-label": `Remove ${name}` } });
					remove.setText("✕");
					remove.onclick = () => {
						void (async () => {
							remove.disabled = true;
							const files2 = await this.store.removeReferenceDoc(name, true);
							new Notice(`Grill: removed "${name}".`);
							renderList(files2);
						})();
					};
				}
			};

			const handleFiles = (picked: FileList | null) => {
				if (!picked || !picked.length) return;
				void (async () => {
					dropzone.addClass("is-busy");
					status.setText("Adding…");
					let files: string[] = await this.store.listReferenceDocNames();
					let added = 0;
					const errors: string[] = [];
					for (let i = 0; i < picked.length; i++) {
						const f = picked[i];
						// Client-side size/count checks fail fast, before spending time reading the
						// file into memory — addReferenceDoc enforces the same two limits itself
						// (that's the real gate; this is just so a big or extra file doesn't sit
						// there "adding" for a few seconds before being rejected).
						if (files.length >= GrillStore.MAX_REFERENCE_DOCS) {
							errors.push(`stopped at the ${GrillStore.MAX_REFERENCE_DOCS}-document limit (${picked.length - i} not added)`);
							break;
						}
						if (f.size > GrillStore.MAX_REFERENCE_DOC_BYTES) {
							errors.push(`"${f.name}" is over the ${(GrillStore.MAX_REFERENCE_DOC_BYTES / (1024 * 1024)).toFixed(0)} MB limit`);
							continue;
						}
						try {
							const bytes = await f.arrayBuffer();
							const result = await this.store.addReferenceDoc(bytes, f.name);
							files = result.files;
							added++;
						} catch (e) {
							console.error(`Grill: couldn't add reference document "${f.name}"`, e);
							errors.push(e instanceof Error ? e.message : `"${f.name}" couldn't be added`);
						}
					}
					dropzone.removeClass("is-busy");
					status.setText("Drop PDFs here, or click to browse");
					renderList(files);
					if (added === 1 && !errors.length) new Notice(`Grill: added "${picked[0].name}".`);
					else if (added) new Notice(`Grill: added ${added} document${added === 1 ? "" : "s"}.`);
					for (const msg of errors) new Notice(`Grill: ${msg}.`, 8000);
				})();
			};

			const dropzone = root.createDiv({ cls: "grill-doc-dropzone", attr: { tabindex: "0", role: "button" } });
			dropzone.createSpan({ cls: "grill-doc-dropzone-icon", text: "+" });
			const status = dropzone.createSpan({ cls: "grill-doc-dropzone-text", text: "Drop PDFs here, or click to browse" });
			dropzone.createSpan({
				cls: "grill-doc-dropzone-caption",
				text: `PDF only · up to ${(GrillStore.MAX_REFERENCE_DOC_BYTES / (1024 * 1024)).toFixed(0)} MB each · ${GrillStore.MAX_REFERENCE_DOCS} documents max`,
			});
			const input = dropzone.createEl("input", {
				cls: "grill-doc-input",
				attr: { type: "file", accept: ".pdf", multiple: true },
			});
			dropzone.onclick = () => input.click();
			dropzone.onkeydown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					input.click();
				}
			};
			input.onclick = (e) => e.stopPropagation();
			input.onchange = () => handleFiles(input.files);
			dropzone.ondragover = (e) => {
				e.preventDefault();
				dropzone.addClass("is-dragover");
			};
			dropzone.ondragleave = () => dropzone.removeClass("is-dragover");
			dropzone.ondrop = (e) => {
				e.preventDefault();
				dropzone.removeClass("is-dragover");
				handleFiles(e.dataTransfer?.files ?? null);
			};

			void this.store.listReferenceDocNames().then(renderList);
		});

		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				this.mastery = await this.store.loadMastery();
				this.concepts = await this.store.loadConcepts();
				// One-time move to concept-level scheduling: keep stats, reset scheduling.
				if (!this.data.settings.conceptsMigrated) {
					migrateResetScheduling(this.mastery);
					try {
						await this.store.saveMastery(this.mastery);
						this.data.settings.conceptsMigrated = true;
						await this.persist();
					} catch (e) {
						console.error("Grill: couldn't save the scheduling migration; will retry next launch", e);
					}
				}
				this.refreshStatusBar();
				this.warnOnDuplicateBasenames();
				// On Grill Cloud this waits for the end of a session (see the summary screen):
				// nothing is spent in the background that a receipt doesn't show.
				if (this.data.settings.provider !== "grillcloud") void this.maybeSynthesizeArc();
				// A pane already open at this point rendered its start screen from the
				// empty mastery placeholder (see refreshIfOnStartScreen) — bring it up to
				// date now that the real data has loaded.
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
					if (leaf.view instanceof SessionView) leaf.view.refreshIfOnStartScreen();
				}
				// First run: open Grill and ask which folders are its territory.
				if (!this.data.settings.onboarded) {
					await this.activateView();
					const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
					if (view instanceof SessionView) view.showOnboarding();
				}
			})();
		});
	}

	onunload(): void {
		this.stopCloudWatch();
		void terminateOcrWorker();
	}

	statusBar: HTMLElement | null = null;

	/** Create Grill/Instructions.md if needed and open it for editing. */
	/** Open Obsidian's settings straight to Grill's tab. `app.setting` isn't in the
	 * public typings, hence the narrow cast. */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	async openInstructions(): Promise<void> {
		const file = await this.store.createInstructions();
		if (!file) {
			new Notice("Grill: couldn't create the instructions file.");
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/** Write Grill/review-log.csv from every concept's raw FSRS review history and
	 * open it — an audit trail for optimizer.ts's fit, portable outside this plugin. */
	async exportReviewLog(): Promise<void> {
		const file = await this.store.exportReviewLog(this.concepts);
		if (!file) {
			new Notice("Grill: couldn't write the review log.");
			return;
		}
		new Notice(`Grill: exported review log to ${file.path}.`);
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/** Fit personalized FSRS weights from this vault's own logged review history
	 * (see optimizer.ts) and switch the scheduler over to them. Safe to call
	 * anytime, from the command palette or the settings button: too little data
	 * or a fit that doesn't beat the library defaults on this vault's own data
	 * both leave settings untouched. */
	/** Refit ratio for the automatic pass: once this vault has half again as much review
	 * history as the last fit trained on, the fit is stale enough to be worth redoing. A
	 * proportional threshold rather than a fixed count, so a vault with 5,000 reviews
	 * doesn't refit every fortnight for a change it can't feel. */
	private static readonly FSRS_REFIT_GROWTH = 1.5;

	/** Fit this vault's own FSRS weights once there's enough history to fit against, and
	 * refit as that history grows. Called at session end.
	 *
	 * This used to be an "Optimize now" button in settings, which put the burden on the
	 * student to know that FSRS ships with population-average weights, that their own
	 * forgetting differs, and that a button existed to close the gap. None of that is
	 * theirs to know. The fit is local, deterministic, and reads data Grill already logs,
	 * so the only thing the button ever added was the asking. The Notice still fires, so
	 * "personalized" stays visible rather than silent, and Tuning keeps a way back to the
	 * library defaults. */
	async maybeAutoOptimizeFsrs(): Promise<void> {
		const trainable = countTrainableReviews(this.concepts);
		if (trainable < MIN_REVIEWS_FOR_OPTIMIZATION) return;
		const s = this.data.settings;
		// Measured against the last ATTEMPT, not the last successful fit — a run that
		// finds no improvement still costs the same gradient descent, and gating on the
		// fit alone would repeat it after every session on a vault it can't improve.
		const lastTried = Math.max(s.fsrsPersonalization?.reviewCount ?? 0, s.fsrsLastFitAttemptReviews);
		if (lastTried && trainable < lastTried * GrillPlugin.FSRS_REFIT_GROWTH) return;
		await this.optimizeFsrsParameters({ silentWhenUnchanged: true });
	}

	/** `silentWhenUnchanged` suppresses the two Notices that only answer a question the
	 * user asked by pressing a button ("not enough history yet", "no change made"). The
	 * automatic pass has no question to answer, and a Notice for "nothing happened" on
	 * every session end would be noise; the one that reports a real change still fires. */
	async optimizeFsrsParameters(opts: { silentWhenUnchanged?: boolean } = {}): Promise<void> {
		const trainable = countTrainableReviews(this.concepts);
		if (trainable < MIN_REVIEWS_FOR_OPTIMIZATION) {
			if (!opts.silentWhenUnchanged)
				new Notice(
					`Grill: not enough review history yet to personalize FSRS (${trainable}/${MIN_REVIEWS_FOR_OPTIMIZATION} reviews). ` +
						"Keep studying — this gets better with more real reviews to fit against.",
				);
			return;
		}
		if (!opts.silentWhenUnchanged) new Notice(`Grill: optimizing FSRS parameters from ${trainable} reviews...`);
		// Recorded before the result is known, and for the manual path too: what the
		// automatic pass needs to know is that a fit was tried at this much history.
		this.data.settings.fsrsLastFitAttemptReviews = trainable;
		const result = await optimizeFSRSWeights(this.concepts);
		if (!result.weights) {
			await this.persist();
			if (!opts.silentWhenUnchanged)
				new Notice("Grill: your current schedule already fits this vault as well as a refit would — no change made.");
			return;
		}
		const improvementPct = ((result.baselineLoss - result.finalLoss) / result.baselineLoss) * 100;
		this.data.settings.fsrsPersonalization = {
			weights: result.weights,
			fitAt: new Date().toISOString(),
			reviewCount: result.reviewsUsed,
			improvementPct,
		};
		configureFSRSWeights(result.weights);
		await this.persist();
		new Notice(
			`Grill: FSRS parameters personalized from ${result.reviewsUsed} reviews ` +
				`(${improvementPct.toFixed(1)}% tighter fit than the defaults). Applies to every review from now on.`,
		);
	}

	/** On-demand fix for pile-ups a big import or a long study stretch can leave in the
	 * future due-date queue (see rebalanceDueDates's doc comment in concepts.ts): keeps
	 * what's due WHEN it's due, just re-smooths the day-crowding against a clean slate.
	 * Safe to call anytime, including mid-session (SessionView's own `concepts` map is
	 * the same object once a session has loaded one — see the field comment on
	 * `concepts` above). */
	/** Drop every cached question so each concept writes a fresh one next time it's due.
	 * A concept's question is written once and reused verbatim on every later review; this
	 * is the escape hatch for when a Grill update changes how questions are written and you
	 * want that to reach concepts you've already studied, not just new ones. Doesn't touch
	 * scheduling, and doesn't affect a session that's already open. */
	async clearQuestionCache(): Promise<void> {
		try {
			await this.store.saveQuestionBank({});
		} catch (e) {
			new Notice(`Grill: couldn't clear cached questions (${(e as Error).message}).`, 8000);
			return;
		}
		new Notice("Grill: cleared cached questions. Each concept writes a fresh one next time it's due.");
	}

	async rebalanceSchedule(): Promise<void> {
		const easyWeekdays = new Set(this.data.settings.easyDays);
		const changed = rebalanceDueDates(this.concepts, new Date(), easyWeekdays);
		if (changed > 0) {
			try {
				await this.store.saveConcepts(this.concepts);
			} catch (e) {
				new Notice(`Grill: couldn't save the rebalanced dates (${(e as Error).message}).`, 8000);
				return;
			}
		}
		new Notice(
			changed > 0
				? `Grill: rebalanced ${changed} upcoming due date${changed === 1 ? "" : "s"}.`
				: "Grill: upcoming due dates are already well-spread — nothing to rebalance.",
		);
	}

	/** True if a note path is outside Grill's territory: in the Grill folder, outside the
	 * chosen included folders (when any are set), or in a user-excluded folder. Empty
	 * `includedFolders` means the whole vault is Grill's. */
	isExcluded(path: string): boolean {
		if (path.startsWith(`${this.data.settings.folder}/`)) return true;
		const included = this.data.settings.includedFolders;
		if (included.length) {
			const inside = included.some((raw) => {
				const i = raw.trim();
				return i && (path === i || path.startsWith(`${i}/`));
			});
			if (!inside) return true;
		}
		for (const raw of this.data.settings.excludedFolders) {
			const e = raw.trim();
			if (e && (path === e || path.startsWith(`${e}/`))) return true;
		}
		return false;
	}

	/** Startup check (see `duplicateBasenames`): if two of Grill's eligible notes
	 * share a filename, Grill's basename-keyed mastery/concepts can't tell them
	 * apart, so their scheduling/progress silently mixes together and which file wins
	 * a given lookup isn't guaranteed stable. Not fixable without a schema migration —
	 * this just makes it visible instead of a silent, confusing mastery-map glitch.
	 *
	 * Only actually shows the Notice when the duplicate SET has changed since the last
	 * time it warned (a new collision appeared, or an old one got renamed away) —
	 * runs on every plugin load, but the same unresolved duplicates you haven't gotten
	 * around to renaming yet don't re-nag you every single time you open Obsidian. */
	private warnOnDuplicateBasenames(): void {
		const eligible = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
		const dupes = duplicateBasenames(eligible); // already sorted, so array equality below is order-stable
		const s = this.data.settings;
		const unchanged =
			dupes.length === s.lastWarnedDuplicateBasenames.length &&
			dupes.every((d, i) => d === s.lastWarnedDuplicateBasenames[i]);
		if (unchanged) return;
		s.lastWarnedDuplicateBasenames = dupes;
		void this.persist();
		if (!dupes.length) return; // the only change worth persisting silently: it just resolved
		const shown = dupes.slice(0, 5).join(", ");
		const more = dupes.length > 5 ? ` and ${dupes.length - 5} more` : "";
		new Notice(
			`Grill: ${dupes.length} filename${dupes.length > 1 ? "s" : ""} appear on more than one note in Grill's scope (${shown}${more}). ` +
				"Grill tracks progress by filename, not folder, so notes sharing a name share one progress record. Rename one of each pair to keep them separate.",
			12000,
		);
	}

	/** Count of concepts currently due for review — the real size of what clicking
	 * into the due queue will deliver (see `dueConceptCount` and `pickConcepts`'s
	 * `dueOnly` branch). Deliberately NOT a count of due notes: a note's rolled-up
	 * `dueAt` (see `noteAggregate`) is the EARLIEST of its concepts' due dates, so
	 * counting notes undercounts whenever a note has more than one concept due at
	 * once — the number shown wouldn't match the queue it launches. */
	dueCount(): number {
		const eligibleNames = new Set(
			this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path)).map((f) => f.basename),
		);
		return dueConceptCount(this.concepts, (note) => eligibleNames.has(note));
	}

	refreshStatusBar(): void {
		if (!this.statusBar) return;
		const n = this.dueCount();
		this.statusBar.setText(n > 0 ? `Grill: ${n} due` : "Grill");
	}

	/** Whether a session touches the model at all — questions, grading, or both. Single
	 * source of truth for "does this session need a key" / "is an AI debrief possible",
	 * so the two call sites don't each re-derive the same `questionSource === "ai" ||
	 * gradingMode === "ai"` check and risk drifting apart. */
	usesAI(): boolean {
		return this.data.settings.questionSource === "ai" || this.data.settings.gradingMode === "ai";
	}

	/** Debounce a single file's concept re-extraction so a burst of "modify" events
	 * from active editing/autosave collapses into one re-parse after editing settles,
	 * not one per keystroke-triggered save. */
	private scheduleConceptRefresh(file: TFile): void {
		const prev = this.modifyTimers.get(file.path);
		if (prev !== undefined) window.clearTimeout(prev);
		// registerInterval (despite the name, works for any numeric timer id) so a
		// pending debounce is also cleared if the plugin unloads before it fires.
		const id = this.registerInterval(
			window.setTimeout(() => {
				this.modifyTimers.delete(file.path);
				void this.refreshConceptsForFile(file);
			}, 2000),
		);
		this.modifyTimers.set(file.path, id);
	}

	/** Run a disk rewrite of the shared stores with every open Grill pane flushed
	 * before it and reloaded after it. Without this, a pane mid-session held its own
	 * pre-rename copies of the question bank/bridges/registry and its next save put
	 * them straight back, undoing the rename or delete. */
	private async withViewsSynced(edit: () => Promise<void>): Promise<void> {
		const views = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is SessionView => v instanceof SessionView);
		let edited = false;
		try {
			for (const v of views) {
				if (!(await v.flushForExternalEdit())) {
					// Rewriting the stores now would either lose that pane's unsaved changes
					// (on reload) or be undone by them (on its next save). Leave the old
					// records in place; history stays attached to the old name until then.
					new Notice("Grill: couldn't update its records for that rename/delete while a save is failing.", 8000);
					return;
				}
			}
			edited = true;
			await edit();
		} catch (e) {
			new Notice(`Grill: couldn't update its records for that rename/delete (${(e as Error).message}).`, 8000);
		} finally {
			// Once the edit has started, re-sync even after a partial failure, so no pane
			// keeps copies that disagree with what's on disk.
			if (edited) for (const v of views) await v.reloadSharedStores().catch(() => undefined);
		}
	}

	/** Migrate every store's records from an old basename to the new one after an
	 * actual rename (see the rename listener in onload). Never clobbers a record
	 * already sitting at the new name/id/key — that's the same duplicate-basename
	 * situation Grill already warns about elsewhere (renaming into a collision),
	 * and merging two real histories together silently would be the wrong call;
	 * leaving the old-name record in place (orphaned, same as if the note had been
	 * deleted) is the safe default there. */
	private async renameTrackedNote(oldName: string, newName: string): Promise<void> {
		let touched = false;
		if (this.mastery[oldName] && !this.mastery[newName]) {
			this.mastery[newName] = this.mastery[oldName];
			delete this.mastery[oldName];
			touched = true;
		}
		// Concept ids bake the note name in as a prefix (`${note}::${kind}:${slug(label)}`
		// — see generate-local.ts's extractConcepts), so patching only the `.note` display
		// field in place (the old behaviour here) left every concept keyed under an id the
		// next real extraction of this note can never produce again: reconcileConcepts
		// would treat the renamed note as brand new, silently resetting FSRS scheduling to
		// scratch (stability/streak/dueAt all null) while the correctly-relabeled-but-now-
		// unreachable old entry sat there forever as dead weight, still counted as due by
		// dueConceptCount/priorityNotes. Fix: re-key by swapping the note-name prefix — the
		// suffix after the first "::" depends only on kind+label, never the note name, so
		// this reconstructs exactly the id the next extraction (same, unchanged content)
		// will compute, and scheduling carries over correctly instead of resetting.
		const oldPrefix = `${oldName}::`;
		const newPrefix = `${newName}::`;
		for (const [id, cm] of Object.entries(this.concepts)) {
			if (cm.note !== oldName || !id.startsWith(oldPrefix)) continue;
			const newId = newPrefix + id.slice(oldPrefix.length);
			if (this.concepts[newId]) continue; // already tracked under the new id; leave the old orphaned rather than clobber
			cm.note = newName;
			this.concepts[newId] = cm;
			delete this.concepts[id];
			touched = true;
		}
		if (touched) {
			await this.store.saveMastery(this.mastery);
			await this.store.saveConcepts(this.concepts);
		}

		const reg = await this.store.loadRegistry();
		let regTouched = false;
		for (const c of Object.values(reg)) {
			const idx = c.notes.indexOf(oldName);
			if (idx === -1) continue;
			if (c.notes.includes(newName)) {
				c.notes.splice(idx, 1); // already tracked under the new name too; drop the stale duplicate
			} else {
				c.notes[idx] = newName;
			}
			regTouched = true;
		}
		if (regTouched) await this.store.saveRegistry(reg);

		// Question bank: same id-prefix swap as concepts.json above, so a cached
		// question's variants survive the rename instead of being orphaned and silently
		// regenerated from scratch on next review. Also patch the cached entries' own
		// `node` field directly — belt-and-suspenders alongside buildPrebuilt's serve-time
		// re-stamp in view.ts, since anything reading the bank straight off disk (not
		// through a live session) should see the current name too.
		const bank = await this.store.loadQuestionBank();
		let bankTouched = false;
		for (const [id, entries] of Object.entries(bank)) {
			if (!id.startsWith(oldPrefix)) continue;
			const newId = newPrefix + id.slice(oldPrefix.length);
			if (bank[newId]) continue; // already tracked under the new id; leave the old orphaned rather than clobber
			for (const e of entries) if (e.node === oldName) e.node = newName;
			bank[newId] = entries;
			delete bank[id];
			bankTouched = true;
		}
		if (bankTouched) await this.store.saveQuestionBank(bank);

		// Embeddings and the map's saved node layout are both keyed directly by note
		// basename with no id to reconstruct — a plain key swap, same as mastery above.
		const embeddings = await this.store.loadEmbeddings();
		if (embeddings[oldName] && !embeddings[newName]) {
			embeddings[newName] = embeddings[oldName];
			delete embeddings[oldName];
			await this.store.saveEmbeddings(embeddings);
		}
		const layout = await this.store.loadGraphLayout();
		if (layout[oldName] && !layout[newName]) {
			layout[newName] = layout[oldName];
			delete layout[oldName];
			await this.store.saveGraphLayout(layout);
		}

		// Bridge suggestions are keyed by an order-independent pair key over both notes'
		// basenames, with the basenames also duplicated into the record's own a/b fields —
		// recompute the key and patch whichever side (a or b) matched the rename, so a
		// pair already suggested/answered/linked/dismissed isn't re-adjudicated from
		// scratch (and, for "dismissed", isn't re-suggested against the user's own call).
		const bridges = await this.store.loadBridges();
		let bridgesTouched = false;
		for (const [key, rec] of Object.entries(bridges)) {
			if (rec.a !== oldName && rec.b !== oldName) continue;
			const newRec = { ...rec, a: rec.a === oldName ? newName : rec.a, b: rec.b === oldName ? newName : rec.b };
			const newKey = pairKey(newRec.a, newRec.b);
			delete bridges[key];
			if (!bridges[newKey]) bridges[newKey] = newRec; // else already tracked under the new key; drop the stale duplicate
			bridgesTouched = true;
		}
		if (bridgesTouched) await this.store.saveBridges(bridges);
	}

	/** Does any markdown file in the vault still have this basename? */
	private basenameInUse(name: string): boolean {
		return this.app.vault.getMarkdownFiles().some((f) => f.basename === name);
	}

	/** Prune every store's records for a genuinely deleted note, by basename. Unlike a
	 * rename (where real history should carry over — see renameTrackedNote above), a
	 * delete means the note is gone for good: leaving its records in place would let an
	 * unrelated FUTURE note that happens to reuse the same filename silently inherit a
	 * stranger's mastery/scheduling/misconception history, which is worse than losing
	 * it outright. Matches by note-name prefix as well as the `.note`/`a`/`b` display
	 * fields, so it also cleans up any already-drifted entry left behind by a rename
	 * from before this and renameTrackedNote's id re-keying existed. */
	private async removeTrackedNote(name: string): Promise<void> {
		let touched = false;
		if (this.mastery[name]) {
			delete this.mastery[name];
			touched = true;
		}
		const prefix = `${name}::`;
		for (const id of Object.keys(this.concepts)) {
			if (this.concepts[id].note === name || id.startsWith(prefix)) {
				delete this.concepts[id];
				touched = true;
			}
		}
		if (touched) {
			await this.store.saveMastery(this.mastery);
			await this.store.saveConcepts(this.concepts);
		}

		const reg = await this.store.loadRegistry();
		let regTouched = false;
		for (const c of Object.values(reg)) {
			const idx = c.notes.indexOf(name);
			if (idx === -1) continue;
			c.notes.splice(idx, 1);
			regTouched = true;
		}
		if (regTouched) await this.store.saveRegistry(reg);

		const bank = await this.store.loadQuestionBank();
		let bankTouched = false;
		for (const id of Object.keys(bank)) {
			if (!id.startsWith(prefix)) continue;
			delete bank[id];
			bankTouched = true;
		}
		if (bankTouched) await this.store.saveQuestionBank(bank);

		const embeddings = await this.store.loadEmbeddings();
		if (embeddings[name]) {
			delete embeddings[name];
			await this.store.saveEmbeddings(embeddings);
		}
		const layout = await this.store.loadGraphLayout();
		if (layout[name]) {
			delete layout[name];
			await this.store.saveGraphLayout(layout);
		}

		const bridges = await this.store.loadBridges();
		let bridgesTouched = false;
		for (const [key, rec] of Object.entries(bridges)) {
			if (rec.a !== name && rec.b !== name) continue;
			delete bridges[key];
			bridgesTouched = true;
		}
		if (bridgesTouched) await this.store.saveBridges(bridges);
	}

	/** Re-extract just this one file's concepts and fold them into the live map, so
	 * an edit (a new `[!grill]` callout, a changed vocab entry) is reflected in the
	 * due-count/dashboard without waiting for a session to touch this note. Same
	 * extraction call a session start makes (see view.ts) — just for one file,
	 * on edit, instead of every scoped file, on session start. Best-effort: a
	 * mid-save read error here just means the next real session re-syncs it, same
	 * as it always would. */
	private async refreshConceptsForFile(file: TFile): Promise<void> {
		try {
			// Same text a session extracts from (markdown + embedded PDFs). Reading the
			// markdown alone orphaned every PDF-derived concept on each edit. Occlusion
			// concepts come from an OCR pass this refresh doesn't run, so they're kept.
			const pdfCache = await this.store.loadPdfCache();
			const text = await noteStudyText(this.app, file, pdfCache);
			await this.store.savePdfCache(pdfCache);
			const extracted = extractConcepts(file.basename, text, this.data.settings.questionFormats);
			reconcileConcepts(this.concepts, extracted, new Set(["occlusion"]));
			await this.store.saveConcepts(this.concepts);
			this.refreshStatusBar();
		} catch {
			// Best-effort — see doc comment above.
		}
	}

	/** Push a graph display-setting change (colour mode, number overlay, grade weighting)
	 * into any already-open Grill pane's graph, live, without a full re-render. */
	refreshMapDisplay(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof SessionView) leaf.view.updateMapDisplay();
		}
	}

	async startScoped(files: TFile[], dueOnly = false): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof SessionView) await view.startScopedSession(files, dueOnly);
	}

	/** Redo a saved session's questions (from its grill-redo block): same questions, no
	 * generation, graded per the current setting, and it doesn't change your schedule. */
	async startReplay(questions: Question[]): Promise<void> {
		if (!questions.length) {
			new Notice("Grill: no questions to redo.");
			return;
		}
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof SessionView) await view.startReplay(questions);
	}

	/** Start a session on exactly the notes that are due or struggling. */
	async startDueSession(): Promise<void> {
		const eligible = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
		const due = dueFiles(eligible, this.concepts);
		if (!due.length) {
			new Notice("Grill: nothing due right now. Nice work.");
			await this.activateView();
			return;
		}
		await this.startScoped(due, true);
	}

	/** Open the progress dashboard in the Grill panel. */
	async openDashboard(): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof SessionView) view.showDashboard();
	}

	/** Re-synthesize the progress-dashboard arc if enough new study days have
	 * accumulated since the last one. Called once from onLayoutReady (Obsidian
	 * launch), never on a timer or on dashboard render — the gate check itself is
	 * local date math over arcLog, so it costs nothing on the launches where it
	 * declines to call the LLM (the common case). See ACTIVE_DAYS_BETWEEN_ARCS
	 * and MIN_ACTIVE_DAYS_FOR_ARC in debrief.ts for why the unit is days, not
	 * sessions or wall-clock time. */
	async maybeSynthesizeArc(): Promise<void> {
		// A vault with real session history from before this feature existed starts
		// with an empty (or nearly empty) arcLog otherwise, making an established
		// user wait MIN_ACTIVE_DAYS_FOR_ARC days from scratch despite already having
		// weeks of real evidence in the misconception registry. Always merge, never
		// gate on arcLog being empty: a brand-new vault has no session files to find
		// (backfillArcLog naturally returns []), and a vault with a few days already
		// logged organically since this feature shipped still needs the rest of its
		// real history folded in, not skipped because arcLog wasn't literally empty.
		// logArcEntry dedupes by date, so re-deriving a day already present (from
		// its own session file) is a harmless no-op, not a double-count. Runs once,
		// ever, per vault; only marked done on success, so a read error retries on
		// the next launch instead of silently giving up forever.
		if (!this.data.settings.arcBackfilled) {
			try {
				const historical = await this.store.backfillArcLog(ARC_LOG_CAP);
				let merged = this.data.arcLog;
				for (const entry of historical) merged = logArcEntry(merged, entry);
				this.data.arcLog = merged;
				this.data.settings.arcBackfilled = true;
				await this.persist();
			} catch {
				// best-effort; arcBackfilled stays false so this retries next launch
			}
		}
		const days = activeDayCount(this.data.arcLog);
		const threshold = this.data.arc ? this.data.arc.atActiveDays + ACTIVE_DAYS_BETWEEN_ARCS : MIN_ACTIVE_DAYS_FOR_ARC;
		if (days < threshold) return;
		const cfg = this.llmConfig();
		if (!cfg) return;
		try {
			const reg = await this.store.loadRegistry();
			const top = topMisconceptions(reg, 30);
			const resolved = top.filter((c) => c.status === "resolved");
			const stillActive = top.filter((c) => c.status === "active");
			const headlines = this.data.arcLog.map((e) => e.headline);
			const { persona, preferences } = await this.store.loadInstructions();
			const data = await synthesizeArc(cfg, resolved, stillActive, headlines, persona, preferences);
			this.data.arc = { data, atActiveDays: days };
			await this.persist();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				if (leaf.view instanceof SessionView) leaf.view.refreshIfOnDashboard();
			}
		} catch (e) {
			// Best-effort: launch shouldn't fail or nag the user on a bad key/network
			// blip, so this never surfaces as a Notice. Still logged (not swallowed
			// silently) so a real, recurring failure is at least visible in DevTools
			// instead of just reading as "nothing ever appears" with no trail. The
			// gate re-checks on the next launch since atActiveDays is only advanced
			// on success.
			console.error("Grill: arc synthesis failed", e);
		}
	}

	/** Active provider config for LLM calls; null if a needed key is missing. */
	llmConfig(): LLMConfig | null {
		const s = this.data.settings;
		const info = PROVIDERS[s.provider];
		const apiKey = s.apiKeys[s.provider];
		if (info.needsKey && !apiKey) return null;
		if (s.provider === "grillcloud" && !cloudEnabled()) return null;
		// Custom provider needs both an endpoint and a model to be usable.
		if (s.provider === "custom" && (!s.customBaseUrl || !s.models.custom)) return null;
		return {
			provider: s.provider,
			apiKey,
			// Grill Cloud's server picks the model; the name is only what the screen calls
			// it, whatever an earlier build may have saved.
			model: s.provider === "grillcloud" ? info.defaultModel : s.models[s.provider] || info.defaultModel,
			baseUrl: s.provider === "ollama" ? s.ollamaUrl : s.provider === "custom" ? s.customBaseUrl : undefined,
		};
	}

	/** Grill Cloud credits left as last heard from the server; null until known. */
	cloudCredits: number | null = null;
	/** Whether Grill Cloud can read aloud in a natural voice, as it last said. */
	cloudSpeech = false;

	/** Where a natural voice would come from right now, if anywhere. */
	naturalVoiceSource(): "cloud" | "openai" | null {
		const s = this.data.settings;
		if (cloudEnabled() && s.provider === "grillcloud" && isCloudKey(s.apiKeys.grillcloud) && this.cloudSpeech) return "cloud";
		if (s.provider === "openai" && s.apiKeys.openai) return "openai";
		return null;
	}

	/** Read text aloud: in a natural voice when the user has asked for one and one is
	 * to be had, in the device's own voice otherwise, or if the natural one fails. */
	async readAloud(text: string): Promise<void> {
		const s = this.data.settings;
		const source = s.naturalVoice ? this.naturalVoiceSource() : null;
		if (source) {
			try {
				await speakNatural(text, async (clean) => {
					if (source === "cloud") {
						const r = await cloudSpeech(s.apiKeys.grillcloud, clean);
						if (!r.ok) throw new Error(r.message);
						return r.data;
					}
					const r = await Promise.race([
						requestUrl({
							url: "https://api.openai.com/v1/audio/speech",
							method: "POST",
							headers: { authorization: `Bearer ${s.apiKeys.openai}`, "content-type": "application/json" },
							body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "sage", input: clean, response_format: "mp3" }),
							throw: false,
						}),
						new Promise<never>((_, no) => window.setTimeout(() => no(new Error("The voice took too long.")), 45_000)),
					]);
					if (r.status !== 200) throw new Error(`The voice had a problem (${r.status}).`);
					return r.arrayBuffer;
				});
				return;
			} catch (e) {
				new Notice(`Grill: ${(e as Error).message} Using your device's voice instead.`, 8000);
			}
		}
		speak(text, { lang: s.ttsLanguage, voiceURI: s.ttsVoiceURI });
	}

	/** Credits the session under way has used. The view zeroes it when one starts. */
	cloudSessionSpent = 0;

	/** What has been spent since this was last asked, and start counting again. */
	takeCloudSpend(): number {
		const spent = this.cloudSessionSpent;
		this.cloudSessionSpent = 0;
		return spent;
	}

	/** A session has ended: keep what it cost, to say back later. Returns the cost, or
	 * 0 if it used nothing (not on Grill Cloud, or nothing was asked of it). */
	async noteCloudSession(extra = 0): Promise<number> {
		return this.recordCloudSession(this.takeCloudSpend() + extra);
	}

	/** Keep `used` as what a session cost, without touching the running count. */
	async recordCloudSession(used: number): Promise<number> {
		// Whole credits, and never "0" for a session that did use something.
		const spent = used > 0 ? Math.max(1, Math.round(used)) : 0;
		if (spent <= 0 || this.data.settings.provider !== "grillcloud") return 0;
		this.data.settings.cloudUsage = [...this.data.settings.cloudUsage, spent].slice(-10);
		await this.persist();
		return spent;
	}
	/** What the last look at the server found:
	 *  unknown  not asked yet            offline  couldn't be reached
	 *  ok       there is an account      refused  it answered with an error (see cloudNote)
	 *  none     it has no account for this key yet: no starter was given and nothing
	 *           has been bought. Buying credits is what opens it. */
	cloudState: "unknown" | "ok" | "offline" | "refused" | "none" = "unknown";
	/** The server's own words, when it refused. */
	cloudNote = "";
	/** Whether credits can be bought right now, as the server last said. */
	cloudSales = true;
	/** How many purchases the server has credited to this key. */
	cloudPurchases: number | null = null;
	/** The packs on sale with their checkout links for the key in use, ready so a click
	 * can open one at once. Emptied the moment the key changes, so a click can never
	 * pay into a key no longer held. */
	cloudPacks: Array<CloudPack & { link: string }> = [];
	/** Keys this session deleted from the server: never taken back from a stale copy. */
	private cloudGone = new Set<string>();
	/** Told whenever the balance, the key or a wait changes, so every open Grill view
	 * can redraw. (The settings tab has cloudArrived, which also carries the numbers.) */
	cloudListeners = new Set<() => void>();
	private tellCloud(): void {
		for (const heard of [...this.cloudListeners]) {
			try {
				heard();
			} catch (e) {
				console.error("Grill: a screen failed to redraw", e);
			}
		}
	}

	/** Whether buying credits would work right now. With no account yet ("none") it
	 * does: a purchase is what opens one. Not while the server can't be reached or is
	 * refusing: what it last said about sales may no longer hold. */
	get cloudCanBuy(): boolean {
		return this.cloudPacks.length > 0 && this.cloudSales && this.cloudState !== "offline" && this.cloudState !== "refused";
	}

	private async linkCloudCheckout(key: string): Promise<void> {
		this.cloudPacks = [];
		if (!isCloudKey(key)) return;
		const packs: Array<CloudPack & { link: string }> = [];
		for (const pack of cloud.packs) {
			if (pack.url) packs.push({ ...pack, link: await cloudCheckoutUrl(key, pack.url) });
		}
		const id = await cloudAccount(key);
		if (this.data.settings.apiKeys.grillcloud === key) {
			this.cloudPacks = packs;
			this.cloudAccountId = id;
		}
	}
	/** The account id of the key in use (its hash; never the key): what to quote when
	 * asking for credits to be moved here from a lost key. */
	cloudAccountId = "";

	// A Grill Cloud key is the only handle on money already paid, and it lives in
	// data.json, a file that other devices rewrite whole: one still on Grill 6.2.0
	// blanks keys it finds there, and any device saves over what another just wrote.
	// So the key and the keys before it are also kept on this device, outside the
	// synced file, and what is on disk is read again before every save.

	private cloudBackup(): { key: string; retired: string[]; gone: string[] } {
		try {
			const raw = (this.app as unknown as { loadLocalStorage?: (k: string) => unknown }).loadLocalStorage?.("grill-cloud");
			const kept = (typeof raw === "string" ? JSON.parse(raw) : raw) as { key?: unknown; retired?: unknown; gone?: unknown } | null;
			return {
				key: typeof kept?.key === "string" && isCloudKey(kept.key) ? kept.key : "",
				retired: Array.isArray(kept?.retired) ? kept.retired.filter((k): k is string => typeof k === "string" && isCloudKey(k)) : [],
				gone: Array.isArray(kept?.gone) ? kept.gone.filter(isAccountId) : [],
			};
		} catch {
			return { key: "", retired: [], gone: [] };
		}
	}

	// One balance for every vault on a device. A vault's settings and Obsidian's own
	// storage are both per vault, so each vault would otherwise make its own key and
	// its own balance, and the only way to share one was to copy the key across by
	// hand. The window's storage is shared by all vaults on the device, so the key in
	// use is also noted there, and Start free in another vault picks it up.

	/** The Grill Cloud key last used on this device, in any vault, if there is one. */
	/** Whether Start free here would join a balance already on this device. */
	sharesDeviceCloud(): boolean {
		const shared = this.deviceCloudKey();
		const s = this.data.settings;
		return !!shared && !s.apiKeys.grillcloud && !s.retiredCloudKeys.includes(shared) && !this.cloudGone.has(shared);
	}

	deviceCloudKey(): string {
		try {
			const key = window.localStorage.getItem(DEVICE_CLOUD_KEY) ?? "";
			return isCloudKey(key) ? key : "";
		} catch {
			return "";
		}
	}

	private setDeviceCloudKey(key: string): void {
		try {
			if (key) window.localStorage.setItem(DEVICE_CLOUD_KEY, key);
			else window.localStorage.removeItem(DEVICE_CLOUD_KEY);
		} catch {
			// No shared storage here: each vault keeps its own key, as before.
		}
	}

	/** Account ids of keys deleted in any vault on this device. A vault's own record of
	 * a deletion is per vault; without this, another vault still holding the key would
	 * carry on with a dead account, and hand it to the next vault that starts. */
	private deviceCloudGone(): string[] {
		try {
			const kept = JSON.parse(window.localStorage.getItem(DEVICE_CLOUD_GONE) ?? "[]") as unknown;
			return Array.isArray(kept) ? kept.filter(isAccountId) : [];
		} catch {
			return [];
		}
	}

	private addDeviceCloudGone(id: string): void {
		try {
			window.localStorage.setItem(DEVICE_CLOUD_GONE, JSON.stringify([...new Set([...this.deviceCloudGone(), id])].slice(-GONE_KEYS_KEPT)));
		} catch {
			// This vault's own record still holds.
		}
	}

	private saveCloudBackup(): void {
		const s = this.data.settings;
		if (isCloudKey(s.apiKeys.grillcloud)) this.setDeviceCloudKey(s.apiKeys.grillcloud);
		try {
			(this.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void }).saveLocalStorage?.("grill-cloud", {
				key: isCloudKey(s.apiKeys.grillcloud) ? s.apiKeys.grillcloud : "",
				retired: s.retiredCloudKeys,
				gone: s.cloudGone,
			});
		} catch {
			// The copy in data.json is still there.
		}
	}

	private keepRetired(...more: string[][]): void {
		const s = this.data.settings;
		const all = [...s.retiredCloudKeys, ...more.flat()].filter((k) => isCloudKey(k) && k !== s.apiKeys.grillcloud && !this.cloudGone.has(k));
		s.retiredCloudKeys = [...new Set(all)].slice(0, RETIRED_KEYS_KEPT);
	}

	private clearCloudState(): void {
		this.cloudPacks = [];
		this.cloudCredits = null;
		this.cloudPurchases = null;
		this.cloudState = "unknown";
		this.cloudNote = "";
	}

	/** Take in what was found somewhere other than memory (this device's own copy, or
	 * the settings file as another device left it): a key, earlier keys, and the ids of
	 * deleted keys. The rules, which every device applies the same way so they agree:
	 *  - a deleted key is never used again, here or anywhere it turns up;
	 *  - a blank never replaces a key;
	 *  - a key found there replaces the one here if the other side had let ours go,
	 *    or, when two devices each made a key before hearing of the other's, if it is
	 *    the smaller of the two: both sides then settle on the same one;
	 *  - whichever key loses is kept among the earlier keys, never thrown away.
	 * Returns whether the key in use changed. */
	private takeCloudKey(found: string, retired: string[], gone: string[]): Promise<boolean> {
		// One at a time: a merge reads the key, waits (hashing), then writes, and two
		// running at once from different copies of the file could each undo the other.
		const run = this.cloudMerging.then(() => this.mergeCloudKey(found, retired, gone));
		this.cloudMerging = run.catch(() => false);
		return run;
	}
	private cloudMerging: Promise<boolean> = Promise.resolve(false);

	private async mergeCloudKey(found: string, retired: string[], gone: string[]): Promise<boolean> {
		const s = this.data.settings;
		s.cloudGone = [...new Set([...s.cloudGone, ...gone.filter(isAccountId)])].slice(-GONE_KEYS_KEPT);
		const deleted = async (k: string): Promise<boolean> => isCloudKey(k) && (this.cloudGone.has(k) || s.cloudGone.includes(await cloudAccount(k)));
		let changed = false;
		if (await deleted(s.apiKeys.grillcloud)) {
			this.stopCloudWatch();
			s.apiKeys.grillcloud = "";
			this.clearCloudState();
			changed = true;
		}
		const mine = s.apiKeys.grillcloud;
		let theirs = retired;
		if (isCloudKey(found) && found !== mine && !s.retiredCloudKeys.includes(found) && !(await deleted(found))) {
			if (!isCloudKey(mine) || retired.includes(mine) || found < mine) {
				this.stopCloudWatch();
				s.apiKeys.grillcloud = found;
				if (isCloudKey(mine)) s.retiredCloudKeys = [mine, ...s.retiredCloudKeys];
				this.clearCloudState();
				changed = true;
			} else {
				theirs = [...retired, found];
			}
		}
		this.keepRetired(theirs);
		const kept: string[] = [];
		for (const k of s.retiredCloudKeys) if (!(await deleted(k))) kept.push(k);
		s.retiredCloudKeys = kept;
		return changed;
	}

	/** Called once at load, after the settings are read. */
	private async restoreCloudKey(): Promise<boolean> {
		if (!cloudEnabled()) return false;
		const kept = this.cloudBackup();
		const s = this.data.settings;
		const before = JSON.stringify([s.retiredCloudKeys, s.cloudGone, s.apiKeys.grillcloud]);
		// A key Grill 6.2.0 left in the keychain that isn't the one in use is kept too.
		const rescued = this.keys.rescuedKey && this.keys.rescuedKey !== s.apiKeys.grillcloud ? [this.keys.rescuedKey] : [];
		// The key this device kept is always handed over: used if the file has none, and
		// otherwise kept among the earlier keys. (Left out, a different key in the file
		// would simply replace this device's record of it, and the only copy of a key
		// that may hold paid credits would be gone.)
		const mine = isCloudKey(kept.key) ? [kept.key] : [];
		await this.takeCloudKey(isCloudKey(s.apiKeys.grillcloud) ? "" : kept.key, [...kept.retired, ...rescued, ...mine], [...kept.gone, ...this.deviceCloudGone()]);
		this.saveCloudBackup();
		return JSON.stringify([s.retiredCloudKeys, s.cloudGone, s.apiKeys.grillcloud]) !== before;
	}

	/** Read the key as the settings file holds it right now. */
	private async mergeCloudFromDisk(): Promise<boolean> {
		if (!cloudEnabled()) return false;
		let onDisk: Partial<GrillSettings> | undefined;
		try {
			onDisk = ((await this.loadData()) as Partial<PluginData> | null)?.settings;
		} catch {
			return false;
		}
		const key = onDisk?.apiKeys?.grillcloud;
		const retired = Array.isArray(onDisk?.retiredCloudKeys) ? onDisk.retiredCloudKeys.filter((k) => typeof k === "string") : [];
		// Deletions made in another vault on this device count here too.
		const gone = [...(Array.isArray(onDisk?.cloudGone) ? onDisk.cloudGone : []), ...this.deviceCloudGone()];
		return this.takeCloudKey(typeof key === "string" ? key : "", retired, gone);
	}

	/** Obsidian calls this when data.json was changed by something else (sync). Only
	 * the Grill Cloud key is taken from it: a key made on another device arrives here. */
	async onExternalSettingsChange(): Promise<void> {
		if (!(await this.mergeCloudFromDisk())) return;
		this.saveCloudBackup();
		await this.refreshCloud();
		this.tellCloud();
	}

	/** Look at the balance. Asks nothing of the server but to look. */
	async refreshCloud(): Promise<void> {
		const key = this.data.settings.apiKeys.grillcloud;
		if (!cloudEnabled() || !isCloudKey(key)) return;
		if (!this.cloudPacks.length) await this.linkCloudCheckout(key);
		const r = await cloudBalance(key);
		// The key was replaced or deleted while the server was answering.
		if (this.data.settings.apiKeys.grillcloud !== key) return;
		if (!r.ok) {
			this.cloudState = r.offline ? "offline" : "refused";
			this.cloudNote = r.message;
			return;
		}
		this.cloudCredits = r.data.credits;
		this.cloudPurchases = r.data.purchases;
		this.cloudSales = r.data.sales;
		this.cloudSpeech = r.data.speech === true;
		this.cloudState = r.data.account ? "ok" : "none";
		this.cloudNote = "";
	}

	/** Turn Grill Cloud on for this vault: make a key, switch to it, open its account.
	 * The key is saved before the server is asked, so a lost reply can't leave a
	 * starter spent on a key nobody kept. Returns a line to show the user. */
	async startCloud(): Promise<string> {
		if (!cloudEnabled()) return "Grill Cloud isn't available in this version of Grill.";
		const s = this.data.settings;
		// Another device may have made this vault's key a moment ago.
		await this.mergeCloudFromDisk();
		if (!isCloudKey(s.apiKeys.grillcloud)) {
			// Another vault on this device may already have a key: use that one, so there
			// is one balance on the device and nothing to copy across. Not a key this
			// vault deliberately let go of or deleted.
			const shared = this.deviceCloudKey();
			const sharedId = shared ? await cloudAccount(shared) : "";
			const usable = shared && !s.retiredCloudKeys.includes(shared) && !this.cloudGone.has(shared) && !s.cloudGone.includes(sharedId) && !this.deviceCloudGone().includes(sharedId);
			s.apiKeys.grillcloud = usable ? shared : newCloudKey();
		}
		const was = { provider: s.provider, questionSource: s.questionSource, gradingMode: s.gradingMode };
		s.provider = "grillcloud";
		// Grill Cloud is for AI questions and AI grading: turning it on turns those on.
		s.questionSource = "ai";
		s.gradingMode = "ai";
		await this.persist();
		// That save reads the file first, and may have found another device's key there.
		const key = s.apiKeys.grillcloud;
		await this.linkCloudCheckout(key);
		const r = await cloudStart(key);
		if (!r.ok) {
			// Not reached: the key is kept (asking again uses it), but how Grill studies
			// goes back to what it was, so nobody is left on a mode that can't work.
			Object.assign(s, was);
			await this.persist();
			this.cloudState = r.offline ? "offline" : "refused";
			this.cloudNote = r.message;
			this.tellCloud();
			return r.message;
		}
		await this.refreshCloud();
		this.tellCloud();
		const credits = r.data.credits;
		if (r.data.granted) return `Grill Cloud is on. You have ${credits} free credits to start.`;
		if (credits > 0) return `Grill Cloud is on. ${creditsInWords(credits)}.`;
		return "Grill Cloud is on, with no free credits this time. Add credits in settings to begin.";
	}

	/** Put the key in use aside (never thrown away: it may still hold a balance). */
	private retireCloudKey(): void {
		const s = this.data.settings;
		const old = s.apiKeys.grillcloud;
		s.apiKeys.grillcloud = "";
		if (isCloudKey(old)) s.retiredCloudKeys = [old, ...s.retiredCloudKeys.filter((k) => k !== old)];
		this.keepRetired();
		// A copy Grill 6.2.0 left in the keychain must not bring it back.
		this.keys.dropUnkept();
		this.cloudPacks = [];
		this.cloudCredits = null;
		this.cloudPurchases = null;
		this.cloudState = "unknown";
		this.cloudNote = "";
	}

	/** Switch this vault to a key made elsewhere, to share that balance. Only a key the
	 * server already has an account for: a mistyped one would otherwise quietly become
	 * a new, empty account. Returns what went wrong, or null. */
	async useCloudKey(key: string): Promise<string | null> {
		if (this.cloudGone.has(key) || this.data.settings.cloudGone.includes(await cloudAccount(key))) {
			return "That key's account was deleted from this vault, so it can't be used again. Start free makes a new one.";
		}
		const r = await cloudBalance(key);
		if (!r.ok) return r.message;
		if (!r.data.account) return "No Grill Cloud account has that key. Check it was copied whole.";
		this.stopCloudWatch();
		this.retireCloudKey();
		const s = this.data.settings;
		s.apiKeys.grillcloud = key;
		// A key being brought back is in use again, not an earlier one.
		s.retiredCloudKeys = s.retiredCloudKeys.filter((k) => k !== key);
		this.cloudGone.delete(key);
		await this.persist();
		this.cloudCredits = r.data.credits;
		this.cloudPurchases = r.data.purchases;
		this.cloudSales = r.data.sales;
		this.cloudSpeech = r.data.speech === true;
		this.cloudState = "ok";
		await this.linkCloudCheckout(key);
		this.tellCloud();
		return null;
	}

	/** Erase this vault's Grill Cloud account on the server and forget its key. Any
	 * credits left on it are gone. The key is only dropped once the server confirms
	 * (or says there is no such account). Returns what went wrong, or null. */
	async deleteCloud(): Promise<string | null> {
		const s = this.data.settings;
		const key = s.apiKeys.grillcloud;
		if (!isCloudKey(key)) return "There's no Grill Cloud key in this vault.";
		const r = await cloudDelete(key);
		if (!r.ok) return r.message;
		this.stopCloudWatch();
		// Deleted for good, so it isn't kept among the earlier keys either, and a stale
		// copy of it elsewhere is never taken back.
		this.cloudGone.add(key);
		if (this.deviceCloudKey() === key) this.setDeviceCloudKey("");
		const goneId = await cloudAccount(key);
		this.addDeviceCloudGone(goneId);
		s.cloudGone = [...new Set([...s.cloudGone, goneId])].slice(-GONE_KEYS_KEPT);
		s.apiKeys.grillcloud = "";
		this.keepRetired();
		this.keys.dropUnkept();
		this.clearCloudState();
		// This device's own record first: it holds even if the shared file can't be saved.
		this.saveCloudBackup();
		try {
			await this.persist();
		} catch (e) {
			console.error("Grill: couldn't save settings after deleting the Grill Cloud account", e);
		}
		this.tellCloud();
		return null;
	}

	/** Stop using the key in this vault without touching the server. It is kept among
	 * the earlier keys. */
	async forgetCloudKey(): Promise<void> {
		this.stopCloudWatch();
		this.retireCloudKey();
		await this.persist();
		this.tellCloud();
	}

	/** Open the checkout page for one pack (the largest, if none is named) for this
	 * vault's Grill Cloud account, then keep an eye on the server so the credits show
	 * up by themselves when the payment lands. */
	openCloudCheckout(link?: string): void {
		if (!this.cloudCanBuy) return;
		// A link from a screen drawn before the key changed opens nothing.
		const pack = link === undefined ? this.cloudPacks[this.cloudPacks.length - 1] : this.cloudPacks.find((p) => p.link === link);
		if (!pack) return;
		window.open(pack.link);
		this.watchCloudTopUp();
		this.tellCloud();
	}

	/** Set while a purchase is being waited for: the balance when the wait began. */
	cloudWaitingFrom: number | null = null;
	/** The purchase count when the wait began (null until the server has said). A
	 * purchase arriving is this count going up; nothing else moves it. */
	private cloudWaitingPurchases: number | null = null;
	/** Whether the balance the wait is measured from was a real one. */
	private cloudWaitingKnown = false;
	/** Told when a waited-for purchase arrives (or the wait ends), so the settings tab
	 * can redraw and count the number up. */
	cloudArrived: ((from: number, to: number) => void) | null = null;
	private cloudWatchTimer: number | null = null;
	private cloudChecking = false;

	/** One look during a wait. True once a purchase has been credited: the wait is
	 * over, the user is told, and whoever is listening gets the old and new balance. */
	async checkCloudTopUp(): Promise<boolean> {
		// The timer and a return to the window can both ask at once; one look at a time.
		if (this.cloudWaitingFrom === null || this.cloudChecking) return false;
		this.cloudChecking = true;
		try {
			await this.refreshCloud();
		} finally {
			this.cloudChecking = false;
		}
		// Read after the answer: the wait may have ended, or its starting point moved.
		const from = this.cloudWaitingFrom;
		const to = this.cloudCredits;
		const purchases = this.cloudPurchases;
		if (from === null || to === null || purchases === null) return false;
		// The wait began before the server had said how many purchases there were. This
		// first answer is the starting point, unless the balance has already jumped by
		// a pack's worth: then the purchase beat the first look, and that is an arrival.
		if (this.cloudWaitingPurchases === null) {
			const smallest = Math.min(...cloud.packs.map((p) => p.credits));
			if (!(this.cloudWaitingKnown && purchases > 0 && to - from >= smallest)) {
				this.cloudWaitingPurchases = purchases;
				if (!this.cloudWaitingKnown || to < from) this.cloudWaitingFrom = to;
				this.cloudWaitingKnown = true;
				return false;
			}
		} else if (purchases <= this.cloudWaitingPurchases) return false;
		this.stopCloudWatch(true);
		const added = to - from;
		new Notice(
			added > 0 ? `Grill: ${added.toLocaleString("en-US")} credits added. You have ${to.toLocaleString("en-US")}.` : `Grill: your purchase arrived. You have ${to.toLocaleString("en-US")} credits.`,
			6000,
		);
		try {
			this.cloudArrived?.(Math.min(from, to), to);
		} catch (e) {
			console.error("Grill: settings failed to redraw", e);
		}
		this.tellCloud();
		return true;
	}

	/** End the wait, whether or not anything arrived. */
	stopCloudWatch(quiet = false): void {
		const waiting = this.cloudWaitingFrom !== null;
		this.cloudWaitingFrom = null;
		this.cloudWaitingPurchases = null;
		if (this.cloudWatchTimer !== null) window.clearInterval(this.cloudWatchTimer);
		this.cloudWatchTimer = null;
		window.removeEventListener("focus", this.cloudOnFocus);
		if (waiting && !quiet) {
			try {
				this.cloudArrived?.(this.cloudCredits ?? 0, this.cloudCredits ?? 0);
			} catch (e) {
				console.error("Grill: settings failed to redraw", e);
			}
			this.tellCloud();
		}
	}

	/** Coming back from the browser is the likeliest moment the payment has landed. */
	private cloudOnFocus = (): void => void this.checkCloudTopUp();

	/** Check every few seconds, and whenever Obsidian regains focus, for ten minutes. */
	private watchCloudTopUp(): void {
		this.stopCloudWatch(true);
		this.cloudWaitingFrom = this.cloudCredits ?? 0;
		this.cloudWaitingKnown = this.cloudCredits !== null;
		this.cloudWaitingPurchases = this.cloudState === "ok" || this.cloudState === "none" ? this.cloudPurchases : null;
		let checks = 0;
		this.cloudWatchTimer = window.setInterval(() => {
			if (++checks > 150) {
				this.stopCloudWatch();
				return;
			}
			void this.checkCloudTopUp();
		}, 4000);
		this.registerInterval(this.cloudWatchTimer);
		window.addEventListener("focus", this.cloudOnFocus);
	}

	/** The settings in memory always hold the live API keys; what's written to
	 * data.json has them blanked wherever the keychain holds them (see secrets.ts). */
	async persist(): Promise<void> {
		// Another device may have put a Grill Cloud key in the file since it was read:
		// this save must not blank it.
		const took = await this.mergeCloudFromDisk();
		const s = this.data.settings;
		const apiKeys = this.keys.stash(s.apiKeys);
		await this.saveData({ ...this.data, settings: { ...s, apiKeys } });
		this.saveCloudBackup();
		if (took) {
			void this.refreshCloud().then(() => this.tellCloud());
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}

/** How many replaced Grill Cloud keys a vault keeps, in case one still has credits. */
const RETIRED_KEYS_KEPT = 20;
/** Where the key in use is noted for the other vaults on this device. */
const DEVICE_CLOUD_KEY = "grill-cloud-device-key";
const DEVICE_CLOUD_GONE = "grill-cloud-device-gone";
/** How many deleted keys' ids are remembered. */
const GONE_KEYS_KEPT = 50;
const isAccountId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

const CUSTOM = "__custom__";

const TUNING_NAME = "Tuning";
const TUNING_DESC =
	"Changing one sets Study intensity to Custom.";

/** Run a number up from `from` to `to` in an element's text, over about a second,
 * easing out. Skipped (the final text is simply set) for people who ask for reduced
 * motion, and wherever animation frames aren't available. */
function countUp(el: HTMLElement, from: number, to: number, text: (n: number) => string): void {
	const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (still || typeof window.requestAnimationFrame !== "function") {
		el.setText(text(to));
		return;
	}
	const started = performance.now();
	const step = (now: number): void => {
		const t = Math.min(1, (now - started) / 1100);
		const eased = 1 - Math.pow(1 - t, 3);
		el.setText(text(Math.round(from + (to - from) * eased)));
		if (t < 1) window.requestAnimationFrame(step);
	};
	window.requestAnimationFrame(step);
}

/** One settings row, described once. display() (Obsidian before 1.13) and
 * getSettingDefinitions() (1.13+, which is what makes the rows searchable) both render
 * from the same list, so the two can't drift apart. `build` receives a row that already
 * has its name and description set. */
interface Row {
	name: string;
	desc?: string;
	/** Extra words the settings search should find this row by. */
	aliases?: string[];
	/** Returns whatever the builder chain returns; it's ignored. */
	build: (setting: Setting) => unknown;
}

interface Section {
	heading: string;
	rows: Row[];
}

export class GrillSettingTab extends PluginSettingTab {
	plugin: GrillPlugin;
	/** Live model lists, cached per provider for the lifetime of the tab. */
	private modelLists: Partial<Record<ProviderId, string[]>> = {};
	private fetching: Partial<Record<ProviderId, boolean>> = {};
	/** Why the last model-list fetch came back empty, when it said. */
	private modelProblems: Partial<Record<ProviderId, string>> = {};
	private showCustomModel = false;
	/** Whether Grill Cloud has been asked for the balance since the tab was opened. */
	private cloudAsked = false;
	private showCloudKey = false;
	private showRetiredKeys = false;
	/** Whether the key row is opened up to its controls. */
	private manageKey = false;
	/** A key being typed in from another vault; applied only by its button. */
	private cloudKeyDraft = "";
	/** Set by the first press on a replacement, so the second one does it. */
	private cloudKeyConfirm = false;
	/** The same, for deleting the account. */
	private cloudDeleteConfirm = false;
	/** Set when a purchase has just landed: the balance to count up from on the next draw. */
	private cloudCountFrom: number | null = null;
	/** Guards against attaching a duplicate voiceschanged listener on every display(). */
	private voicesListenerAttached = false;

	constructor(app: App, plugin: GrillPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.addClass("grill-settings");
	}

	/** Closing the tab forgets everything about the Grill Cloud key rows: the key goes
	 * back to hidden, a half-typed replacement is dropped, the balance is asked for
	 * again next time. */
	hide(): void {
		this.cloudAsked = false;
		this.showCloudKey = false;
		this.showRetiredKeys = false;
		this.manageKey = false;
		this.cloudKeyDraft = "";
		this.cloudKeyConfirm = false;
		this.cloudDeleteConfirm = false;
		this.cloudCountFrom = null;
		this.plugin.cloudArrived = null;
		super.hide();
	}

	/** Re-render after a change that adds, removes or rewords rows. Obsidian 1.13+
	 * renders from getSettingDefinitions() and never calls display(), so there the
	 * definitions are rebuilt instead. */
	private rerender(): void {
		const update = (this as unknown as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.display();
	}

	/** A slider whose current value is shown inline next to it. */
	private sliderRow(
		name: string,
		desc: string,
		min: number,
		max: number,
		value: number,
		format: (v: number) => string,
		onChange: (v: number) => Promise<void>,
	): Row {
		return {
			name,
			desc: desc || undefined,
			build: (setting) => {
				// Obsidian 1.13 always shows the slider's value inline itself (setDynamicTooltip is
				// deprecated because of it) and added setDisplayFormat to customize that display —
				// so on 1.13+, adding our own value span next to it just prints the number twice.
				// Feature-detected (not a minAppVersion bump) so this still renders correctly, just
				// without the friendly formatting, on the older Obsidian versions Grill supports.
				let valueEl: HTMLSpanElement | null = null;
				setting.addSlider((sl) => {
					const hasDisplayFormat =
						typeof (sl as unknown as { setDisplayFormat?: unknown }).setDisplayFormat === "function";
					if (hasDisplayFormat) {
						(sl as unknown as { setDisplayFormat: (f: (v: number) => string) => void }).setDisplayFormat(format);
					} else {
						valueEl = setting.controlEl.createSpan({ cls: "grill-slider-value", text: format(value) });
					}
					return sl
						.setLimits(min, max, 1)
						.setValue(value)
						.onChange(async (v) => {
							valueEl?.setText(format(v));
							await onChange(v);
						});
				});
			},
		};
	}

	private async refreshModels(p: ProviderId): Promise<void> {
		if (this.fetching[p]) return;
		this.fetching[p] = true;
		const s = this.plugin.data.settings;
		const hadProblem = this.modelProblems[p];
		const { models, problem } = await listModels(p, s.apiKeys[p], p === "custom" ? s.customBaseUrl : s.ollamaUrl);
		this.fetching[p] = false;
		if (models.length) this.modelLists[p] = models;
		if (problem) this.modelProblems[p] = problem;
		else delete this.modelProblems[p];
		if (models.length || problem !== hadProblem) this.rerender();
	}

	/** Reset the behavioural settings to the recommended defaults, keeping the user's
	 * credentials, provider, and folder choices.
	 *
	 * Every one-time migration flag is carried across too, not just `conceptsMigrated`.
	 * They aren't preferences — they record that a coercion has already happened — so
	 * resetting them to false re-armed each migration to fire again on the next plugin
	 * load, which silently undid a deliberate post-Restore choice of `newConceptsPerDay`
	 * 0 or `graphNumberMode` "off": exactly what the flags exist to prevent (see their
	 * doc comments on GrillSettings). */
	private async restoreDefaults(): Promise<void> {
		const s = this.plugin.data.settings;
		this.plugin.data.settings = {
			...defaultSettings(),
			provider: s.provider,
			apiKeys: s.apiKeys,
			models: s.models,
			ollamaUrl: s.ollamaUrl,
			customBaseUrl: s.customBaseUrl,
			folder: s.folder,
			includedFolders: s.includedFolders,
			excludedFolders: s.excludedFolders,
			onboarded: s.onboarded,
			dismissedOffers: s.dismissedOffers,
			retiredCloudKeys: s.retiredCloudKeys,
			cloudUsage: s.cloudUsage,
			cloudGone: s.cloudGone,
			conceptsMigrated: s.conceptsMigrated,
			legacyDefaultsMigrated: s.legacyDefaultsMigrated,
			newConceptsCapMigrated: s.newConceptsCapMigrated,
			intensityMigrated: s.intensityMigrated,
			modelsMigrated61: s.modelsMigrated61,
			modelsMigrated62: s.modelsMigrated62,
			arcBackfilled: s.arcBackfilled,
			fsrsLastFitAttemptReviews: s.fsrsLastFitAttemptReviews,
		};
		// defaultSettings() nulls fsrsPersonalization, but the fitted weights are also
		// held in ts-fsrs' own module-level config — without this they stay live for the
		// rest of the session and only actually reset on the next Obsidian reload. The
		// dedicated reset button does this; Restore has to as well.
		configureFSRSWeights(null);
		await this.plugin.persist();
		new Notice("Grill: restored the recommended settings.");
		this.rerender();
	}

	/** Read-aloud voice: one dropdown where there used to be two (a language picker plus a
	 * voice picker, 50 lines for a single `speak()` call site). Every state that pair could
	 * express still exists here — full auto, "always this language, best voice for it", and
	 * one exact pinned voice — as entries in one grouped list, so it stays a single choice
	 * instead of a two-step one where the second step is disabled until the first is made.
	 * Values are prefixed (`lang:` / `voice:`) rather than raw, so a voiceURI can never be
	 * mistaken for a language code. */
	/** The switch for a natural read-aloud voice, saying plainly where the text goes
	 * and what it costs, and why it is unavailable when it is. */
	private naturalVoiceRow(s: GrillSettings): Row {
		const source = this.plugin.naturalVoiceSource();
		return {
			name: "Natural voice",
			desc:
				source === "cloud"
					? "A natural AI voice for read-aloud. About 5 credits per 1,000 characters. The text read is sent to OpenAI. Off uses your device's voice, free."
					: source === "openai"
						? "A natural AI voice for read-aloud, on your OpenAI key."
						: `Needs ${cloudEnabled() ? "Grill Cloud or " : ""}an OpenAI key.`,
			aliases: ["text to speech", "tts", "read aloud", "speech", "audio"],
			build: (setting) =>
				setting.addToggle((t) =>
					t
						.setValue(source !== null && s.naturalVoice)
						.setDisabled(source === null)
						.onChange(async (v) => {
							s.naturalVoice = v;
							await this.plugin.persist();
						}),
				),
		};
	}

	private voiceRow(s: GrillSettings): Row {
		return {
			name: "Read-aloud voice",
			desc: "Your device's voice. Automatic picks by language.",
			aliases: ["text to speech", "tts", "language"],
			build: (setting) => {
				const langs = listLanguages();
				// getVoices() can be empty on the very first call — the browser loads its voice
				// list asynchronously. Re-render once it actually arrives, same pattern as
				// refreshModels' re-render on late data.
				if (langs.length === 0) {
					setting.setDesc("No voices found yet — reopen Settings in a moment.");
					if (!this.voicesListenerAttached) {
						this.voicesListenerAttached = true;
						onVoicesChanged(() => this.rerender());
					}
				}
				setting.addDropdown((d) => {
					d.addOption("", "Automatic");
					for (const l of langs) {
						// Obsidian's DropdownComponent has no optgroup API, so the group is added to
						// its select element directly — options nested in an optgroup are still
						// found by setValue/value, so the component keeps working normally.
						const group = d.selectEl.createEl("optgroup", { attr: { label: l.label } });
						group.createEl("option", { value: `lang:${l.code}`, text: `Best ${l.label} voice` });
						for (const v of listVoicesForLang(l.code)) {
							group.createEl("option", { value: `voice:${v.voiceURI}`, text: v.name });
						}
					}
					d.setValue(s.ttsVoiceURI ? `voice:${s.ttsVoiceURI}` : s.ttsLanguage ? `lang:${s.ttsLanguage}` : "");
					d.onChange(async (v) => {
						if (v.startsWith("voice:")) {
							const uri = v.slice("voice:".length);
							s.ttsVoiceURI = uri;
							// Keep `lang` in step with the pinned voice so the two fields never
							// disagree — speak() prefers the URI, but the language is what it falls
							// back to if that voice is later uninstalled.
							const voice = listVoices().find((x) => x.voiceURI === uri);
							s.ttsLanguage = voice ? voice.lang.split(/[-_]/)[0].toLowerCase() : s.ttsLanguage;
						} else if (v.startsWith("lang:")) {
							s.ttsLanguage = v.slice("lang:".length);
							s.ttsVoiceURI = "";
						} else {
							s.ttsLanguage = "";
							s.ttsVoiceURI = "";
						}
						await this.plugin.persist();
					});
				});
			},
		};
	}

	/** The escape hatch: every number the engine schedules on, reachable but never asked
	 * about. Deliberately NOT a persisted preference — before Obsidian 1.13 it's a native
	 * <details> that collapses again on every reopen, on 1.13+ a sub-page you have to walk
	 * into. The previous round of this used a sticky "Show advanced settings" toggle, which
	 * is what let the tab re-accrete: once a power user flipped it on, adding one more
	 * setting behind it was free. A click every time is the friction that keeps the default
	 * surface honest. */
	private tuningRows(): Row[] {
		const s = this.plugin.data.settings;

		/** Editing any raw scheduling number means the preset no longer describes them. */
		const toCustom = async (): Promise<void> => {
			s.studyIntensity = "custom";
			await this.plugin.persist();
		};

		const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

		return [
			this.sliderRow(
				"Review frequency",
				"FSRS's target recall probability at each concept's due date. Lower brings concepts back sooner (more " +
					"reviews, progress feels faster); higher spaces them further apart (fewer reviews, longer " +
					"before something you know comes back around).",
				70,
				97,
				Math.min(Math.max(s.desiredRetention, 70), 97),
				(v) => `${v}%`,
				async (v) => {
					s.desiredRetention = v;
					await toCustom();
				},
			),
			this.sliderRow(
				"New concepts per day",
				"Caps how many never-before-tested concepts \"Get grilled\" will introduce per calendar day. Once " +
					"hit, sessions fill remaining slots by reviewing what's already due instead, so a few missed " +
					"days can't leave the due queue permanently outrunning what you can actually review. 0 = no new " +
					"concepts at all, ever — pure review. Only governs \"Get grilled\": a deliberately scoped session " +
					"(\"Grill this note/folder\", a committed Custom Study pick) is never throttled by this.",
				0,
				100,
				Math.min(Math.max(s.newConceptsPerDay, 0), 100),
				(v) => (v === 0 ? "None" : `${v}/day`),
				async (v) => {
					s.newConceptsPerDay = v;
					await toCustom();
				},
			),
			this.sliderRow(
				"New material share",
				"The most a single session lets new/untested material claim, whenever it's allowed to claim any " +
					"room at all (see the toggle below).",
				0,
				100,
				Math.min(Math.max(s.freshContentShare, 0), 100),
				(v) => `${v}%`,
				async (v) => {
					s.freshContentShare = v;
					await toCustom();
				},
			),
			{
				name: "Always guarantee new material",
				desc: "Keep room for new material even when reviews are piling up.",
				build: (setting) =>
					setting.addToggle((t) =>
						t.setValue(s.freshContentAlwaysGuarantee).onChange(async (v) => {
							s.freshContentAlwaysGuarantee = v;
							await toCustom();
						}),
					),
			},
			{
				name: "Light review days",
				desc: `Weekdays to steer new reviews away from. Order: ${WEEKDAY_NAMES.join(", ")}.`,
				aliases: ["easy days", "weekend"],
				build: (setting) => {
					WEEKDAY_NAMES.forEach((full, weekday) => {
						setting.addToggle((t) =>
							t
								.setTooltip(full)
								.setValue(s.easyDays.includes(weekday))
								.onChange(async (v) => {
									s.easyDays = v ? [...new Set([...s.easyDays, weekday])] : s.easyDays.filter((d) => d !== weekday);
									await this.plugin.persist();
								}),
						);
					});
				},
			},
			this.sliderRow(
				"Grade weighting",
				"How much a graph node's number weighs coverage (how much of the note you've confirmed, capped so a " +
					"long note isn't penalised for its length) against mastery (how well you'd recall what you've " +
					"actually studied right now). Left: pure mastery. Right: pure coverage.",
				0,
				100,
				s.graphCoverageWeight,
				(v) => `${v}% coverage`,
				async (v) => {
					s.graphCoverageWeight = v;
					await this.plugin.persist();
					this.plugin.refreshMapDisplay();
				},
			),
			// Fitting runs itself once there's enough review history (see
			// GrillPlugin.maybeAutoOptimizeFsrs) — there's no "Optimize now" button here
			// because being asked to press it was the setting. What's left is the status, so
			// "personalized" isn't a black box, and a way back to the shared defaults.
			{
				name: "Personalized FSRS weights",
				desc: "Scheduling fitted to your own review history.",
				build: (setting) => {
					// Read here, not when the rows are listed: the definitions are first built
					// while the plugin is still loading, before the concept store exists.
					const trainable = countTrainableReviews(this.plugin.concepts);
					const fp = s.fsrsPersonalization;
					setting.setDesc(
						fp
							? `Active: fit from ${fp.reviewCount} reviews on ${new Date(fp.fitAt).toLocaleDateString()}, ` +
									`${fp.improvementPct.toFixed(1)}% tighter fit than the library defaults on this vault's own data at the time. ` +
									"Refits itself as more review history accumulates."
							: `Not yet: scheduling runs on FSRS-6's library defaults, fit across a large pooled population, not this vault. ` +
									`Grill fits your own weights automatically at ${MIN_REVIEWS_FOR_OPTIMIZATION} real reviews (${trainable} so far).`,
					);
					setting.addButton((b) => {
						b.setButtonText("Reset to library defaults").setDisabled(!fp);
						if (fp) {
							b.onClick(async () => {
								s.fsrsPersonalization = null;
								configureFSRSWeights(null);
								await this.plugin.persist();
								new Notice("Grill: FSRS parameters reset to the library defaults.");
								this.rerender();
							});
						}
						return b;
					});
				},
			},
			{
				name: "Grill folder",
				desc: "Where Grill keeps its data and session notes.",
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Grill")
							.setValue(s.folder)
							.onChange(async (v) => {
								s.folder = v.trim() || "Grill";
								await this.plugin.persist();
							}),
					),
			},
			{
				name: "Restore recommended settings",
				desc: "Reset to defaults. Keys, provider and folders are kept.",
				aliases: ["reset"],
				build: (setting) => setting.addButton((b) => b.setButtonText("Restore").onClick(() => void this.restoreDefaults())),
			},
		];
	}

	/** Every row outside Tuning, in the order the page shows them. `all` also lists
	 * the rows the current state hides (another provider's fields, the custom model
	 * box): the 1.13+ definitions are built once and need every row that could appear. */
	private sections(all = false): Section[] {
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];
		const inKeychain = this.plugin.keys.available;

		// ------------------------------------------------------------ AI
		// One control where there used to be two independent dropdowns (questionSource +
		// gradingMode). All four combinations they could express are still here — including
		// notes-built questions with AI marking, the cheapest way to get graded feedback —
		// but as four named ways to study rather than a matrix the reader has to multiply
		// out themselves. Same wording as the onboarding cards, so the choice made there is
		// recognisable here.
		const MODES: Record<string, { source: "ai" | "local"; grading: "ai" | "self" }> = {
			ai: { source: "ai", grading: "ai" },
			"ai-self": { source: "ai", grading: "self" },
			"local-ai": { source: "local", grading: "ai" },
			local: { source: "local", grading: "self" },
		};
		const mode =
			Object.keys(MODES).find((k) => MODES[k].source === s.questionSource && MODES[k].grading === s.gradingMode) ?? "ai";

		const ai: Row[] = [
			{
				name: "Study mode",
				desc: "Where questions come from and who marks them.",
				aliases: ["offline", "grading", "no key", "self grade"],
				build: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOption("ai", "AI writes and grades")
							.addOption("ai-self", "AI writes, I grade myself")
							.addOption("local-ai", "From my notes, AI grades")
							.addOption("local", "Fully offline — no key")
							.setValue(mode)
							.onChange(async (v) => {
								const picked = MODES[v] ?? MODES.ai;
								s.questionSource = picked.source;
								s.gradingMode = picked.grading;
								await this.plugin.persist();
								this.rerender();
							}),
					),
			},
			{
				name: "Provider",
				desc: (cloudEnabled() && p === "grillcloud" ? "Grill Cloud is in use. " : "") + "Whose model to use with your own key. Ollama runs on your machine.",
				aliases: ["anthropic", "claude", "openai", "chatgpt", "gemini", "deepseek", "ollama", "openrouter", "local", ...(cloudEnabled() ? ["grill cloud", "credits"] : [])],
				build: (setting) =>
					setting.addDropdown((d) => {
						for (const [id, pi] of offeredProviders()) d.addOption(id, pi.label);
						d.setValue(p).onChange(async (v) => {
							s.provider = v as ProviderId;
							this.showCustomModel = false;
							this.cloudKeyConfirm = false;
							this.cloudDeleteConfirm = false;
							await this.plugin.persist();
							this.rerender();
							void this.refreshModels(v as ProviderId);
						});
					}),
			},
		];

		const keyField = (setting: Setting): void => {
			setting.addText((t) => {
				t.setPlaceholder(info.keyPlaceholder)
					.setValue(s.apiKeys[p])
					.onChange(async (v) => {
						s.apiKeys[p] = v.trim();
						delete this.modelLists[p];
						delete this.modelProblems[p];
						await this.plugin.persist();
					});
				t.inputEl.type = "password";
			});
		};
		const keyHome = inKeychain
			? "Kept in Obsidian's keychain. Each device needs it once."
			: "Stored in this vault's plugin data.";

		const baseUrlRow: Row = {
			name: "Base URL",
			desc: "Any OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1.",
			build: (setting) =>
				setting.addText((t) =>
					t
						.setPlaceholder("https://openrouter.ai/api/v1")
						.setValue(s.customBaseUrl)
						.onChange(async (v) => {
							s.customBaseUrl = v.trim();
							delete this.modelLists.custom;
							delete this.modelProblems.custom;
							await this.plugin.persist();
						}),
				),
		};
		const cloudKey = s.apiKeys.grillcloud;
		const credits = this.plugin.cloudCredits;
		const state = this.plugin.cloudState;
		const waiting = this.plugin.cloudWaitingFrom !== null;
		const usingCloud = p === "grillcloud";
		const creditsLine = (n: number): string => `${usingCloud ? "In use" : "Not in use"}. ${creditsInWords(n)}.`;
		const start = (setting: Setting, label: string, cta: boolean): void => {
			setting.addButton((b) => {
				b.setButtonText(label).onClick(async () => {
					b.setDisabled(true);
					try {
						new Notice(`Grill: ${await this.plugin.startCloud()}`, 8000);
					} finally {
						this.rerender();
					}
				});
				if (cta) b.setCta();
				return b;
			});
		};
		// Grill Cloud has the first section of the page to itself, whichever provider is
		// in use, drawn as one card in Grill's own colours (themes restyle settings rows,
		// and a plain row doesn't sell anything): what it is, or the balance and what
		// sessions have cost, then the packs. The row's name and description are still
		// set, for the settings search; the card says the same in its own way.
		const usage = usageInWords(s.cloudUsage);
		const cloudRow: Row = {
			name: "Grill Cloud",
			desc: !cloudKey
				? "AI questions and grading, with nothing to set up."
				: state === "offline"
					? "Couldn't reach Grill Cloud."
					: state === "refused"
						? this.plugin.cloudNote
						: state === "none"
							? "No credits yet."
							: credits === null
								? "Checking your balance..."
								: waiting
									? `${creditsInWords(credits)}. Checkout is open in your browser. Credits show up here a few seconds after you pay.`
									: creditsLine(credits) + (usingCloud ? "" : " Another provider is selected below."),
			aliases: ["credits", "hosted", "no key", "no api key", "balance", "cloud", "free", "trial", "top up", "buy", "pay", "price"],
			build: (setting) => {
				setting.settingEl.addClass("grill-cloud-hero");
				const card = setting.settingEl.createDiv({ cls: "grill-view" }).createDiv({ cls: "grill-arcade-screen grill-cloud-card" });
				const head = card.createDiv({ cls: "grill-cloud-card-head" });
				head.createSpan({ cls: "grill-arcade-mark", text: "GRILL CLOUD" });
				// Top right: check balance, then whether it's in use.
				const corner = head.createDiv({ cls: "grill-cloud-card-corner" });
				const body = card.createDiv({ cls: "grill-cloud-card-body" });
				// The buttons are Obsidian's own, moved into the card.
				const controls = card.createDiv({ cls: "grill-cloud-buy" });
				controls.appendChild(setting.controlEl);
				// Obsidian redraws a row in place, so the card from the last draw is still
				// here: take it away now that the buttons have moved into the new one.
				setting.settingEl.querySelectorAll(":scope > .grill-view").forEach((old) => {
					if (!old.contains(card)) old.remove();
				});
				if (!cloudKey) {
					// Said before anything is sent: what it costs, what it needs, where notes go.
					body.createDiv({ cls: "grill-cloud-panel-lead", text: "AI writes and grades questions from your notes. Nothing to set up." });
					if (this.plugin.sharesDeviceCloud()) body.createDiv({ cls: "grill-meta", text: "You already use Grill Cloud in another vault on this device. Starting here uses the same balance." });
					const facts = body.createDiv({ cls: "grill-cloud-facts" });
					for (const fact of CLOUD_FACTS) facts.createDiv({ cls: "grill-cloud-fact", text: fact });
					const more = body.createEl("details", { cls: "grill-cloud-more" });
					more.createEl("summary", { text: "What exactly is sent?" });
					more.createEl("p", { text: CLOUD_PITCH });
					if (cloud.privacyUrl || cloud.termsUrl) {
						const legal = card.createDiv({ cls: "grill-cloud-agree grill-meta" });
						legal.appendText("For ages 18 and over. By starting you agree to the ");
						if (cloud.termsUrl) legal.createEl("a", { text: "terms", href: cloud.termsUrl });
						if (cloud.privacyUrl && cloud.termsUrl) legal.appendText(" and the ");
						if (cloud.privacyUrl) legal.createEl("a", { text: "privacy policy", href: cloud.privacyUrl });
						legal.appendText(".");
					}
					start(setting, "Start free", true);
					return;
				}
				const known = (state === "ok" || state === "none") && credits !== null;
				// No number until the server has said one: a placeholder reads as a balance.
				const figure = body.createDiv({ cls: "grill-cloud-balance" });
				const number = figure.createSpan({ cls: "grill-cloud-balance-number", text: known ? (credits ?? 0).toLocaleString("en-US") : "" });
				if (known) figure.createSpan({ cls: "grill-cloud-balance-unit", text: "credits" });
				body.createDiv({
					cls: "grill-meta",
					text:
						state === "offline" || state === "refused"
							? this.plugin.cloudNote || "Couldn't reach Grill Cloud."
							: state === "none"
								? "No credits yet."
								: !known
									? "Checking your balance..."
									: waiting
										? "Checkout is open in your browser. Credits show up here a few seconds after you pay."
										: usage,
				});
				card.toggleClass("grill-cloud-waiting", waiting);
				if (!usingCloud) {
					setting.addButton((b) =>
						b
							.setButtonText("Use Grill Cloud")
							.setCta()
							.onClick(async () => {
								s.provider = "grillcloud";
								s.questionSource = "ai";
								s.gradingMode = "ai";
								await this.plugin.persist();
								this.rerender();
							}),
					);
				}
				if (waiting) {
					setting.addButton((b) =>
						b.setButtonText("Stop checking").onClick(() => {
							this.plugin.stopCloudWatch();
							this.rerender();
						}),
					);
				} else {
					if (state === "none") start(setting, "Try free credits", false);
					if (this.plugin.cloudCanBuy) {
						const packs = this.plugin.cloudPacks;
						for (const pack of packs) {
							setting.addButton((b) => {
								b.setButtonText(packLabel(pack)).onClick(() => {
									this.plugin.openCloudCheckout(pack.link);
									this.rerender();
								});
								if (usingCloud && pack === packs[packs.length - 1]) b.setCta();
								return b;
							});
						}
						card.createDiv({ cls: "grill-cloud-card-foot", text: "Checkout by Stripe. Credits arrive here in a few seconds." });
					}
				}
				// The policies: there when wanted, as a line of small print, not a row of their own.
				if (cloud.privacyUrl || cloud.termsUrl) {
					const legal = card.createDiv({ cls: "grill-cloud-card-foot grill-cloud-legal" });
					if (cloud.privacyUrl) legal.createEl("a", { text: "Privacy", href: cloud.privacyUrl });
					if (cloud.termsUrl) legal.createEl("a", { text: "Terms", href: cloud.termsUrl });
				}
				setting.addExtraButton((b) => {
					b.setIcon("refresh-cw")
						.setTooltip("Check balance")
						.onClick(async () => {
							await this.plugin.refreshCloud();
							this.rerender();
						});
					// Up in the corner, out of the row of pack buttons, which needs its width.
					if (b.extraSettingsEl) corner.appendChild(b.extraSettingsEl);
					return b;
				});
				corner.createSpan({ cls: usingCloud ? "grill-cloud-chip is-on" : "grill-cloud-chip", text: usingCloud ? "In use" : "Not in use" });
				// When a purchase lands (or the wait ends) while this tab is open: redraw,
				// and count the balance up from the old number to the new one.
				this.plugin.cloudArrived = (from, to) => {
					this.cloudCountFrom = to > from ? from : null;
					this.rerender();
				};
				if (this.cloudCountFrom !== null && credits !== null) {
					const from = this.cloudCountFrom;
					this.cloudCountFrom = null;
					countUp(number, from, credits, (n) => n.toLocaleString("en-US"));
					card.addClass("grill-cloud-arrived");
				}
				// Ask once each time the tab is opened; a server that can't be reached
				// isn't asked again on every re-render.
				if (!this.cloudAsked) {
					this.cloudAsked = true;
					void this.plugin.refreshCloud().then(() => this.rerender());
				}
			},
		};
		// The key is the balance, so it is never an editable field: one stray keystroke
		// in a password box would otherwise replace it. It can be shown, to save it or
		// carry it to another vault, and replaced only by a key the server knows, on a
		// second press. A replaced key is kept, not thrown away.
		const retired = s.retiredCloudKeys.length;
		const cloudKeyRow: Row = {
			name: "Account",
			desc: !this.manageKey
				? "One balance for every vault on this device."
				: "Enter this key on another device to use the same balance there. Keep it private." +
					(retired ? ` ${retired} earlier ${retired === 1 ? "key" : "keys"} kept.` : ""),
			aliases: ["credits", "another device", "sync", "cloud", "delete account", "key", "grill cloud key", "backup"],
			build: (setting) => {
				setting.settingEl.addClass("grill-cloud-row");
				// One line until asked for: these controls are rarely needed and one of
				// them deletes the account.
				if (!this.manageKey) {
					setting.addButton((b) =>
						b.setButtonText("Manage").onClick(() => {
							this.manageKey = true;
							this.rerender();
						}),
					);
					return;
				}
				setting.settingEl.addClass("grill-cloud-key");
				setting.addButton((b) =>
					b.setButtonText("Done").onClick(() => {
						this.manageKey = false;
						this.showCloudKey = false;
						this.showRetiredKeys = false;
						this.cloudKeyConfirm = false;
						this.cloudDeleteConfirm = false;
						this.rerender();
					}),
				);
				const busy = (): boolean => {
					if (this.plugin.cloudWaitingFrom === null) return false;
					new Notice("Grill: a purchase is still on its way to this key. Wait for it, or press Stop checking first.", 8000);
					return true;
				};
				if (cloudKey && this.plugin.cloudAccountId) {
					setting.addText((t) => {
						t.setValue(this.plugin.cloudAccountId);
						t.inputEl.readOnly = true;
						t.inputEl.ariaLabel = "Your account ID, to quote to support. It is not your key.";
						t.inputEl.title = "Account ID (not your key)";
						t.inputEl.onfocus = () => t.inputEl.select();
					});
				}
				if (cloudKey) {
					if (this.showCloudKey) {
						setting.addText((t) => {
							t.setValue(cloudKey);
							t.inputEl.readOnly = true;
							t.inputEl.ariaLabel = "Your Grill Cloud key";
							// Select it all on focus, so one click and a copy shortcut is enough.
							t.inputEl.onfocus = () => t.inputEl.select();
						});
					}
					setting.addButton((b) =>
						b.setButtonText(this.showCloudKey ? "Hide" : "Show").onClick(() => {
							this.showCloudKey = !this.showCloudKey;
							this.rerender();
						}),
					);
				}
				setting.addText((t) => {
					t.setPlaceholder("Key from another vault")
						.setValue(this.cloudKeyDraft)
						.onChange((v) => {
							this.cloudKeyDraft = v.trim();
							this.cloudKeyConfirm = false;
						});
					t.inputEl.ariaLabel = "A Grill Cloud key from another vault";
				});
				setting.addButton((b) =>
					b.setButtonText(this.cloudKeyConfirm ? "Replace key" : "Use this key").onClick(async () => {
						const draft = this.cloudKeyDraft;
						if (busy()) return;
						if (!isCloudKey(draft)) {
							new Notice("Grill: that isn't a Grill Cloud key.");
							return;
						}
						if (draft === cloudKey) return;
						if (cloudKey && !this.cloudKeyConfirm) {
							this.cloudKeyConfirm = true;
							new Notice(
								"Grill: this replaces the key in use" +
									(credits ? `, which has ${credits} credits on it` : "") +
									". The old key is kept under Earlier keys, but save it yourself if it matters. Press Replace key to go ahead.",
								10000,
							);
							this.rerender();
							return;
						}
						const problem = await this.plugin.useCloudKey(draft);
						this.cloudKeyConfirm = false;
						this.cloudDeleteConfirm = false;
						if (problem) {
							new Notice(`Grill: ${problem}`, 8000);
						} else {
							this.cloudKeyDraft = "";
							this.showCloudKey = false;
						}
						this.rerender();
					}),
				);
				if (retired) {
					if (this.showRetiredKeys) {
						setting.addText((t) => {
							t.setValue(s.retiredCloudKeys.join(" "));
							t.inputEl.readOnly = true;
							t.inputEl.ariaLabel = "Earlier Grill Cloud keys";
							t.inputEl.onfocus = () => t.inputEl.select();
						});
					}
					setting.addButton((b) =>
						b.setButtonText(this.showRetiredKeys ? "Hide earlier keys" : "Earlier keys").onClick(() => {
							this.showRetiredKeys = !this.showRetiredKeys;
							this.rerender();
						}),
					);
				}
				if (cloudKey && state === "none") {
					// Nothing on the server to delete: the key can only be let go of here.
					setting.addButton((b) =>
						b.setButtonText("Forget this key").onClick(async () => {
							if (busy()) return;
							await this.plugin.forgetCloudKey();
							this.rerender();
						}),
					);
				}
				if (cloudKey && state !== "none") {
					// Erasing is permanent and forfeits the balance, so it takes two presses.
					setting.addButton((b) => {
						b.setButtonText(this.cloudDeleteConfirm ? "Really delete" : "Delete account").onClick(async () => {
							if (busy()) return;
							if (!this.cloudDeleteConfirm) {
								this.cloudDeleteConfirm = true;
								new Notice(
									"Grill: this deletes your Grill Cloud balance and usage from the server" +
										(credits ? `, including the ${credits} credits on it` : "") +
										". It can't be undone. Press Really delete to go ahead.",
									10000,
								);
								this.rerender();
								return;
							}
							this.cloudDeleteConfirm = false;
							const problem = await this.plugin.deleteCloud();
							new Notice(problem ? `Grill: ${problem} Nothing was deleted.` : "Grill: your Grill Cloud account is deleted.", 8000);
							this.rerender();
						});
						if (this.cloudDeleteConfirm) {
							// setDestructive is Obsidian 1.13+; setWarning is its older spelling.
							const styled = b as unknown as { setDestructive?: () => unknown; setWarning?: () => unknown };
							if (typeof styled.setDestructive === "function") styled.setDestructive();
							else styled.setWarning?.();
						}
						return b;
					});
				}
			},
		};
		const keyRow: Row = {
			name: "API key",
			desc:
				p === "custom"
					? `Optional for local servers. ${keyHome}`
					: `${keyHome} Get one at ${info.keyUrl}.`,
			aliases: ["token", "secret"],
			build: keyField,
		};
		const ollamaRow: Row = {
			name: "Ollama server",
			desc: "Needs Ollama running locally. 8B+ models recommended.",
			build: (setting) =>
				setting.addText((t) =>
					t
						.setPlaceholder("http://localhost:11434")
						.setValue(s.ollamaUrl)
						.onChange(async (v) => {
							s.ollamaUrl = v.trim() || "http://localhost:11434";
							delete this.modelLists.ollama;
							delete this.modelProblems.ollama;
							await this.plugin.persist();
						}),
				),
		};
		// Not there at all, even for the settings search, in a build without Grill Cloud.
		const cloudRows: Row[] = [];
		if (cloudEnabled()) {
			cloudRows.push(cloudRow);
			if (all || cloudKey || s.retiredCloudKeys.length) cloudRows.push(cloudKeyRow);

		} else if (p === "grillcloud") {
			ai.push({
				name: "Grill Cloud",
				desc: "Grill Cloud isn't available in this version of Grill. Pick another provider above.",
				build: () => undefined,
			});
		}
		if (all || p === "custom") ai.push(baseUrlRow);
		if (all || p === "custom" || (info.needsKey && p !== "grillcloud")) ai.push(keyRow);
		if (all || (p !== "custom" && !info.needsKey)) ai.push(ollamaRow);

		const list = this.modelLists[p] ?? [];
		const options = list.length ? list : info.fallbackModels;
		const current = s.models[p] || info.defaultModel;
		const staleCurrent = list.length > 0 && !list.includes(current);
		// The list couldn't be fetched, and the reason is known: a rejected key, a server
		// that isn't running. Said here, where the key and the model are chosen.
		const listProblem = list.length ? undefined : this.modelProblems[p];
		ai.push({
			name: "Model",
			desc: staleCurrent
				? `'${current}' isn't on your account. Pick another.`
				: list.length
					? `${list.length} models on your account.`
					: (listProblem ??
						(p === "ollama" ? "Refresh to list your installed models." : "Common models. Refresh to list yours.")),
			build: (setting) => {
				setting.descEl.toggleClass("mod-warning", staleCurrent || !!listProblem);
				setting.addDropdown((d) => {
					for (const m of options) d.addOption(m, m);
					if (current && !options.includes(current) && !this.showCustomModel)
						d.addOption(current, `${current} (not found)`);
					d.addOption(CUSTOM, "Custom model ID...");
					d.setValue(this.showCustomModel ? CUSTOM : current);
					d.onChange(async (v) => {
						if (v === CUSTOM) {
							this.showCustomModel = true;
							this.rerender();
							return;
						}
						this.showCustomModel = false;
						s.models[p] = v;
						await this.plugin.persist();
					});
				});
				setting.addExtraButton((b) =>
					b
						.setIcon("refresh-cw")
						.setTooltip("Fetch model list")
						.onClick(() => void this.refreshModels(p)),
				);
				setting.addExtraButton((b) =>
					b
						.setIcon("zap")
						.setTooltip("Test this model with a tiny request")
						.onClick(async () => {
							const cfg = this.plugin.llmConfig();
							if (!cfg) {
								new Notice("Grill: set an API key first.");
								return;
							}
							new Notice(`Grill: testing ${cfg.model}...`);
							const err = await testModel(cfg);
							new Notice(err ? `Grill: ${cfg.model} failed. ${err}` : `Grill: ${cfg.model} works.`, 8000);
						}),
				);
				// Kick off a background model-list fetch the first time the row is shown.
				// Not again after a failure that was said: the refresh button is the retry.
				if (!this.modelLists[p] && !this.modelProblems[p] && (s.apiKeys[p] || p === "ollama" || (p === "custom" && s.customBaseUrl)))
					void this.refreshModels(p);
			},
		});

		if (all || this.showCustomModel) {
			ai.push({
				name: "Custom model ID",
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder(info.defaultModel)
							.setValue(s.models[p])
							.onChange(async (v) => {
								s.models[p] = v.trim() || info.defaultModel;
								await this.plugin.persist();
							}),
					),
			});
		}

		ai.push({
			name: "Persona & instructions",
			desc: "Grill's character and how you want to be quizzed, in a note you can edit.",
			aliases: ["prompt", "tone"],
			build: (setting) =>
				setting.addButton((b) =>
					b
						.setButtonText("Manage")
						.setTooltip("Create Grill/Instructions.md if needed and open it")
						.onClick(() => void this.plugin.openInstructions()),
				),
		});

		// ------------------------------------------------------------ Studying
		const studying: Row[] = [
			this.sliderRow(
				"Questions per session",
				"",
				1,
				50,
				Math.min(Math.max(s.questionsPerSession, 1), 50),
				(v) => String(v),
				async (v) => {
					s.questionsPerSession = v;
					await this.plugin.persist();
				},
			),
			// One choice standing in for the four FSRS/new-material numbers Grill actually
			// schedules on. Those numbers still exist and are still what every scheduling call
			// site reads — they just live in Tuning now, because "what share of one session may
			// new material claim" is not a question a student should be asked. "Custom" only
			// appears when the numbers were hand-edited there, so picking it is never a way to
			// end up somewhere undefined.
			{
				name: "Study intensity",
				desc: "How often things come back and how much is new each day.",
				aliases: ["retention", "spaced repetition", "fsrs", "schedule"],
				build: (setting) =>
					setting.addDropdown((d) => {
						d.addOption("relaxed", "Relaxed — fewer reviews, slower intake");
						d.addOption("steady", "Steady — recommended");
						d.addOption("intense", "Intense — exam in a fortnight");
						if (s.studyIntensity === "custom") d.addOption("custom", "Custom — set in Tuning below");
						d.setValue(s.studyIntensity);
						d.onChange(async (v) => {
							if (v === "custom") return;
							const preset = INTENSITY_PRESETS[v as Exclude<StudyIntensity, "custom">];
							s.desiredRetention = preset.desiredRetention;
							s.newConceptsPerDay = preset.newConceptsPerDay;
							s.freshContentShare = preset.freshContentShare;
							s.freshContentAlwaysGuarantee = preset.freshContentAlwaysGuarantee;
							s.studyIntensity = v as StudyIntensity;
							await this.plugin.persist();
							this.rerender();
						});
					}),
			},
			{
				name: "Question formats",
				desc: "Mixed picks the format that fits each concept.",
				build: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOption("mixed", "Mixed (write, multiple-choice, fill-in-the-blank, true/false, and more)")
							.addOption("mc", "Multiple choice only")
							.addOption("write", "Write only")
							.setValue(s.questionFormats)
							.onChange(async (v) => {
								s.questionFormats = v === "write" ? "write" : v === "mc" ? "mc" : "mixed";
								await this.plugin.persist();
							}),
					),
			},
			{
				name: "Sound & celebration",
				desc: "Sound cues on answers, and confetti for a perfect session.",
				aliases: ["audio", "confetti", "mute"],
				build: (setting) =>
					setting.addToggle((t) =>
						t.setValue(s.sounds).onChange(async (v) => {
							s.sounds = v;
							await this.plugin.persist();
						}),
					),
			},
			this.naturalVoiceRow(s),
			this.voiceRow(s),
		];

		// ------------------------------------------------------------ Graph
		const graph: Row[] = [
			{
				name: "Colour by",
				desc: "What the graph's colours show.",
				aliases: ["color", "map"],
				build: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOption("mastery", "Mastery (default)")
							.addOption("recency", "Recency: stale notes read red")
							.addOption("dueness", "Due-ness: overdue notes read red")
							.addOption("misconceptions", "Misconceptions: notes you keep getting wrong read red")
							.setValue(s.graphColorMode)
							.onChange(async (v) => {
								s.graphColorMode = v as ColorMode;
								await this.plugin.persist();
								this.plugin.refreshMapDisplay();
							}),
					),
			},
			{
				name: "Grade numbers on the graph",
				desc: "Show a score on each practised note.",
				build: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOption("off", "Off")
							.addOption("percent", "Percent (78%)")
							.addOption("letter", "Letter grade (B+)")
							.setValue(s.graphNumberMode)
							.onChange(async (v) => {
								s.graphNumberMode = v as NumberMode;
								await this.plugin.persist();
								this.plugin.refreshMapDisplay();
							}),
					),
			},
		];

		// ------------------------------------------------------------ Scope
		const folderList = (v: string): string[] =>
			v
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean);
		const scope: Row[] = [
			{
				name: "Grill's folders",
				desc: "Folders to study, comma-separated. Blank for the whole vault.",
				aliases: ["include", "scope"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Whole vault")
							.setValue(s.includedFolders.join(", "))
							.onChange(async (v) => {
								s.includedFolders = folderList(v);
								await this.plugin.persist();
							}),
					),
			},
			{
				name: "Excluded folders",
				desc: "Folders to leave out, comma-separated.",
				aliases: ["ignore", "skip"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Templates, Inbox")
							.setValue(s.excludedFolders.join(", "))
							.onChange(async (v) => {
								s.excludedFolders = folderList(v);
								await this.plugin.persist();
							}),
					),
			},
		];

		// Study mode is about how you study, not which model runs it.
		const studyMode = ai.splice(ai.findIndex((r) => r.name === "Study mode"), 1);
		return [
			...(cloudRows.length ? [{ heading: "Grill Cloud", rows: cloudRows }] : []),
			// Grill Cloud picks the model itself.
			{
				heading: cloudEnabled() ? "Your own key or Ollama" : "AI",
				rows: all || p !== "grillcloud" ? ai : ai.filter((r) => r.name !== "Model" && r.name !== "Custom model ID"),
			},
			{ heading: "Studying", rows: [...studyMode, ...studying] },
			{ heading: "Graph", rows: graph },
			{ heading: "Scope", rows: scope },
		];
	}

	/** The row called `name` as it stands right now, or undefined if the current
	 * state doesn't show it. */
	private liveRow(name: string): Row | undefined {
		try {
			return [...this.sections().flatMap((sec) => sec.rows), ...this.tuningRows()].find((r) => r.name === name);
		} catch (e) {
			console.error("Grill: settings row failed", e);
			return undefined;
		}
	}

	/** Obsidian 1.13+: the same rows as display(), handed over as definitions so the
	 * settings search can find them. Tuning becomes a sub-page.
	 *
	 * Obsidian asks for these once, when the plugin loads, and again only on update();
	 * opening the tab just re-renders what it already has. So a definition carries no
	 * state: it names a row, and each render looks that row up fresh, which is also
	 * what decides whether it shows. Anything going wrong here returns no definitions,
	 * which makes Obsidian fall back to display(). */
	getSettingDefinitions(): SettingDefinitionItem[] {
		try {
			const toDef = (r: Row): SettingDefinition => ({
				name: r.name,
				desc: r.desc,
				aliases: r.aliases,
				visible: () => this.liveRow(r.name) !== undefined,
				render: (setting) => {
					const live = this.liveRow(r.name);
					if (!live) return;
					setting.setDesc(live.desc ?? "");
					live.build(setting);
				},
			});
			return [
				...this.sections(true).map(
					(sec): SettingDefinitionItem => ({
						type: "group",
						heading: sec.heading,
						items: sec.rows.map(toDef),
					}),
				),
				{
					type: "page",
					name: TUNING_NAME,
					desc: TUNING_DESC,
					items: this.tuningRows().map(toDef),
				},
			];
		} catch (e) {
			console.error("Grill: settings definitions failed, using the classic settings page", e);
			return [];
		}
	}

	/** Obsidian before 1.13 (and the fallback above). */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("grill-settings");
		const renderRow = (parent: HTMLElement, r: Row): void => {
			const setting = new Setting(parent).setName(r.name);
			if (r.desc) setting.setDesc(r.desc);
			r.build(setting);
		};
		for (const sec of this.sections()) {
			new Setting(containerEl).setName(sec.heading).setHeading();
			for (const r of sec.rows) renderRow(containerEl, r);
		}
		const details = containerEl.createEl("details", { cls: "grill-tuning" });
		details.createEl("summary", { text: `${TUNING_NAME} — you shouldn't need any of this` });
		details.createEl("p", { cls: "setting-item-description", text: TUNING_DESC });
		for (const r of this.tuningRows()) renderRow(details, r);
	}
}
