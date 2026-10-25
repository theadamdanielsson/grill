/** Grill's settings page: its tabs, sections and rows. */

import type GrillPlugin from "./main";
import { App, Notice, Platform, PluginSettingTab, Setting, SettingDefinition, SettingDefinitionItem, TFile } from "obsidian";
import { configureFSRSWeights } from "./mastery";
import { OLLAMA_DEFAULT_URL, offeredProviders, ProviderId, PROVIDERS } from "./providers";
import { listModels, testModel } from "./llm";
import { cloud, CLOUD_FACTS, CLOUD_LEAD, CLOUD_PITCH, planInWords, planLabel, cloudEnabled, creditsInWords, isCloudKey, packLabel, usageInWords } from "./cloud";
import { drawOffers, drawPlanUsage, packGo } from "./refill";
import { importedNames } from "./imported";
import { countTrainableReviews, MIN_REVIEWS_FOR_OPTIMIZATION } from "./optimizer";
import { canInstall, findOpencode, isGrillInstall, OPENCODE_VERSION, uninstallOpencode } from "./opencode";
import { daysLeft, examLines, examName, whenWords, type Exam } from "./exams";
import { ExamModal } from "./exammodal";
import { listLanguages, listVoices, listVoicesForLang, onVoicesChanged } from "./tts";
import { applyIntensity, type StudyIntensity } from "./settingstools";
import { type GrillSettings, restoredSettings } from "./settings";

const CUSTOM = "__custom__";

const TUNING_NAME = "Tuning";
const TUNING_DESC = "Changing one of these sets Study intensity to Custom.";
const DATA_NAME = "Data";

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

/** The MCP servers Claude Code has for every project (~/.claude.json) and Claude
 * Desktop has, by name. Empty on a phone or when there are none. */
