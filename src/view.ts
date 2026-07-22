/** Quiz session side panel. */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type GrillPlugin from "./main";
import { generateQuestions, gradeAnswer, Question, supportsVision, Verdict } from "./llm";
import { generateLocalQuestions } from "./generate-local";
import { collectNoteImages, ImageInput } from "./images";
import { masteryPromptBlock, pickCandidates, Rating, recordAnswer, recordRating, statusOf } from "./mastery";
import { SessionEntry } from "./store";

export const VIEW_TYPE = "grill-session";

const NOTE_CHAR_CAP = 4000;
/** Questions generated per model call. Small batches cut the wait before the
 * first question and let the next batch prefetch while the user answers. */
const BATCH = 2;
/** Most images to pull from a single note, and across a whole session's context,
 * so a screenshot-heavy vault doesn't run up a huge image-token bill. */
const IMAGES_PER_NOTE_CAP = 4;
const CONTEXT_IMAGE_CAP = 12;

interface QuestionResult extends SessionEntry {
	hintsUsed: number;
}

export class SessionView extends ItemView {
	plugin: GrillPlugin;
	private noteText: Record<string, string> = {};
	private byName = new Map<string, TFile>();
	/** When set, sessions draw only from these files (Grill this note/folder). */
	sessionScope: TFile[] | null = null;

	private results: QuestionResult[] = [];
	private idx = 0;
	private sessionStart = new Date();

