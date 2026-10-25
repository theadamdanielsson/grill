/**
 * Tools that let the model behind Chat answer questions about Grill and fit its study
 * settings to what the student is aiming for: read a short guide, read the settings,
 * change some of them.
 *
 * Only the settings listed here can be reached, each checked before it is written.
 * Keys, engines, models and Grill Cloud are never among them. A change goes through
 * the same permission card as a change to a note (see vaulttools.ts).
 */
import type { ToolCall, ToolSpec } from "./stream";

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
export interface IntensityNumbers {
	desiredRetention: number;
	newConceptsPerDay: number;
	freshContentShare: number;
	freshContentAlwaysGuarantee: boolean;
}

export const INTENSITY_PRESETS: Record<Exclude<StudyIntensity, "custom">, IntensityNumbers> = {
	relaxed: { desiredRetention: 85, newConceptsPerDay: 10, freshContentShare: 25, freshContentAlwaysGuarantee: false },
	steady: { desiredRetention: 90, newConceptsPerDay: 20, freshContentShare: 30, freshContentAlwaysGuarantee: false },
	intense: { desiredRetention: 95, newConceptsPerDay: 40, freshContentShare: 40, freshContentAlwaysGuarantee: true },
};

/** Which preset (if any) a stored set of the four numbers exactly expresses. Exact match
 * only, deliberately: a near-miss is a hand-tuning, and rounding it to the nearest preset
 * would change someone's schedule behind their back on upgrade. */
