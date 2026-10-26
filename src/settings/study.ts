/** The Study tab: how sessions run, exams, which folders, what was brought in from
 * other AI chats, and the profile. The engine row and the program locations are built
 * here and shown on the Basic and Agents tabs. */

import { Notice, Platform, TFile } from "obsidian";
import { PROVIDERS } from "../providers";
import { cloudEnabled } from "../cloud";
import { importedNames } from "../imported";
import { daysLeft, examLines, examName, whenWords, type Exam } from "../exams";
import { ExamModal } from "../exammodal";
import { listLanguages, listVoices, listVoicesForLang, onVoicesChanged } from "../tts";
import { applyIntensity, type StudyIntensity } from "../settingstools";
import { type GrillSettings } from "../settings";
import { sliderRow, type Row, type SettingsCtx } from "./ctx";

/** The Studying rows, then the Folders rows. */
export function studyRows(ctx: SettingsCtx): { studying: Row[]; scope: Row[] } {
	const s = ctx.plugin.data.settings;
	const p = s.provider;
	// ------------------------------------------------------------ Studying
	const studying: Row[] = [
		sliderRow(
			"Questions per session",
			"How many an open test asks. Retry and Catch up ask what they count.",
			1,
			50,
			Math.min(Math.max(s.questionsPerSession, 1), 50),
			(v) => String(v),
			async (v) => {
				await ctx.plugin.settings.update({ questionsPerSession: v });
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
						await ctx.plugin.persist();
						ctx.rerender();
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
							await ctx.plugin.settings.update({ questionFormats: v === "write" ? "write" : v === "mc" ? "mc" : "mixed" });
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
						await ctx.plugin.settings.update({ testHints: v });
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
							await ctx.plugin.settings.update({ chatEngine: v === "claudecode" || v === "codex" || v === "opencode" ? v : "model" });
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
							await ctx.plugin.settings.update({ claudePath: v.trim() });
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
							await ctx.plugin.settings.update({ codexPath: v.trim() });
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
						await ctx.plugin.settings.update({ sounds: v });
					}),
				),
		},
		naturalVoiceRow(ctx, s),
		voiceRow(ctx, s),
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
							await ctx.plugin.settings.update({ includedFolders: folderList(v) });
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
							await ctx.plugin.settings.update({ excludedFolders: folderList(v) });
						}),
				),
		},
	];
	return { studying, scope };
}

/** The switch for a natural read-aloud voice, saying plainly where the text goes
 * and what it costs, and why it is unavailable when it is. */
export function naturalVoiceRow(ctx: SettingsCtx, s: GrillSettings): Row {
	const source = ctx.plugin.naturalVoiceSource();
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
						await ctx.plugin.settings.update({ naturalVoice: v });
					}),
			),
	};
}

/** Read-aloud voice: one dropdown where there used to be two (a language picker plus a
 * voice picker, 50 lines for a single `speak()` call site). Every state that pair could
 * express still exists here — full auto, "always this language, best voice for it", and
 * one exact pinned voice — as entries in one grouped list, so it stays a single choice
 * instead of a two-step one where the second step is disabled until the first is made.
 * Values are prefixed (`lang:` / `voice:`) rather than raw, so a voiceURI can never be
 * mistaken for a language code. */
export function voiceRow(ctx: SettingsCtx, s: GrillSettings): Row {
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
				if (!ctx.voicesListenerAttached) {
					ctx.voicesListenerAttached = true;
					ctx.plugin.register(onVoicesChanged(() => ctx.rerender()));
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
					await ctx.plugin.persist();
				});
			});
		},
	};
}

/** One row per exam, then a row to add one. Each opens ExamModal: the date, and
 * what the exam covers. */