function importClaudeServers(): Record<string, unknown> {
	const req = (window as unknown as { require?: (m: string) => unknown }).require;
	if (!req) return {};
	const fs = req("fs") as { readFileSync(p: string, e: "utf8"): string };
	const home = (req("os") as { homedir(): string }).homedir();
	const out: Record<string, unknown> = {};
	for (const file of [`${home}/Library/Application Support/Claude/claude_desktop_config.json`, `${home}/.claude.json`]) {
		try {
			const servers = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers;
			if (servers && typeof servers === "object") Object.assign(out, servers);
		} catch {
			// Not there.
		}
	}
	// Grill's own server: Chat here has its record tools already.
	for (const [name, v] of Object.entries(out)) if (JSON.stringify(v).includes("grill-mcp")) delete out[name];
	return out;
}

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
	/** The tab open now. Kept while Obsidian is open, so the page comes back where it was. */
	private tab: TabId = "basic";
	/** While opencode is being downloaded from this tab. */
	private opencodeBusy = false;
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
		this.plugin.account.cloudArrived = null;
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
	 * The record of which one-time upgrades have run is kept (see restoredSettings): they
	 * aren't preferences, and running one again would undo a choice made after Restore. */
	private async restoreDefaults(): Promise<void> {
		const s = this.plugin.data.settings;
		this.plugin.data.settings = restoredSettings(s);
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
							await this.plugin.settings.update({ naturalVoice: v });
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
					setting.setDesc("No voices found yet. Reopen Settings in a moment.");
					if (!this.voicesListenerAttached) {
						this.voicesListenerAttached = true;
						this.plugin.register(onVoicesChanged(() => this.rerender()));
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
	 * about. They live on the Advanced tab, which the page never opens on, so the other
	 * tabs stay short. The last two rows, Grill folder and Restore, are not tuning: they
	 * are drawn under a heading of their own (see dataRows). */
	private tuningRows(): Row[] {
		const s = this.plugin.data.settings;

		/** Editing any raw scheduling number means the preset no longer describes them. */
		const toCustom = async (): Promise<void> => {
			await this.plugin.settings.update({ studyIntensity: "custom" });
		};

		const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

		return [
			this.sliderRow(
				"Review frequency",
				"How sure Grill wants you to be when a concept comes back. Higher means more reviews.",
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
				"The most untested concepts a day. Tests on a note or folder you pick aren't capped. 0 means review only.",
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
				"The most of one session that new material can take.",
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
									await this.plugin.settings.update({ easyDays: v ? [...new Set([...s.easyDays, weekday])] : s.easyDays.filter((d) => d !== weekday) });
								}),
						);
					});
				},
			},
			this.sliderRow(
				"Grade weighting",
				"A note's score on the map: how well you recall it (left) or how much of it you've covered (right).",
				0,
				100,
				s.graphCoverageWeight,
				(v) => `${v}% coverage`,
				async (v) => {
					await this.plugin.settings.update({ graphCoverageWeight: v });
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
		];
	}

	/** Where Grill keeps its files, and the way back to the recommended settings. */
	private dataRows(): Row[] {
		const s = this.plugin.data.settings;
		return [
			{
				name: "Grill folder",
				desc: "Where Grill keeps its data and session notes.",
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Grill")
							.setValue(s.folder)
							.onChange(async (v) => {
								await this.plugin.settings.update({ folder: v.trim() || "Grill" });
							}),
					),
			},
			{
				name: "Record in note properties",
				desc: "Adds status, due date, last tested and confusions to each studied note, for Bases and other agents. This edits your notes.",
				aliases: ["properties", "frontmatter", "bases", "yaml"],
				build: (setting) =>
					setting.addToggle((t) =>
						t.setValue(s.noteProperties).onChange(async (v) => {
							await this.plugin.settings.update({ noteProperties: v });
							await this.plugin.syncNoteProperties(v);
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
		const ai: Row[] = [
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
		const credits = this.plugin.account.cloudCredits;
		const state = this.plugin.account.cloudState;
		const waiting = this.plugin.account.cloudWaitingFrom !== null;
		const plan = this.plugin.account.cloudPlan;
		const usingCloud = p === "grillcloud";
		const creditsLine = (n: number): string => `${usingCloud ? "In use" : "Not in use"}. ${creditsInWords(n)}.`;
		const start = (setting: Setting, label: string, cta: boolean): void => {
			setting.addButton((b) => {
				b.setButtonText(label).onClick(async () => {
					b.setDisabled(true);
					try {
						new Notice(`Grill: ${await this.plugin.account.startCloud()}`, 8000);
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
						? this.plugin.account.cloudNote
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
				// No name in the card: the section heading above already says Grill Cloud.
				const head = card.createDiv({ cls: "grill-cloud-card-head" });
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
					body.createDiv({ cls: "grill-cloud-panel-lead", text: CLOUD_LEAD });
					if (this.plugin.account.sharesDeviceCloud()) body.createDiv({ cls: "grill-meta", text: "You already use Grill Cloud in another vault on this device. Starting here uses the same balance." });
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
				// An empty balance is not the headline while the plan is on offer: the offer is.
				const empty = known && (credits ?? 0) <= 0 && this.plugin.account.cloudCanSubscribe && !plan && !waiting;
				// No number until the server has said one: a placeholder reads as a balance.
				const figure = body.createDiv({ cls: "grill-cloud-balance" });
				if (empty) figure.hide();
				// On the plan with no credits beside it, the plan is what there is to show.
				const onPlanOnly = known && plan !== null && (credits ?? 0) <= 0;
				const number = figure.createSpan({ cls: "grill-cloud-balance-number", text: onPlanOnly ? "On" : known ? (credits ?? 0).toLocaleString("en-US") : "" });
				if (known) figure.createSpan({ cls: "grill-cloud-balance-unit", text: onPlanOnly ? "monthly plan" : "credits" });
				// Free credits used up, no plan: the balance, what sessions cost and whether
				// Cloud is in use say nothing useful. The offer is the whole card.
				card.toggleClass("grill-cloud-offering", empty);
				if (!empty) body.createDiv({
					cls: "grill-meta",
					text:
						state === "offline" || state === "refused"
							? this.plugin.account.cloudNote || "Couldn't reach Grill Cloud."
							: state === "none"
								? "No credits yet."
								: !known
									? "Checking your balance..."
									: waiting
										? "Checkout is open in your browser. It shows up here a few seconds after you pay."
										: plan
											? planInWords(plan)
											: usage,
				});
				if (known && plan && !waiting) drawPlanUsage(body, plan);
				card.toggleClass("grill-cloud-waiting", waiting);
				if (!usingCloud && !empty) {
					setting.addButton((b) => {
						b.setButtonText("Use Grill Cloud").onClick(async () => {
							await this.plugin.settings.update({ provider: "grillcloud" });
							this.rerender();
						});
						// One lit button in the card: the plan's, when it is on offer.
						if (!this.plugin.account.cloudCanSubscribe) b.setCta();
						return b;
					});
				}
				if (waiting) {
					setting.addButton((b) =>
						b.setButtonText("Stop checking").onClick(() => {
							this.plugin.account.stopCloudWatch();
							this.rerender();
						}),
					);
				} else {
					if (state === "none") start(setting, "Try free credits", false);
					const canSubscribe = this.plugin.account.cloudCanSubscribe;
					const packs = this.plugin.account.cloudShowPacks ? this.plugin.account.cloudPacks : [];
					if (canSubscribe) {
						// The plan and the packs as one row of prices; the buttons are Obsidian's
						// own, moved into their columns.
						const slots = drawOffers(body, packs);
						setting.addButton((b) => {
							b.setButtonText(planLabel())
								.setCta()
								.onClick(() => {
									this.plugin.account.openCloudPlanCheckout();
									this.rerender();
								});
							if (b.buttonEl) {
								b.buttonEl.addClass("grill-plan-go");
								slots.plan.appendChild(b.buttonEl);
							}
							return b;
						});
						packs.forEach((pack, i) => {
							setting.addButton((b) => {
								b.setButtonText(packGo(pack)).onClick(() => {
									this.plugin.account.openCloudCheckout(pack.link);
									this.rerender();
								});
								if (b.buttonEl) slots.packs[i].appendChild(b.buttonEl);
								return b;
							});
						});
					} else {
						for (const pack of packs) {
							setting.addButton((b) => {
								b.setButtonText(packLabel(pack)).onClick(() => {
									this.plugin.account.openCloudCheckout(pack.link);
									this.rerender();
								});
								if (usingCloud && pack === packs[packs.length - 1]) b.setCta();
								return b;
							});
						}
					}
					// The plan's offer says how checkout works under its own button.
					if (this.plugin.account.cloudShowPacks && !canSubscribe) {
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
							await this.plugin.account.refreshCloud();
							this.rerender();
						});
					// Up in the corner, out of the row of pack buttons, which needs its width.
					if (b.extraSettingsEl) corner.appendChild(b.extraSettingsEl);
					return b;
				});
				if (!empty) corner.createSpan({ cls: usingCloud ? "grill-cloud-chip is-on" : "grill-cloud-chip", text: usingCloud ? "In use" : "Not in use" });
				// When a purchase lands (or the wait ends) while this tab is open: redraw,
				// and count the balance up from the old number to the new one.
				this.plugin.account.cloudArrived = (from, to) => {
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
					void this.plugin.account.refreshCloud().then(() => this.rerender());
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
					if (this.plugin.account.cloudWaitingFrom === null) return false;
					new Notice("Grill: a purchase is still on its way to this key. Wait for it, or press Stop checking first.", 8000);
					return true;
				};
				if (cloudKey && this.plugin.account.cloudAccountId) {
					setting.addText((t) => {
						t.setValue(this.plugin.account.cloudAccountId);
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
						const problem = await this.plugin.account.useCloudKey(draft);
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
							await this.plugin.account.forgetCloudKey();
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
							const problem = await this.plugin.account.deleteCloud();
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
						.setPlaceholder(OLLAMA_DEFAULT_URL)
						.setValue(s.ollamaUrl)
						.onChange(async (v) => {
							s.ollamaUrl = v.trim() || OLLAMA_DEFAULT_URL;
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
							const cfg = this.plugin.modelConfig();
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
			desc: "Grill's character, and how you want to be tested and answered, in a note you can edit.",
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
				"How many an open test asks. Retry and Catch up ask what they count.",
				1,
				50,
				Math.min(Math.max(s.questionsPerSession, 1), 50),
				(v) => String(v),
				async (v) => {
					await this.plugin.settings.update({ questionsPerSession: v });
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
				desc: examLines(s.exams, new Date()).length
					? "How often things come back and how much is new each day. Notes in an exam follow its date instead."
					: "How often things come back and how much is new each day.",
				aliases: ["retention", "spaced repetition", "fsrs", "schedule"],
				build: (setting) =>
					setting.addDropdown((d) => {
						d.addOption("relaxed", "Relaxed: fewer reviews, slower intake");
						d.addOption("steady", "Steady (recommended)");
						d.addOption("intense", "Intense: more reviews, faster intake");
						if (s.studyIntensity === "custom") d.addOption("custom", "Custom: set in Advanced");
						d.setValue(s.studyIntensity);
						d.onChange(async (v) => {
							if (v === "custom") return;
							applyIntensity(s, v as Exclude<StudyIntensity, "custom">);
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
								await this.plugin.settings.update({ questionFormats: v === "write" ? "write" : v === "mc" ? "mc" : "mixed" });
							}),
					),
			},
			{
				name: "Hints in tests",
				desc: "Offer a hint while you answer. Using one lowers what a correct answer counts for.",
				aliases: ["hint", "help", "clue"],
				build: (setting) =>
					setting.addToggle((t) =>
						t.setValue(s.testHints).onChange(async (v) => {
							await this.plugin.settings.update({ testHints: v });
						}),
					),
			},
			{
				name: "Engine",
				desc: "What answers in Chat and writes and marks your tests. Claude Code, Codex and opencode run on this computer with your own sign-in and your own setup: skills, MCP servers, hooks and CLAUDE.md. Desktop only.",
				aliases: ["claude code", "codex", "opencode", "agent", "engine", "subscription", "chatgpt", "skills", "mcp", "hooks"],
				build: (setting) =>
					setting.addDropdown((d) =>
						d
							.addOption("model", cloudEnabled() && p === "grillcloud" ? "Grill Cloud" : PROVIDERS[p].label)
							.addOption("claudecode", "Claude Code")
							.addOption("codex", "Codex")
							.addOption("opencode", "opencode")
							.setValue(s.chatEngine)
							.onChange(async (v) => {
								await this.plugin.settings.update({ chatEngine: v === "claudecode" || v === "codex" || v === "opencode" ? v : "model" });
							}),
					),
			},
			{
				name: "Claude Code location",
				desc: "Leave empty to have it found. Fill in the full path if Chat says it could not be started.",
				aliases: ["claude path", "binary", "executable"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Found automatically")
							.setValue(s.claudePath)
							.onChange(async (v) => {
								await this.plugin.settings.update({ claudePath: v.trim() });
							}),
					),
			},
			{
				name: "Codex location",
				desc: "Leave empty to have it found. Fill in the full path if Chat says it could not be started.",
				aliases: ["codex path", "binary", "executable"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Found automatically")
							.setValue(s.codexPath)
							.onChange(async (v) => {
								await this.plugin.settings.update({ codexPath: v.trim() });
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
							await this.plugin.settings.update({ sounds: v });
						}),
					),
			},
			this.naturalVoiceRow(s),
			this.voiceRow(s),
		];

		// The map's display options (what its colours show, the score on each note) had a
		// section here. The map is one view on the progress screen now, in its defaults;
		// an install that changed them keeps what it chose.

		// ------------------------------------------------------------ Scope
		const folderList = (v: string): string[] =>
			v
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean);
		const scope: Row[] = [
			{
				name: "Grill's folders",
				desc: "Folders Grill tests you on and reads to answer you, comma-separated. Blank for the whole vault.",
				aliases: ["include", "scope"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Whole vault")
							.setValue(s.includedFolders.join(", "))
							.onChange(async (v) => {
								await this.plugin.settings.update({ includedFolders: folderList(v) });
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
								await this.plugin.settings.update({ excludedFolders: folderList(v) });
							}),
					),
			},
		];

		const take = (rows: Row[], name: string): Row[] => {
			const at = rows.findIndex((r) => r.name === name);
			return at < 0 ? [] : rows.splice(at, 1);
		};
		// What answers, and how Grill talks, go on the first tab; where each program is
		// goes with the programs.
		const persona = take(ai, "Persona & instructions");
		const engine = take(studying, "Engine");
		const programs = [...take(studying, "Claude Code location"), ...take(studying, "Codex location"), ...this.opencodeRows()];
		return [
			...(cloudRows.length ? [{ tab: "basic" as const, heading: "Grill Cloud", rows: cloudRows }] : []),
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
			...(all || Platform.isDesktopApp ? [{ tab: "agents" as const, heading: "Other agents", rows: [this.recordForAgentsRow()] }] : []),
			{ tab: "agents" as const, heading: "Tools and skills", rows: this.toolRows() },
			{ tab: "study", heading: "Studying", rows: studying },
			{ tab: "study", heading: "Exams", rows: this.examRows() },
			{ tab: "study", heading: "Folders", rows: scope },
			{ tab: "study", heading: "From other AI chats", rows: this.importRows(all) },
			{ tab: "study", heading: "Your profile", rows: [this.profileRow()] },
		];
	}

	/** One row per exam, then a row to add one. Each opens ExamModal: the date, and
	 * what the exam covers. */
	private examRows(): Row[] {
		const s = this.plugin.data.settings;
		const when = (e: Exam): string => {
			const left = daysLeft(e, new Date());
			if (left < 0) return "Over. Scheduled as usual again.";
			const w = whenWords(left);
			return `${w[0].toUpperCase()}${w.slice(1)}. Reviews come back more often as it nears, and new material is paced to be covered by then.`;
		};
		const folders = (): string[] =>
			this.app.vault
				.getAllFolders(false)
				.map((f) => f.path)
				.filter((p) => !this.plugin.isExcluded(`${p}/x.md`))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const open = (exam: Exam | null): void =>
			new ExamModal(this.app, folders(), exam, async (saved) => {
				await this.plugin.settings.update({ exams: exam ? s.exams.map((x) => (x === exam ? saved : x)) : [...s.exams, saved] });
				new Notice(`Grill: ${examName(saved)} now scheduled for your exam ${whenWords(daysLeft(saved, new Date()))}.`, 6000);
				this.rerender();
			}).open();
		const rows: Row[] = s.exams.map((e) => ({
			name: examName(e),
			desc: when(e),
			build: (setting) => {
				setting.addButton((b) => b.setButtonText("Edit").onClick(() => open(e)));
				setting.addExtraButton((b) =>
					b
						.setIcon("x")
						.setTooltip("Remove")
						.onClick(async () => {
							await this.plugin.settings.update({ exams: s.exams.filter((x) => x !== e) });
							this.rerender();
						}),
				);
			},
		}));
		rows.push({
			name: "Add exam",
			desc: "What it covers and the day of the exam. Those notes are scheduled to be ready by then.",
			aliases: ["exam", "deadline", "test date", "course"],
			build: (setting) => setting.addButton((b) => b.setButtonText("Add").onClick(() => open(null))),
		});
		rows.push({
			name: "Everything else",
			desc: "Notes outside an exam. Keep what I read brings fewer new ones in each day and lets reviews wait longer.",
			aliases: ["casual", "reading", "books", "keep", "remember"],
			build: (setting) =>
				setting.addDropdown((d) =>
					d
						.addOption("study", "Study it like an exam")
						.addOption("keep", "Keep what I read")
						.setValue(s.everythingElse)
						.onChange(async (v) => {
							await this.plugin.settings.update({ everythingElse: v === "keep" ? "keep" : "study" });
						}),
				),
		});
		return rows;
	}

	/** Bringing in what the student asked other AI tools, and what they know about them. */
	private importRows(all: boolean): Row[] {
		const s = this.plugin.data.settings;
		const told = (r: { notes: number; names: string[] }): void => {
			new Notice(r.notes ? `Grill: your past chats say something about ${importedNames(r.names)}. Chat and your tests now start from that.` : "Grill: none of those conversations were about your notes.", 8000);
		};
		const rows: Row[] = [];
		if (all || Platform.isDesktopApp) {
			const found = this.plugin.agentChats();
			rows.push({
				name: "Claude Code and Codex",
				desc: `Let Grill learn what you already know from your ${found.claudeCode} Claude Code and ${found.codex} Codex conversations: whether you were quizzed on a topic in your notes, and where you started. The model Chat uses reads the parts about your notes, once; Grill keeps one line a note.`,
				aliases: ["import", "history", "personalize"],
				build: (setting) =>
					setting.addButton((b) =>
						b.setButtonText("Import").onClick(async () => {
							b.setDisabled(true).setButtonText("Reading…");
							try {
								told(await this.plugin.importAgentChats());
							} catch (e) {
								new Notice(`Grill: couldn't read them (${e instanceof Error ? e.message : String(e)}).`);
							}
							await this.plugin.settings.update({ importAsked: true });
							b.setDisabled(false).setButtonText("Import");
						}),
					),
			});
		}
		rows.push({
			name: "ChatGPT or Claude",
			desc: "In ChatGPT or Claude, open Settings and export your data. Choose the zip they send you, or conversations.json inside it.",
			aliases: ["import", "export", "chatgpt", "openai", "history"],
			build: (setting) =>
				setting.addButton((b) =>
					b.setButtonText("Choose file").onClick(() => {
						const input = document.createElement("input");
						input.type = "file";
						input.accept = ".zip,.json";
						input.onchange = async () => {
							const file = input.files?.[0];
							if (!file) return;
							b.setDisabled(true).setButtonText("Reading…");
							try {
								told(await this.plugin.importExport(file));
							} catch (e) {
								new Notice(`Grill: couldn't read that file. ${e instanceof Error ? e.message : String(e)}`, 8000);
							}
							b.setDisabled(false).setButtonText("Choose file");
						};
						input.click();
					}),
				),
		});
		rows.push({
			name: "What they know about you",
			desc: 'Ask ChatGPT or Claude "What do you know about me?" and paste the answer. Grill\'s chats and questions read it.',
			aliases: ["memory", "about me", "profile"],
			build: (setting) =>
				setting.addTextArea((t) => {
					t.inputEl.rows = 5;
					t.setValue(s.aboutMe).onChange(async (v) => {
						await this.plugin.settings.update({ aboutMe: v });
					});
				}),
		});
		rows.push({
			name: "Forget what was brought in",
			desc: "Removes what Grill learned from your past chats. Your tests and the text above stay.",
			build: (setting) =>
				setting.addButton((b) =>
					b
						.setButtonText("Forget")
						.setWarning()
						.onClick(async () => {
							await this.plugin.store.saveImported(null);
							new Notice("Grill: removed what was learned from your past chats.");
						}),
				),
		});
		return rows;
	}

	/** Grill's profile of the student, to paste into another AI or send to someone. */
	private profileRow(): Row {
		return {
			name: "Share your profile",
			desc: "What Grill knows about how you study, as text: what you know, what you keep getting wrong, what you asked elsewhere. Paste it into another AI, or send it to someone.",
			aliases: ["export", "share", "profile", "record"],
			build: (setting) => {
				const get = async (): Promise<string | null> => {
					const text = await this.plugin.profileText();
					if (!text) new Notice("Grill: nothing to share yet. Take a test or bring in your AI chats first.");
					return text || null;
				};
				setting.addButton((b) =>
					b.setButtonText("Copy").onClick(async () => {
						const text = await get();
						if (!text) return;
						await navigator.clipboard.writeText(text);
						new Notice("Grill: profile copied.");
					}),
				);
				setting.addButton((b) =>
					b.setButtonText("Save as note").onClick(async () => {
						const text = await get();
						if (!text) return;
						const path = this.plugin.store.inFolder("Profile.md");
						const at = this.app.vault.getAbstractFileByPath(path);
						if (at instanceof TFile) await this.app.vault.modify(at, text);
						else await this.app.vault.create(path, text);
						await this.app.workspace.getLeaf(true).openFile(this.app.vault.getAbstractFileByPath(path) as TFile);
					}),
				);
			},
		};
	}

	/** MCP servers and skills for Chat on Grill Cloud or a key of one's own. Claude Code,
	 * Codex and opencode bring their own. */
	private toolRows(): Row[] {
		const s = this.plugin.data.settings;
		const says = (el: HTMLElement): void => {
			el.empty();
			const over = this.plugin.mcp.leftOut();
			if (over > 0) el.createDiv({ cls: "mod-warning", text: `${over} ${over === 1 ? "tool is" : "tools are"} left out: more than one message can carry.` });
			for (const st of this.plugin.mcp.status()) {
				const line = el.createDiv({ text: st.error ? `${st.name}: ${st.error}` : `${st.name}: ${st.tools} ${st.tools === 1 ? "tool" : "tools"}`, cls: st.error && !st.signIn ? "mod-warning" : "" });
				if (!st.signIn) continue;
				const go = line.createEl("button", { text: `Sign in to ${st.name}`, cls: "grill-inline-btn" });
				go.onclick = async () => {
					go.disabled = true;
					go.setText("Waiting for the browser...");
					const failed = await this.plugin.mcp.signIn(st.name, (url) => window.open(url));
					if (failed) new Notice(`Grill: ${st.name}: ${failed}`, 8000);
					says(el);
				};
			}
		};
		return [
			{
				name: "MCP servers",
				desc: "Written as in Claude Code's .mcp.json. Kept in Obsidian's keychain on this device. Claude Code, Codex and opencode use their own.",
				aliases: ["mcp", "tools", "servers", "connectors", "integrations"],
				build: (setting) => {
					setting.settingEl.addClass("grill-setting-tall");
					const status = setting.descEl.createDiv({ cls: "grill-meta" });
					says(status);
					let area: HTMLTextAreaElement | null = null;
					setting.addTextArea((t) => {
						area = t.inputEl;
						t.inputEl.rows = 8;
						t.inputEl.addClass("grill-mono");
						t.setPlaceholder('{\n  "mcpServers": {\n    "name": { "url": "https://..." }\n  }\n}');
						t.setValue(this.plugin.mcpConfig()).onChange(async (v) => {
							await this.plugin.setMcpConfig(v);
						});
					});
					const connect = async (): Promise<void> => {
						status.setText("Connecting...");
						await this.plugin.mcp.close();
						await this.plugin.mcp.ready(this.plugin.mcpConfig());
						says(status);
						if (!this.plugin.mcp.status().length) status.setText("No servers.");
					};
					if (Platform.isDesktopApp) {
						setting.addButton((b) =>
							b.setButtonText("Import from Claude Code").onClick(async () => {
								const found = importClaudeServers();
								if (!Object.keys(found).length) return void new Notice("Grill: Claude Code has no MCP servers set up for all projects.", 6000);
								const had = (() => {
									try {
										const v = JSON.parse(this.plugin.mcpConfig() || "{}") as { mcpServers?: Record<string, unknown> };
										return v.mcpServers ?? v;
									} catch {
										return {};
									}
								})();
								const merged = JSON.stringify({ mcpServers: { ...found, ...had } }, null, 2);
								await this.plugin.setMcpConfig(merged);
								if (area) area.value = merged;
								await this.plugin.persist();
								await connect();
							}),
						);
					}
					setting.addButton((b) => b.setButtonText("Connect").onClick(() => void connect()));
				},
			},
			{
				name: "Web",
				desc: "Chat reads web pages and searches the web. Reading a page asks first at the Safe level.",
				aliases: ["web", "internet", "search", "browse", "fetch", "url"],
				build: (setting) =>
					setting.addToggle((t) =>
						t.setValue(s.useWeb).onChange(async (v) => {
							await this.plugin.settings.update({ useWeb: v });
						}),
					),
			},
			{
				name: "Search by meaning",
				desc: "",
				aliases: ["semantic", "embeddings", "vault search", "vault qa", "meaning"],
				build: (setting) => {
					if (!Platform.isDesktopApp) return setting.setDesc("Desktop only.");
					setting.setDesc("Lets Chat find notes by what they are about, not only by their words. A model (about 130 MB) is downloaded once and runs on this device; your notes never leave it.");
					const st = setting.descEl.createDiv({ cls: "grill-meta" });
					const show = (): void => {
						const p = this.plugin.searchProgress;
						st.setText(s.searchByMeaning && p.total ? `${p.indexed} of ${p.total} notes indexed.` : "");
					};
					show();
					setting.addToggle((t) =>
						t.setValue(s.searchByMeaning).onChange(async (v) => {
							await this.plugin.settings.update({ searchByMeaning: v });
							if (v) {
								st.setText("Indexing...");
								const tick = window.setInterval(show, 1000);
								try {
									await this.plugin.indexForSearch();
								} finally {
									window.clearInterval(tick);
								}
							}
							show();
						}),
					);
				},
			},
			{
				name: "Skills",
				desc: "",
				aliases: ["skills", "skill", "agent skills", "skills.sh"],
				build: (setting) => {
					const where = this.plugin.skillPlaces().map((p) => p.shown).join(", ");
					setting.setDesc(`Grill reads them from ${where}.`);
					const found = setting.descEl.createDiv({ cls: "grill-meta" });
					void this.plugin.findSkills().then((all) => found.setText(s.useSkills ? (all.length ? `${all.length} found: ${all.slice(0, 8).map((k) => k.name).join(", ")}${all.length > 8 ? ", ..." : ""}` : "None found.") : ""));
					setting.addToggle((t) =>
						t.setValue(s.useSkills).onChange(async (v) => {
							await this.plugin.settings.update({ useSkills: v });
							this.display();
						}),
					);
				},
			},
		];
	}

	/** grill-mcp: the record for Claude Code, Codex and other agents outside Grill. One
	 * command to paste in a terminal; their answers come back through the Inbox folder. */
	private recordForAgentsRow(): Row {
		const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
		const server = `npx -y grill-mcp --vault "${base.replace(/"/g, '\\"')}"`;
		const commands = [
			{ agent: "Claude Code", text: `claude mcp add --scope user grill -- ${server}` },
			{ agent: "Codex", text: `codex mcp add grill -- ${server}` },
		];
		return {
			name: "Connect an agent",
			desc: "Lets the agent see what you know and test you. Its answers count in Grill. Paste the copied line in a terminal.",
			aliases: ["mcp", "claude code", "codex", "cursor", "record", "memory"],
			build: (setting) => {
				for (const c of commands) {
					setting.addButton((b) =>
						b.setButtonText(`Copy for ${c.agent}`).onClick(async () => {
							await navigator.clipboard.writeText(c.text);
							new Notice(`Grill: copied. Paste it in a terminal, then start a new ${c.agent} session.`, 6000);
						}),
					);
				}
			},
		};
	}

	/** opencode: installed by Grill, or found where it already is. */
	private opencodeRows(): Row[] {
		const s = this.plugin.data.settings;
		return [
			{
				name: "opencode",
				desc: "",
				aliases: ["opencode", "free models", "agent", "ollama", "install", "download"],
				build: (setting) => {
					if (!Platform.isDesktopApp) return setting.setDesc("Runs on desktop only.");
					const found = findOpencode(s.opencodePath);
					const mb = this.plugin.opencodeDownloadSize();
					if (this.opencodeBusy) return setting.setDesc(`Downloading opencode${mb ? ` (${mb} MB)` : ""} and checking it...`);
					if (found) {
						setting.setDesc(
							`${isGrillInstall(found) ? `Installed by Grill (${OPENCODE_VERSION})` : `Found at ${found}`}. Free models work without signing in, and may keep what you send them to improve the model. To use an account of yours, run opencode auth login in a terminal.`,
						);
						if (isGrillInstall(found)) {
							setting.addButton((b) =>
								b.setButtonText("Remove").onClick(() => {
									uninstallOpencode();
									if (s.chatEngine === "opencode") s.chatEngine = "model";
									void this.plugin.persist();
									this.rerender();
								}),
							);
						}
						return setting;
					}
					if (!canInstall()) return setting.setDesc("Not installed, and there is no build of it for this computer.");
					setting.setDesc(`An agent that can read and change the vault, with free models of its own. Grill downloads opencode's build${mb ? ` (${mb} MB)` : ""} and checks it before installing.`);
					return setting.addButton((b) =>
						b
							.setButtonText("Install")
							.setCta()
							.onClick(async () => {
								this.opencodeBusy = true;
								this.rerender();
								try {
									await this.plugin.installOpencode();
								} finally {
									this.opencodeBusy = false;
									this.rerender();
								}
							}),
					);
				},
			},
			{
				name: "opencode location",
				desc: "Leave empty to have it found. Fill in the full path to use a copy of your own.",
				aliases: ["opencode path", "binary", "executable"],
				build: (setting) =>
					setting.addText((t) =>
						t
							.setPlaceholder("Found automatically")
							.setValue(s.opencodePath)
							.onChange(async (v) => {
								await this.plugin.settings.update({ opencodePath: v.trim() });
							}),
					),
			},
		];
	}

	/** The row called `name` as it stands right now, or undefined if the current
	 * state doesn't show it. */
	private liveRow(name: string): Row | undefined {
		try {
			return [...this.sections().flatMap((sec) => sec.rows), ...this.tuningRows(), ...this.dataRows()].find((r) => r.name === name);
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
						...this.tuningRows().map(toDef),
					],
				},
				{
					type: "group",
					heading: DATA_NAME,
					visible: () => this.tab === "advanced" || this.searching(),
					items: this.dataRows().map(toDef),
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
			for (const r of this.tuningRows()) renderRow(containerEl, r);
			new Setting(containerEl).setName(DATA_NAME).setHeading();
			for (const r of this.dataRows()) renderRow(containerEl, r);
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