export function intensityOf(s: IntensityNumbers): StudyIntensity {
	for (const [name, p] of Object.entries(INTENSITY_PRESETS) as [Exclude<StudyIntensity, "custom">, IntensityNumbers][]) {
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

/** Writes a preset's four numbers, and its name, into the settings. */
export function applyIntensity(s: IntensityNumbers & { studyIntensity: StudyIntensity }, name: Exclude<StudyIntensity, "custom">): void {
	Object.assign(s, INTENSITY_PRESETS[name], { studyIntensity: name });
}

/** The study settings, as far as these tools need them. */
export interface StudySettings {
	questionsPerSession: number;
	studyIntensity: StudyIntensity;
	questionFormats: "write" | "mixed" | "mc";
	easyDays: number[];
	includedFolders: string[];
	testHints: boolean;
	sounds: boolean;
}

export interface SettingsPort {
	get(): StudySettings;
	/** Folders in the vault, for checking the ones named. */
	folders(): string[];
	/** Write the changes, already checked, and save them. */
	set(changes: Partial<StudySettings>): Promise<void>;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayName = (d: number): string => DAYS[d][0].toUpperCase() + DAYS[d].slice(1);

type Check = { ok: Partial<StudySettings>; shown: string } | { error: string };

interface Spec {
	name: string;
	label: string;
	about: string;
	shown(s: StudySettings): string;
	check(value: unknown, port: SettingsPort): Check;
}

const P = INTENSITY_PRESETS;

const SPECS: Spec[] = [
	{
		name: "questions_per_session",
		label: "Questions per session",
		about: "How many questions an ordinary test asks. A whole number from 1 to 50. Retry and Catch up ask as many as they count.",
		shown: (s) => String(s.questionsPerSession),
		check: (v) => {
			const n = typeof v === "string" ? Number(v) : v;
			if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) return { error: "questions_per_session must be a whole number from 1 to 50." };
			return { ok: { questionsPerSession: n }, shown: String(n) };
		},
	},
	{
		name: "study_intensity",
		label: "Study intensity",
		about:
			`How hard the review schedule pushes. relaxed: aims for ${P.relaxed.desiredRetention}% recall, up to ${P.relaxed.newConceptsPerDay} new concepts a day. ` +
			`steady (the default): ${P.steady.desiredRetention}%, up to ${P.steady.newConceptsPerDay} a day. ` +
			`intense: ${P.intense.desiredRetention}%, up to ${P.intense.newConceptsPerDay} a day, and new material always gets room in a session. custom means the numbers were tuned by hand in settings; it cannot be chosen here.`,
		shown: (s) => s.studyIntensity,
		check: (v) => {
			if (v !== "relaxed" && v !== "steady" && v !== "intense") return { error: "study_intensity must be relaxed, steady or intense." };
			return { ok: { studyIntensity: v }, shown: v };
		},
	},
	{
		name: "question_formats",
		label: "Question formats",
		about: "mixed: the format that fits each concept (written, multiple choice, fill in the blank, true/false and more). mc: multiple choice only. write: written answers only.",
		shown: (s) => s.questionFormats,
		check: (v) => {
			if (v !== "mixed" && v !== "mc" && v !== "write") return { error: "question_formats must be mixed, mc or write." };
			return { ok: { questionFormats: v }, shown: v };
		},
	},
	{
		name: "easy_days",
		label: "Easy days",
		about: "Weekdays to keep light: reviews are moved off them when an equally free day is close by. A list of weekday names; an empty list means no preference.",
		shown: (s) => (s.easyDays.length ? s.easyDays.map(dayName).join(", ") : "none"),
		check: (v) => {
			if (!Array.isArray(v)) return { error: "easy_days must be a list of weekday names, e.g. [\"Saturday\", \"Sunday\"]." };
			const days: number[] = [];
			for (const d of v) {
				const at = typeof d === "string" ? DAYS.indexOf(d.trim().toLowerCase()) : -1;
				if (at < 0) return { error: `"${String(d)}" is not a weekday name.` };
				if (!days.includes(at)) days.push(at);
			}
			days.sort((a, b) => a - b);
			return { ok: { easyDays: days }, shown: days.length ? days.map(dayName).join(", ") : "none" };
		},
	},
	{
		name: "study_folders",
		label: "Study folders",
		about: "The folders Grill tests on and draws its map from. A list of folder paths in the vault; an empty list means the whole vault.",
		shown: (s) => (s.includedFolders.length ? s.includedFolders.join(", ") : "the whole vault"),
		check: (v, port) => {
			if (!Array.isArray(v)) return { error: "study_folders must be a list of folder paths, or an empty list for the whole vault." };
			const all = port.folders();
			const picked: string[] = [];
			for (const f of v) {
				const want = typeof f === "string" ? f.trim().replace(/^\/+|\/+$/g, "") : "";
				const found = all.find((p) => p === want) ?? all.find((p) => p.toLowerCase() === want.toLowerCase());
				if (!found) return { error: `There is no folder "${String(f)}" in the vault. Use list_notes to see the folders.` };
				if (!picked.includes(found)) picked.push(found);
			}
			return { ok: { includedFolders: picked }, shown: picked.length ? picked.join(", ") : "the whole vault" };
		},
	},
	{
		name: "test_hints",
		label: "Hints in tests",
		about: "Offer a hint while a test question is answered. Using one lowers what a correct answer counts for. true or false.",
		shown: (s) => (s.testHints ? "on" : "off"),
		check: (v) => (typeof v === "boolean" ? { ok: { testHints: v }, shown: v ? "on" : "off" } : { error: "test_hints must be true or false." }),
	},
	{
		name: "sounds",
		label: "Sounds",
		about: "Short sounds on each answer and at the end of a test. true or false.",
		shown: (s) => (s.sounds ? "on" : "off"),
		check: (v) => (typeof v === "boolean" ? { ok: { sounds: v }, shown: v ? "on" : "off" } : { error: "sounds must be true or false." }),
	},
];

/** How Grill works, for questions about it: what the model reads before answering one. */
export const GRILL_GUIDE = `Grill is an Obsidian plugin. It opens in a side pane (the flame icon, or the command "Open Grill"). Its home screen has two tabs.

Chat: a conversation about your notes in which nothing is graded. It opens on the note beside it and answers from that note, the notes it links to, a map of the vault, and Grill's record of how you have done. Chat can read, search, change and create notes; a change shows a permission card first unless the level under the chat box is Auto. Plan only proposes. Every conversation is saved under Grill/Learn/. Right-click selected text and choose Grill to ask about it, explain it, rewrite it or make a note from it. The Prompts button under the box offers ready prompts and your saved ones; a saved prompt is a note in Grill/Prompts/ (command: New saved prompt), and {{selection}} in it marks where selected text goes.

Test: Grill writes questions from your notes, you answer from memory, and each answer is marked with partial credit and feedback. Suggestions on the Test tab: Retry my misses, Review what is due, Something new, the open note, and Catch up when a backlog has built. You can also type a note or folder name to be tested on it. Typing a question instead of an answer gets help, and the record notes that help was needed.

Schedule: Grill tracks each concept in a note (headings, definitions, bold terms, formulas, flashcards) on its own, on FSRS, the spaced-repetition scheme Anki uses. Right answers come back later, wrong ones sooner, and questions get harder as a concept is recalled. Editing a note reopens only the parts that changed. After enough reviews Grill fits the schedule to how you forget.

Writing your own questions: a callout in any note.
> [!grill] The question
> A: the answer (optional)
> rubric: what a good answer mentions (optional)
> choices: a, b, c (optional; one answer among them makes multiple choice, several make select-all)

PDFs embedded with ![[file.pdf]] are read and tested like notes (text only, up to 40 pages).

How Grill quizzes and talks: Grill/Instructions.md (command: Open persona & instructions) has a Persona section (its voice) and an Instructions section (how to be quizzed and marked, in plain sentences). The student edits that file; Chat cannot.

Progress: the Progress screen (or the tiles on the home screen) shows the arc of how you have changed, what you keep missing, coverage per folder, a map of your notes coloured by how well you know them, and a review heatmap.

Engines: what answers in Chat, switched with the button under the chat box. Grill Cloud needs no setup and has a monthly plan once the free credits are used. Your own key (Anthropic, OpenAI, Gemini, DeepSeek, any OpenAI-compatible endpoint) or Ollama on your machine. Claude Code, Codex or opencode if installed (desktop only); opencode can be installed from the Agents tab of Grill's settings and has free models that need no sign-in. Tests use Grill Cloud, your key or Ollama, as chosen in settings; with none of those set up, the program Chat runs on writes and marks them.

Settings: grill_settings lists the study settings Chat can change. Everything else (engine, keys, models, folders to exclude, voice, the graph) is in Obsidian's settings under Grill, in tabs: Basic (Grill Cloud, the engine, persona and instructions), Own key, Agents (desktop only), Study (including the folders Grill covers), Advanced (scheduling numbers, the Grill folder, restoring the recommended settings).`;

export const SETTINGS_TOOLS: ToolSpec[] = [
	{
		name: "grill_guide",
		description: "How Grill works: its screens, tests, schedule, own questions, instructions file, engines and settings. Read it before answering a question about Grill.",
		input: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "grill_settings",
		description: "Grill's study settings that can be changed from Chat: each one's current value and what it does.",
		input: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "change_grill_settings",
		description:
			"Change one or more of Grill's study settings, by the names grill_settings gives. Read grill_settings first. The student may be asked to allow the change, and all of it is allowed or declined together.",
		input: {
			type: "object",
			properties: {
				changes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							setting: { type: "string", enum: SPECS.map((s) => s.name) },
							value: { description: "The new value: a number, a word, true or false, or a list, as grill_settings says." },
						},
						required: ["setting", "value"],
						additionalProperties: false,
					},
				},
			},
			required: ["changes"],
			additionalProperties: false,
		},
	},
];

