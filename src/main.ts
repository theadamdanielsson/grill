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
	normalizePath,
} from "obsidian";
import { MasteryMap, statusOf } from "./mastery";
import { LLMConfig, PROVIDERS, ProviderId, listModels, testModel } from "./llm";
import { GrillStore } from "./store";
import { SessionView, VIEW_TYPE } from "./view";

interface GrillSettings {
	provider: ProviderId;
	apiKeys: Record<ProviderId, string>;
	models: Record<ProviderId, string>;
	ollamaUrl: string;
	questionsPerSession: number;
	maxNotesPerSession: number;
	/** Vault folder holding mastery.json and session notes. */
	folder: string;
	compact: boolean;
	showProgress: boolean;
	hideNoteName: boolean;
	/** Mirror mastery into note frontmatter (grill-status / grill-due). */
	writeStatus: boolean;
	/** Wiki-link session transcripts to the quizzed notes. */
	linkSessions: boolean;
	/** Vault folders to exclude from sessions (relative paths). */
	excludedFolders: string[];
	/** Send embedded images to the model when it supports vision. */
	sendImages: boolean;
	/** Where questions come from: an LLM, or the note's own structure (no key). */
	questionSource: "ai" | "local";
	/** How answers are graded: an LLM, or the user grades themselves (no key). */
	gradingMode: "ai" | "self";
	/** End-of-session AI debrief (one extra call per session). Off falls back to
	 * a deterministic summary. Ignored for no-key sessions (always deterministic). */
	sessionDebrief: boolean;
}

interface PluginData {
	settings: GrillSettings;
}

function defaultSettings(): GrillSettings {
	return {
		provider: "anthropic",
		apiKeys: { anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "" },
		models: Object.fromEntries(
			(Object.keys(PROVIDERS) as ProviderId[]).map((p) => [p, PROVIDERS[p].defaultModel]),
		) as Record<ProviderId, string>,
		ollamaUrl: "http://localhost:11434",
		questionsPerSession: 5,
		maxNotesPerSession: 15,
		folder: "Grill",
		compact: false,
		showProgress: true,
		hideNoteName: false,
		writeStatus: false,
		linkSessions: true,
		excludedFolders: [],
		sendImages: true,
		questionSource: "ai",
		gradingMode: "ai",
		sessionDebrief: true,
	};
}

export default class GrillPlugin extends Plugin {
	data: PluginData = { settings: defaultSettings() };
	store!: GrillStore;
	/** In-memory mastery cache; source of truth is <folder>/mastery.json. */
	mastery: MasteryMap = {};

