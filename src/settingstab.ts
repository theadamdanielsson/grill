/** Grill's settings page: its tabs, sections and rows. */

import type GrillPlugin from "./main";
import { App, Platform, PluginSettingTab, Setting, SettingDefinition, SettingDefinitionItem } from "obsidian";
import { listModels } from "./llm";
import { cloudEnabled } from "./cloud";
import type { ProviderId } from "./providers";
import { dataRows, tuningRows } from "./settings/advanced";
import { opencodeRows, recordForAgentsRow, toolRows } from "./settings/agents";
import { cloudRows } from "./settings/cloud";
import type { Row, SettingsCtx } from "./settings/ctx";
import { modelRows } from "./settings/model";
import { examRows, importRows, profileRow, studyRows } from "./settings/study";

const TUNING_NAME = "Tuning";
const TUNING_DESC = "Changing one of these sets Study intensity to Custom.";
const DATA_NAME = "Data";

/** Where to read more, linked from the Basic tab. */
const HELP_LINKS: Array<{ text: string; href: string }> = [
	{ text: "Website", href: "https://grill.onbridger.com" },
	{ text: "How Grill works", href: "https://github.com/theadamdanielsson/grill/blob/main/docs/features.md" },
	{ text: "Choosing a model", href: "https://github.com/theadamdanielsson/grill/blob/main/docs/models.md" },
	{ text: "Troubleshooting", href: "https://github.com/theadamdanielsson/grill/blob/main/docs/troubleshooting.md" },
];

/** The tabs along the top of Grill's settings. */
type TabId = "basic" | "key" | "agents" | "study" | "advanced";
const TABS: Array<{ id: TabId; name: string }> = [
	{ id: "basic", name: "Basic" },
	{ id: "key", name: "Own key" },
	{ id: "agents", name: "Agents" },
	{ id: "study", name: "Study" },
	{ id: "advanced", name: "Advanced" },
];

interface Section {
	tab: TabId;
	heading: string;
	rows: Row[];
}

