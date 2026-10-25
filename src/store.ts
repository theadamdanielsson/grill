/** Vault storage: state is content, secrets are config.
 *
 * - Settings stay in the plugin's data.json, API keys in Obsidian's keychain (see
 *   secrets.ts); neither is ever in synced markdown.
 * - Mastery state lives at `<folder>/mastery.json` in the vault: user-visible,
 *   versionable, survives plugin reinstalls, syncs with the vault.
 * - Each session is written as a markdown note under `<folder>/Sessions/`,
 *   wiki-linked to the quizzed notes so study history shows up in backlinks
 *   and the graph.
 */

import { App, TFile, normalizePath } from "obsidian";
import { MasteryMap, normalizeMastery } from "./mastery";
import { Question } from "./question";
import { ArcEntry, MisconceptionRegistry, SessionDebrief } from "./debrief";
import { ConceptMap } from "./concepts";
import { BridgeMap } from "./bridges";
import { PdfCacheMap } from "./pdf";
import { ConceptExtractionCacheMap } from "./generate-local";
import { inlineLinks, INSTRUCTIONS_CONTEXT_CAP, INSTRUCTIONS_TEMPLATE, splitInstructions } from "./instructions";
import { renderSessionNote, renderTurns, stampOf, STAMP_RE, type SessionEntry, type SessionMeta } from "./sessionnote";
export type { SessionEntry, SessionMeta } from "./sessionnote";
import type { ImportedRecord } from "./imported";
import { replyTitle } from "./learn";
import { InboxResult, parseResult } from "./record";
import { DEFAULT_FOLDER, INBOX_DIR, LEARN_DIR, PROMPTS_DIR, RECORD_FILES, SESSIONS_DIR, SKILLS_DIR } from "./recordpaths";
import { applyProps, noteProps, sessionFields, sessionsBase } from "./props";

/** A generated question cached for reuse. `sourceHash` ties it to the concept's
 * source text at generation time; a mismatch means the note changed and the entry
 * is stale. Reused across reviews so a due concept isn't re-generated every time. */
export interface CachedQuestion extends Question {
	sourceHash: string;
	lastShownAt?: string;
	timesShown: number;
	/** Flagged "Bad question" mid-review. Kept (not removed) so its text still reaches
	 * the model as "already tried, don't restate" context (see priorQuestionsFor in
	 * view.ts) — deleting it outright let a malformed concept regenerate the same
	 * broken question forever, since nothing recorded that this exact text had already
	 * been rejected. Excluded from cacheHit (never re-served) and from the manage-
	 * questions list (reads as gone to the student). */
	rejected?: boolean;
}

/** Per-concept bank of cached questions, keyed by concept id. */
export type QuestionBank = Record<string, CachedQuestion[]>;

/** One note's cached embedding vector for the semantic bridge prefilter. */
export interface EmbeddingRecord {
	/** Content hash of the note text at embedding time; a mismatch means the note
	 * changed and this entry needs re-embedding. */
	hash: string;
	vector: number[];
	/** Guards against mixing vectors from two different embedding models/dimensions
	 * if the user switches provider between sessions. */
	model: string;
}

/** Cached embeddings, keyed by note basename (same key space as mastery/graph). */
export type EmbeddingMap = Record<string, EmbeddingRecord>;

/** Something wrong with a file Grill read: it couldn't be read (so it isn't saved over),
 * or it was reset (and a copy of it kept beside it). */
export type LoadProblem = { kind: "unreadable" | "reset"; name: string; why: string };

export class GrillStore {
	constructor(
		private app: App,
		private folderName: () => string,
	) {}

	/** The Grill folder, normalised. */
	folder(): string {
		return normalizePath(this.folderName() || DEFAULT_FOLDER);
	}

	/** A path inside the Grill folder. */
	inFolder(...parts: string[]): string {
		return normalizePath([this.folder(), ...parts].join("/"));
	}

	sessionsDir(): string {
		return this.inFolder(SESSIONS_DIR);
	}

	learnDir(): string {
		return this.inFolder(LEARN_DIR);
	}

	promptsDir(): string {
		return this.inFolder(PROMPTS_DIR);
	}

	skillsDir(): string {
		return this.inFolder(SKILLS_DIR);
	}

	private masteryPath(): string {
		return this.inFolder(RECORD_FILES.mastery);
	}

	private instructionsPath(): string {
		return normalizePath(`${this.folder()}/Instructions.md`);
	}

	private registryPath(): string {
		return this.inFolder(RECORD_FILES.registry);
	}

	private conceptsPath(): string {
		return this.inFolder(RECORD_FILES.concepts);
	}

	private bridgesPath(): string {
		return normalizePath(`${this.folder()}/bridges.json`);
	}

	private questionsPath(): string {
		return this.inFolder(RECORD_FILES.bank);
	}

	private reviewLogPath(): string {
		return normalizePath(`${this.folder()}/review-log.csv`);
	}

	private embeddingsPath(): string {
		return normalizePath(`${this.folder()}/embeddings.json`);
	}