	async onload(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		const settings = defaultSettings();
		const s: Partial<GrillSettings> = stored?.settings ?? {};
		if (s.provider && s.provider in PROVIDERS) settings.provider = s.provider;
		if (s.apiKeys) settings.apiKeys = { ...settings.apiKeys, ...s.apiKeys };
		if (s.models) settings.models = { ...settings.models, ...s.models };
		if (typeof s.ollamaUrl === "string" && s.ollamaUrl.trim()) settings.ollamaUrl = s.ollamaUrl.trim();
		if (typeof s.questionsPerSession === "number") settings.questionsPerSession = s.questionsPerSession;
		if (typeof s.maxNotesPerSession === "number") settings.maxNotesPerSession = s.maxNotesPerSession;
		if (typeof s.folder === "string" && s.folder.trim()) settings.folder = s.folder.trim();
		if (typeof s.compact === "boolean") settings.compact = s.compact;
		if (typeof s.showProgress === "boolean") settings.showProgress = s.showProgress;
		if (typeof s.hideNoteName === "boolean") settings.hideNoteName = s.hideNoteName;
		if (typeof s.writeStatus === "boolean") settings.writeStatus = s.writeStatus;
		if (typeof s.linkSessions === "boolean") settings.linkSessions = s.linkSessions;
		if (Array.isArray(s.excludedFolders))
			settings.excludedFolders = s.excludedFolders.filter((v): v is string => typeof v === "string");
		if (typeof s.sendImages === "boolean") settings.sendImages = s.sendImages;
		if (s.questionSource === "ai" || s.questionSource === "local") settings.questionSource = s.questionSource;
		if (s.gradingMode === "ai" || s.gradingMode === "self") settings.gradingMode = s.gradingMode;
		if (typeof s.sessionDebrief === "boolean") settings.sessionDebrief = s.sessionDebrief;
		this.data = { settings };

		this.store = new GrillStore(this.app, () => this.data.settings.folder);

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new SessionView(leaf, this));
		this.addRibbonIcon("flame", "Grill", () => void this.activateView());
		this.addCommand({
			id: "start-session",
			name: "Start session",
			callback: () => void this.activateView(),
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
			id: "sync-note-properties",
			name: "Update note properties from mastery",
			callback: () => void this.backfillStatus(),
		});
		this.addCommand({
			id: "open-instructions",
			name: "Open question instructions",
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
		if (!Platform.isMobile) {
			this.statusBar = this.addStatusBarItem();
			this.statusBar.addClass("mod-clickable");
			this.statusBar.onClickEvent(() => void this.activateView());
		}
		this.addSettingTab(new GrillSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				this.mastery = await this.store.loadMastery();
				this.refreshStatusBar();
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

	/** True if a note path is in the Grill folder or a user-excluded folder. */
	isExcluded(path: string): boolean {
		if (path.startsWith(`${this.data.settings.folder}/`)) return true;
		for (const raw of this.data.settings.excludedFolders) {
			const e = raw.trim();
			if (e && (path === e || path.startsWith(`${e}/`))) return true;
		}
		return false;
	}

	/** Count of notes currently worth reviewing (struggling or due). */
	dueCount(): number {
		const now = new Date();
		let n = 0;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.isExcluded(f.path)) continue;
			const m = this.mastery[f.basename];
			if (!m) continue;
			const s = statusOf(m);
			if (s === "struggling" || (m.dueAt && new Date(m.dueAt) <= now)) n += 1;
		}
		return n;
	}

	refreshStatusBar(): void {
		if (!this.statusBar) return;
		const n = this.dueCount();
		this.statusBar.setText(n > 0 ? `Grill: ${n} due` : "Grill");
	}

	async startScoped(files: TFile[]): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const view = leaf?.view;
		if (view instanceof SessionView) await view.startScopedSession(files);
	}

