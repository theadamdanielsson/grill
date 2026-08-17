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

/** A generated question cached for reuse. `sourceHash` ties it to the concept's
 * source text at generation time; a mismatch means the note changed and the entry
 * is stale. Reused across reviews so a due concept isn't re-generated every time. */
export interface CachedQuestion extends Question {
	sourceHash: string;
	lastShownAt?: string;
	timesShown: number;
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

	private static readonly INSTRUCTIONS_CAP = 2000;

	/** Total characters of referenced-note text that [[wikilinks]] in the
	 * instructions may inline, shared across the whole file, so a linked style guide
	 * can't inflate every session's prompt without bound. */
	private static readonly INSTRUCTIONS_CONTEXT_CAP = 4000;

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
			let persona = "";
			let preferences = "";
			// Legacy file with no section headings: treat the whole thing as preferences.
			if (pIdx === -1 && fIdx === -1) {
				preferences = safeSlice(strip(raw), cap);
			} else {
				if (pIdx !== -1) {
					const end = fIdx > pIdx ? fIdx : raw.length;
					persona = safeSlice(strip(raw.slice(pIdx + "## persona".length, end)), cap);
				}
				if (fIdx !== -1) {
					const end = pIdx > fIdx ? pIdx : raw.length;
					preferences = safeSlice(strip(raw.slice(fIdx + "## preferences".length, end)), cap);
				}
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
