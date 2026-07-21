/** Quiz session side panel. */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type GrillPlugin from "./main";
import { generateQuestions, gradeAnswer, Question, Verdict } from "./llm";
import { masteryPromptBlock, pickCandidates, recordAnswer, statusOf } from "./mastery";
import { SessionEntry } from "./store";

export const VIEW_TYPE = "grill-session";

const NOTE_CHAR_CAP = 4000;

interface QuestionResult extends SessionEntry {
	hintsUsed: number;
}

export class SessionView extends ItemView {
	plugin: GrillPlugin;
	private noteText: Record<string, string> = {};
	private byName = new Map<string, TFile>();
	/** When set, sessions draw only from these files (Grill this note/folder). */
	sessionScope: TFile[] | null = null;
	private questions: Question[] = [];
	private results: QuestionResult[] = [];
	private idx = 0;
	private sessionStart = new Date();

	constructor(leaf: WorkspaceLeaf, plugin: GrillPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Grill";
	}
	getIcon(): string {
		return "flame";
	}

	async onOpen(): Promise<void> {
		this.renderStart();
	}

	private root(): HTMLElement {
		const el = this.contentEl;
		el.empty();
		el.addClass("grill-view");
		const wrap = el.createDiv({ cls: "grill-wrap" });
		wrap.toggleClass("grill-compact", this.plugin.data.settings.compact);
		return wrap;
	}

	private md(markdown: string, el: HTMLElement): void {
		void MarkdownRenderer.render(this.app, markdown, el, "", this);
	}

	private openNote(name: string): void {
		void this.app.workspace.openLinkText(name, "", false);
	}

	// ------------------------------------------------------------ screens

