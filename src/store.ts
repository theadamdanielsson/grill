/** Vault storage: state is content, secrets are config.
 *
 * - API keys and settings stay in the plugin's data.json (never in synced markdown).
 * - Mastery state lives at `<folder>/mastery.json` in the vault: user-visible,
 *   versionable, survives plugin reinstalls, syncs with the vault.
 * - Each session is written as a markdown note under `<folder>/Sessions/`,
 *   wiki-linked to the quizzed notes so study history shows up in backlinks
 *   and the graph.
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import { MasteryMap, Verdict, normalizeMastery } from "./mastery";
import { DEFAULT_PERSONA, Question } from "./llm";
import { ArcEntry, MisconceptionRegistry, SessionDebrief } from "./debrief";
import { ConceptMap } from "./concepts";
import { safeSlice } from "./text";
import { BridgeMap } from "./bridges";
import { PdfCacheMap } from "./pdf";

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

export interface SessionEntry {
	node: string;
	question: string;
	answer: string;
	verdict: Verdict;
	gaveUp: boolean;
	feedback: string;
	modelAnswer: string;
}

export interface SessionMeta {
	provider: string;
	model: string;
	startedAt: Date;
	/** True when this session came from "Review N due now" / the due-queue status bar,
	 * not a regular study session, so the note can say so instead of reading identically. */
	dueOnly?: boolean;
}

export class GrillStore {
	constructor(
		private app: App,
		private folderName: () => string,
	) {}

	private folder(): string {
		return normalizePath(this.folderName() || "Grill");
	}

	private masteryPath(): string {
		return normalizePath(`${this.folder()}/mastery.json`);
	}

	private instructionsPath(): string {
		return normalizePath(`${this.folder()}/Instructions.md`);
	}

	private registryPath(): string {
		return normalizePath(`${this.folder()}/misconceptions.json`);
	}

	private conceptsPath(): string {
		return normalizePath(`${this.folder()}/concepts.json`);
	}

	private bridgesPath(): string {
		return normalizePath(`${this.folder()}/bridges.json`);
	}