export function examRows(ctx: SettingsCtx): Row[] {
	const s = ctx.plugin.data.settings;
	const when = (e: Exam): string => {
		const left = daysLeft(e, new Date());
		if (left < 0) return "Over. Scheduled as usual again.";
		const w = whenWords(left);
		return `${w[0].toUpperCase()}${w.slice(1)}. Reviews come back more often as it nears, and new material is paced to be covered by then.`;
	};
	const folders = (): string[] =>
		ctx.app.vault
			.getAllFolders(false)
			.map((f) => f.path)
			.filter((p) => !ctx.plugin.isExcluded(`${p}/x.md`))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const open = (exam: Exam | null): void =>
		new ExamModal(ctx.app, folders(), exam, (saved) => {
			void ctx.plugin.settings.update({ exams: exam ? s.exams.map((x) => (x === exam ? saved : x)) : [...s.exams, saved] }).then(() => {
				new Notice(`Grill: ${examName(saved)} now scheduled for your exam ${whenWords(daysLeft(saved, new Date()))}.`, 6000);
				ctx.rerender();
			});
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
						await ctx.plugin.settings.update({ exams: s.exams.filter((x) => x !== e) });
						ctx.rerender();
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
						await ctx.plugin.settings.update({ everythingElse: v === "keep" ? "keep" : "study" });
					}),
			),
	});
	return rows;
}

/** Bringing in what the student asked other AI tools, and what they know about them. */
export function importRows(ctx: SettingsCtx, all: boolean): Row[] {
	const s = ctx.plugin.data.settings;
	const told = (r: { notes: number; names: string[] }): void => {
		new Notice(r.notes ? `Grill: your past chats say something about ${importedNames(r.names)}. Chat and your tests now start from that.` : "Grill: none of those conversations were about your notes.", 8000);
	};
	const rows: Row[] = [];
	if (all || Platform.isDesktopApp) {
		const found = ctx.plugin.agentChats();
		rows.push({
			name: "Claude Code and Codex",
			desc: `Let Grill learn what you already know from your ${found.claudeCode} Claude Code and ${found.codex} Codex conversations: whether you were quizzed on a topic in your notes, and where you started. The model Chat uses reads the parts about your notes, once; Grill keeps one line a note.`,
			aliases: ["import", "history", "personalize"],
			build: (setting) =>
				setting.addButton((b) =>
					b.setButtonText("Import").onClick(async () => {
						b.setDisabled(true).setButtonText("Reading…");
						try {
							told(await ctx.plugin.importAgentChats());
						} catch (e) {
							new Notice(`Grill: couldn't read them (${e instanceof Error ? e.message : String(e)}).`);
						}
						await ctx.plugin.settings.update({ importAsked: true });
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
					const input = createEl("input", { attr: { type: "file", accept: ".zip,.json" } });
					input.onchange = async () => {
						const file = input.files?.[0];
						if (!file) return;
						b.setDisabled(true).setButtonText("Reading…");
						try {
							told(await ctx.plugin.importExport(file));
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
					await ctx.plugin.settings.update({ aboutMe: v });
				});
			}),
	});
	rows.push({
		name: "Forget what was brought in",
		desc: "Removes what Grill learned from your past chats. Your tests and the text above stay.",
		build: (setting) =>
			setting.addButton((b) => {
				b.setButtonText("Forget").onClick(async () => {
					await ctx.plugin.store.saveImported(null);
					new Notice("Grill: removed what was learned from your past chats.");
				});
				// setDestructive is Obsidian 1.13+; setWarning is its older spelling.
				const styled = b as unknown as { setDestructive?: () => unknown; setWarning?: () => unknown };
				if (typeof styled.setDestructive === "function") styled.setDestructive();
				else styled.setWarning?.();
				return b;
			}),
	});
	return rows;
}

/** Grill's profile of the student, to paste into another AI or send to someone. */
export function profileRow(ctx: SettingsCtx): Row {
	return {
		name: "Share your profile",
		desc: "What Grill knows about how you study, as text: what you know, what you keep getting wrong, what you asked elsewhere. Paste it into another AI, or send it to someone.",
		aliases: ["export", "share", "profile", "record"],
		build: (setting) => {
			const get = async (): Promise<string | null> => {
				const text = await ctx.plugin.profileText();
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
					const path = ctx.plugin.store.inFolder("Profile.md");
					const at = ctx.app.vault.getAbstractFileByPath(path);
					if (at instanceof TFile) await ctx.app.vault.modify(at, text);
					else await ctx.app.vault.create(path, text);
					const saved = ctx.app.vault.getAbstractFileByPath(path);
					if (saved instanceof TFile) await ctx.app.workspace.getLeaf(true).openFile(saved);
				}),
			);
		},
	};
}
