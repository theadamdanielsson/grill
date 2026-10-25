/** Session scope: let the start screen restrict a session to a folder, a tag,
 * or the current note, not just the whole vault. Kept deliberately single-axis
 * (pick one) so the control stays a single dropdown rather than a query builder.
 */

import { TFile } from "obsidian";
import { ConceptMap, conceptTested, dueNotes } from "./concepts";

/** Every folder that contains at least one eligible note, ancestors included,
 * sorted by path. Selecting an ancestor scopes to all its descendants. */
export function listFolders(eligible: TFile[]): string[] {
	const set = new Set<string>();
	for (const f of eligible) {
		const parts = f.path.split("/");
		parts.pop(); // drop the filename
		let acc = "";
		for (const p of parts) {
			acc = acc ? `${acc}/${p}` : p;
			set.add(acc);
		}
	}
	return [...set].sort((a, b) => a.localeCompare(b));
}

/** Basenames that belong to more than one eligible file (Obsidian allows the same
 * filename in different folders). Grill's mastery/concepts persistence and its
 * whole file-resolution layer (this module, links.ts, main.ts's due-count/exclusion
 * checks) identify a note by basename, matching the mastery map — so two files
 * sharing one silently share one scheduling/progress record too, and whichever file
 * a given lookup resolves to isn't guaranteed stable. Not a fix for that (it'd mean
 * migrating the whole persisted schema to full paths); this just makes the situation
 * detectable so it can be surfaced instead of failing silently. */
export function duplicateBasenames(files: TFile[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const f of files) {
		if (seen.has(f.basename)) dupes.add(f.basename);
		else seen.add(f.basename);
	}
	return [...dupes].sort((a, b) => a.localeCompare(b));
}

/** Notes with at least one currently-due, tested concept — live from concept data
 * (see `dueNotes` in concepts.ts), not the note-level mastery.dueAt rollup cache,
 * which only refreshes when a note is next answered and can otherwise undercount. */
export function dueFiles(eligible: TFile[], concepts: ConceptMap, now = new Date()): TFile[] {
	const due = dueNotes(concepts, () => true, now);
	return eligible.filter((f) => due.has(f.basename));
}

/** Notes with not one tested concept — live from concept data, same "derive from the
 * ground truth" pattern as `dueFiles` above, not the note-level `mastery.aggStatus`
 * cache: that cache can drift stale (see renderMap's repair pass in view.ts, which
 * found 14 real notes wrongly still reading "untested"), so a second, permanent scope
 * category built on it would just reproduce the same class of bug it exists to avoid. */
/** `untestable`: basenames already confirmed to have nothing Grill can quiz at all
 * (no extractable text structure, and — unless image occlusion is on — nothing else),
 * so they're excluded here rather than counted as a testable backlog. See view.ts's
 * renderStart, which computes this asynchronously (it needs each note's actual text,
 * not just its mastery record) and re-resolves this scope once that's ready. */
export function untestedFiles(eligible: TFile[], concepts: ConceptMap, untestable: Set<string> = new Set()): TFile[] {
	const tested = new Set<string>();
	for (const cm of Object.values(concepts)) if (conceptTested(cm)) tested.add(cm.note);
	return eligible.filter((f) => !tested.has(f.basename) && !untestable.has(f.basename));
}

/** What a typed request to be tested is about: a folder or the notes whose names it
 * mentions. Plain matching on names, no model: "test me on chapter 2" finds the folder
 * "Chapter 2", "gdp deflator" finds the note. Null when nothing matches. */
export function matchScope(text: string, eligible: TFile[]): { files: TFile[]; name: string } | null {
	const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const want = norm(text).replace(/^(please )?((test|grill|quiz|ask) me|questions?) (on|about) /, "").replace(/^(on|about) /, "").trim();
	if (!want) return null;
	const folders = listFolders(eligible);
	const inFolder = (path: string): TFile[] => eligible.filter((f) => f.path.startsWith(`${path}/`));
	const leaf = (path: string): string => norm(path.split("/").pop() ?? path);
	// A folder named exactly that, then a note named exactly that, then the nearest
	// thing: notes or folders whose name contains what was typed.
	const folder = folders.find((p) => leaf(p) === want) ?? folders.find((p) => norm(p) === want);
	if (folder) return { files: inFolder(folder), name: folder.split("/").pop() ?? folder };
	const exact = eligible.filter((f) => norm(f.basename) === want);
	if (exact.length) return { files: exact, name: exact[0].basename };
	const notes = eligible.filter((f) => norm(f.basename).includes(want));
	if (notes.length) return { files: notes, name: notes.length === 1 ? notes[0].basename : `${notes.length} notes matching "${text.trim()}"` };
	const loose = folders.find((p) => leaf(p).includes(want));
	if (loose) return { files: inFolder(loose), name: loose.split("/").pop() ?? loose };
	return null;
}
