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
import { MasteryMap, NoteMastery, Verdict, normalizeMastery, statusOf } from "./mastery";
import { DEFAULT_PERSONA } from "./llm";
import { MisconceptionRegistry, SessionDebrief } from "./debrief";
import { ConceptMap } from "./concepts";

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

	private static readonly INSTRUCTIONS_CAP = 2000;

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
		"     Keep it short; long text costs more tokens every session. -->",
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
			// Legacy file with no section headings: treat the whole thing as preferences.
			if (pIdx === -1 && fIdx === -1) {
				return { persona: "", preferences: strip(raw).slice(0, cap) };
			}
			let persona = "";
			let preferences = "";
			if (pIdx !== -1) {
				const end = fIdx > pIdx ? fIdx : raw.length;
				persona = strip(raw.slice(pIdx + "## persona".length, end));
			}
			if (fIdx !== -1) {
				const end = pIdx > fIdx ? pIdx : raw.length;
				preferences = strip(raw.slice(fIdx + "## preferences".length, end));
			}
			return { persona: persona.slice(0, cap), preferences: preferences.slice(0, cap) };
		} catch {
			return empty;
		}
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

	/** Opt-in: mirror a note's mastery into its frontmatter so graph groups,
	 * Dataview, and Bases can use it. */
	async writeNoteStatus(file: TFile, m: NoteMastery | undefined): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: unknown) => {
			const frontmatter = fm as Record<string, unknown>;
			frontmatter["grill-status"] = statusOf(m);
			if (m?.dueAt) frontmatter["grill-due"] = m.dueAt.slice(0, 10);
			else delete frontmatter["grill-due"];
		});
	}

	async writeSessionNote(
		entries: SessionEntry[],
		meta: SessionMeta,
		link = true,
		debrief?: SessionDebrief,
	): Promise<TFile | null> {
		const dir = normalizePath(`${this.folder()}/Sessions`);
		await this.ensureFolder(this.folder());
		await this.ensureFolder(dir);

		const d = meta.startedAt;
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
		const right = entries.filter((e) => e.verdict === "correct").length;

		const lines: string[] = [
			"---",
			`date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
			`score: ${right}/${entries.length}`,
			`provider: ${meta.provider}`,
			`model: ${meta.model}`,
			"---",
			"",
			`# Grill session ${stamp}`,
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