/** Said to the model with the tools. */
export const SETTINGS_RULES =
	"For a question about Grill itself, read grill_guide first and answer from it; for a question about Obsidian, answer from what you know of Obsidian, and say so when you are not sure a feature exists. " +
	"When the student says what they are aiming for (an exam on a date, a subject to keep up, less time to spare), you may fit Grill's study settings to it: read grill_settings, change only what serves the aim with change_grill_settings, and then say in a sentence or two what you changed and why.";

export const isSettingsTool = (name: string): boolean => SETTINGS_TOOLS.some((t) => t.name === name);

/** The changes asked for, checked: each as it is now and as it would be, or the first
 * reason it can't be done. */
export function checkChanges(port: SettingsPort, input: Record<string, unknown>): { ok: Partial<StudySettings>; lines: Array<{ label: string; was: string; now: string }> } | { error: string } {
	const asked = input.changes;
	if (!Array.isArray(asked) || !asked.length) return { error: "No changes were given. Send changes as a list of {setting, value}." };
	const now = port.get();
	const ok: Partial<StudySettings> = {};
	const lines: Array<{ label: string; was: string; now: string }> = [];
	for (const c of asked) {
		const name = c && typeof c === "object" ? (c as Record<string, unknown>).setting : undefined;
		const spec = SPECS.find((s) => s.name === name);
		if (!spec) return { error: `There is no setting called "${String(name)}" that can be changed here. Read grill_settings for the ones there are.` };
		const got = spec.check((c as Record<string, unknown>).value, port);
		if ("error" in got) return got;
		Object.assign(ok, got.ok);
		const was = spec.shown(now);
		if (was !== got.shown) lines.push({ label: spec.label, was, now: got.shown });
	}
	return { ok, lines };
}

/** Do what one call asks. Never throws. A change has been allowed before this is
 * called. */
export async function runSettingsTool(port: SettingsPort | undefined, call: ToolCall): Promise<{ content: string; failed?: boolean }> {
	if (!port) return { content: "Grill's settings can't be reached from here.", failed: true };
	try {
		if (call.name === "grill_guide") return { content: GRILL_GUIDE };
		if (call.name === "grill_settings") {
			const s = port.get();
			return { content: SPECS.map((spec) => `${spec.name} = ${spec.shown(s)}\n  ${spec.about}`).join("\n") };
		}
		const checked = checkChanges(port, call.input);
		if ("error" in checked) return { content: checked.error, failed: true };
		if (!checked.lines.length) return { content: "Those settings already have those values: nothing changed." };
		await port.set(checked.ok);
		return { content: `Changed: ${checked.lines.map((l) => `${l.label} ${l.was} -> ${l.now}`).join("; ")}.` };
	} catch (e) {
		return { content: `That didn't work: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`, failed: true };
	}
}
