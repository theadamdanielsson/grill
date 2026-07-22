/** Link-graph utilities.
 *
 * Obsidian already resolves the vault's `[[wikilinks]]` into a graph
 * (`metadataCache.resolvedLinks`), so we never parse note text for links.
 * This turns that graph into two things the tutor can use:
 *   - session-scoped adjacency, so questions can respect prerequisite order
 *     and span related notes, and
 *   - a selection expansion that pulls a due note's weak prerequisites into
 *     the same session ("you're due on Backprop but shaky on the Chain Rule
 *     it builds on").
 *
 * Everything here is keyed by note basename, matching the mastery map.
 */

import type { App, TFile } from "obsidian";
import { MasteryMap, statusOf } from "./mastery";

export interface NoteLinks {
	/** in-session notes this note links out to (basenames) */
	linksTo: string[];
	/** in-session notes that link to this note (basenames) */
	linkedFrom: string[];
}

export interface SessionGraph {
	/** basename -> its in-session neighbours */
	adjacency: Record<string, NoteLinks>;
	/** basenames ordered most-foundational first (linked-to a lot, links-out little) */
	foundationalOrder: string[];
}

/** Basenames of the markdown notes a file links out to, vault-wide. */
export function outgoingBasenames(app: App, file: TFile): string[] {
	const targets = app.metadataCache.resolvedLinks[file.path] ?? {};
	const out: string[] = [];
	for (const path of Object.keys(targets)) {
		const dest = app.vault.getAbstractFileByPath(path);
		// TFile is imported only as a type; check by shape to avoid a value import.
		if (dest && "extension" in dest && (dest as TFile).extension === "md") out.push((dest as TFile).basename);
	}
	return out;
}

/** Build the link graph restricted to a set of in-session notes. Only edges
 * whose both ends are in `files` are kept, so the model sees relationships it
 * can actually act on this session. */
export function buildSessionGraph(app: App, files: TFile[]): SessionGraph {
	const byPath = new Map<string, TFile>();
	for (const f of files) byPath.set(f.path, f);

	const adjacency: Record<string, NoteLinks> = {};
	for (const f of files) adjacency[f.basename] = { linksTo: [], linkedFrom: [] };

	const resolved = app.metadataCache.resolvedLinks;
	for (const f of files) {
		const targets = resolved[f.path] ?? {};
		for (const targetPath of Object.keys(targets)) {
			const dest = byPath.get(targetPath);
			if (!dest || dest.basename === f.basename) continue;
			const t = dest.basename;
			if (!adjacency[f.basename].linksTo.includes(t)) adjacency[f.basename].linksTo.push(t);
			if (!adjacency[t].linkedFrom.includes(f.basename)) adjacency[t].linkedFrom.push(f.basename);
		}
	}

	const foundationalOrder = Object.keys(adjacency).sort((a, b) => {
		const scoreA = adjacency[a].linkedFrom.length - adjacency[a].linksTo.length;
		const scoreB = adjacency[b].linkedFrom.length - adjacency[b].linksTo.length;
		if (scoreB !== scoreA) return scoreB - scoreA;
		return adjacency[b].linkedFrom.length - adjacency[a].linkedFrom.length;
	});

	return { adjacency, foundationalOrder };
}

/** Given the priority-ordered seed from pickCandidates, weave in the weak
 * (untested/struggling) prerequisites of each seed note so foundations get
 * quizzed before the notes that build on them. Stays within `cap`. */
export function expandSelectionWithLinks(
	app: App,
	seed: string[],
	byName: Map<string, TFile>,
	mastery: MasteryMap,
	cap: number,
): string[] {
	const chosen = new Set<string>();
	const ordered: string[] = [];
	const add = (n: string): void => {
		if (byName.has(n) && !chosen.has(n)) {
			chosen.add(n);
			ordered.push(n);
		}
	};

	for (const n of seed) {
		if (ordered.length >= cap) break;
		const f = byName.get(n);
		if (f) {
			for (const pre of outgoingBasenames(app, f)) {
				if (ordered.length >= cap) break;
				const s = statusOf(mastery[pre]);
				if (s === "struggling" || s === "untested") add(pre); // weak prerequisite first
			}
		}
		add(n);
	}
	// Fill any remaining room straight from the priority seed.
	for (const n of seed) {
		if (ordered.length >= cap) break;
		add(n);
	}
	return ordered.slice(0, cap);
}

/** A compact, model-readable description of how the session's notes relate,
 * annotated with each prerequisite's mastery status. Empty when there are no
 * links between the selected notes. */
export function formatLinksBlock(graph: SessionGraph, mastery: MasteryMap): string {
	const lines: string[] = [];
	for (const name of graph.foundationalOrder) {
		const adj = graph.adjacency[name];
		if (!adj || adj.linksTo.length === 0) continue;
		const parts = adj.linksTo.map((t) => `${t} [${statusOf(mastery[t])}]`);
		lines.push(`- "${name}" builds on / references: ${parts.join(", ")}`);
	}
	if (lines.length === 0) return "";
	return (
		"Relationships between these notes, taken from their links. Quiz a foundational note before " +
		"the notes that build on it, and prefer shoring up a weak prerequisite before a shakier note " +
		"that depends on it. For a 'hard' question you may write one synthesis question connecting two " +
		"linked notes, as long as both are grounded in the notes above and answerable from them.\n" +
		lines.join("\n")
	);
}
