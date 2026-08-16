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
import { LLMConfig, PROVIDERS, ProviderId, Question, listModels, synthesizeArc, testModel } from "./llm";
import { ConceptMap, dueConceptCount, migrateResetScheduling, rebalanceDueDates, reconcileConcepts } from "./concepts";
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
import { countTrainableReviews, MIN_REVIEWS_FOR_OPTIMIZATION, optimizeFSRSWeights } from "./optimizer";
import { dueFiles, duplicateBasenames } from "./scope";
import { GrillStore } from "./store";
import { SessionView, VIEW_TYPE } from "./view";
import type { ColorMode, NumberMode } from "./mapview";
import { listLanguages, listVoicesForLang, onVoicesChanged } from "./tts";

interface GrillSettings {
	provider: ProviderId;
	apiKeys: Record<ProviderId, string>;
	models: Record<ProviderId, string>;
	ollamaUrl: string;
	/** Base URL for the custom OpenAI-compatible provider, e.g. https://openrouter.ai/api/v1 */
	customBaseUrl: string;
	questionsPerSession: number;
	/** Vault folder holding mastery.json and session notes. */
	folder: string;
	compact: boolean;
	showProgress: boolean;
	hideNoteName: boolean;
	/** Wiki-link session transcripts to the quizzed notes. */
	linkSessions: boolean;
	/** Vault folders to exclude from sessions (relative paths). */
	excludedFolders: string[];
	/** Folders that ARE Grill's study material + graph (relative paths). Empty = the
	 * whole vault. Chosen on first run; the universe of the learning graph. */
	includedFolders: string[];
	/** One-time flag: the first-run "what's Grill's" onboarding has been completed. */
	onboarded: boolean;
	/** Send embedded images to the model when it supports vision. Image occlusion
	 * rides entirely on this + the model's own vision capability (see view.ts's
	 * appendOcclusionConcepts) — no separate toggle: whether an occlusion question
	 * actually shows up depends on whether the model finds something worth redacting
	 * on a given image, not a count the student dials in. */
	sendImages: boolean;
	/** Where questions come from: an LLM, or the note's own structure (no key). */
	questionSource: "ai" | "local";
	/** How answers are graded: an LLM, or the user grades themselves (no key). */
	gradingMode: "ai" | "self";
	/** Question formats: plain free-response only, or a mix that also includes
	 * multiple-choice and fill-in-the-blank. "Mixed" costs a bit more prompt (AI mode)
	 * per generation call, so it's a real toggle, not baked in unconditionally. */
	questionFormats: "write" | "mixed" | "mc";
	/** End-of-session AI debrief (one extra call per session). Off falls back to
	 * a deterministic summary. Ignored for no-key sessions (always deterministic). */
	sessionDebrief: boolean;
	/** Ask "how sure are you?" after each answer and track calibration (Brier score).
	 * Off by default; surfaces an over/underconfidence line in the session debrief. */
	confidenceCheck: boolean;
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
	 * AI sessions and offer to write the link. On by default. How many actually show
	 * up isn't a count the student dials in — it's however many pairs the adjudicator
	 * confirms are genuinely related this session (see view.ts's appendBridgeTargets
	 * and BRIDGE_TARGET_CAP), naturally zero on a session with no real connections. */
	graphInsights: boolean;
	/** Additive to the lexical missing-link prefilter: also embed notes (via
	 * whichever provider is configured, when it supports embeddings) and surface
	 * pairs with strong semantic similarity but too little shared vocabulary to
	 * pass the lexical gate. Off by default — coverage is uneven across providers
	 * (see the setting's own description) and it costs an extra call per new/changed
	 * note. Only consulted when `graphInsights` is also on. */
	semanticBridges: boolean;
	/** Careful grading: grade an answer with a small consensus of calls (opt-in,
	 * higher cost) to reduce leniency error. Off by default. */
	carefulGrade: boolean;
	/** One-time flag: the note→concept scheduling reset has run. */
	conceptsMigrated: boolean;
	/** One-time flag: legacy installs have had their stored old shipped defaults
	 * (graphNumberMode "off", newConceptsPerDay 0) carried to the current defaults.
	 * Guards the migration so it fires exactly once — after it, the user can freely
	 * pick "off" / 0 again without being re-flipped on the next launch. */
	legacyDefaultsMigrated: boolean;
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
	/** Settings-tab progressive disclosure: reveal the rarely-touched tuning/maintenance
	 * settings (careful grading, coverage weighting, cache clearing, missing-link
	 * bridges, etc.) below a single toggle instead of always showing all ~30 settings
	 * flat. Sticky across reopens — a power user who turns it on shouldn't have to
	 * re-expand every time. */
	showAdvancedSettings: boolean;
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
		compact: false,
		showProgress: true,
		hideNoteName: false,
		linkSessions: true,
		excludedFolders: [],
		includedFolders: [],
		onboarded: false,
		sendImages: true,
		questionSource: "ai",
		gradingMode: "ai",
		questionFormats: "mixed",
		sessionDebrief: true,
		confidenceCheck: false,
		sounds: true,
		ttsLanguage: "",
		ttsVoiceURI: "",
		graphInsights: true,
		semanticBridges: false,
		carefulGrade: false,
		conceptsMigrated: false,
		graphColorMode: "mastery",
		graphNumberMode: "percent",
		graphCoverageWeight: 15,
		desiredRetention: 90,
		fsrsPersonalization: null,
		easyDays: [],
		newConceptsPerDay: 20,
		legacyDefaultsMigrated: false,
		showAdvancedSettings: false,
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
		if (typeof s.compact === "boolean") settings.compact = s.compact;
		if (typeof s.showProgress === "boolean") settings.showProgress = s.showProgress;
		if (typeof s.hideNoteName === "boolean") settings.hideNoteName = s.hideNoteName;
		if (typeof s.linkSessions === "boolean") settings.linkSessions = s.linkSessions;
		if (Array.isArray(s.excludedFolders))
			settings.excludedFolders = s.excludedFolders.filter((v): v is string => typeof v === "string");
		if (Array.isArray(s.includedFolders))
			settings.includedFolders = s.includedFolders.filter((v): v is string => typeof v === "string");
		if (typeof s.onboarded === "boolean") settings.onboarded = s.onboarded;
		if (typeof s.sendImages === "boolean") settings.sendImages = s.sendImages;
		if (s.questionSource === "ai" || s.questionSource === "local") settings.questionSource = s.questionSource;
		if (s.gradingMode === "ai" || s.gradingMode === "self") settings.gradingMode = s.gradingMode;
		if (s.questionFormats === "write" || s.questionFormats === "mixed" || s.questionFormats === "mc") settings.questionFormats = s.questionFormats;
		if (typeof s.sessionDebrief === "boolean") settings.sessionDebrief = s.sessionDebrief;
		if (typeof s.confidenceCheck === "boolean") settings.confidenceCheck = s.confidenceCheck;
		if (typeof s.sounds === "boolean") settings.sounds = s.sounds;
		if (typeof s.ttsLanguage === "string") settings.ttsLanguage = s.ttsLanguage;
		if (typeof s.ttsVoiceURI === "string") settings.ttsVoiceURI = s.ttsVoiceURI;
		if (typeof s.graphInsights === "boolean") settings.graphInsights = s.graphInsights;
		if (typeof s.semanticBridges === "boolean") settings.semanticBridges = s.semanticBridges;
		if (typeof s.carefulGrade === "boolean") settings.carefulGrade = s.carefulGrade;
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
		if (Array.isArray(s.easyDays)) {
			settings.easyDays = s.easyDays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6);
		}
		if (typeof s.newConceptsPerDay === "number") settings.newConceptsPerDay = s.newConceptsPerDay;
		if (typeof s.legacyDefaultsMigrated === "boolean") settings.legacyDefaultsMigrated = s.legacyDefaultsMigrated;
		if (typeof s.showAdvancedSettings === "boolean") settings.showAdvancedSettings = s.showAdvancedSettings;
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
				void this.renameTrackedNote(oldName, file.basename);
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

		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				this.mastery = await this.store.loadMastery();
				this.concepts = await this.store.loadConcepts();
				// One-time move to concept-level scheduling: keep stats, reset scheduling.
				if (!this.data.settings.conceptsMigrated) {
					migrateResetScheduling(this.mastery);
					await this.store.saveMastery(this.mastery);
					this.data.settings.conceptsMigrated = true;
					await this.persist();
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

	statusBar: HTMLElement | null = null;

	/** Create Grill/Instructions.md if needed and open it for editing. */
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
	async optimizeFsrsParameters(): Promise<void> {
		const trainable = countTrainableReviews(this.concepts);
		if (trainable < MIN_REVIEWS_FOR_OPTIMIZATION) {
			new Notice(
				`Grill: not enough review history yet to personalize FSRS (${trainable}/${MIN_REVIEWS_FOR_OPTIMIZATION} reviews). ` +
					"Keep studying — this gets better with more real reviews to fit against.",
			);
			return;
		}
		new Notice(`Grill: optimizing FSRS parameters from ${trainable} reviews...`);
		const result = await optimizeFSRSWeights(this.concepts);
		if (!result.weights) {
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
	async rebalanceSchedule(): Promise<void> {
		const easyWeekdays = new Set(this.data.settings.easyDays);
		const changed = rebalanceDueDates(this.concepts, new Date(), easyWeekdays);
		if (changed > 0) await this.store.saveConcepts(this.concepts);
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

	/** Migrate mastery.json's key, concepts.json's `note` field, and the
	 * misconception registry's `notes` lists from an old basename to the new one
	 * after an actual rename (see the rename listener in onload). Never clobbers a
	 * record already sitting at the new name — that's the same duplicate-basename
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
		for (const cm of Object.values(this.concepts)) {
			if (cm.note === oldName) {
				cm.note = newName;
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
			const text = await this.app.vault.cachedRead(file);
			const extracted = extractConcepts(file.basename, text, this.data.settings.questionFormats);
			reconcileConcepts(this.concepts, extracted);
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
	 * credentials, provider, and folder choices. */
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
			conceptsMigrated: s.conceptsMigrated,
		};
		await this.plugin.persist();
		new Notice("Grill: restored the recommended settings.");
		this.display();
	}

	/** Language + voice pickers for the read-aloud button. Both default to "auto" —
	 * best-quality installed voice for whatever language the question text turns out to
	 * be — so out of the box this always uses the best available voice with no setup;
	 * pinning either is only for overriding that. */
	private buildVoiceSettings(containerEl: HTMLElement, s: GrillSettings): void {
		const langs = listLanguages();
		// getVoices() can be empty on the very first call — the browser loads its voice
		// list asynchronously. Re-render once it actually arrives, same pattern as
		// refreshModels' `this.display()` on late data.
		if (langs.length === 0 && !this.voicesListenerAttached) {
			this.voicesListenerAttached = true;
			onVoicesChanged(() => this.display());
		}

		new Setting(containerEl)
			.setName("Read-aloud language")
			.setDesc(
				langs.length === 0
					? "No voices found yet — reopen Settings in a moment."
					: "Auto-detect (default) matches each question's voice to its language. Pin one to always use it instead.",
			)
			.addDropdown((d) => {
				d.addOption("", "Auto-detect");
				for (const l of langs) d.addOption(l.code, l.label);
				d.setValue(s.ttsLanguage);
				d.onChange(async (v) => {
					s.ttsLanguage = v;
					s.ttsVoiceURI = ""; // a pinned voice belongs to the old language; changing it invalidates that pin
					await this.plugin.persist();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Read-aloud voice")
			.setDesc(
				s.ttsLanguage
					? "Best available (default) uses the top-quality installed voice for that language."
					: "Pick a language above first.",
			)
			.addDropdown((d) => {
				d.addOption("", "Best available");
				if (!s.ttsLanguage) {
					d.setDisabled(true);
					return;
				}
				for (const v of listVoicesForLang(s.ttsLanguage)) d.addOption(v.voiceURI, v.name);
				d.setValue(s.ttsVoiceURI);
				d.onChange(async (v) => {
					s.ttsVoiceURI = v;
					await this.plugin.persist();
				});
			});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("grill-settings");
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];

		new Setting(containerEl)
			.setName("Recommended settings")
			.setDesc(
				"Reset everything below to the recommended defaults, in case you've changed too much. Your API " +
					"keys, provider, and folder choices are kept.",
			)
			.addButton((b) => b.setButtonText("Restore").onClick(() => void this.restoreDefaults()));

		new Setting(containerEl)
			.setName("Show advanced settings")
			.setDesc(
				"Reveal rarely-touched tuning and maintenance settings: careful grading, coverage weighting, " +
					"cache clearing, and similar.",
			)
			.addToggle((t) =>
				t.setValue(s.showAdvancedSettings).onChange(async (v) => {
					s.showAdvancedSettings = v;
					await this.plugin.persist();
					this.display();
				}),
			);

		// ------------------------------------------------------------ AI
		new Setting(containerEl).setName("AI").setHeading();

		new Setting(containerEl)
			.setName("Where questions come from")
			.setDesc(
				"AI writes questions from your notes (needs a key), or Grill builds them from your notes' own " +
					"structure: definitions, bold terms, headings and formulas (no key, no cost).",
			)
			.addDropdown((d) =>
				d
					.addOption("ai", "AI writes them")
					.addOption("local", "From my notes (no key)")
					.setValue(s.questionSource)
					.onChange(async (v) => {
						s.questionSource = v === "local" ? "local" : "ai";
						await this.plugin.persist();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Grading")
			.setDesc(
				"AI marks your written answer against the note (needs a key), or you reveal the answer and grade " +
					"yourself Again / Hard / Good / Easy (no key, no cost).",
			)
			.addDropdown((d) =>
				d
					.addOption("ai", "AI marks me")
					.addOption("self", "I mark myself (no key)")
					.setValue(s.gradingMode)
					.onChange(async (v) => {
						s.gradingMode = v === "self" ? "self" : "ai";
						await this.plugin.persist();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Question formats")
			.setDesc(
				"Mixed picks whichever format (multiple-choice, fill-in-the-blank, true/false, select-all, matching, " +
					"or write-in) actually fits each concept. Set here, not in Instructions.md — a free-text preference " +
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

		if (s.questionSource === "local" && s.gradingMode === "self") {
			containerEl.createEl("p", {
				cls: "setting-item-description grill-nokey-note",
				text: "No-key mode: Grill runs entirely on your machine, nothing is sent anywhere, and there's nothing to pay. A model key is only needed for AI questions or AI grading.",
			});
		}

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

		// Only reachable when questions are generated at all — no-key ("From my notes")
		// sessions never call the model, so this toggle would otherwise sit there doing
		// nothing with no indication why. Advanced: a one-time "does my note have
		// diagrams" call, not something most sessions need to reconsider.
		if (s.questionSource === "ai" && s.showAdvancedSettings) {
			new Setting(containerEl)
				.setName("Send images to the model")
				.setDesc(
					"When a note embeds images and your model can read them (Claude, GPT, Gemini, and vision Ollama " +
						"models can), Grill sends the images too, so it can quiz on diagrams and screenshots. Costs " +
						"extra tokens. Text-only models never receive images.",
				)
				.addToggle((t) =>
					t.setValue(s.sendImages).onChange(async (v) => {
						s.sendImages = v;
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

		// ------------------------------------------------------------ Sessions
		new Setting(containerEl).setName("Sessions").setHeading();

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

		this.sliderSetting(
			containerEl,
			"Review frequency",
			"How hard the schedule works to keep things fresh. Lower brings concepts back sooner (more " +
				"reviews, progress feels faster); higher spaces them further apart (fewer reviews, longer " +
				"before something you know comes back around).",
			70,
			97,
			Math.min(Math.max(s.desiredRetention, 70), 97),
			(v) => `${v}%`,
			async (v) => {
				s.desiredRetention = v;
				await this.plugin.persist();
			},
		);

		this.sliderSetting(
			containerEl,
			"New concepts per day",
			"Caps how many never-before-tested concepts a session will introduce per calendar day, on top " +
				"of the per-session limits above. Once hit, sessions fill remaining slots by reviewing what's " +
				"already due instead — so a few missed days can't leave the due queue permanently outrunning " +
				"what you can actually review. 0 = no daily cap.",
			0,
			100,
			Math.min(Math.max(s.newConceptsPerDay, 0), 100),
			(v) => (v === 0 ? "No cap" : `${v}/day`),
			async (v) => {
				s.newConceptsPerDay = v;
				await this.plugin.persist();
			},
		);

		new Setting(containerEl)
			.setName("End-of-session debrief")
			.setDesc(
				"When a session uses AI, spend one extra call at the end to summarise how you did, name any " +
					"recurring confusion, and point you at what to study next. Off: a plain summary, no extra cost. " +
					"No-key sessions always get the plain summary.",
			)
			.addToggle((t) =>
				t.setValue(s.sessionDebrief).onChange(async (v) => {
					s.sessionDebrief = v;
					await this.plugin.persist();
				}),
			);

		if (s.showAdvancedSettings) {
			const trainable = countTrainableReviews(this.plugin.concepts);
			const fp = s.fsrsPersonalization;
			const fsrsDesc = fp
				? `Active: fit from ${fp.reviewCount} reviews on ${new Date(fp.fitAt).toLocaleDateString()}, ` +
					`${fp.improvementPct.toFixed(1)}% tighter fit than the library defaults on this vault's own data at the time. ` +
					"Re-run occasionally as more review history accumulates, or reset to the shared library defaults."
				: `Off: scheduling runs on FSRS-6's library defaults, fit across a large pooled population, not this vault. ` +
					`Needs ${MIN_REVIEWS_FOR_OPTIMIZATION} real reviews to fit against (${trainable}/${MIN_REVIEWS_FOR_OPTIMIZATION} so far) — ` +
					"keep studying and re-open this panel to check progress.";
			new Setting(containerEl)
				.setName("Personalize FSRS to your own memory")
				.setDesc(
					"Fits FSRS's ~21 scheduling weights to how YOU actually forget, from your own logged review history, " +
						"instead of the library's one-size-fits-all defaults — the same idea as Anki's own FSRS optimizer, run " +
						"locally with no data leaving your machine. " +
						fsrsDesc,
				)
				.addButton((b) =>
					b.setButtonText("Optimize now").onClick(async () => {
						await this.plugin.optimizeFsrsParameters();
						this.display();
					}),
				)
				.addButton((b) => {
					b.setButtonText("Reset to defaults").setDisabled(!fp);
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

			const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
			const easyDaysSetting = new Setting(containerEl)
				.setName("Light review days")
				.setDesc(
					"Toggle on any weekday you'd rather Grill went easier on. Doesn't cap or skip that day outright " +
						"(the backlog still has to go somewhere) — it just steers newly-scheduled reviews off it toward " +
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

			new Setting(containerEl)
				.setName("Confidence check")
				.setDesc(
					"After each answer, ask how sure you were (Sure / Think so / Guessing). Grill tracks how well " +
						"your confidence matches your accuracy and tells you in the debrief when you lean over- or " +
						"underconfident. Off by default; no extra model cost.",
				)
				.addToggle((t) =>
					t.setValue(s.confidenceCheck).onChange(async (v) => {
						s.confidenceCheck = v;
						await this.plugin.persist();
					}),
				);

			new Setting(containerEl)
				.setName("Find missing links")
				.setDesc(
					"In AI sessions, look for two of your notes that clearly relate but aren't linked, quiz you on the " +
						"connection, and offer to add the [[link]] for you. How many show up isn't a count you dial in — " +
						"it's however many pairs actually turn out to be genuinely related this session, naturally zero " +
						"some sessions. Needs a key; off for no-key sessions.",
				)
				.addToggle((t) =>
					t.setValue(s.graphInsights).onChange(async (v) => {
						s.graphInsights = v;
						await this.plugin.persist();
						this.display();
					}),
				);

			if (s.graphInsights) {
				new Setting(containerEl)
					.setName("Find missing links by meaning, not just wording")
					.setDesc(
						"Also embed your notes and look for pairs that are conceptually related even when they don't share " +
							"vocabulary — the lexical search above can miss those. Needs an OpenAI or Gemini key, or a local " +
							"Ollama server with an embedding model pulled (e.g. `ollama pull nomic-embed-text`); off for " +
							"Anthropic and DeepSeek, which have no embeddings API to call. Costs one extra request per " +
							"new or changed note, capped per session.",
					)
					.addToggle((t) =>
						t.setValue(s.semanticBridges).onChange(async (v) => {
							s.semanticBridges = v;
							await this.plugin.persist();
						}),
					);
			}

			new Setting(containerEl)
				.setName("Clear cached questions")
				.setDesc(
					"A concept's question is written once and reused verbatim on every later review — never silently " +
						"reworded. Use this to force every concept to write a fresh question next time it's due, e.g. right " +
						"after a Grill update changes how questions are written (a new format, a prompt fix) so it reaches " +
						"concepts you've already studied a lot, not just new ones. Doesn't affect a session already open.",
				)
				.addButton((b) =>
					b.setButtonText("Clear").onClick(async () => {
						await this.plugin.store.saveQuestionBank({});
						new Notice("Grill: cleared cached questions.");
					}),
				);

			// Only reachable under AI grading — self-grade's Again/Hard/Good/Easy is the
			// student's own verdict, nothing here for a consensus of calls to double-check.
			if (s.gradingMode === "ai") {
				new Setting(containerEl)
					.setName("Careful grading")
					.setDesc(
						"When AI grades your answer, run a small consensus of calls and fall back to the stricter verdict on " +
							"disagreement. Cuts the chance of being marked correct when you weren't, at a higher per-answer cost. " +
							"Off by default.",
					)
					.addToggle((t) =>
						t.setValue(s.carefulGrade).onChange(async (v) => {
							s.carefulGrade = v;
							await this.plugin.persist();
						}),
					);
			}
		}

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

		this.buildVoiceSettings(containerEl, s);

		// ------------------------------------------------------------ Appearance
		new Setting(containerEl).setName("Appearance").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "The start screen and progress dashboard always use the banner's own colours, not your Obsidian " +
				"theme, so they look the same on any theme. Everything else, sessions, grading, this settings page, " +
				"still follows your theme. Fine-grained control (colors, width, spacing) is available via the " +
				"community Style Settings plugin; the essentials are here.",
		});

		new Setting(containerEl)
			.setName("Compact layout")
			.setDesc("Tighter spacing and smaller text, for narrow sidebars.")
			.addToggle((t) =>
				t.setValue(s.compact).onChange(async (v) => {
					s.compact = v;
					await this.plugin.persist();
				}),
			);

		new Setting(containerEl)
			.setName("Show progress bar")
			.addToggle((t) =>
				t.setValue(s.showProgress).onChange(async (v) => {
					s.showProgress = v;
					await this.plugin.persist();
				}),
			);

		new Setting(containerEl)
			.setName("Hide note name during questions")
			.setDesc("The note name can give the answer away. Hide it until after you answer.")
			.addToggle((t) =>
				t.setValue(s.hideNoteName).onChange(async (v) => {
					s.hideNoteName = v;
					await this.plugin.persist();
				}),
			);

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
						this.display();
					}),
			);

		if (s.graphNumberMode !== "off" && s.showAdvancedSettings) {
			this.sliderSetting(
				containerEl,
				"Grade weighting",
				"How much the score weighs coverage (how much of the note you've confirmed, capped so a long " +
					"note isn't penalised for its length) against mastery (how well you'd recall what you've " +
					"actually studied right now, from spaced review, not a single lucky answer). Left: pure " +
					"mastery. Right: pure coverage, so the score stays low until a representative slice of the " +
					"note is confirmed.",
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
		}

		// ------------------------------------------------------------ Storage
		new Setting(containerEl).setName("Storage").setHeading();

		if (s.showAdvancedSettings) {
			new Setting(containerEl)
				.setName("Rebalance upcoming due dates")
				.setDesc(
					"Keeps what's due WHEN it's due, but re-smooths the days they land on against a clean slate — " +
						"fixes pile-ups a big import or a long study stretch can leave behind, where several concepts " +
						"scheduled around the same time each landed against a load-balancer that hadn't yet seen all " +
						"its own siblings. Only touches concepts still comfortably in the future; never pulls in or " +
						"pushes out anything already due or overdue.",
				)
				.addButton((b) => b.setButtonText("Rebalance").onClick(() => void this.plugin.rebalanceSchedule()));

			new Setting(containerEl)
				.setName("Show quiz history in a note's backlinks")
				.setDesc(
					"Each saved session links back to the notes it tested, so opening a note's backlinks shows every " +
						'time Grill quizzed you on it. Off: sessions are still saved, just not linked. (They appear in ' +
						'the graph; hide them with -path:"Grill/" in the graph filter.)',
				)
				.addToggle((t) =>
					t.setValue(s.linkSessions).onChange(async (v) => {
						s.linkSessions = v;
						await this.plugin.persist();
					}),
				);

			new Setting(containerEl)
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
		}

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

		if (s.showAdvancedSettings) {
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
		}

		// Kick off a background model-list fetch the first time the tab opens.
		if (!this.modelLists[p] && (s.apiKeys[p] || p === "ollama" || (p === "custom" && s.customBaseUrl)))
			void this.refreshModels(p);
	}
}