	private pdfCachePath(): string {
		return normalizePath(`${this.folder()}/pdf-cache.json`);
	}

	private conceptExtractionCachePath(): string {
		return normalizePath(`${this.folder()}/concept-extraction-cache.json`);
	}

	/** Where uploads from the Instructions note's document area land. Same folder
	 * a hand-written `![[file.pdf]]` embed would use, so the two mechanisms (drop
	 * a file in the upload area vs. embed one manually anywhere in the vault)
	 * are just two ways of doing the same thing, not two separate systems. */
	private attachmentsFolder(): string {
		return normalizePath(`${this.folder()}/Attachments`);
	}

	/** The fenced code block in Instructions.md that lists attached reference
	 * documents, rendered as an upload/remove area by the grill-documents
	 * code-block processor in main.ts. JSON body so add/remove can rewrite it
	 * precisely without disturbing anything else the user wrote in the file. */
	private static readonly REFERENCE_DOCS_FENCE = "```grill-documents";

	/** Per-file size ceiling — this is the real analogue to a chat app's upload
	 * limit (Claude.ai caps a single PDF around 30 MB too): a genuine technical
	 * constraint, since extraction runs client-side on pdf.js and an unbounded
	 * file size is an unbounded parse cost on the student's own machine. */
	static readonly MAX_REFERENCE_DOC_BYTES = 30 * 1024 * 1024;

	/** Document COUNT is a different problem from per-file size, and a small cap
	 * here was the wrong instinct: this list is a persistent course library (every
	 * worksheet across a semester, easily 15-30+ files for one class), not a
	 * single chat turn's attachments — the right comparison is a Claude Project's
	 * knowledge base, not a message's attachment limit. Per-session prompt size
	 * is bounded elsewhere now (each document's real content flows through the
	 * same concept-extraction/FSRS pipeline a note does — see view.ts's session
	 * start — so it's the per-concept context size that matters, not a document-
	 * count-driven text budget); this cap only guards the pathological case
	 * (thousands of files bloating the manifest JSON and the chip list), not
	 * normal comprehensive use. */
	static readonly MAX_REFERENCE_DOCS = 300;

