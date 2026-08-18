/** Session scope: let the start screen restrict a session to a folder, a tag,
 * or the current note, not just the whole vault. Kept deliberately single-axis
 * (pick one) so the control stays a single dropdown rather than a query builder.
 */

import { App, TFile, getAllTags } from "obsidian";
import { ConceptMap, conceptTested, dueNotes } from "./concepts";

export type ScopeKind = "all" | "due" | "untested" | "folder" | "tag" | "note";

export interface Scope {
	kind: ScopeKind;
	/** folder path, tag (with #), or note path; unused for "all"/"untested". */
	id: string;
}

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

/** Vault tags with note counts, most-used first, capped so the dropdown stays short.
 * Built from the public metadata API (getAllTags per file) rather than the
 * undocumented metadataCache.getTags(). */
export function listTags(app: App, limit = 40): { tag: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const f of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(f);
		if (!cache) continue;
		for (const tag of getAllTags(cache) ?? []) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit);
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

/** Resolve a scope to the eligible notes it covers. `untestable`: see `untestedFiles`. */
export function filesForScope(
	app: App,
	scope: Scope,
	eligible: TFile[],
	concepts: ConceptMap = {},
	untestable: Set<string> = new Set(),
): TFile[] {
	switch (scope.kind) {
		case "all":
			return eligible;
		case "due":
			return dueFiles(eligible, concepts);
		case "untested":
			return untestedFiles(eligible, concepts, untestable);
		case "note":
			return eligible.filter((f) => f.path === scope.id);
		case "folder":
			return eligible.filter((f) => f.path === scope.id || f.path.startsWith(`${scope.id}/`));
		case "tag": {
			const want = scope.id.startsWith("#") ? scope.id : `#${scope.id}`;
			return eligible.filter((f) => {
				const cache = app.metadataCache.getFileCache(f);
				return cache ? (getAllTags(cache) ?? []).includes(want) : false;
			});
		}
	}
}
