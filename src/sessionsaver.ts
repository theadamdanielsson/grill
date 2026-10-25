/** Saving a session's state: what changed since the last save, written together and in
 * order, a few seconds after each grade and whenever the session asks. A dirty flag is
 * cleared only once its write succeeded, so a failed save is retried by the next one
 * instead of forgotten. Said once when saving fails, not on every retry. */

import { Notice } from "obsidian";
import type { BridgeMap } from "./bridges";
import type { RecordHandle } from "./recordhandle";
import type { EmbeddingMap, QuestionBank } from "./store";

/** How long after the last grade a session is saved: a burst of answers is one write, and
 * a session cut off (a phone app killed) loses at most the last answer or two. */
export const CHECKPOINT_MS = 3000;

/** What the saver writes, and when the record may be written. */
export interface SaverParts {
	record(): Pick<RecordHandle, "save">;
	store(): {
		saveQuestionBank(b: QuestionBank): Promise<void>;
		saveBridges(b: BridgeMap): Promise<void>;
		saveEmbeddings(e: EmbeddingMap): Promise<void>;
		hasReadProtected(): boolean;
	};
	/** The concepts and misconceptions held are the loaded ones, not a redo's stand-ins. */
	recordIsLive(): boolean;
	/** A redo: practice only, never scheduled. */
	replay(): boolean;
	bank(): QuestionBank;
	bridges(): BridgeMap;
	embeddings(): EmbeddingMap;
}

export class SessionSaver {
	/** The record (mastery, and concepts and misconceptions when live) changed. */
	dirty = false;
	bankDirty = false;
	bridgesDirty = false;
	embeddingsDirty = false;
	/** Why the last save failed, for the Notice when a new start is refused. */
	lastError = "";
	/** Serialises saves, so a checkpoint and an asked-for save never overlap. */
	chain: Promise<void> = Promise.resolve();
	/** The pending checkpoint, if any. */
	timer: number | null = null;
	private failSaid = false;

	constructor(private parts: SaverParts) {}

	/** Anything unsaved. */
	get pending(): boolean {
		return this.dirty || this.bankDirty || this.bridgesDirty || this.embeddingsDirty;
	}

	/** Save everything that changed. Never throws: a failure is said once and kept dirty. */
	flush(): Promise<void> {
		const run = this.chain.then(() => this.flushNow());
		this.chain = run.catch(() => undefined);
		return run.catch((e) => {
			this.lastError = (e as Error).message;
			if (!this.failSaid) {
				this.failSaid = true;
				new Notice(`Grill: couldn't save your progress (${(e as Error).message}). It'll retry on the next answer.`, 10000);
			}
		});
	}

	private async flushNow(): Promise<void> {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		const p = this.parts;
		if (this.dirty) {
			this.dirty = false;
			try {
				if (p.recordIsLive() && !p.replay()) await p.record().save("mastery", "concepts", "registry");
				else await p.record().save("mastery");
			} catch (e) {
				this.dirty = true;
				throw e;
			}
		}
		if (this.bankDirty) {
			this.bankDirty = false;
			try {
				await p.store().saveQuestionBank(p.bank());
			} catch (e) {
				this.bankDirty = true;
				throw e;
			}
		}
		if (this.bridgesDirty) {
			this.bridgesDirty = false;
			try {
				await p.store().saveBridges(p.bridges());
			} catch (e) {
				this.bridgesDirty = true;
				throw e;
			}
		}
		if (this.embeddingsDirty) {
			this.embeddingsDirty = false;
			try {
				await p.store().saveEmbeddings(p.embeddings());
			} catch (e) {
				this.embeddingsDirty = true;
				throw e;
			}
		}
		this.failSaid = false;
	}

	/** Save CHECKPOINT_MS after the last change. Not in a redo. */
	scheduleCheckpoint(): void {
		if (this.parts.replay()) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, CHECKPOINT_MS);
	}

	/** The unsaved state can't be saved because a store file couldn't be READ (see
	 * GrillStore.loadJSON): that state was built on an empty stand-in for the real file,
	 * so it isn't worth keeping, and refusing to start would wedge the user, since only a
	 * fresh session's reload can pick the real file back up. Drop it. A plain write failure
	 * (disk full) returns false instead, so real grades are kept and retried. */
	discardIfUnsaveable(): boolean {
		if (!this.parts.store().hasReadProtected()) return false;
		new Notice(`Grill: couldn't save the last session (${this.lastError}). Starting fresh from what's on disk.`, 10000);
		this.dirty = this.bankDirty = this.bridgesDirty = this.embeddingsDirty = false;
		return true;
	}
}
