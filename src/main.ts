import {
	App,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import { configureFSRSWeights, MasteryMap } from "./mastery";
import { CalPoint, isCalPoint } from "./calibration";
import { LLMConfig, PROVIDERS, ProviderId, Question, listModels, migrateLegacyModels, synthesizeArc, testModel } from "./llm";
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
import { GrillStore } from "./store";
import { SessionView, VIEW_TYPE } from "./view";
import type { ColorMode, NumberMode } from "./mapview";
import { listLanguages, listVoices, listVoicesForLang, onVoicesChanged } from "./tts";

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
		apiKeys: { anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "", custom: "" },
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
		sendImages: true,
		enableOcclusion: false,
		questionSource: "ai",
		gradingMode: "ai",
		questionFormats: "mixed",
		sessionDebrief: true,
		sounds: true,
		ttsLanguage: "",
		ttsVoiceURI: "",
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

	async onload(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		const settings = defaultSettings();
		const s: Partial<GrillSettings> = stored?.settings ?? {};
		if (s.provider && s.provider in PROVIDERS) settings.provider = s.provider;
		if (s.apiKeys) settings.apiKeys = { ...settings.apiKeys, ...s.apiKeys };
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
		const calibration = Array.isArray(stored?.calibration) ? stored.calibration.filter(isCalPoint) : [];
		const arcLog = Array.isArray(stored?.arcLog) ? stored.arcLog.filter(isArcEntry) : [];
		const storedArc = stored?.arc;
		const arc =
			storedArc && typeof storedArc.atActiveDays === "number" && storedArc.data && typeof storedArc.data.headline === "string"
				? storedArc
				: null;
		this.data = { settings, calibration, arcLog, arc };
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
				void this.maybeSynthesizeArc();
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
		// Custom provider needs both an endpoint and a model to be usable.
		if (s.provider === "custom" && (!s.customBaseUrl || !s.models.custom)) return null;
		return {
			provider: s.provider,
			apiKey,
			model: s.models[s.provider] || info.defaultModel,
			baseUrl: s.provider === "ollama" ? s.ollamaUrl : s.provider === "custom" ? s.customBaseUrl : undefined,
		};
	}

	async persist(): Promise<void> {
		await this.saveData(this.data);
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

const CUSTOM = "__custom__";

class GrillSettingTab extends PluginSettingTab {
	plugin: GrillPlugin;
	/** Live model lists, cached per provider for the lifetime of the tab. */
	private modelLists: Partial<Record<ProviderId, string[]>> = {};
	private fetching: Partial<Record<ProviderId, boolean>> = {};
	private showCustomModel = false;
	/** Guards against attaching a duplicate voiceschanged listener on every display(). */
	private voicesListenerAttached = false;

	constructor(app: App, plugin: GrillPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** A slider whose current value is shown inline next to it. */
	private sliderSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		min: number,
		max: number,
		value: number,
		format: (v: number) => string,
		onChange: (v: number) => Promise<void>,
	): void {
		const setting = new Setting(containerEl).setName(name);
		if (desc) setting.setDesc(desc);
		// Obsidian 1.13 always shows the slider's value inline itself (setDynamicTooltip is
		// deprecated because of it) and added setDisplayFormat to customize that display —
		// so on 1.13+, adding our own value span next to it just prints the number twice.
		// Feature-detected (not a minAppVersion bump) so this still renders correctly, just
		// without the friendly formatting, on the older Obsidian versions Grill supports.
		let valueEl: HTMLSpanElement | null = null;
		setting.addSlider((sl) => {
			const hasDisplayFormat = typeof (sl as unknown as { setDisplayFormat?: unknown }).setDisplayFormat === "function";
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
	}

	private async refreshModels(p: ProviderId): Promise<void> {
		if (this.fetching[p]) return;
		this.fetching[p] = true;
		const s = this.plugin.data.settings;
		const models = await listModels(p, s.apiKeys[p], p === "custom" ? s.customBaseUrl : s.ollamaUrl);
		this.fetching[p] = false;
		if (models.length) {
			this.modelLists[p] = models;
			this.display();
		}
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
			conceptsMigrated: s.conceptsMigrated,
			legacyDefaultsMigrated: s.legacyDefaultsMigrated,
			newConceptsCapMigrated: s.newConceptsCapMigrated,
			intensityMigrated: s.intensityMigrated,
			modelsMigrated61: s.modelsMigrated61,
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
		this.display();
	}

	/** Read-aloud voice: one dropdown where there used to be two (a language picker plus a
	 * voice picker, 50 lines for a single `speak()` call site). Every state that pair could
	 * express still exists here — full auto, "always this language, best voice for it", and
	 * one exact pinned voice — as entries in one grouped list, so it stays a single choice
	 * instead of a two-step one where the second step is disabled until the first is made.
	 * Values are prefixed (`lang:` / `voice:`) rather than raw, so a voiceURI can never be
	 * mistaken for a language code. */
	private buildVoiceSetting(containerEl: HTMLElement, s: GrillSettings): void {
		const langs = listLanguages();
		// getVoices() can be empty on the very first call — the browser loads its voice
		// list asynchronously. Re-render once it actually arrives, same pattern as
		// refreshModels' `this.display()` on late data.
		if (langs.length === 0 && !this.voicesListenerAttached) {
			this.voicesListenerAttached = true;
			onVoicesChanged(() => this.display());
		}

		const setting = new Setting(containerEl)
			.setName("Read-aloud voice")
			.setDesc(
				langs.length === 0
					? "No voices found yet — reopen Settings in a moment."
					: "Automatic matches each question to its own language. Pick a language to always use that one, or a specific voice to pin it exactly.",
			);
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
	}

	/** The escape hatch: every number the engine schedules on, reachable but never asked
	 * about. A native <details>, deliberately NOT a persisted preference — it collapses
	 * again on every reopen. The previous round of this used a sticky "Show advanced
	 * settings" toggle, which is what let the tab re-accrete: once a power user flipped it
	 * on, adding one more setting behind it was free. A click every time is the friction
	 * that keeps the default surface honest. */
	private buildTuning(containerEl: HTMLElement, s: GrillSettings): void {
		const details = containerEl.createEl("details", { cls: "grill-tuning" });
		details.createEl("summary", { text: "Tuning — you shouldn't need any of this" });
		details.createEl("p", {
			cls: "setting-item-description",
			text:
				"Study intensity above already sets the first four. Change one here and it becomes Custom, " +
				"and stays exactly where you put it.",
		});

		/** Editing any raw scheduling number means the preset no longer describes them. */
		const toCustom = async (): Promise<void> => {
			s.studyIntensity = "custom";
			await this.plugin.persist();
		};

		this.sliderSetting(
			details,
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
		);

		this.sliderSetting(
			details,
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
		);

		this.sliderSetting(
			details,
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
		);

		new Setting(details)
			.setName("Always guarantee new material")
			.setDesc(
				"Off: a full due/struggling backlog leaves no room for new material that session, reviews win. " +
					"On: new material always gets its full share above, no matter how large the backlog is.",
			)
			.addToggle((t) =>
				t.setValue(s.freshContentAlwaysGuarantee).onChange(async (v) => {
					s.freshContentAlwaysGuarantee = v;
					await toCustom();
				}),
			);

		const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		const easyDaysSetting = new Setting(details)
			.setName("Light review days")
			.setDesc(
				"Toggle on any weekday you'd rather Grill went easier on. Doesn't cap or skip that day outright " +
					"(the backlog still has to go somewhere); it just steers newly-scheduled reviews off it toward " +
					"an equally-uncrowded day nearby whenever one's available. Toggle order: " +
					WEEKDAY_NAMES.join(", ") +
					".",
			);
		WEEKDAY_NAMES.forEach((full, weekday) => {
			easyDaysSetting.addToggle((t) =>
				t
					.setTooltip(full)
					.setValue(s.easyDays.includes(weekday))
					.onChange(async (v) => {
						s.easyDays = v ? [...new Set([...s.easyDays, weekday])] : s.easyDays.filter((d) => d !== weekday);
						await this.plugin.persist();
					}),
			);
		});

		this.sliderSetting(
			details,
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
		);

		// Fitting runs itself once there's enough review history (see
		// GrillPlugin.maybeAutoOptimizeFsrs) — there's no "Optimize now" button here
		// because being asked to press it was the setting. What's left is the status, so
		// "personalized" isn't a black box, and a way back to the shared defaults.
		const trainable = countTrainableReviews(this.plugin.concepts);
		const fp = s.fsrsPersonalization;
		new Setting(details)
			.setName("Personalized FSRS weights")
			.setDesc(
				fp
					? `Active: fit from ${fp.reviewCount} reviews on ${new Date(fp.fitAt).toLocaleDateString()}, ` +
						`${fp.improvementPct.toFixed(1)}% tighter fit than the library defaults on this vault's own data at the time. ` +
						"Refits itself as more review history accumulates."
					: `Not yet: scheduling runs on FSRS-6's library defaults, fit across a large pooled population, not this vault. ` +
						`Grill fits your own weights automatically at ${MIN_REVIEWS_FOR_OPTIMIZATION} real reviews (${trainable} so far).`,
			)
			.addButton((b) => {
				b.setButtonText("Reset to library defaults").setDisabled(!fp);
				if (fp) {
					b.onClick(async () => {
						s.fsrsPersonalization = null;
						configureFSRSWeights(null);
						await this.plugin.persist();
						new Notice("Grill: FSRS parameters reset to the library defaults.");
						this.display();
					});
				}
				return b;
			});

		new Setting(details)
			.setName("Grill folder")
			.setDesc(
				"Vault folder for mastery.json and session transcripts. These are plain files: " +
					"read them, edit them, sync them like any note.",
			)
			.addText((t) =>
				t
					.setPlaceholder("Grill")
					.setValue(s.folder)
					.onChange(async (v) => {
						s.folder = v.trim() || "Grill";
						await this.plugin.persist();
					}),
			);

		new Setting(details)
			.setName("Restore recommended settings")
			.setDesc("Reset everything back to the defaults. Your API keys, provider, and folder choices are kept.")
			.addButton((b) => b.setButtonText("Restore").onClick(() => void this.restoreDefaults()));
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("grill-settings");
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];

		// ------------------------------------------------------------ AI
		new Setting(containerEl).setName("AI").setHeading();

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
		new Setting(containerEl)
			.setName("Study mode")
			.setDesc(
				"Where questions come from and who marks them. Anything with AI in it needs a key below; " +
					"fully offline runs entirely on your machine, nothing is sent anywhere, and there's nothing to pay.",
			)
			.addDropdown((d) =>
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
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Provider")
			.setDesc(
				"Cloud providers send the quizzed notes to that provider using your key. " +
					"Ollama runs fully on your machine: private, but local models write noticeably weaker questions.",
			)
			.addDropdown((d) => {
				for (const [id, pi] of Object.entries(PROVIDERS)) d.addOption(id, pi.label);
				d.setValue(p).onChange(async (v) => {
					s.provider = v as ProviderId;
					this.showCustomModel = false;
					await this.plugin.persist();
					this.display();
					void this.refreshModels(v as ProviderId);
				});
			});

		if (p === "custom") {
			new Setting(containerEl)
				.setName("Base URL")
				.setDesc(
					"Any OpenAI-compatible endpoint, for example https://openrouter.ai/api/v1, " +
						"https://api.groq.com/openai/v1, or http://localhost:1234/v1 for LM Studio.",
				)
				.addText((t) =>
					t
						.setPlaceholder("https://openrouter.ai/api/v1")
						.setValue(s.customBaseUrl)
						.onChange(async (v) => {
							s.customBaseUrl = v.trim();
							delete this.modelLists.custom;
							await this.plugin.persist();
						}),
				);
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Sent as a Bearer token. Leave blank for local servers that don't require one.")
				.addText((t) => {
					t.setPlaceholder(info.keyPlaceholder)
						.setValue(s.apiKeys.custom)
						.onChange(async (v) => {
							s.apiKeys.custom = v.trim();
							delete this.modelLists.custom;
							await this.plugin.persist();
						});
					t.inputEl.type = "password";
				});
		} else if (info.needsKey) {
			new Setting(containerEl)
				.setName("API key")
				.setDesc(`Stored locally in this vault's plugin data, never in your notes. Get one at ${info.keyUrl}.`)
				.addText((t) => {
					t.setPlaceholder(info.keyPlaceholder)
						.setValue(s.apiKeys[p])
						.onChange(async (v) => {
							s.apiKeys[p] = v.trim();
							delete this.modelLists[p];
							await this.plugin.persist();
						});
					t.inputEl.type = "password";
				});
		} else {
			new Setting(containerEl)
				.setName("Ollama server")
				.setDesc(
					"Requires Ollama running locally (ollama.com). Nothing leaves your machine. " +
						"Expect slower sessions and simpler questions than cloud models; 8B+ models recommended.",
				)
				.addText((t) =>
					t
						.setPlaceholder("http://localhost:11434")
						.setValue(s.ollamaUrl)
						.onChange(async (v) => {
							s.ollamaUrl = v.trim() || "http://localhost:11434";
							delete this.modelLists.ollama;
							await this.plugin.persist();
						}),
				);
		}

		const list = this.modelLists[p] ?? [];
		const options = list.length ? list : info.fallbackModels;
		const current = s.models[p] || info.defaultModel;
		const staleCurrent = list.length > 0 && !list.includes(current);
		const modelSetting = new Setting(containerEl)
			.setName("Model")
			.setDesc(
				staleCurrent
					? `'${current}' was not found on your account and will fail. Pick a model from the list.`
					: list.length
						? `${list.length} models available on your account, verified against your key.`
						: p === "ollama"
							? "Click refresh to list installed models from your Ollama server."
							: "Showing common models. Click refresh to list what your key can access.",
			);
		if (staleCurrent) modelSetting.descEl.addClass("mod-warning");
		modelSetting.addDropdown((d) => {
			for (const m of options) d.addOption(m, m);
			if (current && !options.includes(current) && !this.showCustomModel)
				d.addOption(current, `${current} (not found)`);
			d.addOption(CUSTOM, "Custom model ID...");
			d.setValue(this.showCustomModel ? CUSTOM : current);
			d.onChange(async (v) => {
				if (v === CUSTOM) {
					this.showCustomModel = true;
					this.display();
					return;
				}
				this.showCustomModel = false;
				s.models[p] = v;
				await this.plugin.persist();
			});
		});
		modelSetting.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Fetch model list")
				.onClick(() => void this.refreshModels(p)),
		);
		modelSetting.addExtraButton((b) =>
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

		if (this.showCustomModel) {
			new Setting(containerEl).setName("Custom model ID").addText((t) =>
				t
					.setPlaceholder(info.defaultModel)
					.setValue(s.models[p])
					.onChange(async (v) => {
						s.models[p] = v.trim() || info.defaultModel;
						await this.plugin.persist();
					}),
			);
		}

		new Setting(containerEl)
			.setName("Persona & instructions")
			.setDesc(
				"A file in your Grill folder with two parts. Persona: Grill's default character is shown " +
					"there, editable, so you can make it a strict examiner, a gentle guide, whatever you like. " +
					"Instructions: how you want to be quizzed and graded. Scoring itself is fixed by the engine, " +
					"so grades stay consistent whatever you write. Leave it blank for the defaults.",
			)
			.addButton((b) =>
				b
					.setButtonText("Open")
					.setTooltip("Create Grill/Instructions.md if needed and open it")
					.onClick(() => void this.plugin.openInstructions()),
			);

		// ------------------------------------------------------------ Studying
		new Setting(containerEl).setName("Studying").setHeading();

		this.sliderSetting(
			containerEl,
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
		);

		// One choice standing in for the four FSRS/new-material numbers Grill actually
		// schedules on. Those numbers still exist and are still what every scheduling call
		// site reads — they just live in Tuning now, because "what share of one session may
		// new material claim" is not a question a student should be asked. "Custom" only
		// appears when the numbers were hand-edited there, so picking it is never a way to
		// end up somewhere undefined.
		new Setting(containerEl)
			.setName("Study intensity")
			.setDesc(
				"How hard the schedule pushes: how often things come back, and how much new material a day " +
					"introduces. Steady is what most people should leave this on.",
			)
			.addDropdown((d) => {
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
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Question formats")
			.setDesc(
				"Mixed picks whichever format (multiple-choice, fill-in-the-blank, true/false, select-all, matching, " +
					"or write-in) actually fits each concept. Set here, not in Instructions.md: a free-text preference " +
					"there won't reliably stick.",
			)
			.addDropdown((d) =>
				d
					.addOption("mixed", "Mixed (write, multiple-choice, fill-in-the-blank, true/false, and more)")
					.addOption("mc", "Multiple choice only")
					.addOption("write", "Write only")
					.setValue(s.questionFormats)
					.onChange(async (v) => {
						s.questionFormats = v === "write" ? "write" : v === "mc" ? "mc" : "mixed";
						await this.plugin.persist();
					}),
			);

		new Setting(containerEl)
			.setName("Sound & celebration")
			.setDesc(
				"Short sound cues on each answer and at the end of a session, plus a confetti burst when " +
					"you get a whole session right. Synthesized on the fly (no files), gentle, and silent when off.",
			)
			.addToggle((t) =>
				t.setValue(s.sounds).onChange(async (v) => {
					s.sounds = v;
					await this.plugin.persist();
				}),
			);

		this.buildVoiceSetting(containerEl, s);

		// ------------------------------------------------------------ Graph
		new Setting(containerEl).setName("Graph").setHeading();

		new Setting(containerEl)
			.setName("Colour by")
			.setDesc(
				"Mastery is the default: grey untested, red learning, green known. The " +
					"others colour every practised note on a green-to-red scale by a different signal, so you can " +
					"spot what needs attention at a glance instead of reading it note by note.",
			)
			.addDropdown((d) =>
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
			);

		new Setting(containerEl)
			.setName("Grade numbers on the graph")
			.setDesc(
				"Show a number on every practised node: your current coverage and mastery on that note folded " +
					"into one score, so you can read \"what would I score on this right now\" at a glance instead of " +
					"just a colour. Untested notes show nothing.",
			)
			.addDropdown((d) =>
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
			);

		// ------------------------------------------------------------ Scope
		new Setting(containerEl).setName("Scope").setHeading();

		new Setting(containerEl)
			.setName("Grill's folders")
			.setDesc(
				"Comma-separated folders that ARE Grill's study material and knowledge graph. Relative paths, " +
					"e.g. Courses, Zettelkasten. Leave blank to use your whole vault.",
			)
			.addText((t) =>
				t
					.setPlaceholder("Whole vault")
					.setValue(s.includedFolders.join(", "))
					.onChange(async (v) => {
						s.includedFolders = v
							.split(",")
							.map((x) => x.trim())
							.filter(Boolean);
						await this.plugin.persist();
					}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Comma-separated folders to leave out of sessions, so notes like templates and attachments " +
					"aren't quizzed. Relative paths, e.g. Templates, Inbox, Archive.",
			)
			.addText((t) =>
				t
					.setPlaceholder("Templates, Inbox")
					.setValue(s.excludedFolders.join(", "))
					.onChange(async (v) => {
						s.excludedFolders = v
							.split(",")
							.map((x) => x.trim())
							.filter(Boolean);
						await this.plugin.persist();
					}),
			);

		this.buildTuning(containerEl, s);

		// Kick off a background model-list fetch the first time the tab opens.
		if (!this.modelLists[p] && (s.apiKeys[p] || p === "ollama" || (p === "custom" && s.customBaseUrl)))
			void this.refreshModels(p);
	}
}