	/** The user's persona override and question/grading preferences (see instructions.ts),
	 * with notes they link to read in. */
	async loadInstructions(): Promise<{ persona: string; preferences: string }> {
		const empty = { persona: "", preferences: "" };
		const path = this.instructionsPath();
		if (!(await this.app.vault.adapter.exists(path))) return empty;
		try {
			const { persona, preferences } = splitInstructions(await this.app.vault.adapter.read(path));
			// Linked notes, read the way Obsidian resolves the link from this note: never
			// the note itself, and only Markdown.
			const readNote = async (linkpath: string): Promise<string | null> => {
				const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, path);
				if (!dest || dest.extension !== "md" || dest.path === path) return null;
				return this.app.vault.cachedRead(dest).catch(() => null);
			};
			const budget = { left: INSTRUCTIONS_CONTEXT_CAP };
			return { persona: await inlineLinks(persona, readNote, budget), preferences: await inlineLinks(preferences, readNote, budget) };
		} catch {
			return empty;
		}
	}

	/** Pull the grill-documents fence's JSON body straight out of raw file text,
	 * independent of loadInstructions' section-slicing above (that path strips
	 * code fences along with everything else non-prose, so it can't be reused
	 * here). Malformed JSON or a missing/incomplete fence both just mean "nothing
	 * attached yet" rather than an error the caller has to handle. */
	private static parseDocManifest(raw: string): string[] {
		const fenceIdx = raw.indexOf(GrillStore.REFERENCE_DOCS_FENCE);
		if (fenceIdx === -1) return [];
		const bodyStart = raw.indexOf("\n", fenceIdx) + 1;
		const end = bodyStart > 0 ? raw.indexOf("```", bodyStart) : -1;
		if (bodyStart <= 0 || end === -1) return [];
		try {
			const data = JSON.parse(raw.slice(bodyStart, end)) as { files?: unknown };
			return Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : [];
		} catch {
			return [];
		}
	}

	/** The names (not full paths — always resolved against attachmentsFolder()) of
	 * documents currently listed in Instructions.md's upload area, in the order
	 * they were added. [] if the file or the section doesn't exist yet. */
	async listReferenceDocNames(): Promise<string[]> {
		const file = this.app.vault.getAbstractFileByPath(this.instructionsPath());
		if (!(file instanceof TFile)) return [];
		try {
			return GrillStore.parseDocManifest(await this.app.vault.cachedRead(file));
		} catch {
			return [];
		}
	}

	/** Rewrite just the grill-documents fence's JSON body in place, creating the
	 * file/section/fence as needed (from the template, which already ships an
	 * empty one) — so attaching the very first document and removing the last
	 * one both just work without a separate migration step. Never touches
	 * anything else in the file: persona, preferences, and the user's own
	 * comments are byte-for-byte untouched by this.
	 *
	 * Goes through `vault.process` when the file already exists, not a raw
	 * adapter write: the upload area renders INSIDE this exact note, so it's
	 * open in an editor essentially every time this runs. `vault.process` is
	 * Obsidian's own safe read-modify-write for a file that might be open —
	 * an adapter-level write here risked the editor's in-memory buffer (which
	 * might hold an edit the user just made) clobbering this change right back,
	 * or this change getting silently lost to the next autosave. */
	private async writeDocManifest(files: string[]): Promise<void> {
		await this.ensureFolder(this.folder());
		const path = this.instructionsPath();
		const rewrite = (raw: string): string => {
			const block = `${GrillStore.REFERENCE_DOCS_FENCE}\n${JSON.stringify({ v: 1, files })}\n\`\`\``;
			const fenceIdx = raw.indexOf(GrillStore.REFERENCE_DOCS_FENCE);
			if (fenceIdx === -1) return raw.replace(/\s*$/, "") + `\n\n## Reference documents\n${block}\n`;
			const bodyStart = raw.indexOf("\n", fenceIdx) + 1;
			const end = bodyStart > 0 ? raw.indexOf("```", bodyStart) : -1;
			return end === -1 ? raw.slice(0, fenceIdx) + block : raw.slice(0, fenceIdx) + block + raw.slice(end + 3);
		};
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.process(existing, rewrite);
		else await this.app.vault.create(path, rewrite(INSTRUCTIONS_TEMPLATE));
	}

	/** The attached documents, resolved to real TFiles (silently dropping any
	 * manifest entry that's missing, renamed, or not a PDF — same "just don't
	 * show it" tolerance loadReferenceDocNames already has for a broken fence).
	 * This is the actual integration point: view.ts's session start feeds each
	 * of these through extractConcepts() exactly like a note's own text, so a
	 * question can genuinely come from an uploaded worksheet — see the "Reference
	 * documents" loop in startScopedSession, not anything in this file. Nothing
	 * here inlines document text into persona/preferences anymore; that channel
	 * is advisory-only (see loadInstructions/TUTOR_RULES) and could never make a
	 * question's actual content come from an attached document, only its tone. */
	async listReferenceDocFiles(): Promise<TFile[]> {
		const names = await this.listReferenceDocNames();
		const files: TFile[] = [];
		for (const name of names) {
			const dest = this.app.vault.getAbstractFileByPath(normalizePath(`${this.attachmentsFolder()}/${name}`));
			if (dest instanceof TFile && dest.extension.toLowerCase() === "pdf") files.push(dest);
		}
		return files;
	}

	/** Cache of extracted PDF text keyed by vault path, shared by every code path
	 * that reads a PDF (note embeds via view.ts, and the upload area above) so a
	 * worksheet costs one real pdf.js parse total, not one per place it's used —
	 * see pdf.ts's PdfCacheMap doc comment for the invalidation rule. */
	async loadPdfCache(): Promise<PdfCacheMap> {
		return this.loadJSON<PdfCacheMap>(this.pdfCachePath(), {});
	}

	async savePdfCache(map: PdfCacheMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveCacheJSON(this.pdfCachePath(), JSON.stringify(map));
	}

	/** Cache of extractConcepts() output, keyed by note/reference-doc name, so the
	 * regex-based structural parse (headings, bold terms, definitions, LaTeX, cloze
	 * cards) only reruns for a file when its effective text actually changed since
	 * last session — see generate-local.ts's ConceptExtractionCacheMap doc comment
	 * for the invalidation rule. */
	async loadConceptExtractionCache(): Promise<ConceptExtractionCacheMap> {
		return this.loadJSON<ConceptExtractionCacheMap>(this.conceptExtractionCachePath(), {});
	}

	async saveConceptExtractionCache(map: ConceptExtractionCacheMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveCacheJSON(this.conceptExtractionCachePath(), JSON.stringify(map));
	}

	/** Copy a picked file's bytes into the Grill Attachments folder — deduplicating
	 * the name if it collides with something already there, same as Obsidian's own
	 * "insert attachment" would — and add it to the upload area's manifest. This is
	 * the "upload" half of the Claude-style attach/remove area in Instructions.md. */
	async addReferenceDoc(bytes: ArrayBuffer, suggestedName: string): Promise<{ file: TFile; files: string[] }> {
		if (bytes.byteLength > GrillStore.MAX_REFERENCE_DOC_BYTES) {
			const mb = (GrillStore.MAX_REFERENCE_DOC_BYTES / (1024 * 1024)).toFixed(0);
			throw new Error(`"${suggestedName}" is over the ${mb} MB limit.`);
		}
		const existingCount = (await this.listReferenceDocNames()).length;
		if (existingCount >= GrillStore.MAX_REFERENCE_DOCS) {
			throw new Error(`You've hit the ${GrillStore.MAX_REFERENCE_DOCS}-document limit. Remove one before adding another.`);
		}
		const dir = this.attachmentsFolder();
		await this.ensureFolder(dir);
		const dot = suggestedName.lastIndexOf(".");
		const base = dot === -1 ? suggestedName : suggestedName.slice(0, dot);
		const ext = dot === -1 ? "" : suggestedName.slice(dot);
		let name = suggestedName;
		let path = normalizePath(`${dir}/${name}`);
		let n = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			name = `${base} ${++n}${ext}`;
			path = normalizePath(`${dir}/${name}`);
		}
		const file = await this.app.vault.createBinary(path, bytes);
		const files = await this.listReferenceDocNames();
		files.push(name);
		await this.writeDocManifest(files);
		return { file, files };
	}

	/** The "remove" half: drops the entry from the manifest and, if asked, deletes
	 * the underlying file and its cached extraction too — a real removal, not
	 * just hiding the line, since the whole point of removing something is that
	 * it stops costing tokens and stops taking up space. */
	async removeReferenceDoc(name: string, deleteFile: boolean): Promise<string[]> {
		const files = (await this.listReferenceDocNames()).filter((f) => f !== name);
		await this.writeDocManifest(files);
		if (deleteFile) {
			const dest = this.app.vault.getAbstractFileByPath(normalizePath(`${this.attachmentsFolder()}/${name}`));
			if (dest instanceof TFile) {
				await this.app.fileManager.trashFile(dest).catch(() => undefined);
				const cache = await this.loadPdfCache();
				if (cache[dest.path]) {
					delete cache[dest.path];
					await this.savePdfCache(cache);
				}
			}
		}
		return files;
	}

	/** Create the instructions file with a commented template if it does not exist,
	 * and return it as a TFile so the caller can open it. */
	async createInstructions(): Promise<TFile | null> {
		await this.ensureFolder(this.folder());
		const path = this.instructionsPath();
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		try {
			return await this.app.vault.create(path, INSTRUCTIONS_TEMPLATE);
		} catch {
			const after = this.app.vault.getAbstractFileByPath(path);
			return after instanceof TFile ? after : null;
		}
	}

	/** Export every concept's raw review history as a flat CSV — a portable audit
	 * trail for the FSRS personalization optimizer.ts fits against, independent of
	 * this plugin's own JSON shape. Overwrites on each export (a snapshot, not a
	 * template like the instructions file), so `vault.modify` when the file's
	 * already there rather than `createInstructions`'s create-once dance. */
	/** Graded answers other agents left in `<folder>/Inbox/` (see record.ts), oldest
	 * first. Files that aren't a result are left where they are and skipped. */
	async readInbox(): Promise<Array<{ path: string; result: InboxResult }>> {
		const dir = normalizePath(`${this.folder()}/${INBOX_DIR}`);
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) return [];
		const out: Array<{ path: string; result: InboxResult }> = [];
		for (const path of (await adapter.list(dir)).files) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(await adapter.read(path));
			} catch {
				continue; // half written or half synced: tried again next time
			}
			const result = parseResult(raw);
			// Whole, but not an answer Grill takes: put aside, not read again every time.
			if (result) out.push({ path, result });
			else await this.setAsideInboxFile(path);
		}
		return out.sort((a, b) => a.result.at.localeCompare(b.result.at));
	}

	async removeInboxFile(path: string): Promise<void> {
		await this.app.vault.adapter.remove(path).catch(() => undefined);
	}

	/** An answer that could not be applied is kept beside the others under a name the
	 * fold no longer reads, so it is not tried again every time. */
	async setAsideInboxFile(path: string): Promise<void> {
		await this.app.vault.adapter.rename(path, `${path}.rejected`).catch(() => this.removeInboxFile(path));
	}

	private appliedPath(): string {
		return normalizePath(`${this.folder()}/inbox-applied.json`);
	}

	/** Ids of agent answers already in the record. In the vault, not the plugin's own data,
	 * so a second device that syncs the same answer file in skips it too. */
	async loadAppliedInbox(): Promise<string[]> {
		const ids = await this.loadJSON<unknown>(this.appliedPath(), []);
		return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
	}

	async saveAppliedInbox(ids: string[]): Promise<void> {
		await this.saveJSON(this.appliedPath(), JSON.stringify(ids.slice(-5000)));
	}

	/** The Inbox folder, once nothing is left in it, so it isn't left in the file list. */
	async removeEmptyInbox(): Promise<void> {
		const dir = normalizePath(`${this.folder()}/${INBOX_DIR}`);
		const adapter = this.app.vault.adapter;
		try {
			const left = await adapter.list(dir);
			if (!left.files.length && !left.folders.length) await adapter.rmdir(dir, false);
		} catch {
			/* already gone, or something arrived meanwhile */
		}
	}

	isInboxPath(path: string): boolean {
		return path.startsWith(normalizePath(`${this.folder()}/${INBOX_DIR}`) + "/") && path.endsWith(".json");
	}

	async exportReviewLog(concepts: ConceptMap): Promise<TFile | null> {
		await this.ensureFolder(this.folder());
		const csvField = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
		const rows = ["concept_id,note,elapsed_days,rating,timestamp"];
		for (const [id, cm] of Object.entries(concepts)) {
			for (const entry of cm.reviewLog ?? []) {
				rows.push(
					[csvField(id), csvField(cm.note), entry.elapsedDays.toFixed(4), String(entry.rating), entry.t].join(","),
				);
			}
		}
		const csv = rows.join("\n") + "\n";
		const path = this.reviewLogPath();
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, csv);
				return existing;
			}
			return await this.app.vault.create(path, csv);
		} catch {
			const after = this.app.vault.getAbstractFileByPath(path);
			return after instanceof TFile ? after : null;
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.createFolder(path).catch(() => {});
		}
	}

	/** Shared JSON load for every store below. A missing file is the first-run
	 * `fallback`. A file that exists but can't be parsed, or isn't the shape `check`
	 * wants, is backed up alongside itself as `.corrupt-<ts>.json`, reported through
	 * `onProblem`, and read as `fallback`. A file that exists but can't be READ (iCloud
	 * hasn't downloaded it yet, a sync lock) is different: its real content is still
	 * there, so the path is marked read-only for this plugin session and every save to it
	 * is refused, until a later read of it succeeds. Reading it as empty and then saving
	 * used to overwrite a user's whole history with near-empty data. */
	private async loadJSON<T>(path: string, fallback: T, check?: (v: unknown) => string | null): Promise<T> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) return fallback;
		const name = path.split("/").pop() ?? path;
		let raw: string;
		try {
			raw = await adapter.read(path);
			// Readable again (the sync finished). Every caller replaces its in-memory
			// copy with what this returns, so saving over the file is safe once more.
			this.readOnlyPaths.delete(path);
		} catch (e) {
			this.readOnlyPaths.add(path);
			this.onProblem({ kind: "unreadable", name, why: (e as Error).message });
			return fallback;
		}
		let value: unknown;
		let why: string | null;
		try {
			value = JSON.parse(raw);
			why = check ? check(value) : null;
		} catch {
			why = "corrupted JSON";
		}
		if (why === null) return value as T;
		try {
			await adapter.write(`${path}.corrupt-${Date.now()}.json`, raw);
			this.onProblem({ kind: "reset", name, why });
		} catch {
			/* best-effort backup */
		}
		return fallback;
	}

	/** A cache that can always be rebuilt: anything wrong with it reads as `fallback`,
	 * without a backup or a word. */
	private async loadCacheJSON<T>(path: string, fallback: T): Promise<T> {
		const adapter = this.app.vault.adapter;
		try {
			return (await adapter.exists(path)) ? (JSON.parse(await adapter.read(path)) as T) : fallback;
		} catch {
			return fallback;
		}
	}

	/** Told when a file couldn't be read, or was reset; the plugin says so. */
	onProblem: (p: LoadProblem) => void = () => {};

	/** Paths whose read failed this plugin session; see loadJSON. */
	private readOnlyPaths = new Set<string>();

	/** Is any store currently refusing saves because it couldn't be read? */
	hasReadProtected(): boolean {
		return this.readOnlyPaths.size > 0;
	}

	/** Shared JSON save for every store below: write a sibling `.tmp` and rename it
	 * into place; where the adapter refuses to rename over an existing file, write the
	 * real file directly (never delete-then-rename: a sync tool could ship the delete
	 * to another device before the new file). Throws if the data couldn't be written,
	 * or if the path is read-protected (see loadJSON), so callers (the session's
	 * flush) keep their state dirty and say so instead of believing it was saved. */
	private saveJSON(path: string, data: string): Promise<void> {
		return this.inTurn(path, () => this.writeJSON(path, data));
	}

	/** Saves to one file, one at a time, in the order they were asked for: two writes
	 * racing through the temp file could otherwise land the older one last. */
	private inTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
		const turn = (this.turns.get(path) ?? Promise.resolve()).then(work, work);
		const settled = turn.then(
			() => undefined,
			() => undefined,
		);
		this.turns.set(path, settled);
		void settled.then(() => {
			if (this.turns.get(path) === settled) this.turns.delete(path);
		});
		return turn;
	}

	private turns = new Map<string, Promise<void>>();

	/** Read-modify-write edits of the record (an inbox fold, a rename, a refresh of a
	 * note's concepts) run one at a time, so one can't save over what another just
	 * changed. */
	editRecord<T>(edit: () => Promise<T>): Promise<T> {
		return this.inTurn("record", edit);
	}

	private async writeJSON(path: string, data: string): Promise<void> {
		if (this.readOnlyPaths.has(path)) {
			// Refuse loudly, not silently: a quiet skip let the session's flush think it
			// had saved. Throwing keeps it dirty and makes its "couldn't save" Notice fire.
			const name = path.split("/").pop() ?? path;
			throw new Error(`${name} couldn't be read at startup, so Grill won't save over it until it can read it again. Start a new session once your sync has finished`);
		}
		const adapter = this.app.vault.adapter;
		const tmp = `${path}.tmp`;
		try {
			await adapter.write(tmp, data);
			await adapter.rename(tmp, path);
			return;
		} catch {
			/* rename over an existing file is refused on most adapters: write directly */
		}
		await adapter.write(path, data);
		await adapter.remove(tmp).catch(() => undefined);
	}

	/** saveJSON for derived caches that can always be rebuilt: never throws, so a
	 * cache that couldn't be written never aborts a session. */
	private async saveCacheJSON(path: string, data: string): Promise<void> {
		await this.saveJSON(path, data).catch((e) => console.error(`Grill: couldn't write cache ${path}`, e));
	}

	async loadSearchIndex<T>(fallback: T): Promise<T> {
		return this.loadCacheJSON(this.inFolder("search-index.json"), fallback);
	}

	async saveSearchIndex(index: unknown): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveCacheJSON(this.inFolder("search-index.json"), JSON.stringify(index));
	}

	async loadMastery(): Promise<MasteryMap> {
		return normalizeMastery(await this.loadJSON<MasteryMap>(this.masteryPath(), {}));
	}

	async saveMastery(map: MasteryMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.masteryPath(), JSON.stringify(map, null, 1));
		if (this.notePropsOn()) void this.syncNoteProps(map, true).catch((e) => console.error("Grill: couldn't write note properties", e));
	}

	/** The "Write the record into notes" setting; set by the plugin. */
	notePropsOn: () => boolean = () => false;
	/** What each note's properties were last set to, so a save only touches notes whose
	 * record changed. Empty after a restart: the first save checks every studied note,
	 * and still rewrites only those whose properties differ. */
	private writtenProps = new Map<string, string>();

	/** Writes each studied note's record into its properties (props.ts), or with `on`
	 * false removes them. Notes in Grill's own folder and non-Markdown files are skipped.
	 * A note whose properties already match is not rewritten. Returns notes changed. */
	async syncNoteProps(map: MasteryMap, on: boolean): Promise<number> {
		if (!on) this.writtenProps.clear();
		let changed = 0;
		for (const name of Object.keys(map)) {
			const props = on ? noteProps(map[name]) : {};
			const key = JSON.stringify(props);
			if (on && this.writtenProps.get(name) === key) continue;
			const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
			if (!(file instanceof TFile) || file.extension !== "md" || file.path.startsWith(`${this.folder()}/`)) continue;
			const cached = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
			if (applyProps(cached, props)) {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => applyProps(fm, props));
				changed++;
			}
			if (on) this.writtenProps.set(name, key);
		}
		return changed;
	}

	/** Writes a view file into Grill's folder unless one is already there: a view the
	 * user has edited is theirs. */
	async writeBaseIfMissing(name: string, text: string): Promise<void> {
		await this.ensureFolder(this.folder());
		const path = normalizePath(`${this.folder()}/${name}`);
		if (this.app.vault.getAbstractFileByPath(path) || (await this.app.vault.adapter.exists(path))) return;
		await this.app.vault.create(path, text);
	}

	/** Gives older session notes the `correct`, `total` and `notes` properties newer
	 * ones are written with, read from their own text (props.ts's sessionFields), so
	 * the Sessions view has no empty columns. `notes` are links with `link`, else plain
	 * names. A note that already has them is left alone. Returns notes changed. */
	async backfillSessionFields(link: boolean): Promise<number> {
		const dir = `${this.sessionsDir()}/`;
		let changed = 0;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(dir)) continue;
			const had = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (typeof had?.correct === "number" && had.notes !== undefined) continue;
			const fields = sessionFields(await this.app.vault.cachedRead(f));
			if (!fields) continue;
			await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				fm.correct = fields.correct;
				fm.total = fields.total;
				if (fields.notes.length && fm.notes === undefined) fm.notes = fields.notes.map((n) => (link ? `[[${n}]]` : n));
			});
			changed++;
		}
		return changed;
	}

	/** Has this vault's Grill folder got a Sessions folder yet? */
	async hasSessions(): Promise<boolean> {
		return this.app.vault.adapter.exists(this.sessionsDir());
	}

	sessionsBaseText(): string {
		return sessionsBase(this.folder());
	}

	/** Cached note embeddings for the semantic bridge prefilter (bridges.ts's
	 * detectSemanticBridgeCandidates). `hash` guards each entry against the note's
	 * content changing since it was embedded; `model` guards against silently mixing
	 * vectors from two different embedding models/dimensions if the user switches
	 * provider. Same load/save shape as loadMastery/saveMastery. */
	async loadEmbeddings(): Promise<EmbeddingMap> {
		return this.loadJSON<EmbeddingMap>(this.embeddingsPath(), {});
	}

	async saveEmbeddings(map: EmbeddingMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveCacheJSON(this.embeddingsPath(), JSON.stringify(map));
	}

	/** The canonical misconception registry (recomputable projection over raw tags). */
	async loadRegistry(): Promise<MisconceptionRegistry> {
		return this.loadJSON<MisconceptionRegistry>(this.registryPath(), {});
	}

	async saveRegistry(reg: MisconceptionRegistry): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.registryPath(), JSON.stringify(reg, null, 1));
	}

	/** Per-concept scheduling state (the source of truth for scheduling). */
	async loadConcepts(): Promise<ConceptMap> {
		return this.loadJSON<ConceptMap>(this.conceptsPath(), {});
	}

	async saveConcepts(map: ConceptMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.conceptsPath(), JSON.stringify(map, null, 1));
	}

	/** Missing-link records: which note pairs have been surfaced, answered, or linked. */
	/** Questions asked in other AI chats, matched to notes (see imported.ts). */
	async loadImported(): Promise<ImportedRecord | null> {
		return this.loadJSON<ImportedRecord | null>(normalizePath(`${this.folder()}/imported.json`), null);
	}

	async saveImported(rec: ImportedRecord | null): Promise<void> {
		const path = normalizePath(`${this.folder()}/imported.json`);
		if (!rec) {
			if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
			return;
		}
		await this.ensureFolder(this.folder());
		await this.saveJSON(path, JSON.stringify(rec, null, 1));
	}

	async loadBridges(): Promise<BridgeMap> {
		return this.loadJSON<BridgeMap>(this.bridgesPath(), {});
	}

	async saveBridges(map: BridgeMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.bridgesPath(), JSON.stringify(map, null, 1));
	}

	/** Persisted learning-graph node positions, so the map is stable across opens. */
	async loadGraphLayout(): Promise<Record<string, { x: number; y: number }>> {
		return this.loadJSON<Record<string, { x: number; y: number }>>(normalizePath(`${this.folder()}/graph-layout.json`), {});
	}

	async saveGraphLayout(pos: Record<string, { x: number; y: number }>): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveCacheJSON(normalizePath(`${this.folder()}/graph-layout.json`), JSON.stringify(pos, null, 0));
	}

	/** Per-concept question bank, reused across reviews so a due concept isn't
	 * re-generated by a fresh API call every time it comes up. */
	async loadQuestionBank(): Promise<QuestionBank> {
		return this.loadJSON<QuestionBank>(this.questionsPath(), {});
	}

	async saveQuestionBank(map: QuestionBank): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.questionsPath(), JSON.stringify(map, null, 1));
	}

	/** Write a `[[toBase]]` link into `from`'s body under a `## Related` section
	 * (created if absent). Idempotent and button-gated: this is the only place Grill
	 * writes into a user's note body, and only on an explicit "Link these notes".
	 * Returns false if the note couldn't be edited. */
	async linkNotes(from: TFile, toBase: string): Promise<boolean> {
		try {
			await this.app.vault.process(from, (data) => {
				if (data.includes(`[[${toBase}`)) return data; // already links to it
				const heading = /(^|\n)(#{1,6})\s+Related\s*(\r?\n)/i;
				const m = heading.exec(data);
				if (m) {
					const at = m.index + m[0].length;
					return data.slice(0, at) + `- [[${toBase}]]\n` + data.slice(at);
				}
				return data.replace(/\s*$/, "") + `\n\n## Related\n- [[${toBase}]]\n`;
			});
			return true;
		} catch {
			return false;
		}
	}

	async writeSessionNote(
		entries: SessionEntry[],
		meta: SessionMeta,
		link = true,
		debrief?: SessionDebrief,
		redoQuestions: Question[] = [],
		/** A note written earlier for the same session, rewritten in place with all of it. */
		replace?: TFile | null,
	): Promise<TFile | null> {
		const d = meta.startedAt;
		const pad = (n: number) => String(n).padStart(2, "0");
		// One subfolder per month: a daily-use vault writes a session note every
		// sitting, so a flat Sessions/ folder turns into hundreds of files within a
		// couple of months and floods Obsidian's file explorer, backlinks, and search.
		const monthDir = this.inFolder(SESSIONS_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
		await this.ensureFolder(this.folder());
		// The first session in a vault brings the view file that lists them all.
		const first = !(await this.hasSessions());
		await this.ensureFolder(this.sessionsDir());
		await this.ensureFolder(monthDir);
		if (first) await this.writeBaseIfMissing("Sessions.base", this.sessionsBaseText()).catch(() => undefined);
		const dir = monthDir;
		const stamp = stampOf(d);
		const text = renderSessionNote(entries, meta, link, debrief, redoQuestions);

		if (replace && this.app.vault.getAbstractFileByPath(replace.path) === replace) {
			try {
				await this.app.vault.modify(replace, text);
				return replace;
			} catch {
				return null;
			}
		}
		let path = normalizePath(`${dir}/${stamp}.md`);
		if (await this.app.vault.adapter.exists(path)) {
			path = normalizePath(`${dir}/${stamp}.${pad(d.getSeconds())}.md`);
		}
		try {
			return await this.app.vault.create(path, text);
		} catch {
			return null;
		}
	}

	/** A Learn conversation, kept as a note under `<folder>/Learn/`, apart from the
	 * session notes: nothing in it was graded, so it has no score and must not be read
	 * as a session by what counts reviews. */
	async saveLearnThread(
		note: string,
		turns: Array<{ role: "student" | "tutor"; text: string; diagram?: string }>,
		meta: { provider: string; model: string; startedAt: Date; into?: TFile; from?: number },
	): Promise<TFile | null> {
		if (!turns.length) return null;
		const d = meta.startedAt;
		const pad = (n: number) => String(n).padStart(2, "0");
		const dir = this.inFolder(LEARN_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
		await this.ensureFolder(this.folder());
		await this.ensureFolder(this.learnDir());
		await this.ensureFolder(dir);
		const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		// A conversation carried on keeps the title it has, which may be one given to it.
		const had: unknown = meta.into ? this.app.metadataCache.getFileCache(meta.into)?.frontmatter?.title : undefined;
		const title = typeof had === "string" && had.trim() ? had.trim() : learnTitle(turns, note === "Your notes" ? "" : note);
		const lines: string[] = [
			"---",
			`date: ${day}`,
			"type: learn",
			`title: ${JSON.stringify(title)}`,
			`note: ${JSON.stringify(note)}`,
			`provider: ${meta.provider}`,
			`model: ${meta.model}`,
			"---",
			`# ${title}`,
			// A conversation about the notes as a whole has no one note to link to.
			note === "Your notes" ? "About your notes." : `About [[${note}]].`,
			"",
		];
		lines.push(...renderTurns(turns));
		// A conversation carried on is kept in the note it was saved in: what was said since
		// is added at its end, and the rest of the note, with anything added to it by
		// hand, is left as it is.
		if (meta.into && this.app.vault.getAbstractFileByPath(meta.into.path)) {
			const more = renderTurns(turns.slice(meta.from ?? 0));
			if (more.length) await this.app.vault.process(meta.into, (text) => `${text.replace(/\s+$/, "")}\n\n${more.join("\n")}`);
			return meta.into;
		}
		// Dated first, so the folder reads in order and the name can't be taken for a
		// note of the student's own with the same title.
		const base = `${day} ${title}`;
		let path = normalizePath(`${dir}/${base}.md`);
		for (let n = 2; await this.app.vault.adapter.exists(path); n++) path = normalizePath(`${dir}/${base} ${n}.md`);
		try {
			return await this.app.vault.create(path, lines.join("\n"));
		} catch {
			return null;
		}
	}

	/** One-time backfill for a vault that already has real session history from
	 * before the arc feature existed: without this, activeDayCount only sees days
	 * logged going forward, so an existing user with weeks of real study behind
	 * them would be made to wait MIN_ACTIVE_DAYS_FOR_ARC days from scratch despite
	 * already having a misconception registry full of real evidence. Reads past
	 * session notes' own filenames (the date) and their embedded debrief callout
	 * (the headline, if any) — the same two fields writeSessionNote itself writes
	 * (`> [!summary] Debrief`, `> ${headline}`) — so this only ever reconstructs
	 * what a running arcLog would already have if the feature had shipped earlier.
	 * Capped to the most recent `cap` distinct days, same as logArcEntry's ongoing
	 * cap, so a heavy vault's backfill costs one read per recent day, not one per
	 * lifetime session. Best-effort: an unparseable or unreadable file just yields
	 * no headline for that day rather than failing the whole backfill. */
	async backfillArcLog(cap: number): Promise<ArcEntry[]> {
		const headlineFromBody = /^> \[!summary\] Debrief\n> (.+)$/m;
		const prefix = `${this.sessionsDir()}/`;
		const byDate = new Map<string, TFile>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const m = STAMP_RE.exec(f.basename);
			if (!m) continue;
			const existing = byDate.get(m[1]);
			if (!existing || f.name > existing.name) byDate.set(m[1], f); // last session of the day wins
		}
		const recentDates = [...byDate.keys()].sort().slice(-cap);
		const out: ArcEntry[] = [];
		for (const date of recentDates) {
			const file = byDate.get(date);
			if (!file) continue;
			let headline = "";
			try {
				const body = await this.app.vault.cachedRead(file);
				headline = headlineFromBody.exec(body)?.[1]?.trim() ?? "";
			} catch {
				// best-effort, see doc comment
			}
			out.push({ date, headline });
		}
		return out;
	}
}

/** What a Learn conversation is called: the first heading Grill wrote, else the first
 * thing asked (when it says more than two words), else the note it was about. Already
 * safe to be a file name. */
export function learnTitle(turns: Array<{ role: "student" | "tutor"; text: string }>, note: string): string {
	const reply = turns.find((t) => t.role === "tutor")?.text ?? "";
	const heading = replyTitle(/^#{1,3}\s+(.+)$/m.exec(reply)?.[1] ?? "");
	if (heading) return heading;
	const asked = replyTitle((turns.find((t) => t.role === "student")?.text ?? "").split("\n")[0]).replace(/[?!]+$/, "");
	if (asked.split(" ").length >= 3) return asked[0].toUpperCase() + asked.slice(1);
	return replyTitle(note) || asked || "Chat";
}
