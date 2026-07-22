import {
	App,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	TFolder,
	WorkspaceLeaf,
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

	/** Configure a given setting row as a slider whose current value is shown
	 * inline. (Grill uses the declarative render hook, so the framework hands us
	 * the row and we fill in the control.) */
	private configureSlider(
		setting: Setting,
		min: number,
		max: number,
		value: number,
		format: (v: number) => string,
		onChange: (v: number) => Promise<void>,
	): void {
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

	private async refreshModels(p: ProviderId): Promise<void> {
		if (this.fetching[p]) return;
		this.fetching[p] = true;
		const s = this.plugin.data.settings;
		const models = await listModels(p, s.apiKeys[p], s.ollamaUrl);
		this.fetching[p] = false;
		if (models.length) {
			this.modelLists[p] = models;
			this.update();
		}
	}

	private renderModel(setting: Setting): void {
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];
		const list = this.modelLists[p] ?? [];
		const options = list.length ? list : info.fallbackModels;
		const current = s.models[p] || info.defaultModel;
		const staleCurrent = list.length > 0 && !list.includes(current);
		setting.setName("Model").setDesc(
			staleCurrent
				? `'${current}' was not found on your account and will fail. Pick a model from the list.`
				: list.length
					? `${list.length} models available on your account, verified against your key.`
					: p === "ollama"
						? "Click refresh to list installed models from your Ollama server."
						: "Showing common models. Click refresh to list what your key can access.",
		);
		if (staleCurrent) setting.descEl.addClass("mod-warning");
		setting.addDropdown((d) => {
			for (const m of options) d.addOption(m, m);
			if (!options.includes(current) && !this.showCustomModel) d.addOption(current, `${current} (not found)`);
			d.addOption(CUSTOM, "Custom model ID...");
			d.setValue(this.showCustomModel ? CUSTOM : current);
			d.onChange(async (v) => {
				if (v === CUSTOM) {
					this.showCustomModel = true;
					this.update();
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
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.data.settings;
		const p = s.provider;
		const info = PROVIDERS[p];

		// Kick off a background model-list fetch the first time the tab renders.
		if (!this.modelLists[p] && (s.apiKeys[p] || p === "ollama")) void this.refreshModels(p);

		const keyRow =
			info.needsKey
				? {
						name: "API key",
						desc: `Stored locally in this vault's plugin data, never in your notes. Get one at ${info.keyUrl}.`,
						render: (setting: Setting) =>
							void setting.addText((t) => {
								t.setPlaceholder(info.keyPlaceholder)
									.setValue(s.apiKeys[p])
									.onChange(async (v) => {
										s.apiKeys[p] = v.trim();
										delete this.modelLists[p];
										await this.plugin.persist();
									});
								t.inputEl.type = "password";
							}),
					}
				: {
						name: "Ollama server",
						desc:
							"Requires Ollama running locally (ollama.com). Nothing leaves your machine. " +
							"Expect slower sessions and simpler questions than cloud models; 8B+ models recommended.",
						render: (setting: Setting) =>
							void setting.addText((t) =>
								t
									.setPlaceholder("http://localhost:11434")
									.setValue(s.ollamaUrl)
									.onChange(async (v) => {
										s.ollamaUrl = v.trim() || "http://localhost:11434";
										delete this.modelLists.ollama;
										await this.plugin.persist();
									}),
							),
					};

		const totalNotes = Math.max(
			1,
			this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(`${s.folder}/`)).length,
		);
		const notesValue = s.maxNotesPerSession >= totalNotes ? totalNotes : Math.max(1, s.maxNotesPerSession);

		return [
			{
				type: "group",
				heading: "AI",
				items: [
					{
						name: "Provider",
						desc:
							"Cloud providers send the quizzed notes to that provider using your key. " +
							"Ollama runs fully on your machine: private, but local models write noticeably weaker questions.",
						render: (setting: Setting) =>
							void setting.addDropdown((d) => {
								for (const [id, pi] of Object.entries(PROVIDERS)) d.addOption(id, pi.label);
								d.setValue(p).onChange(async (v) => {
									s.provider = v as ProviderId;
									this.showCustomModel = false;
									await this.plugin.persist();
									this.update();
									void this.refreshModels(v as ProviderId);
								});
							}),
					},
					keyRow,
					{ name: "Model", render: (setting: Setting) => this.renderModel(setting) },
					{
						name: "Custom model ID",
						visible: () => this.showCustomModel,
						render: (setting: Setting) =>
							void setting.addText((t) =>
								t
									.setPlaceholder(info.defaultModel)
									.setValue(s.models[p])
									.onChange(async (v) => {
										s.models[p] = v.trim() || info.defaultModel;
										await this.plugin.persist();
									}),
							),
					},
					{
						name: "Send images to the model",
						desc:
							"When a note embeds images and your model can read them (Claude, GPT, Gemini, and vision Ollama " +
							"models can), Grill sends the images too, so it can quiz on diagrams and screenshots. Costs " +
							"extra tokens. Text-only models never receive images.",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.sendImages).onChange(async (v) => {
									s.sendImages = v;
									await this.plugin.persist();
								}),
							),
					},
				],
			},
			{
				type: "group",
				heading: "Sessions",
				items: [
					{
						name: "Questions per session",
						render: (setting: Setting) =>
							this.configureSlider(
								setting,
								1,
								50,
								Math.min(Math.max(s.questionsPerSession, 1), 50),
								(v) => String(v),
								async (v) => {
									s.questionsPerSession = v;
									await this.plugin.persist();
								},
							),
					},
					{
						name: "Notes considered per session",
						desc:
							"How many notes (chosen by due date and weakness) are sent as context. Fewer is faster and " +
							"cheaper; more gives the questions greater variety. Default suits most vaults.",
						render: (setting: Setting) =>
							this.configureSlider(
								setting,
								1,
								totalNotes,
								notesValue,
								(v) => (v >= totalNotes ? "All" : String(v)),
								async (v) => {
									// Store a large sentinel for "All" so it stays All as the vault grows.
									s.maxNotesPerSession = v >= totalNotes ? ALL_NOTES : v;
									await this.plugin.persist();
								},
							),
					},
				],
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Theme",
						desc:
							"Grill follows your theme. Fine-grained control (colors, width, spacing) is available via " +
							"the community Style Settings plugin; the essentials are here.",
						searchable: false,
						render: (setting: Setting) => void setting.settingEl.addClass("grill-settings-note"),
					},
					{
						name: "Compact layout",
						desc: "Tighter spacing and smaller text, for narrow sidebars.",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.compact).onChange(async (v) => {
									s.compact = v;
									await this.plugin.persist();
								}),
							),
					},
					{
						name: "Show progress bar",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.showProgress).onChange(async (v) => {
									s.showProgress = v;
									await this.plugin.persist();
								}),
							),
					},
					{
						name: "Hide note name during questions",
						desc: "The note name can give the answer away. Hide it until after you answer.",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.hideNoteName).onChange(async (v) => {
									s.hideNoteName = v;
									await this.plugin.persist();
								}),
							),
					},
				],
			},
			{
				type: "group",
				heading: "Storage",
				items: [
					{
						name: "Write mastery to note properties",
						desc:
							"Adds grill-status and grill-due to quizzed notes' frontmatter, so graph view groups " +
							"can color notes by mastery and Dataview/Bases can query it. Off: notes are never touched.",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.writeStatus).onChange(async (v) => {
									s.writeStatus = v;
									await this.plugin.persist();
									if (v)
										new Notice(
											"Grill: run 'Update note properties from mastery' to backfill existing notes.",
										);
								}),
							),
					},
					{
						name: "Link session transcripts to notes",
						desc:
							"Wiki-links quizzed notes from session transcripts, so a note's backlinks show its quiz " +
							'history. Sessions then appear in graph view; hide them there by adding -path:"Grill/" to ' +
							"the graph filter.",
						render: (setting: Setting) =>
							void setting.addToggle((t) =>
								t.setValue(s.linkSessions).onChange(async (v) => {
									s.linkSessions = v;
									await this.plugin.persist();
								}),
							),
					},
					{
						name: "Grill folder",
						desc:
							"Vault folder for mastery.json and session transcripts. These are plain files: " +
							"read them, edit them, sync them like any note.",
						render: (setting: Setting) =>
							void setting.addText((t) =>
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
						name: "Excluded folders",
						desc:
							"Comma-separated folders to leave out of sessions, so notes like templates and " +
							"attachments aren't quizzed. Relative paths, e.g. Templates, Inbox, Archive.",
						render: (setting: Setting) =>
							void setting.addText((t) =>
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
							),
					},
				],
			},
		];
	}
}
