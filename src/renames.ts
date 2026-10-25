/** A note renamed in the vault, followed through every part of the record that names it:
 * note mastery, concept ids, misconceptions, cached questions, embeddings, the map's
 * layout and bridge suggestions. Pure: the plugin loads the parts and saves what changed. */

import { conceptPrefix, type ConceptMap } from "./concepts";
import { pairKey, type BridgeMap } from "./bridges";
import type { MisconceptionRegistry } from "./debrief";
import type { MasteryMap } from "./mastery";
import type { EmbeddingMap, QuestionBank } from "./store";

/** Every part of the record kept by note name. */
export interface KeptByName {
	mastery: MasteryMap;
	concepts: ConceptMap;
	registry: MisconceptionRegistry;
	bank: QuestionBank;
	embeddings: EmbeddingMap;
	layout: Record<string, { x: number; y: number }>;
	bridges: BridgeMap;
}

/** Moves what is kept under `oldName` to `newName`, in place, and returns the parts it
 * changed. What is already kept under the new name is never overwritten: the old one is
 * left orphaned instead (the duplicate-name case Grill warns about elsewhere). */
export function renameInRecord(r: KeptByName, oldName: string, newName: string): Set<keyof KeptByName> {
	const touched = new Set<keyof KeptByName>();
	if (r.mastery[oldName] && !r.mastery[newName]) {
		r.mastery[newName] = r.mastery[oldName];
		delete r.mastery[oldName];
		touched.add("mastery");
	}
	// Concept ids bake the note name in as a prefix (`${note}::${kind}:${slug(label)}`
	// — see generate-local.ts's extractConcepts), so patching only the `.note` display
	// field in place (the old behaviour here) left every concept keyed under an id the
	// next real extraction of this note can never produce again: reconcileConcepts
	// would treat the renamed note as brand new, silently resetting FSRS scheduling to
	// scratch (stability/streak/dueAt all null) while the correctly-relabeled-but-now-
	// unreachable old entry sat there forever as dead weight, still counted as due by
	// dueConceptCount/priorityNotes. Fix: re-key by swapping the note-name prefix — the
	// suffix after the first "::" depends only on kind+label, never the note name, so
	// this reconstructs exactly the id the next extraction (same, unchanged content)
	// will compute, and scheduling carries over correctly instead of resetting.
	const oldPrefix = conceptPrefix(oldName);
	const newPrefix = conceptPrefix(newName);
	for (const [id, cm] of Object.entries(r.concepts)) {
		if (cm.note !== oldName || !id.startsWith(oldPrefix)) continue;
		const newId = newPrefix + id.slice(oldPrefix.length);
		if (r.concepts[newId]) continue; // already tracked under the new id; leave the old orphaned rather than clobber
		cm.note = newName;
		r.concepts[newId] = cm;
		delete r.concepts[id];
		touched.add("concepts");
	}
	const reg = r.registry;
	for (const c of Object.values(reg)) {
		const idx = c.notes.indexOf(oldName);
		if (idx === -1) continue;
		if (c.notes.includes(newName)) {
			c.notes.splice(idx, 1); // already tracked under the new name too; drop the stale duplicate
		} else {
			c.notes[idx] = newName;
		}
		touched.add("registry");
	}

	// Question bank: same id-prefix swap as concepts.json above, so a cached
	// question's variants survive the rename instead of being orphaned and silently
	// regenerated from scratch on next review. Also patch the cached entries' own
	// `node` field directly — belt-and-suspenders alongside buildPrebuilt's serve-time
	// re-stamp in view.ts, since anything reading the bank straight off disk (not
	// through a live session) should see the current name too.
	const bank = r.bank;
	for (const [id, entries] of Object.entries(bank)) {
		if (!id.startsWith(oldPrefix)) continue;
		const newId = newPrefix + id.slice(oldPrefix.length);
		if (bank[newId]) continue; // already tracked under the new id; leave the old orphaned rather than clobber
		for (const e of entries) if (e.node === oldName) e.node = newName;
		bank[newId] = entries;
		delete bank[id];
		touched.add("bank");
	}

	// Embeddings and the map's saved node layout are both keyed directly by note
	// basename with no id to reconstruct — a plain key swap, same as mastery above.
	const { embeddings, layout } = r;
	if (embeddings[oldName] && !embeddings[newName]) {
		embeddings[newName] = embeddings[oldName];
		delete embeddings[oldName];
		touched.add("embeddings");
	}
	if (layout[oldName] && !layout[newName]) {
		layout[newName] = layout[oldName];
		delete layout[oldName];
		touched.add("layout");
	}

	// Bridge suggestions are keyed by an order-independent pair key over both notes'
	// basenames, with the basenames also duplicated into the record's own a/b fields —
	// recompute the key and patch whichever side (a or b) matched the rename, so a
	// pair already suggested/answered/linked/dismissed isn't re-adjudicated from
	// scratch (and, for "dismissed", isn't re-suggested against the user's own call).
	const bridges = r.bridges;
	for (const [key, rec] of Object.entries(bridges)) {
		if (rec.a !== oldName && rec.b !== oldName) continue;
		const newRec = { ...rec, a: rec.a === oldName ? newName : rec.a, b: rec.b === oldName ? newName : rec.b };
		const newKey = pairKey(newRec.a, newRec.b);
		delete bridges[key];
		if (!bridges[newKey]) bridges[newKey] = newRec; // else already tracked under the new key; drop the stale duplicate
		touched.add("bridges");
	}
	return touched;
}
