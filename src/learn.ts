/**
 * Learn: what a conversation about a note is given to read. Pure text handling, no
 * model and no vault access, so what is sent can be tested.
 */
import { safeSlice } from "./text";

export interface LearnNote {
	name: string;
	text: string;
}

/** Most of the budget goes to the note being asked about; each note it links to gets
 * a share, since a question about one note often turns on what the next one defines. */
export const LEARN_CAPS = { note: 12000, linked: 1500, maxLinked: 4 };

/** A note's text as a prompt should see it: without the frontmatter block. */
export function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** The note, and the notes it links to, cut to size. Linked notes that are empty once
 * stripped are left out, and no more than `maxLinked` are sent, in the order given. */
export function learnContext(main: LearnNote, linked: LearnNote[], caps = LEARN_CAPS): { noteText: string; linkedText: string } {
	const noteText = safeSlice(stripFrontmatter(main.text), caps.note);
	const parts: string[] = [];
	for (const n of linked) {
		if (parts.length >= caps.maxLinked) break;
		if (n.name === main.name) continue;
		const text = safeSlice(stripFrontmatter(n.text), caps.linked);
		if (text) parts.push(`'${n.name}':\n${text}`);
	}
	return { noteText, linkedText: parts.join("\n\n") };
}

/** How a saved session reads in a list: the notes it covered, the first by name and
 * the rest as a count. `headings` are the session note's own second-level headings,
 * one per question, which name the note each question came from. */
export function sessionTitle(headings: string[]): string {
	const notes = [...new Set(headings.map((h) => h.trim()).filter((h) => h && h !== "Redo"))];
	if (!notes.length) return "";
	return notes.length === 1 ? notes[0] : `${notes[0]} +${notes.length - 1}`;
}
