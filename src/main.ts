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
import { MasteryMap } from "./mastery";
import { CalPoint, isCalPoint } from "./calibration";
import { LLMConfig, PROVIDERS, ProviderId, Question, listModels, testModel } from "./llm";
import { ConceptMap, dueConceptCount, migrateResetScheduling, reconcileConcepts } from "./concepts";
import { extractConcepts } from "./generate-local";
import { dueFiles, duplicateBasenames } from "./scope";
import { GrillStore } from "./store";
import { SessionView, VIEW_TYPE } from "./view";
import type { ColorMode, NumberMode } from "./mapview";

interface GrillSettings {
	provider: ProviderId;
	apiKeys: Record<ProviderId, string>;
	models: Record<ProviderId, string>;
	ollamaUrl: string;
	/** Base URL for the custom OpenAI-compatible provider, e.g. https://openrouter.ai/api/v1 */
	customBaseUrl: string;
	questionsPerSession: number;
	maxNotesPerSession: number;
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
	/** Send embedded images to the model when it supports vision. */
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
	/** Missing-link finder: surface a "these two notes should be linked" question in
	 * AI sessions and offer to write the link. On by default. */
	graphInsights: boolean;
	/** How many missing-link bridge questions to add per session (0 disables). */
	bridgesPerSession: number;
	/** Question cache: a same-day re-show (the FSRS relearn loop, or reviewing the
	 * same concept twice in one sitting) always reuses the cached text — that's a
	 * real "you just saw this minutes ago" repeat, not a memory test. A later day's
	 * review always gets a freshly written variant instead, since asking someone to
	 * recall a concept days later by recognizing the identical sentence they saw
	 * before isn't testing recall. This flag opts back into the old always-reuse
	 * behavior (across days too) for anyone who wants to minimize model calls over
	 * freshness. */
	reuseAcrossDays: boolean;
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
	/** Cap on how many never-before-tested concepts a session will introduce per
	 * calendar day, independent of questionsPerSession/maxNotesPerSession (which
	 * govern one sitting, not the day). Once hit, sessions fill remaining slots from
	 * due/review material instead, so the due backlog can't balloon from unlimited
	 * new material outrunning how fast it can actually be reviewed. 0 = no cap. */
	newConceptsPerDay: number;
	/** Settings-tab progressive disclosure: reveal the rarely-touched tuning/maintenance
	 * settings (careful grading, coverage weighting, reuse-across-days, cache clearing,
	 * missing-link bridges, etc.) below a single toggle instead of always showing all
	 * ~30 settings flat. Sticky across reopens — a power user who turns it on shouldn't
	 * have to re-expand every time. */
	showAdvancedSettings: boolean;
}

interface PluginData {
	settings: GrillSettings;
	/** Rolling metacognitive-calibration buffer (confidence vs outcome). */
	calibration: CalPoint[];
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
		maxNotesPerSession: 15,
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
		graphInsights: true,
		bridgesPerSession: 1,
		reuseAcrossDays: false,
		carefulGrade: false,
		conceptsMigrated: false,
		graphColorMode: "mastery",
		graphNumberMode: "percent",
		graphCoverageWeight: 15,
		desiredRetention: 90,
		newConceptsPerDay: 20,
		legacyDefaultsMigrated: false,
		showAdvancedSettings: false,
	};
}

export default class GrillPlugin extends Plugin {
	data: PluginData = { settings: defaultSettings(), calibration: [] };
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
		if (typeof s.maxNotesPerSession === "number") settings.maxNotesPerSession = s.maxNotesPerSession;
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
		if (typeof s.graphInsights === "boolean") settings.graphInsights = s.graphInsights;
		if (typeof s.bridgesPerSession === "number") settings.bridgesPerSession = s.bridgesPerSession;
		// One-time migration: "Reuse generated questions" used to be a 0-10 count of
		// same-text repeats before a fresh variant was written. Under the new model
		// (below), only the old maximum-reuse extreme (0, "Always reuse") still means
		// anything — carry that one forward as reuseAcrossDays; every other stored
		// count adopts the new same-day-only default. An explicit reuseAcrossDays
		// already on disk (a newer install) wins over this migration.
		const legacyRegenerateEvery = (s as Record<string, unknown>).regenerateEvery;
		if (typeof legacyRegenerateEvery === "number") settings.reuseAcrossDays = legacyRegenerateEvery === 0;
		if (typeof s.reuseAcrossDays === "boolean") settings.reuseAcrossDays = s.reuseAcrossDays;
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
		if (typeof s.newConceptsPerDay === "number") settings.newConceptsPerDay = s.newConceptsPerDay;
		if (typeof s.legacyDefaultsMigrated === "boolean") settings.legacyDefaultsMigrated = s.legacyDefaultsMigrated;
		if (typeof s.showAdvancedSettings === "boolean") settings.showAdvancedSettings = s.showAdvancedSettings;
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
		this.data = { settings, calibration };

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