	/** One-time backfill: write grill-status/grill-due for every tracked note. */
	async backfillStatus(): Promise<void> {
		let n = 0;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.isExcluded(f.path)) continue;
			const m = this.mastery[f.basename];
			if (!m) continue;
			await this.store.writeNoteStatus(f, m);
			n += 1;
		}
		new Notice(`Grill: updated properties on ${n} notes.`);
	}

	/** Active provider config for LLM calls; null if a needed key is missing. */
	llmConfig(): LLMConfig | null {
		const s = this.data.settings;
		const info = PROVIDERS[s.provider];
		const apiKey = s.apiKeys[s.provider];
		if (info.needsKey && !apiKey) return null;
		return {
			provider: s.provider,
			apiKey,
			model: s.models[s.provider] || info.defaultModel,
			baseUrl: s.provider === "ollama" ? s.ollamaUrl : undefined,
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
		const valueEl = setting.controlEl.createSpan({ cls: "grill-slider-value", text: format(value) });
		setting.addSlider((sl) =>
			sl
				.setLimits(min, max, 1)
				.setValue(value)
				.onChange(async (v) => {
					valueEl.setText(format(v));
					await onChange(v);
				}),
		);
	}

	/** The three Grill graph colour-groups: green known, red struggling, grey untested. */
	private static readonly GRAPH_GROUPS: { query: string; color: { a: number; rgb: number } }[] = [
		{ query: '["grill-status":known]', color: { a: 1, rgb: 0x4caf50 } },
		{ query: '["grill-status":struggling]', color: { a: 1, rgb: 0xe5484d } },
		{ query: '["grill-status":untested]', color: { a: 1, rgb: 0x9e9e9e } },
	];

	/** Add Grill's colour-groups to the graph config, without disturbing the user's own
	 * groups. Falls back to the clipboard if the config can't be edited. */
	private async setUpGraphColours(): Promise<void> {
		const path = normalizePath(`${this.app.vault.configDir}/graph.json`);
		try {
			let config: { colorGroups?: { query: string; color: { a: number; rgb: number } }[] } = {};
			if (await this.app.vault.adapter.exists(path)) {
				config = JSON.parse(await this.app.vault.adapter.read(path)) as typeof config;
			}
			const groups = config.colorGroups ?? [];
			const have = new Set(groups.map((g) => g.query));
			let added = 0;
			for (const g of GrillSettingTab.GRAPH_GROUPS) {
				if (!have.has(g.query)) {
					groups.push(g);
					added++;
				}
			}
			config.colorGroups = groups;
			await this.app.vault.adapter.write(path, JSON.stringify(config, null, 2));
			new Notice(
				added
					? "Grill: graph colours added. Open Graph view to see them."
					: "Grill: graph colours were already set up.",
			);
		} catch {
			try {
				await navigator.clipboard.writeText(JSON.stringify(GrillSettingTab.GRAPH_GROUPS, null, 2));
				new Notice("Grill: couldn't edit the graph automatically; the colour groups are on your clipboard.", 8000);
			} catch {
				new Notice("Grill: couldn't set up graph colours. Add three colour groups in Graph view settings.", 8000);
			}
		}
	}

	private async refreshModels(p: ProviderId): Promise<void> {
		if (this.fetching[p]) return;
		this.fetching[p] = true;
		const s = this.plugin.data.settings;
		const models = await listModels(p, s.apiKeys[p], s.ollamaUrl);
		this.fetching[p] = false;
		if (models.length) {
			this.modelLists[p] = models;
			this.display();
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];

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

		if (info.needsKey) {
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
			if (!options.includes(current) && !this.showCustomModel) d.addOption(current, `${current} (not found)`);
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

		new Setting(containerEl)
			.setName("Question & grading instructions")
			.setDesc(
				"A plain-text file in your Grill folder where you tell Grill how you want to be quizzed and " +
					"graded: question style, format, difficulty, strictness. Leave it blank for the defaults.",
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
			"How many notes (chosen by due date and weakness) are sent as context. Fewer is faster and cheaper; more gives the questions greater variety. Default suits most vaults.",
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

		// ------------------------------------------------------------ Appearance
		new Setting(containerEl).setName("Appearance").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Grill follows your theme. Fine-grained control (colors, width, spacing) is available via the community Style Settings plugin; the essentials are here.",
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

		// ------------------------------------------------------------ Storage
		new Setting(containerEl).setName("Storage").setHeading();

		const masterySetting = new Setting(containerEl)
			.setName("Colour your graph by what you know")
			.setDesc(
				"Tags each note you've been quizzed on with how solid you are on it, so Obsidian's graph can " +
					"colour them: green for known, red for shaky, grey for untested. Use the button to set the " +
					"colours up. Off: your notes are never touched. (Also queryable in Dataview and Bases.)",
			)
			.addToggle((t) =>
				t.setValue(s.writeStatus).onChange(async (v) => {
					s.writeStatus = v;
					await this.plugin.persist();
					if (v)
						new Notice(
							"Grill: run 'Update note properties from mastery' to tag notes you've already studied.",
						);
					this.display();
				}),
			);
		if (s.writeStatus) {
			masterySetting.addButton((b) =>
				b
					.setButtonText("Set up graph colours")
					.setTooltip("Add green/red/grey graph groups for Grill mastery")
					.onClick(() => void this.setUpGraphColours()),
			);
		}

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

		// Kick off a background model-list fetch the first time the tab opens.
		if (!this.modelLists[p] && (s.apiKeys[p] || p === "ollama")) void this.refreshModels(p);
	}
}