export class GrillSettingTab extends PluginSettingTab implements SettingsCtx {
	plugin: GrillPlugin;
	/** Live model lists, cached per provider for the lifetime of the tab. */
	modelLists: Partial<Record<ProviderId, string[]>> = {};
	fetching: Partial<Record<ProviderId, boolean>> = {};
	/** Why the last model-list fetch came back empty, when it said. */
	modelProblems: Partial<Record<ProviderId, string>> = {};
	showCustomModel = false;
	/** Whether Grill Cloud has been asked for the balance since the tab was opened. */
	cloudAsked = false;
	showCloudKey = false;
	showRetiredKeys = false;
	/** Whether the key row is opened up to its controls. */
	manageKey = false;
	/** A key being typed in from another vault; applied only by its button. */
	cloudKeyDraft = "";
	/** Set by the first press on a replacement, so the second one does it. */
	cloudKeyConfirm = false;
	/** The same, for deleting the account. */
	cloudDeleteConfirm = false;
	/** Set when a purchase has just landed: the balance to count up from on the next draw. */
	cloudCountFrom: number | null = null;
	/** The tab open now. Kept while Obsidian is open, so the page comes back where it was. */
	private tab: TabId = "basic";
	/** While opencode is being downloaded from this tab. */
	opencodeBusy = false;
	/** Guards against attaching a duplicate voiceschanged listener on every display(). */
	voicesListenerAttached = false;

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
		this.plugin.account.cloudArrived = null;
		super.hide();
	}

	/** Re-render after a change that adds, removes or rewords rows. Obsidian 1.13+
	 * renders from getSettingDefinitions() and never calls display(), so there the
	 * definitions are rebuilt instead. */
	rerender(): void {
		const update = (this as unknown as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.display();
	}

	async refreshModels(p: ProviderId): Promise<void> {
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

	/** Every row outside Tuning, in the order the page shows them. `all` also lists
	 * the rows the current state hides (another provider's fields, the custom model
	 * box): the 1.13+ definitions are built once and need every row that could appear.
	 * Each tab's rows are built in settings/; this puts them under their headings. */
	private sections(all = false): Section[] {
		const p = this.plugin.data.settings.provider;
		const ai = modelRows(this, all);
		const cloudSection = cloudRows(this, all);
		const { studying, scope } = studyRows(this);
		const take = (rows: Row[], name: string): Row[] => {
			const at = rows.findIndex((r) => r.name === name);
			return at < 0 ? [] : rows.splice(at, 1);
		};
		// What answers, and how Grill talks, go on the first tab; where each program is
		// goes with the programs.
		const persona = take(ai, "Persona & instructions");
		const engine = take(studying, "Engine");
		const programs = [...take(studying, "Claude Code location"), ...take(studying, "Codex location"), ...opencodeRows(this)];
		return [
			...(cloudSection.length ? [{ tab: "basic" as const, heading: "Grill Cloud", rows: cloudSection }] : []),
			{ tab: "basic", heading: "Chat", rows: [...engine, ...persona] },
			{
				tab: "basic",
				heading: "Learn more",
				rows: [
					{
						name: "Guides",
						desc: "How to get the most out of Grill.",
						aliases: ["help", "docs", "documentation", "website", "github", "manual"],
						build: (setting) => {
							const links = setting.descEl.createDiv({ cls: "grill-help-links" });
							for (const l of HELP_LINKS) links.createEl("a", { text: l.text, href: l.href });
						},
					},
				],
			},
			// Grill Cloud picks the model itself.
			{
				tab: "key",
				heading: cloudEnabled() ? "Your own key or Ollama" : "AI",
				rows: all || p !== "grillcloud" ? ai : ai.filter((r) => r.name !== "Model" && r.name !== "Custom model ID"),
			},
			// None of these programs run on mobile, so the tab isn't there.
			...(all || Platform.isDesktopApp ? [{ tab: "agents" as const, heading: "Programs on this computer", rows: programs }] : []),
			...(all || Platform.isDesktopApp ? [{ tab: "agents" as const, heading: "Other agents", rows: [recordForAgentsRow(this)] }] : []),
			{ tab: "agents" as const, heading: "Tools and skills", rows: toolRows(this) },
			{ tab: "study", heading: "Studying", rows: studying },
			{ tab: "study", heading: "Exams", rows: examRows(this) },
			{ tab: "study", heading: "Folders", rows: scope },
			{ tab: "study", heading: "From other AI chats", rows: importRows(this, all) },
			{ tab: "study", heading: "Your profile", rows: [profileRow(this)] },
		];
	}

	/** The row called `name` as it stands right now, or undefined if the current
	 * state doesn't show it. */
	private liveRow(name: string): Row | undefined {
		try {
			return [...this.sections().flatMap((sec) => sec.rows), ...tuningRows(this), ...dataRows(this)].find((r) => r.name === name);
		} catch (e) {
			console.error("Grill: settings row failed", e);
			return undefined;
		}
	}

	/** Obsidian 1.13+: the same rows as display(), handed over as definitions so the
	 * settings search can find them. Tuning is a group on the Advanced tab.
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
				{
					type: "group",
					cls: "grill-settings-tabs-group",
					items: [{ name: "", searchable: false, visible: () => true, render: (setting) => this.tabBar(setting.settingEl) }],
				},
				...this.sections(true).map(
					(sec): SettingDefinitionItem => ({
						type: "group",
						heading: sec.heading,
						visible: () => this.tab === sec.tab || this.searching(),
						items: sec.rows.map(toDef),
					}),
				),
				{
					type: "group",
					heading: TUNING_NAME,
					visible: () => this.tab === "advanced" || this.searching(),
					items: [
						{ name: "", desc: TUNING_DESC, searchable: false, visible: () => this.tab === "advanced", render: (setting) => void setting.setDesc(TUNING_DESC) },
						...tuningRows(this).map(toDef),
					],
				},
				{
					type: "group",
					heading: DATA_NAME,
					visible: () => this.tab === "advanced" || this.searching(),
					items: dataRows(this).map(toDef),
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
		this.tabBar(containerEl.createDiv());
		for (const sec of this.sections()) {
			if (sec.tab !== this.tab) continue;
			new Setting(containerEl).setName(sec.heading).setHeading();
			for (const r of sec.rows) renderRow(containerEl, r);
		}
		if (this.tab === "advanced") {
			new Setting(containerEl).setName(TUNING_NAME).setDesc(TUNING_DESC).setHeading();
			for (const r of tuningRows(this)) renderRow(containerEl, r);
			new Setting(containerEl).setName(DATA_NAME).setHeading();
			for (const r of dataRows(this)) renderRow(containerEl, r);
		}
	}

	/** Whether Obsidian's settings search has something typed in it. Every tab's rows are
	 * then in play, so a search finds a row whatever tab is open. */
	private searching(): boolean {
		return (this.app as unknown as { setting?: { isSearchActive?: boolean } }).setting?.isSearchActive === true;
	}

	/** The tabs along the top: one is open, and only its rows are drawn under it. */
	private tabBar(el: HTMLElement): void {
		el.empty();
		el.className = "grill-settings-tabs";
		el.setAttribute("role", "tablist");
		for (const tab of TABS) {
			const b = el.createEl("button", { cls: "grill-settings-tab", text: tab.name });
			b.setAttribute("role", "tab");
			b.setAttribute("aria-selected", String(tab.id === this.tab));
			if (tab.id === this.tab) b.addClass("is-active");
			b.onclick = () => {
				if (tab.id === this.tab) return;
				this.tab = tab.id;
				this.rerender();
			};
		}
	}
}

