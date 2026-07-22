/** Session scope: let the start screen restrict a session to a folder, a tag,
 * or the current note, not just the whole vault. Kept deliberately single-axis
 * (pick one) so the control stays a single dropdown rather than a query builder.
 */

import { App, TFile, getAllTags } from "obsidian";

export type ScopeKind = "all" | "folder" | "tag" | "note";

export interface Scope {
	kind: ScopeKind;
	/** folder path, tag (with #), or note path; unused for "all". */
	id: string;
}

/** Encode a scope as a dropdown option value, e.g. "folder:Chapters/Ch1". */
export function encodeScope(s: Scope): string {
	return s.kind === "all" ? "all" : `${s.kind}:${s.id}`;
}

export function decodeScope(value: string): Scope {
	if (value === "all") return { kind: "all", id: "" };
	const i = value.indexOf(":");
	const kind = value.slice(0, i) as ScopeKind;
	return { kind, id: value.slice(i + 1) };
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

/** Vault tags with counts, most-used first, capped so the dropdown stays short.
 * getTags() exists at runtime but isn't in the public MetadataCache typings. */
export function listTags(app: App, limit = 40): { tag: string; count: number }[] {
	const cache = app.metadataCache as unknown as { getTags?: () => Record<string, number> };
	const all = cache.getTags?.() ?? {};
	return Object.entries(all)
		.map(([tag, count]) => ({ tag, count: Number(count) }))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit);
}

/** Resolve a scope to the eligible notes it covers. */
export function filesForScope(app: App, scope: Scope, eligible: TFile[]): TFile[] {
	switch (scope.kind) {
		case "all":
			return eligible;
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
