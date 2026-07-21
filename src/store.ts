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

	private async ensureFolder(path: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.createFolder(path).catch(() => {});
		}
	}

	async loadMastery(): Promise<MasteryMap> {
		const path = this.masteryPath();
		if (await this.app.vault.adapter.exists(path)) {
			try {
				return normalizeMastery(JSON.parse(await this.app.vault.adapter.read(path)));
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
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm["grill-status"] = statusOf(m);
			if (m?.dueAt) fm["grill-due"] = m.dueAt.slice(0, 10);
			else delete fm["grill-due"];
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
