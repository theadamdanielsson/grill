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

	private static readonly INSTRUCTIONS_CAP = 2000;

	private static readonly INSTRUCTIONS_TEMPLATE = [
		"<!-- Grill reads this file and follows what you write here when it makes and marks",
		"     your questions. Write plain sentences. Delete this comment or leave it: the",
		"     commented part is ignored, only your own text below is sent to the model.",
		"",
		"     Examples you might write:",
		'       "Prefer short numeric problems over definitions."',
		'       "Ask me to explain concepts in my own words."',
		'       "Be strict on exact terminology."',
		'       "Accept bullet-point answers, do not mark me down for phrasing."',
		"     Keep it under a page; long instructions cost more tokens every session. -->",
		"",
		"",
	].join("\n");

	/** The user's question/grading preferences, with the how-to comments stripped and
	 * length-capped. Empty when the file is absent or only the template comment remains. */
	async loadInstructions(): Promise<string> {
		const path = this.instructionsPath();
		if (!(await this.app.vault.adapter.exists(path))) return "";
		try {
			const raw = await this.app.vault.adapter.read(path);
			const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
			return stripped.slice(0, GrillStore.INSTRUCTIONS_CAP);
		} catch {
			return "";
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

	async writeSessionNote(entries: SessionEntry[], meta: SessionMeta, link = true): Promise<TFile | null> {
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
