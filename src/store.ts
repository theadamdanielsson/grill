/** Vault storage: state is content, secrets are config.
 *
 * - API keys and settings stay in the plugin's data.json (never in synced markdown).
 * - Mastery state lives at `<folder>/mastery.json` in the vault: user-visible,
 *   versionable, survives plugin reinstalls, syncs with the vault.
 * - Each session is written as a markdown note under `<folder>/Sessions/`,
 *   wiki-linked to the quizzed notes so study history shows up in backlinks
 *   and the graph.
 */

import { App, TFile, normalizePath } from "obsidian";
import { MasteryMap, Verdict, normalizeMastery } from "./mastery";
import { DEFAULT_PERSONA, Question } from "./llm";
import { MisconceptionRegistry, SessionDebrief } from "./debrief";
import { ConceptMap } from "./concepts";
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
		"     style, format, difficulty, strictness. Leave blank for the defaults.",
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
				preferences = strip(raw).slice(0, cap);
			} else {
				if (pIdx !== -1) {
					const end = fIdx > pIdx ? fIdx : raw.length;
					persona = strip(raw.slice(pIdx + "## persona".length, end)).slice(0, cap);
				}
				if (fIdx !== -1) {
					const end = pIdx > fIdx ? pIdx : raw.length;
					preferences = strip(raw.slice(fIdx + "## preferences".length, end)).slice(0, cap);
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
			const slice = body.slice(0, budget.left);
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

	private async ensureFolder(path: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.createFolder(path).catch(() => {});
		}
	}

	async loadMastery(): Promise<MasteryMap> {
		const path = this.masteryPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as MasteryMap;
				return normalizeMastery(parsed);
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveMastery(map: MasteryMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(this.masteryPath(), JSON.stringify(map, null, 1));
	}

	/** The canonical misconception registry (recomputable projection over raw tags). */
	async loadRegistry(): Promise<MisconceptionRegistry> {
		const path = this.registryPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return JSON.parse(await this.app.vault.adapter.read(path)) as MisconceptionRegistry;
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveRegistry(reg: MisconceptionRegistry): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(this.registryPath(), JSON.stringify(reg, null, 1));
	}

	/** Per-concept scheduling state (the source of truth for scheduling). */
	async loadConcepts(): Promise<ConceptMap> {
		const path = this.conceptsPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return JSON.parse(await this.app.vault.adapter.read(path)) as ConceptMap;
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveConcepts(map: ConceptMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(this.conceptsPath(), JSON.stringify(map, null, 1));
	}

	/** Missing-link records: which note pairs have been surfaced, answered, or linked. */
	async loadBridges(): Promise<BridgeMap> {
		const path = this.bridgesPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return JSON.parse(await this.app.vault.adapter.read(path)) as BridgeMap;
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveBridges(map: BridgeMap): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(this.bridgesPath(), JSON.stringify(map, null, 1));
	}

	/** Persisted learning-graph node positions, so the map is stable across opens. */
	async loadGraphLayout(): Promise<Record<string, { x: number; y: number }>> {
		const path = normalizePath(`${this.folder()}/graph-layout.json`);
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, { x: number; y: number }>;
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveGraphLayout(pos: Record<string, { x: number; y: number }>): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(
			normalizePath(`${this.folder()}/graph-layout.json`),
			JSON.stringify(pos, null, 0),
		);
	}

	/** Per-concept question bank, reused across reviews so a due concept isn't
	 * re-generated by a fresh API call every time it comes up. */
	async loadQuestionBank(): Promise<QuestionBank> {
		const path = this.questionsPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return JSON.parse(await this.app.vault.adapter.read(path)) as QuestionBank;
			} catch {
				return {};
			}
		}
		return {};
	}

	async saveQuestionBank(map: QuestionBank): Promise<void> {
		await this.ensureFolder(this.folder());
		await this.app.vault.adapter.write(this.questionsPath(), JSON.stringify(map, null, 1));
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
				...(q.type && q.type !== "write" ? { type: q.type, choices: q.choices } : {}),
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
}