	private renderStart(): void {
		const wrap = this.root();
		const map = this.plugin.mastery;
		const files = this.mdFiles();
		const counts = { untested: 0, struggling: 0, known: 0 };
		for (const f of files) counts[statusOf(map[f.basename])]++;
		wrap.createDiv({
			cls: "grill-meta",
			text: `${files.length} notes: ${counts.known} known, ${counts.struggling} struggling, ${counts.untested} untested`,
		});
		const btn = wrap.createEl("button", { text: "Start session", cls: "mod-cta grill-start-btn" });
		btn.onclick = () => {
			this.sessionScope = null;
			void this.startSession();
		};

		const recent = this.recentSessions();
		if (recent.length) {
			wrap.createDiv({ cls: "grill-section-label", text: "Recent sessions" });
			const list = wrap.createDiv({ cls: "grill-recent" });
			for (const f of recent) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				const row = list.createDiv({ cls: "grill-recent-row" });
				row.createSpan({ text: f.basename });
				if (fm?.score) row.createSpan({ cls: "grill-meta", text: String(fm.score) });
				row.onclick = () => void this.app.workspace.getLeaf(false).openFile(f);
			}
		}
	}

	private recentSessions(): TFile[] {
		const dir = `${this.plugin.data.settings.folder}/Sessions/`;
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(dir))
			.sort((a, b) => b.stat.ctime - a.stat.ctime)
			.slice(0, 5);
	}

	private renderLoading(title: string, detail: string): void {
		const wrap = this.root();
		const box = wrap.createDiv({ cls: "grill-loading" });
		box.createDiv({ cls: "grill-spinner" });
		box.createEl("p", { text: title, cls: "grill-loading-title" });
		box.createEl("p", { text: detail, cls: "grill-meta" });
	}

	private progressBar(wrap: HTMLElement): void {
		if (!this.plugin.data.settings.showProgress) return;
		const bar = wrap.createDiv({ cls: "grill-progress" });
		for (let i = 0; i < this.questions.length; i++) {
			const seg = bar.createDiv({ cls: "grill-seg" });
			const r = this.results[i];
			if (r) {
				seg.addClass(
					r.gaveUp ? "grill-seg-skipped" : r.verdict === "correct" ? "grill-seg-correct" : r.verdict === "partial" ? "grill-seg-partial" : "grill-seg-incorrect",
				);
			} else if (i === this.idx) {
				seg.addClass("grill-seg-current");
			}
		}
	}

	private renderQuestion(): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const q = this.questions[this.idx];
		const card = wrap.createDiv({ cls: "grill-body" });
		const meta = card.createDiv({ cls: "grill-meta-row" });
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.questions.length}` });
		if (!this.plugin.data.settings.hideNoteName) meta.createSpan({ cls: "grill-chip", text: q.node });
		const qEl = card.createDiv({ cls: "grill-question" });
		this.md(q.question, qEl);

		const hintBox = card.createDiv({ cls: "grill-hintbox" });
		let hintsUsed = 0;
		const hints = [q.hints.tier1, q.hints.tier2, q.hints.tier3].filter(Boolean);

		const ta = card.createEl("textarea", {
			cls: "grill-answer",
			attr: { rows: "5", placeholder: "Answer from memory... (Cmd/Ctrl+Enter to submit)" },
		});
		const row = card.createDiv({ cls: "grill-btn-row" });
		const submit = row.createEl("button", { text: "Submit", cls: "mod-cta" });
		const hintBtn = row.createEl("button", { text: "Hint" });
		const skip = row.createEl("button", { text: "I don't know", cls: "grill-quiet-btn" });

		hintBtn.onclick = () => {
			if (hintsUsed < hints.length) {
				const h = hintBox.createDiv({ cls: "grill-hint" });
				this.md(`*Hint ${hintsUsed + 1}:* ${hints[hintsUsed]}`, h);
				hintsUsed += 1;
				if (hintsUsed >= hints.length) hintBtn.disabled = true;
			}
		};
		const doSubmit = (giveUp: boolean) => void this.submitAnswer(giveUp ? "" : ta.value.trim(), giveUp, hintsUsed);
		submit.onclick = () => doSubmit(false);
		skip.onclick = () => doSubmit(true);
		ta.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doSubmit(false);
		});
		ta.focus();
	}

	private verdictLabel(r: QuestionResult): { text: string; cls: string } {
		if (r.gaveUp) return { text: "Skipped, marked for review", cls: "grill-v-skipped" };
		if (r.verdict === "correct") return { text: "Correct", cls: "grill-v-correct" };
		if (r.verdict === "partial") return { text: "Partially correct", cls: "grill-v-partial" };
		return { text: "Incorrect", cls: "grill-v-incorrect" };
	}

	private renderFeedback(r: QuestionResult): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const card = wrap.createDiv({ cls: "grill-body" });
		const meta = card.createDiv({ cls: "grill-meta-row" });
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.questions.length}` });
		const chip = meta.createSpan({ cls: "grill-chip grill-chip-link", text: r.node });
		chip.onclick = () => this.openNote(r.node);
		chip.setAttr("aria-label", "Open note");

		const qEl = card.createDiv({ cls: "grill-question grill-question-small" });
		this.md(r.question, qEl);

		const v = this.verdictLabel(r);
		card.createDiv({ cls: `grill-verdict ${v.cls}`, text: v.text });
		if (!r.gaveUp && r.answer) {
			const ans = card.createDiv({ cls: "grill-your-answer" });
			this.md(`> ${r.answer.split("\n").join("\n> ")}`, ans);
		}
		if (r.feedback) {
			const fb = card.createDiv({ cls: "grill-feedback" });
			this.md(r.feedback, fb);
		}
		if (r.verdict !== "correct" && r.modelAnswer) {
			const ma = card.createDiv({ cls: "grill-model-answer" });
			this.md(`**Expected answer:** ${r.modelAnswer}`, ma);
		}

		const btn = card.createEl("button", {
			text: this.idx + 1 < this.questions.length ? "Next question" : "Finish session",
			cls: "mod-cta",
		});
		btn.onclick = () => {
			this.idx += 1;
			if (this.idx < this.questions.length) this.renderQuestion();
			else void this.finishSession();
		};
		btn.focus();
	}

	private async finishSession(): Promise<void> {
		const cfg = this.plugin.llmConfig();
		const note = await this.plugin.store.writeSessionNote(
			this.results,
			{
				provider: cfg?.provider ?? "unknown",
				model: cfg?.model ?? "unknown",
				startedAt: this.sessionStart,
			},
			this.plugin.data.settings.linkSessions,
		);
		this.renderSummary(note);
	}

	private renderSummary(note: TFile | null): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const card = wrap.createDiv({ cls: "grill-body" });
		const right = this.results.filter((r) => r.verdict === "correct").length;
		card.createDiv({ cls: "grill-score", text: `${right} of ${this.results.length} correct` });

		const list = card.createDiv({ cls: "grill-summary-list" });
		for (const r of this.results) {
			const row = list.createDiv({ cls: "grill-summary-row" });
			const v = this.verdictLabel(r);
			row.createSpan({ cls: `grill-dot ${v.cls}` });
			const link = row.createSpan({ cls: "grill-chip-link", text: r.node });
			link.onclick = () => this.openNote(r.node);
		}

		if (note) {
			const saved = card.createDiv({ cls: "grill-meta grill-saved" });
			const a = saved.createSpan({ cls: "grill-chip-link", text: "Open session transcript" });
			a.onclick = () => void this.app.workspace.getLeaf(false).openFile(note);
		}
		card.createEl("p", {
			cls: "grill-meta",
			text: "Missed and skipped notes come back next session; correct ones return on expanding intervals.",
		});
		const btn = card.createEl("button", { text: "Study again", cls: "mod-cta grill-start-btn" });
		btn.onclick = () => void this.startSession();
	}

	// ------------------------------------------------------------ session logic

	private mdFiles(): TFile[] {
		const folder = this.plugin.data.settings.folder;
		const all = this.sessionScope ?? this.app.vault.getMarkdownFiles();
		return all.filter((f) => !f.path.startsWith(`${folder}/`));
	}

	/** Entry point for "Grill this note/folder": scope the session and start. */
	async startScopedSession(files: TFile[]): Promise<void> {
		this.sessionScope = files;
		await this.startSession();
	}

	private async startSession(): Promise<void> {
		const cfg = this.plugin.llmConfig();
		if (!cfg) {
			new Notice("Grill: set an API key for your provider in plugin settings first.");
			return;
		}
		const s = this.plugin.data.settings;
		const files = this.mdFiles();
		if (files.length === 0) {
			new Notice("Grill: no markdown notes in this vault.");
			return;
		}
		this.sessionStart = new Date();
		this.renderLoading("Preparing your session", "Choosing which notes to quiz you on.");
		try {
			this.plugin.mastery = await this.plugin.store.loadMastery();
			this.byName = new Map(files.map((f) => [f.basename, f]));
			const byName = this.byName;
			const names = pickCandidates([...byName.keys()], this.plugin.mastery, s.maxNotesPerSession);
			this.noteText = {};
			for (const n of names) {
				const raw = await this.app.vault.cachedRead(byName.get(n) as TFile);
				this.noteText[n] = raw.length > NOTE_CHAR_CAP ? raw.slice(0, NOTE_CHAR_CAP) + "\n[truncated]" : raw;
			}
			const notesText = names.map((n) => `=== NOTE: ${n} ===\n${this.noteText[n].trim()}`).join("\n\n");
			const masteryBlock = masteryPromptBlock(this.plugin.mastery, names);
			this.renderLoading(
				"Writing your questions",
				`${cfg.model} is reading ${names.length} notes. This usually takes 10-30 seconds.`,
			);
			this.questions = await generateQuestions(cfg, notesText, masteryBlock, names, s.questionsPerSession);
			this.results = [];
			this.idx = 0;
			this.renderQuestion();
		} catch (e) {
			new Notice(`Grill: ${(e as Error).message}`, 8000);
			this.renderStart();
		}
	}

	private async submitAnswer(answer: string, gaveUp: boolean, hintsUsed: number): Promise<void> {
		const cfg = this.plugin.llmConfig();
		if (!cfg) return;
		const q = this.questions[this.idx];
		let verdict: Verdict;
		let feedback: string;
		let misconceptionTag = "";
		if (gaveUp) {
			// Zero-cost path: the rubric was generated with the question.
			verdict = "incorrect";
			feedback = "No penalty for honesty. Read the expected answer, then the note; this comes back next session.";
		} else {
			this.renderLoading("Grading your answer", "Checking it against your note and the rubric.");
			try {
				const g = await gradeAnswer(cfg, q, this.noteText[q.node] ?? "", answer);
				verdict = g.verdict;
				feedback = g.feedback;
				misconceptionTag = g.misconceptionTag;
			} catch (e) {
				new Notice(`Grill: ${(e as Error).message}`, 8000);
				this.renderQuestion();
				return;
			}
		}
		recordAnswer(this.plugin.mastery, q.node, verdict, misconceptionTag || undefined);
		await this.plugin.store.saveMastery(this.plugin.mastery);
		if (this.plugin.data.settings.writeStatus) {
			const f = this.byName.get(q.node);
			if (f) await this.plugin.store.writeNoteStatus(f, this.plugin.mastery[q.node]);
		}
		this.plugin.refreshStatusBar();
		const r: QuestionResult = {
			node: q.node,
			question: q.question,
			answer,
			verdict,
			gaveUp,
			feedback,
			modelAnswer: q.modelAnswer,
			hintsUsed,
		};
		this.results.push(r);
		this.renderFeedback(r);
	}
}
