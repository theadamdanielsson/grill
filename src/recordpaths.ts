/** Where the record lives, by name: the Grill folder's default, the files and folders
 * inside it, the record in the home folder, and the plugin's settings file. The plugin's
 * store and grill-mcp both read from here, so neither can rename something the other
 * still looks for. No Obsidian here: grill-mcp bundles it. */

import { examDay, type Exam } from "./exams";

export const DEFAULT_FOLDER = "Grill";

/** The record's files inside the Grill folder. */
export const RECORD_FILES = {
	concepts: "concepts.json",
	mastery: "mastery.json",
	registry: "misconceptions.json",
	bank: "questions.json",
} as const;

export const SESSIONS_DIR = "Sessions";
export const LEARN_DIR = "Learn";
export const PROMPTS_DIR = "Prompts";
export const SKILLS_DIR = "Skills";
/** Where agents leave answers for the plugin to fold into the record. */
export const INBOX_DIR = "Inbox";

/** The record kept outside any vault, under the home folder: ~/.grill/record. */
export const HOME_RECORD_SEGMENTS = [".grill", "record"] as const;

/** The plugin's settings file, from the vault's root. */
export const PLUGIN_DATA_SEGMENTS = [".obsidian", "plugins", "grill", "data.json"] as const;

/** What grill-mcp needs from the plugin's settings file: the Grill folder's name and the
 * exams set. Anything missing or malformed reads as the default. */
export function readPluginSettings(data: unknown): { folder: string; exams: Exam[] } {
	const s = (data as { settings?: { folder?: unknown; exams?: unknown } } | null)?.settings;
	const folder = typeof s?.folder === "string" && s.folder.trim() ? s.folder.trim().replace(/^\/+|\/+$/g, "") : DEFAULT_FOLDER;
	const raw: unknown[] = Array.isArray(s?.exams) ? s.exams : [];
	const exams = raw.filter((e): e is Exam => !!e && Array.isArray((e as Exam).folders) && typeof (e as Exam).date === "string" && !!examDay((e as Exam).date));
	return { folder, exams };
}

/** An agent's answer's file name in the inbox: when it was given, then its id. */
export function inboxFileName(r: { at: string; id: string }): string {
	return `${r.at.replace(/[:.]/g, "-")}-${r.id.slice(0, 8)}.json`;
}