	/** One-time startup check (see `duplicateBasenames`): if two of Grill's eligible
	 * notes share a filename, Grill's basename-keyed mastery/concepts can't tell them
	 * apart, so their scheduling/progress silently mixes together and which file wins
	 * a given lookup isn't guaranteed stable. Not fixable without a schema migration —
	 * this just makes it visible instead of a silent, confusing mastery-map glitch. */
	private warnOnDuplicateBasenames(): void {
		const eligible = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
		const dupes = duplicateBasenames(eligible);
		if (!dupes.length) return;
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
/** Sentinel stored for maxNotesPerSession meaning "every note", so it stays
 * "All" as the vault grows rather than freezing at the count when it was set. */
const ALL_NOTES = 1_000_000;

class GrillSettingTab extends PluginSettingTab {
	plugin: GrillPlugin;
	/** Live model lists, cached per provider for the lifetime of the tab. */
	private modelLists: Partial<Record<ProviderId, string[]>> = {};
	private fetching: Partial<Record<ProviderId, boolean>> = {};
	private showCustomModel = false;

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
					"reuse-across-days, cache clearing, and similar.",
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
				"Mixed adds multiple-choice, fill-in-the-blank, true/false, select-all-that-apply, and matching " +
					"alongside the usual write-in-the-box questions, picked per concept based on what actually fits it. " +
					"Multiple choice only always uses 'mc' (falling back to another structured format only when a " +
					"concept genuinely can't be posed as a single-answer choice). In AI mode either non-Write option " +
					"costs a little extra prompt on every question batch. Set here, not in Instructions.md — a " +
					"free-text preference like \"only multiple choice\" there won't reliably stick.",
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

		const totalNotes = Math.max(
			1,
			this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(`${s.folder}/`)).length,
		);
		const notesValue = s.maxNotesPerSession >= totalNotes ? totalNotes : Math.max(1, s.maxNotesPerSession);
		this.sliderSetting(
			containerEl,
			"Notes considered per session",
			"How many notes (chosen by due date and weakness) Grill reads and scans for concepts before picking " +
				"this session's questions — only the 1-2 notes behind each question are ever actually sent to the " +
				"model, so this doesn't affect cost. Fewer is faster to start a session; more gives the scheduler a " +
				"wider pool to pick fresh material from on a large vault. Default suits most vaults. Doesn't apply " +
				"when you scope a session yourself (a chosen note/folder, or due review) — those always consider " +
				"everything you picked.",
			1,
			totalNotes,
			notesValue,
			(v) => (v >= totalNotes ? "All" : String(v)),
			async (v) => {
				// Store a large sentinel for "All" so it stays All as the vault grows.
				s.maxNotesPerSession = v >= totalNotes ? ALL_NOTES : v;
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
						"connection, and offer to add the [[link]] for you. Needs a key; off for no-key sessions.",
				)
				.addToggle((t) =>
					t.setValue(s.graphInsights).onChange(async (v) => {
						s.graphInsights = v;
						await this.plugin.persist();
						this.display();
					}),
				);

			if (s.graphInsights) {
				this.sliderSetting(
					containerEl,
					"Missing-link questions per session",
					"How many connection questions to add at most, on top of your normal review.",
					0,
					3,
					Math.min(Math.max(s.bridgesPerSession, 0), 3),
					(v) => String(v),
					async (v) => {
						s.bridgesPerSession = v;
						await this.plugin.persist();
					},
				);
			}

			new Setting(containerEl)
				.setName("Reuse questions across days")
				.setDesc(
					"Off (default): a concept due for review always gets a freshly written question once a new day has " +
						"passed since you last saw it — recognizing the identical sentence you read days ago isn't a real " +
						"memory test. Reviewing the same concept again within the same day (e.g. right after getting it " +
						"wrong) still reuses the cached question either way, since that's a genuine 'you just saw this' " +
						"repeat, not a spaced review. Turn this on to reuse cached questions across days too and minimize " +
						"model calls, at the cost of eventually seeing the same phrasing again on a real review.",
				)
				.addToggle((t) =>
					t.setValue(s.reuseAcrossDays).onChange(async (v) => {
						s.reuseAcrossDays = v;
						await this.plugin.persist();
					}),
				);

			new Setting(containerEl)
				.setName("Clear cached questions")
				.setDesc(
					"Forces every concept to write a fresh question next time it's due, instead of waiting for its next " +
						"new-day review (or, with 'Reuse questions across days' on above, indefinitely). Useful right " +
						"after a Grill update changes how questions are written (a new format, a prompt fix) so it " +
						"reaches concepts you've already studied a lot, not just new ones. Doesn't affect a session " +
						"already open.",
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
