/** The record the plugin holds in memory: concepts, note mastery and misconceptions. One
 * object owns them, so every pane and the plugin read the same maps, and a map loaded
 * again replaces it here, for everyone. */

import type { ConceptMap } from "./concepts";
import type { MisconceptionRegistry } from "./debrief";
import type { MasteryMap } from "./mastery";
import type { RecordState } from "./record";

/** The record's part of the store. */
export interface RecordFiles {
	loadConcepts(): Promise<ConceptMap>;
	loadMastery(): Promise<MasteryMap>;
	loadRegistry(): Promise<MisconceptionRegistry>;
	saveConcepts(m: ConceptMap): Promise<void>;
	saveMastery(m: MasteryMap): Promise<void>;
	saveRegistry(m: MisconceptionRegistry): Promise<void>;
}

export type RecordPart = keyof RecordState;

/** Saved in this order: mastery first, so one unwritable file doesn't hold the others back. */
const ORDER: RecordPart[] = ["mastery", "concepts", "registry"];

export class RecordHandle implements RecordState {
	concepts: ConceptMap = {};
	mastery: MasteryMap = {};
	registry: MisconceptionRegistry = {};

	constructor(private files: () => RecordFiles) {}

	async load(...parts: RecordPart[]): Promise<void> {
		const f = this.files();
		for (const p of ORDER.filter((x) => parts.includes(x))) {
			if (p === "concepts") this.concepts = await f.loadConcepts();
			else if (p === "mastery") this.mastery = await f.loadMastery();
			else this.registry = await f.loadRegistry();
		}
	}

	async save(...parts: RecordPart[]): Promise<void> {
		const f = this.files();
		for (const p of ORDER.filter((x) => parts.includes(x))) {
			if (p === "concepts") await f.saveConcepts(this.concepts);
			else if (p === "mastery") await f.saveMastery(this.mastery);
			else await f.saveRegistry(this.registry);
		}
	}
}