	private questionsPath(): string {
		return normalizePath(`${this.folder()}/questions.json`);
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

	/** Where uploads from the Instructions note's document area land. Same folder
	 * a hand-written `![[file.pdf]]` embed would use, so the two mechanisms (drop
	 * a file in the upload area vs. embed one manually anywhere in the vault)
	 * are just two ways of doing the same thing, not two separate systems. */
	private attachmentsFolder(): string {
		return normalizePath(`${this.folder()}/Attachments`);
	}

	private static readonly INSTRUCTIONS_CAP = 2000;

	/** Total characters of referenced-note text that [[wikilinks]] in persona/
	 * preferences may inline, shared across the whole file, so a linked style
	 * guide can't inflate every session's prompt without bound. */
	private static readonly INSTRUCTIONS_CONTEXT_CAP = 4000;

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

	private static readonly INSTRUCTIONS_TEMPLATE = [
		"## Persona",
		"<!-- This is who Grill is and how it talks to you. Rewrite the line below to change",
		"     Grill's character: a strict examiner, a gentle Socratic guide, a blunt drill",
		"     sergeant, whatever suits you. This changes only Grill's voice. How questions are",
		"     built and how your answers are scored is fixed by the engine, so your grades stay",
		"     consistent no matter what you write here. Leave it blank to use the default. -->",
		"",
		DEFAULT_PERSONA,
		"",
		"## Preferences",
		"<!-- Plain sentences telling Grill how you want to be quizzed and graded: question",
		"     style, difficulty, strictness. Leave blank for the defaults.",
		"",
		"     This is NOT where to pick question FORMAT (multiple-choice, fill-in-the-blank,",
		"     true/false, write-in, etc.) — that's a hard setting the model can't reliably",
		"     override from prose, so it has its own control: Settings -> Question formats.",
		"",
		"     Examples you might write:",
		'       "Prefer short numeric problems over definitions."',
		'       "Ask me to explain concepts in my own words."',
		'       "Be strict on exact terminology."',
		'       "Accept bullet-point answers, do not mark me down for phrasing."',
		"",
		"     You can point at another note with [[links]] and Grill reads it in, so a",
		"     longer style guide or marking rubric can live in its own note. Referenced",
		"     notes are capped, and everything here rides along in every session, so keep",
		"     it short; long text costs more tokens every session. -->",
		"",
		"",
		"## Reference documents",
		"<!-- Drop worksheets, past exams, or official solutions below and Grill reads",
		"     their real text into every session — the same idea as attaching a file in",
		"     an AI chat, not a description of the document, the document itself. PDFs",
		"     are text-extracted (first 40 pages, cached so re-opening a session doesn't",
		"     re-parse them); other file types are stored but not read yet. 30 MB per",
		"     file, 300 documents max — this is a course library, not a single",
		"     message's attachments, so attach every worksheet you have. Each session",
		"     splits a shared text budget evenly across whatever's attached, so a",
		"     bigger library means less depth per document, not documents silently",
		"     dropped. -->",
		"",
		"```grill-documents",
		'{"v":1,"files":[]}',
		"```",
		"",
	].join("\n");

	/** The user's persona override and question/grading preferences, parsed from the two
	 * "## Persona" / "## Preferences" sections, with how-to comments stripped and each section
	 * length-capped. An empty persona means "use the engine default". Files written before this
	 * format (no headings) are read as all-preferences, preserving old behavior. */
	async loadInstructions(): Promise<{ persona: string; preferences: string }> {
		const empty = { persona: "", preferences: "" };
		const path = this.instructionsPath();
		if (!(await this.app.vault.adapter.exists(path))) return empty;
		try {
			const raw = await this.app.vault.adapter.read(path);
			const cap = GrillStore.INSTRUCTIONS_CAP;
			const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim();
			const lower = raw.toLowerCase();
			const pIdx = lower.indexOf("## persona");
			const fIdx = lower.indexOf("## preferences");
			// A third heading now sits after Preferences (see REFERENCE_DOCS_FENCE below) —
			// without accounting for it, Preferences' old "run to end of file" slice would
			// swallow the reference-documents heading and its raw JSON fence as literal,
			// ugly prose. (Attached documents' real content doesn't belong in preferences
			// at all, ugly or not — see listReferenceDocFiles: it flows into the same
			// concept-extraction pipeline a note's text does, not this advisory channel.)
			const rIdx = lower.indexOf("## reference documents");
			const nextBoundary = (start: number): number => {
				const after = [pIdx, fIdx, rIdx].filter((i) => i > start);
				return after.length ? Math.min(...after) : raw.length;
			};
			let persona = "";
			let preferences = "";
			// Legacy file with no section headings: treat the whole thing as preferences,
			// same as before — EXCEPT still stop at the reference-documents fence if one
			// somehow exists in an otherwise-legacy file (the upload area's "add" flow can
			// append that section to any file, headings or not), so its raw JSON manifest
			// never leaks into the prompt as prose.
			if (pIdx === -1 && fIdx === -1) {
				preferences = safeSlice(strip(raw.slice(0, rIdx === -1 ? raw.length : rIdx)), cap);
			} else {
				if (pIdx !== -1) persona = safeSlice(strip(raw.slice(pIdx + "## persona".length, nextBoundary(pIdx))), cap);
				if (fIdx !== -1) preferences = safeSlice(strip(raw.slice(fIdx + "## preferences".length, nextBoundary(fIdx))), cap);
			}
			// Expand any [[wikilinks]] by inlining the referenced notes, under one shared
			// budget across the file, so a longer style guide can live in its own note.
			const budget = { left: GrillStore.INSTRUCTIONS_CONTEXT_CAP };
			persona = await this.inlineLinks(persona, path, budget);
			preferences = await this.inlineLinks(preferences, path, budget);
			return { persona, preferences };
		} catch {
			return empty;
		}
	}

	/** Append the body of any [[wikilinks]] a section references (one level only, no
	 * recursion), under a labelled block. Shares `budget` across the whole file, skips
	 * non-markdown targets and the instructions note itself, and truncates so
	 * referenced docs can never blow up the prompt. */
	private async inlineLinks(text: string, sourcePath: string, budget: { left: number }): Promise<string> {
		if (!text || budget.left <= 0) return text;
		const seen = new Set<string>();
		const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
		let out = text;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (budget.left <= 0) break;
			const linkpath = m[1].trim();
			if (!linkpath || seen.has(linkpath.toLowerCase())) continue;
			seen.add(linkpath.toLowerCase());
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
			if (!dest || dest.extension !== "md" || dest.path === sourcePath) continue;
			let body: string;
			try {
				body = await this.app.vault.cachedRead(dest);
			} catch {
				continue;
			}
			body = body
				.replace(/^---\n[\s\S]*?\n---\n/, "")
				.replace(/<!--[\s\S]*?-->/g, "")
				.trim();
			if (!body) continue;
			const slice = safeSlice(body, budget.left);
			budget.left -= slice.length;
			out += `\n\nReferenced note "${linkpath}":\n${slice}${slice.length < body.length ? "\n[truncated]" : ""}`;
		}
		return out;
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
		else await this.app.vault.create(path, rewrite(GrillStore.INSTRUCTIONS_TEMPLATE));
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
		await this.saveJSON(this.pdfCachePath(), JSON.stringify(map));
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
			throw new Error(`You've hit the ${GrillStore.MAX_REFERENCE_DOCS}-document limit — remove one before adding another.`);
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
			return await this.app.vault.create(path, GrillStore.INSTRUCTIONS_TEMPLATE);
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

	/** Shared JSON load for every store below. A parse failure (a truncated write from
	 * an interrupted save, a sync conflict, disk corruption) used to just silently
	 * return an empty object, indistinguishable from "this store has always been
	 * empty" — the student's entire mastery/concept/question history could vanish
	 * with no notice at all. Instead: back up the unreadable bytes next to the
	 * original (so there's at least a chance of manual recovery) and warn once via
	 * Notice, before falling back to `fallback` the same way every caller already
	 * expects. Best-effort: if even the backup write fails, still degrade to
	 * `fallback` rather than throwing and breaking plugin load entirely. */
	private async loadJSON<T>(path: string, fallback: T): Promise<T> {
		if (!(await this.app.vault.adapter.exists(path))) return fallback;
		let raw: string;
		try {
			raw = await this.app.vault.adapter.read(path);
		} catch {
			return fallback; // unreadable (permissions, sync lock) — nothing to back up
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			const name = path.split("/").pop() ?? path;
			try {
				await this.app.vault.adapter.write(`${path}.corrupt-${Date.now()}.json`, raw);
				new Notice(
					`Grill: ${name} couldn't be read (corrupted JSON) and has been reset. ` +
						`The unreadable file was kept alongside it as a .corrupt backup in case it's recoverable.`,
					12000,
				);
			} catch {
				/* best-effort backup — see doc comment above */
			}
			return fallback;
		}
	}

	/** Shared JSON save for every store below: write to a sibling `.tmp` path, then
	 * rename it over the real one — POSIX rename() (what desktop's FileSystemAdapter
	 * uses under the hood) atomically replaces an existing destination file with no
	 * window where neither the old nor new content is on disk, so a crash, disk-full,
	 * or sync conflict mid-write hits the `.tmp` file, never the live one, and the
	 * store a user already has stays intact instead of getting truncated in place.
	 * Deliberately does NOT remove() the destination first: doing so would open
	 * exactly the gap this is meant to close (old file gone, new one not yet renamed
	 * into place). Falls back to a direct write (today's prior behavior, no worse
	 * than before) if the platform's adapter doesn't cooperate with rename-over-
	 * existing-file for any reason (e.g. some mobile filesystem backends). */
	private async saveJSON(path: string, data: string): Promise<void> {
		const tmp = `${path}.tmp`;
		try {
			await this.app.vault.adapter.write(tmp, data);
			await this.app.vault.adapter.rename(tmp, path);
		} catch {
			await this.app.vault.adapter.write(path, data).catch(() => undefined);
			await this.app.vault.adapter.remove(tmp).catch(() => undefined);
		}
	}

	async loadMastery(): Promise<MasteryMap> {
		return normalizeMastery(await this.loadJSON<MasteryMap>(this.masteryPath(), {}));
	}

	async saveMastery(map: MasteryMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.saveJSON(this.masteryPath(), JSON.stringify(map, null, 1));
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
		await this.saveJSON(this.embeddingsPath(), JSON.stringify(map));
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
		await this.saveJSON(normalizePath(`${this.folder()}/graph-layout.json`), JSON.stringify(pos, null, 0));
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
	): Promise<TFile | null> {
		const d = meta.startedAt;
		const pad = (n: number) => String(n).padStart(2, "0");
		// One subfolder per month: a daily-use vault writes a session note every
		// sitting, so a flat Sessions/ folder turns into hundreds of files within a
		// couple of months and floods Obsidian's file explorer, backlinks, and search.
		const monthDir = normalizePath(`${this.folder()}/Sessions/${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
		await this.ensureFolder(this.folder());
		await this.ensureFolder(normalizePath(`${this.folder()}/Sessions`));
		await this.ensureFolder(monthDir);
		const dir = monthDir;
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
		const right = entries.filter((e) => e.verdict === "correct").length;

		const lines: string[] = [
			"---",
			`date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
			`score: ${right}/${entries.length}`,
			`type: ${meta.dueOnly ? "due review" : "study session"}`,
			`provider: ${meta.provider}`,
			`model: ${meta.model}`,
			"---",
			"",
			`# Grill ${meta.dueOnly ? "due review" : "session"} ${stamp}`,
			"",
		];

		if (debrief) {
			lines.push("> [!summary] Debrief", `> ${debrief.headline}`);
			if (debrief.pattern) lines.push(">", `> **Recurring pattern:** ${debrief.pattern}`);
			if (debrief.gaps.length) {
				lines.push(">", "> **To review:**");
				for (const g of debrief.gaps) {
					const noteRef = link ? `[[${g.note}]]` : g.note;
					lines.push(`> - **${g.concept}** (${noteRef}): ${g.why}`);
				}
			}
			if (debrief.nextFocus.length) {
				const focus = debrief.nextFocus.map((n) => (link ? `[[${n}]]` : n)).join(", ");
				lines.push(">", `> **Study next:** ${focus}`);
			}
			lines.push("");
		}
		for (const e of entries) {
			const label = e.gaveUp ? "Skipped" : e.verdict === "correct" ? "Correct" : e.verdict === "partial" ? "Partially correct" : "Incorrect";
			lines.push(link ? `## [[${e.node}]]` : `## ${e.node}`, "", e.question, "");
			if (!e.gaveUp && e.answer) {
				lines.push(`> [!quote] Your answer`, ...e.answer.split("\n").map((l) => `> ${l}`), "");
			}
			lines.push(`**${label}.** ${e.feedback}`, "");
			if (e.verdict !== "correct" && e.modelAnswer) {
				lines.push(`**Expected answer:** ${e.modelAnswer}`, "");
			}
		}

		// Embed the asked questions (full grading rubric intact) so "Redo this quiz" can
		// re-serve them with no model call. Rendered as a button by the grill-redo code
		// block processor; bridge/missing-link questions are one-offs, so they're excluded.
		const redo = redoQuestions
			.filter((q) => !q.missingLink)
			.map((q) => ({
				node: q.node,
				conceptId: q.conceptId,
				question: q.question,
				difficulty: q.difficulty,
				modelAnswer: q.modelAnswer,
				acceptableAnswers: q.acceptableAnswers,
				commonErrors: q.commonErrors,
				hints: q.hints,
				...(q.authored ? { authored: true, rubric: q.rubric } : {}),
				...(q.targetsMisconception ? { targetsMisconception: q.targetsMisconception } : {}),
				...(q.type && q.type !== "write"
					? { type: q.type, choices: q.choices, correctChoices: q.correctChoices, pairs: q.pairs }
					: {}),
			}));
		if (redo.length) {
			lines.push("## Redo", "", "```grill-redo", JSON.stringify({ v: 1, questions: redo }), "```", "");
		}

		let path = normalizePath(`${dir}/${stamp}.md`);
		if (await this.app.vault.adapter.exists(path)) {
			path = normalizePath(`${dir}/${stamp}.${pad(d.getSeconds())}.md`);
		}
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
		const dateFromName = /(\d{4}-\d{2}-\d{2}) \d{2}\.\d{2}(?:\.\d{2})?\.md$/;
		const headlineFromBody = /^> \[!summary\] Debrief\n> (.+)$/m;
		const prefix = normalizePath(`${this.folder()}/Sessions`) + "/";
		const byDate = new Map<string, TFile>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const m = dateFromName.exec(f.name);
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
