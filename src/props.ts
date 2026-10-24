/** Note properties: a few values from the record, written into the studied note's own
 * frontmatter when the setting is on, so Bases views and any agent working in the
 * vault can read them without going through Grill.
 *
 * Only values that change when a review happens are written. Recall falls a little
 * every day, so writing it would rewrite every studied note daily; a Bases formula
 * can work days-until-due out of `grill_due` instead. */

import { statusOf, type NoteMastery } from "./mastery";

export const PROP_KEYS = ["grill_status", "grill_due", "grill_last_tested", "grill_confusions"] as const;
export type PropKey = (typeof PROP_KEYS)[number];
export type NoteProps = Partial<Record<PropKey, string | string[]>>;

/** The same words the rest of Grill shows for a status. */
const STATUS_WORDS = { known: "known", struggling: "learning", untested: "not tested yet" } as const;

/** Local calendar date of an ISO time: what a note's date property should say. */
function localDate(iso: string): string | null {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The properties a note's record comes to. Empty for a note never tested. Confusions
 * are the most-seen misconception tags, and only while the note isn't known yet: one
 * since put right would read as current in a table. */
export function noteProps(m: NoteMastery | undefined): NoteProps {
	const status = statusOf(m);
	if (!m || status === "untested") return {};
	const p: NoteProps = { grill_status: STATUS_WORDS[status] };
	const seen = m.lastSeen ? localDate(m.lastSeen) : null;
	if (seen) p.grill_last_tested = seen;
	const due = m.dueAt ? localDate(m.dueAt) : null;
	if (due) p.grill_due = due;
	if (status !== "known") {
		const tags = Object.entries(m.misconceptions ?? {})
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([t]) => t);
		if (tags.length) p.grill_confusions = tags;
	}
	return p;
}

/** Sets Grill's properties on a frontmatter object in place, and removes the ones the
 * record no longer has. Nothing else in the frontmatter is touched. True if anything
 * changed, so an unchanged note is never rewritten. */
export function applyProps(fm: Record<string, unknown>, props: NoteProps): boolean {
	let changed = false;
	for (const k of PROP_KEYS) {
		const want = props[k];
		if (want === undefined) {
			if (k in fm) {
				delete fm[k];
				changed = true;
			}
		} else if (JSON.stringify(fm[k]) !== JSON.stringify(want)) {
			fm[k] = want;
			changed = true;
		}
	}
	return changed;
}

/** Removes every Grill property: for turning the setting off. True if anything changed. */
export function clearProps(fm: Record<string, unknown>): boolean {
	return applyProps(fm, {});
}

/** What an older session note's own text says about it, for the fields newer ones
 * carry in their properties: `correct` and `total` from its `score`, and the notes it
 * tested from its question headings (each `## Note` or `## [[Note]]` before `## Redo`).
 * Null when the note has no readable score. */
export function sessionFields(text: string): { correct: number; total: number; notes: string[] } | null {
	const m = /^score:\s*(\d+)\s*\/\s*(\d+)\s*$/m.exec(text.split(/\n---\s*\n/, 1)[0] ?? "");
	if (!m) return null;
	const notes: string[] = [];
	for (const line of text.split("\n")) {
		const h = /^## (.+?)\s*$/.exec(line);
		if (!h) continue;
		if (h[1] === "Redo") break;
		const name = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(h[1])?.[1] ?? h[1];
		if (/^[^[\]|#^]+$/.test(name) && !notes.includes(name)) notes.push(name);
	}
	return { correct: Number(m[1]), total: Number(m[2]), notes };
}

/** The view file shipped for the sessions log: a table of every session, newest first. */
export function sessionsBase(folder: string): string {
	return [
		"filters:",
		"  and:",
		`    - file.inFolder(${JSON.stringify(`${folder}/Sessions`)})`,
		"views:",
		"  - type: table",
		"    name: Sessions",
		"    order:",
		"      - file.name",
		"      - note.date",
		"      - note.correct",
		"      - note.total",
		"      - note.notes",
		"      - note.type",
		"    sort:",
		"      - property: file.name",
		"        direction: DESC",
		"",
	].join("\n");
}

/** The view file for studied notes: every note Grill has a record for, soonest due first. */
export function notesBase(): string {
	return [
		"filters:",
		"  and:",
		'    - file.hasProperty("grill_status")',
		"views:",
		"  - type: table",
		"    name: Studied notes",
		"    order:",
		"      - file.name",
		"      - note.grill_status",
		"      - note.grill_due",
		"      - note.grill_last_tested",
		"      - note.grill_confusions",
		"    sort:",
		"      - property: note.grill_due",
		"        direction: ASC",
		"",
	].join("\n");
}