	// Streaming generation state.
	private questions: Question[] = [];
	private targetCount = 0;
	private askedNodes = new Set<string>();
	private candidateNames: string[] = [];
	private notesConcat = "";
	private masteryBlock = "";
	/** Images per note, resolved once when a vision model is in use. */
	private noteImages: Record<string, ImageInput[]> = {};
	/** Flat image list for question generation (all notes in the session). */
	private contextImages: ImageInput[] = [];
	/** The user's question/grading preferences (Grill/Instructions.md), if any. */
	private sessionInstructions = "";
	/** In-flight batch generation, if any. */
	private pending: Promise<void> | null = null;

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
		for (let i = 0; i < this.targetCount; i++) {
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
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.targetCount}` });
		if (!this.plugin.data.settings.hideNoteName) meta.createSpan({ cls: "grill-chip", text: q.node });
		const qEl = card.createDiv({ cls: "grill-question" });
		this.md(q.question, qEl);

		const selfGrade = this.plugin.data.settings.gradingMode === "self";
		const hintBox = card.createDiv({ cls: "grill-hintbox" });
		let hintsUsed = 0;
		const hints = [q.hints.tier1, q.hints.tier2, q.hints.tier3].filter(Boolean);

		const ta = card.createEl("textarea", {
			cls: "grill-answer",
			attr: {
				rows: "5",
				placeholder: selfGrade
					? "Answer from memory, or just think it through, then reveal... (Cmd/Ctrl+Enter)"
					: "Answer from memory... (Cmd/Ctrl+Enter to submit)",
			},
		});
		const row = card.createDiv({ cls: "grill-btn-row" });
		const submit = row.createEl("button", { text: selfGrade ? "Show answer" : "Submit", cls: "mod-cta" });
		if (hints.length) {
			const hintBtn = row.createEl("button", { text: "Hint" });
			hintBtn.onclick = () => {
				if (hintsUsed < hints.length) {
					const h = hintBox.createDiv({ cls: "grill-hint" });
					this.md(`*Hint ${hintsUsed + 1}:* ${hints[hintsUsed]}`, h);
					hintsUsed += 1;
					if (hintsUsed >= hints.length) hintBtn.disabled = true;
				}
			};
		}
		const skip = row.createEl("button", { text: "I don't know", cls: "grill-quiet-btn" });

		const doAction = (giveUp: boolean) => {
			const answer = giveUp ? "" : ta.value.trim();
			if (selfGrade) this.revealForSelfGrade(answer, giveUp, hintsUsed);
			else void this.submitAnswer(answer, giveUp, hintsUsed);
		};
		submit.onclick = () => doAction(false);
		skip.onclick = () => doAction(true);
		ta.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doAction(false);
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
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.targetCount}` });
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
			text: this.idx + 1 < this.targetCount ? "Next question" : "Finish session",
			cls: "mod-cta",
		});
		btn.onclick = () => void this.goToQuestion(this.idx + 1);
		btn.focus();
	}

	private async finishSession(): Promise<void> {
		const cfg = this.plugin.llmConfig();
		const note = await this.plugin.store.writeSessionNote(
			this.results,
			{
				provider: cfg?.provider ?? (this.plugin.data.settings.questionSource === "local" ? "local" : "unknown"),
				model: cfg?.model ?? (this.plugin.data.settings.gradingMode === "self" ? "self-graded" : "unknown"),
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
		const all = this.sessionScope ?? this.app.vault.getMarkdownFiles();
		return all.filter((f) => !this.plugin.isExcluded(f.path));
	}

	/** Entry point for "Grill this note/folder": scope the session and start. */
	async startScopedSession(files: TFile[]): Promise<void> {
		this.sessionScope = files;
		await this.startSession();
	}

	/** Generate the next batch of questions and append them. At most one batch
	 * runs at a time; concurrent callers share the same in-flight promise. */
	private loadNextBatch(): Promise<void> {
		if (this.pending) return this.pending;
		if (this.questions.length >= this.targetCount) return Promise.resolve();
		const cfg = this.plugin.llmConfig();
		if (!cfg) return Promise.resolve();
		const count = Math.min(BATCH, this.targetCount - this.questions.length);
		const fresh = this.candidateNames.filter((n) => !this.askedNodes.has(n));
		const pool = fresh.length >= count ? fresh : this.candidateNames;
		const run = async (): Promise<void> => {
			try {
				const qs = await generateQuestions(
					cfg,
					this.notesConcat,
					this.masteryBlock,
					pool,
					count,
					this.contextImages,
					this.sessionInstructions,
				);
				for (const q of qs) {
					this.questions.push(q);
					this.askedNodes.add(q.node);
				}
			} finally {
				this.pending = null;
			}
		};
		this.pending = run();
		return this.pending;
	}

	/** Move to question `idx`, generating it (and prefetching the next) as needed. */
	private async goToQuestion(idx: number): Promise<void> {
		if (idx >= this.targetCount) {
			await this.finishSession();
			return;
		}
		this.idx = idx;
		while (this.questions.length <= idx) {
			const before = this.questions.length;
			this.renderLoading("Writing your next question", "Just a moment.");
			try {
				await this.loadNextBatch();
			} catch (e) {
				new Notice(`Grill: ${(e as Error).message}`, 8000);
				this.renderStart();
				return;
			}
			if (this.questions.length === before) break; // model produced nothing more
		}
		if (idx >= this.questions.length) {
			// Could not generate enough questions; finish with what we have.
			await this.finishSession();
			return;
		}
		this.renderQuestion();
		if (this.questions.length < this.targetCount) void this.loadNextBatch().catch(() => undefined);
	}

	private async startSession(): Promise<void> {
		const s = this.plugin.data.settings;
		const needsKey = s.questionSource === "ai" || s.gradingMode === "ai";
		const cfg = this.plugin.llmConfig();
		if (needsKey && !cfg) {
			new Notice(
				"Grill: set an API key in settings, or switch questions and grading to the no-key options.",
				8000,
			);
			return;
		}
		const files = this.mdFiles();
		if (files.length === 0) {
			new Notice("Grill: no markdown notes in this vault.");
			return;
		}
		this.sessionStart = new Date();
		this.renderLoading("Preparing your session", "Choosing which notes to quiz you on.");
		try {
			this.plugin.mastery = await this.plugin.store.loadMastery();
			this.sessionInstructions = await this.plugin.store.loadInstructions();
			this.byName = new Map(files.map((f) => [f.basename, f]));
			const byName = this.byName;
			const names = pickCandidates([...byName.keys()], this.plugin.mastery, s.maxNotesPerSession);
			const vision = !!cfg && s.questionSource === "ai" && s.sendImages && supportsVision(cfg.provider, cfg.model);
			this.noteText = {};
			this.noteImages = {};
			this.contextImages = [];
			let notesWithImages = 0;
			for (const n of names) {
				const file = byName.get(n);
				if (!file) continue;
				const raw = await this.app.vault.cachedRead(file);
				this.noteText[n] = raw.length > NOTE_CHAR_CAP ? raw.slice(0, NOTE_CHAR_CAP) + "\n[truncated]" : raw;
				if (vision) {
					const imgs = await collectNoteImages(this.app, file, IMAGES_PER_NOTE_CAP);
					if (imgs.length) {
						notesWithImages++;
						this.noteImages[n] = imgs;
						this.contextImages.push(...imgs.slice(0, Math.max(0, CONTEXT_IMAGE_CAP - this.contextImages.length)));
					}
				} else if (this.app.metadataCache.getFileCache(file)?.embeds?.length) {
					notesWithImages++;
				}
			}

			this.candidateNames = names;
			this.notesConcat = names.map((n) => `=== NOTE: ${n} ===\n${this.noteText[n].trim()}`).join("\n\n");
			if (!vision && notesWithImages > 0 && s.questionSource === "ai") {
				this.notesConcat +=
					"\n\nNote: some of these notes embed images that cannot be shown to this model. " +
					"Do not write questions that depend on reading an image; quiz only on the text above.";
			}
			this.masteryBlock = masteryPromptBlock(this.plugin.mastery, names);
			this.questions = [];
			this.askedNodes = new Set();
			this.results = [];
			this.idx = 0;
			this.pending = null;
			this.targetCount = Math.max(1, s.questionsPerSession);

			if (s.questionSource === "local") {
				// No model: build every question up front from the notes' structure.
				const pool = names.map((n) => ({ name: n, text: this.noteText[n] ?? "" }));
				this.questions = generateLocalQuestions(pool, this.targetCount);
				if (this.questions.length === 0) {
					new Notice(
						"Grill: couldn't build questions from these notes' structure. Add some bold terms, " +
							"headings, definitions or formulas, or switch questions to AI.",
						10000,
					);
					this.renderStart();
					return;
				}
				this.targetCount = Math.min(this.targetCount, this.questions.length);
				for (const q of this.questions) this.askedNodes.add(q.node);
				this.renderQuestion();
				return;
			}

			this.renderLoading("Writing your questions", `${cfg!.model} is reading ${names.length} notes. This usually takes a few seconds.`);
			await this.loadNextBatch();
			if (this.questions.length === 0) {
				new Notice("Grill: the model returned no usable questions.", 8000);
				this.renderStart();
				return;
			}
			this.renderQuestion();
			if (this.questions.length < this.targetCount) void this.loadNextBatch().catch(() => undefined);
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
				const g = await gradeAnswer(
					cfg,
					q,
					this.noteText[q.node] ?? "",
					answer,
					this.noteImages[q.node] ?? [],
					this.sessionInstructions,
				);
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

	/** Self-grade path: reveal the answer, then let the user rate their own recall. */
	private revealForSelfGrade(answer: string, gaveUp: boolean, hintsUsed: number): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const q = this.questions[this.idx];
		const card = wrap.createDiv({ cls: "grill-body" });
		const meta = card.createDiv({ cls: "grill-meta-row" });
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.targetCount}` });
		const chip = meta.createSpan({ cls: "grill-chip grill-chip-link", text: q.node });
		chip.onclick = () => this.openNote(q.node);
		chip.setAttr("aria-label", "Open note");

		const qEl = card.createDiv({ cls: "grill-question grill-question-small" });
		this.md(q.question, qEl);

		if (!gaveUp && answer) {
			const ans = card.createDiv({ cls: "grill-your-answer" });
			this.md(`> ${answer.split("\n").join("\n> ")}`, ans);
		}

		const ma = card.createDiv({ cls: "grill-model-answer" });
		this.md(`**Answer:** ${q.modelAnswer}`, ma);

		card.createDiv({ cls: "grill-meta grill-selfgrade-prompt", text: "How did you do?" });
		const rateRow = card.createDiv({ cls: "grill-btn-row grill-selfgrade-row" });
		const buttons: { label: string; rating: Rating; cls: string }[] = [
			{ label: "Again", rating: 1, cls: "grill-rate-again" },
			{ label: "Hard", rating: 2, cls: "grill-rate-hard" },
			{ label: "Good", rating: 3, cls: "grill-rate-good" },
			{ label: "Easy", rating: 4, cls: "grill-rate-easy" },
		];
		// If they gave up, nudge toward Again but leave the choice to them.
		for (const b of buttons) {
			const el = rateRow.createEl("button", { text: b.label, cls: `grill-rate-btn ${b.cls}` });
			if (gaveUp && b.rating === 1) el.addClass("mod-cta");
			el.onclick = () => void this.recordSelfGrade(b.rating, answer, gaveUp, hintsUsed);
		}
	}

	private async recordSelfGrade(rating: Rating, answer: string, gaveUp: boolean, hintsUsed: number): Promise<void> {
		const q = this.questions[this.idx];
		const verdict: Verdict = rating === 1 ? "incorrect" : rating === 2 ? "partial" : "correct";
		recordRating(this.plugin.mastery, q.node, rating);
		await this.plugin.store.saveMastery(this.plugin.mastery);
		if (this.plugin.data.settings.writeStatus) {
			const f = this.byName.get(q.node);
			if (f) await this.plugin.store.writeNoteStatus(f, this.plugin.mastery[q.node]);
		}
		this.plugin.refreshStatusBar();
		this.results.push({
			node: q.node,
			question: q.question,
			answer,
			verdict,
			gaveUp,
			feedback: "",
			modelAnswer: q.modelAnswer,
			hintsUsed,
		});
		await this.goToQuestion(this.idx + 1);
	}
}
