/** Quiz session side panel. */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type GrillPlugin from "./main";
import { ConceptTarget, debriefSession, generateQuestions, gradeAnswer, Question, supportsVision, Verdict } from "./llm";
import { Concept, extractConcepts, localQuestions } from "./generate-local";
import {
	ConceptMap,
	conceptTargetDifficulty,
	noteAggregate,
	pickConcepts,
	recordConceptAnswer,
	recordConceptRating,
	reconcileConcepts,
} from "./concepts";
import { collectNoteImages, ImageInput } from "./images";
import { NoteMastery, pickCandidates, Rating, recordNoteStats, statusOf } from "./mastery";
import { buildSessionGraph, expandSelectionWithLinks, formatLinksBlock, outgoingBasenames } from "./links";
import {
	activeMisconceptionsByNote,
	deterministicDebrief,
	mergeAssignments,
	MisconceptionRegistry,
	resolveMisconception,
	SessionDebrief,
	topMisconceptions,
} from "./debrief";
import { decodeScope, dueFiles, encodeScope, filesForScope, listFolders, listTags } from "./scope";
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
	/** Raw grader misconception tag, if any; consumed by the end-of-session debrief. */
	misconceptionTag?: string;
}

export class SessionView extends ItemView {
	plugin: GrillPlugin;
	private noteText: Record<string, string> = {};
	private byName = new Map<string, TFile>();
	/** When set, sessions draw only from these files (Grill this note/folder). */
	sessionScope: TFile[] | null = null;
	/** Scope chosen on the start screen; null means the whole vault. */
	private pendingScope: TFile[] | null = null;

	private results: QuestionResult[] = [];
	private idx = 0;
	private sessionStart = new Date();

	// Streaming generation state.
	private questions: Question[] = [];
	private targetCount = 0;
	private notesConcat = "";
	/** Relationships between the session's notes, from their links. */
	private linksBlock = "";
	/** Canonical misconception registry, held for the session (re-probe + resolve). */
	private registry: MisconceptionRegistry = {};
	/** Per-concept scheduling state (the source of truth for scheduling). */
	private concepts: ConceptMap = {};
	/** Each selected note's current concepts, for recomputing its aggregate. */
	private conceptsByNote = new Map<string, Concept[]>();
	/** The concepts this session tests, in order. */
	private sessionConcepts: Concept[] = [];
	/** Concept targets for the AI generator (one question each, by construction). */
	private targets: ConceptTarget[] = [];
	/** Session state changed in memory and needs flushing to disk. Writes are
	 * batched to session end / pane close to avoid a per-answer sync storm. */
	private dirty = false;
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

	/** All notes eligible for quizzing, ignoring the current session scope. */
	private allEligible(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => !this.plugin.isExcluded(f.path));
	}

	private renderStart(): void {
		const wrap = this.root();
		const map = this.plugin.mastery;
		const eligible = this.allEligible();
		this.pendingScope = null;

		const countsEl = wrap.createDiv({ cls: "grill-meta" });
		const showCounts = (files: TFile[]): void => {
			const counts = { untested: 0, struggling: 0, known: 0 };
			for (const f of files) counts[statusOf(map[f.basename])]++;
			countsEl.setText(
				`${files.length} notes: ${counts.known} known, ${counts.struggling} struggling, ${counts.untested} untested`,
			);
		};
		showCounts(eligible);

		// Highest-intent action first: one tap straight into the due queue. Mobile
		// has no status bar, so this is the due signal there too.
		const due = dueFiles(eligible, map);
		if (due.length) {
			const cta = wrap.createEl("button", { text: `Review ${due.length} due now`, cls: "mod-cta grill-due-cta" });
			cta.onclick = () => {
				this.sessionScope = due;
				void this.startSession();
			};
		}

		// Scope selector: whole vault / current note / a folder / a tag.
		const scopeRow = wrap.createDiv({ cls: "grill-scope" });
		scopeRow.createSpan({ cls: "grill-meta", text: "Study" });
		const sel = scopeRow.createEl("select", { cls: "dropdown grill-scope-select" });
		sel.createEl("option", { value: "all", text: "Whole vault" });

		if (due.length) {
			sel.createEl("option", { value: encodeScope({ kind: "due", id: "" }), text: `Due cards only (${due.length})` });
		}

		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === "md" && !this.plugin.isExcluded(active.path)) {
			sel.createEl("option", { value: encodeScope({ kind: "note", id: active.path }), text: `Current note: ${active.basename}` });
		}

		const folders = listFolders(eligible);
		if (folders.length) {
			const g = sel.createEl("optgroup");
			g.label = "Folders";
			for (const path of folders) g.createEl("option", { value: encodeScope({ kind: "folder", id: path }), text: path });
		}
		const tags = listTags(this.app);
		if (tags.length) {
			const g = sel.createEl("optgroup");
			g.label = "Tags";
			for (const t of tags) g.createEl("option", { value: encodeScope({ kind: "tag", id: t.tag }), text: `${t.tag} (${t.count})` });
		}

		sel.onchange = () => {
			const scope = decodeScope(sel.value);
			if (scope.kind === "all") {
				this.pendingScope = null;
				showCounts(eligible);
			} else {
				const files = filesForScope(this.app, scope, eligible, map);
				this.pendingScope = files;
				showCounts(files);
			}
		};

		const btn = wrap.createEl("button", { text: "Start session", cls: "mod-cta grill-start-btn" });
		btn.onclick = () => {
			this.sessionScope = this.pendingScope;
			void this.startSession();
		};

		const dash = wrap.createDiv({ cls: "grill-meta grill-dash-link" });
		const dashLink = dash.createSpan({ cls: "grill-chip-link", text: "View your progress" });
		dashLink.onclick = () => this.showDashboard();

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

	// ------------------------------------------------------------ dashboard

	/** Open the progress dashboard (called by the command and start-screen link). */
	showDashboard(): void {
		void this.renderDashboard();
	}

	private async renderDashboard(): Promise<void> {
		const wrap = this.root();
		const map = this.plugin.mastery;
		const eligible = this.allEligible();

		const head = wrap.createDiv({ cls: "grill-meta-row" });
		head.createSpan({ cls: "grill-score", text: "Your progress" });
		const back = head.createSpan({ cls: "grill-chip-link", text: "Back" });
		back.onclick = () => this.renderStart();

		// Stats derived from mastery.json.
		const counts = { untested: 0, struggling: 0, known: 0 };
		let correct = 0, answered = 0, dueWeek = 0;
		const now = Date.now();
		const weekMs = 7 * 86400_000;
		for (const f of eligible) {
			const m = map[f.basename];
			counts[statusOf(m)]++;
			if (m) {
				correct += m.correct;
				answered += m.correct + m.partial + m.incorrect;
				if (m.dueAt) {
					const d = new Date(m.dueAt).getTime();
					if (d > now && d <= now + weekMs) dueWeek++;
				}
			}
		}
		const dueNow = dueFiles(eligible, map).length;
		const accuracy = answered ? Math.round((100 * correct) / answered) : 0;

		const stats = wrap.createDiv({ cls: "grill-stats" });
		const stat = (label: string, value: string): void => {
			const s = stats.createDiv({ cls: "grill-stat" });
			s.createDiv({ cls: "grill-stat-value", text: value });
			s.createDiv({ cls: "grill-stat-label grill-meta", text: label });
		};
		stat("due now", String(dueNow));
		stat("due this week", String(dueWeek));
		stat("known", String(counts.known));
		stat("accuracy", answered ? `${accuracy}%` : "—");

		// What you keep getting wrong.
		const reg = await this.plugin.store.loadRegistry();
		const top = topMisconceptions(reg, 100);
		const active = top.filter((c) => c.status === "active");
		const beaten = top.filter((c) => c.status === "resolved");

		wrap.createDiv({ cls: "grill-section-label", text: "What you keep getting wrong" });
		if (!active.length) {
			wrap.createDiv({ cls: "grill-meta", text: "Nothing recurring yet. It builds up as the grader spots patterns." });
		} else {
			const list = wrap.createDiv({ cls: "grill-misc-list" });
			for (const c of active) {
				const row = list.createDiv({ cls: "grill-misc-row" });
				const rowHead = row.createDiv({ cls: "grill-misc-head" });
				rowHead.createSpan({ cls: "grill-misc-label", text: c.label });
				rowHead.createSpan({ cls: "grill-meta", text: `${c.count}×` });
				if (c.notes.length) {
					const notes = row.createDiv({ cls: "grill-misc-notes" });
					for (const n of c.notes.slice(0, 6)) {
						const chip = notes.createSpan({ cls: "grill-chip grill-chip-link", text: n });
						chip.onclick = () => this.openNote(n);
					}
				}
			}
		}
		if (beaten.length) {
			wrap.createDiv({ cls: "grill-meta grill-misc-beaten", text: `Beaten: ${beaten.map((c) => c.label).join(", ")}` });
		}

		// Concept coverage: honest counts from the per-concept scheduler.
		const cmap = await this.plugin.store.loadConcepts();
		const tested = Object.values(cmap).filter((c) => c.correct + c.partial + c.incorrect > 0);
		if (tested.length) {
			const known = tested.filter((c) => statusOf(c) === "known").length;
			wrap.createDiv({ cls: "grill-section-label", text: "Concept coverage" });
			wrap.createDiv({
				cls: "grill-meta",
				text: `${tested.length} concepts tested · ${known} solid · ${tested.length - known} shaky`,
			});
			const byNote = new Map<string, { tested: number; known: number }>();
			for (const c of tested) {
				const e = byNote.get(c.note) ?? { tested: 0, known: 0 };
				e.tested++;
				if (statusOf(c) === "known") e.known++;
				byNote.set(c.note, e);
			}
			const rows = [...byNote.entries()]
				.map(([note, e]) => ({ note, ...e, shaky: e.tested - e.known }))
				.sort((a, b) => b.shaky - a.shaky)
				.slice(0, 6);
			const list = wrap.createDiv({ cls: "grill-summary-list" });
			for (const r of rows) {
				const row = list.createDiv({ cls: "grill-summary-row" });
				const link = row.createSpan({ cls: "grill-chip-link", text: r.note });
				link.onclick = () => this.openNote(r.note);
				row.createSpan({ cls: "grill-meta", text: `${r.known}/${r.tested} solid` });
			}
		}

		this.renderHeatmap(wrap);
	}

	/** GitHub-style grid of reviews done per day, from session-note frontmatter. */
	private renderHeatmap(wrap: HTMLElement): void {
		const pad = (n: number): string => String(n).padStart(2, "0");
		const key = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

		const dir = `${this.plugin.data.settings.folder}/Sessions/`;
		const perDay = new Map<string, number>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(dir)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			const date = typeof fm?.date === "string" ? fm.date : null;
			if (!date) continue;
			const score = typeof fm?.score === "string" ? fm.score : "";
			const total = score.includes("/") ? parseInt(score.split("/")[1], 10) : 1;
			perDay.set(date, (perDay.get(date) ?? 0) + (Number.isNaN(total) ? 1 : total));
		}

		wrap.createDiv({ cls: "grill-section-label", text: "Reviews (last 12 weeks)" });
		const grid = wrap.createDiv({ cls: "grill-heatmap" });
		const today = new Date();
		const level = (c: number): number => (c === 0 ? 0 : c < 3 ? 1 : c < 6 ? 2 : c < 10 ? 3 : 4);
		for (let i = 83; i >= 0; i--) {
			const d = new Date(today.getTime() - i * 86400_000);
			const k = key(d);
			const count = perDay.get(k) ?? 0;
			const cell = grid.createDiv({ cls: `grill-hm-cell grill-hm-${level(count)}` });
			cell.setAttr("aria-label", `${k}: ${count} review${count === 1 ? "" : "s"}`);
			cell.setAttr("title", `${k}: ${count} review${count === 1 ? "" : "s"}`);
		}
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
		const s = this.plugin.data.settings;
		const cfg = this.plugin.llmConfig();
		const usedAI = s.questionSource === "ai" || s.gradingMode === "ai";
		const sessionNodes = [...new Set(this.results.map((r) => r.node))];

		let debrief = deterministicDebrief(this.results);
		if (cfg && usedAI && s.sessionDebrief && sessionNodes.length > 0) {
			this.renderLoading("Writing your debrief", "Summarising how the session went.");
			try {
				const reg = this.registry;
				const rawTags = this.results
					.filter((r) => r.misconceptionTag)
					.map((r) => ({ note: r.node, tag: r.misconceptionTag as string }));
				const transcript = this.results
					.map((r, i) => {
						const verdict = r.gaveUp ? "skipped" : r.verdict;
						const fb = r.feedback ? `\n  feedback: ${r.feedback}` : "";
						return `Q${i + 1} [${r.node}] (${verdict}): ${r.question}\n  answer: ${r.answer || "(none)"}${fb}`;
					})
					.join("\n");
				const existingCanon = Object.values(reg).map((c) => ({ tag: c.tag, label: c.label }));
				const out = await debriefSession(cfg, transcript, sessionNodes, existingCanon, rawTags);
				debrief = out.debrief;
				if (out.assignments.length) {
					mergeAssignments(reg, out.assignments);
					this.dirty = true;
				}
			} catch (e) {
				new Notice(`Grill: debrief unavailable, showing a plain summary. ${(e as Error).message}`, 6000);
				debrief = deterministicDebrief(this.results);
			}
		}

		await this.flush();
		const note = await this.plugin.store.writeSessionNote(
			this.results,
			{
				provider: usedAI && cfg ? cfg.provider : "local",
				model: usedAI && cfg ? cfg.model : "deterministic",
				startedAt: this.sessionStart,
			},
			s.linkSessions,
			debrief,
		);
		this.renderSummary(note, debrief);
	}

	private renderDebrief(card: HTMLElement, debrief: SessionDebrief): void {
		const box = card.createDiv({ cls: "grill-debrief" });
		if (debrief.headline) this.md(debrief.headline, box.createDiv({ cls: "grill-debrief-headline" }));
		if (debrief.pattern) {
			const p = box.createDiv({ cls: "grill-debrief-pattern" });
			this.md(`**Recurring pattern:** ${debrief.pattern}`, p);
		}
		if (debrief.gaps.length) {
			const gaps = box.createDiv({ cls: "grill-debrief-gaps" });
			gaps.createDiv({ cls: "grill-meta grill-debrief-label", text: "To review" });
			for (const g of debrief.gaps) {
				const row = gaps.createDiv({ cls: "grill-debrief-gap" });
				this.md(`**${g.concept}** — ${g.why}`, row.createDiv({ cls: "grill-debrief-gap-text" }));
				const chip = row.createSpan({ cls: "grill-chip grill-chip-link", text: g.note });
				chip.onclick = () => this.openNote(g.note);
			}
		}
		if (debrief.strengths.length) {
			const st = box.createDiv({ cls: "grill-debrief-strengths grill-meta" });
			st.createSpan({ text: "Solid: " });
			st.appendText(debrief.strengths.join(", "));
		}
		if (debrief.nextFocus.length) {
			const nf = box.createDiv({ cls: "grill-debrief-next" });
			nf.createSpan({ cls: "grill-meta", text: "Study next: " });
			for (const name of debrief.nextFocus) {
				const chip = nf.createSpan({ cls: "grill-chip grill-chip-link", text: name });
				chip.onclick = () => this.openNote(name);
			}
		}
	}

	private renderSummary(note: TFile | null, debrief?: SessionDebrief): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const card = wrap.createDiv({ cls: "grill-body" });
		const right = this.results.filter((r) => r.verdict === "correct").length;
		card.createDiv({ cls: "grill-score", text: `${right} of ${this.results.length} correct` });

		if (debrief) this.renderDebrief(card, debrief);

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
		const btnRow = card.createDiv({ cls: "grill-btn-row grill-start-btn" });
		const again = btnRow.createEl("button", { text: "Study again", cls: "mod-cta" });
		again.onclick = () => void this.startSession();
		const menu = btnRow.createEl("button", { text: "Back to menu" });
		menu.onclick = () => {
			this.sessionScope = null;
			this.renderStart();
		};
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
		// The scheduler already picked the concepts; generate the next slice of them.
		const batch = this.targets.slice(this.questions.length, this.questions.length + BATCH);
		if (!batch.length) return Promise.resolve();
		const run = async (): Promise<void> => {
			try {
				const qs = await generateQuestions(
					cfg,
					this.notesConcat,
					batch,
					this.contextImages,
					this.sessionInstructions,
					this.linksBlock,
				);
				for (const q of qs) this.questions.push(q);
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
			this.registry = await this.plugin.store.loadRegistry();
			this.sessionInstructions = await this.plugin.store.loadInstructions();
			this.byName = new Map(files.map((f) => [f.basename, f]));
			const byName = this.byName;
			const seed = pickCandidates([...byName.keys()], this.plugin.mastery, s.maxNotesPerSession);
			const names = expandSelectionWithLinks(this.app, seed, byName, this.plugin.mastery, s.maxNotesPerSession);
			const vision = !!cfg && s.questionSource === "ai" && s.sendImages && supportsVision(cfg.provider, cfg.model);
			this.noteText = {};
			this.noteImages = {};
			this.contextImages = [];
			this.conceptsByNote = new Map();
			let notesWithImages = 0;
			for (const n of names) {
				const file = byName.get(n);
				if (!file) continue;
				const raw = await this.app.vault.cachedRead(file);
				// Extract concepts from the FULL note; only the prompt context is truncated.
				this.conceptsByNote.set(n, extractConcepts(n, raw));
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

			this.notesConcat = names.map((n) => `=== NOTE: ${n} ===\n${this.noteText[n].trim()}`).join("\n\n");
			if (!vision && notesWithImages > 0 && s.questionSource === "ai") {
				this.notesConcat +=
					"\n\nNote: some of these notes embed images that cannot be shown to this model. " +
					"Do not write questions that depend on reading an image; quiz only on the text above.";
			}
			const selectedFiles = names.map((n) => byName.get(n)).filter((f): f is TFile => !!f);
			this.linksBlock = formatLinksBlock(buildSessionGraph(this.app, selectedFiles), this.plugin.mastery);

			// Concept layer: reconcile the extracted concepts (create new ones,
			// re-open any whose source text changed), then pick which to test.
			this.concepts = await this.plugin.store.loadConcepts();
			const allConcepts: Concept[] = [];
			for (const cs of this.conceptsByNote.values()) allConcepts.push(...cs);
			reconcileConcepts(this.concepts, allConcepts);

			this.questions = [];
			this.results = [];
			this.idx = 0;
			this.pending = null;
			const want = Math.max(1, s.questionsPerSession);

			// No-key mode can only use concepts that carry a deterministic question.
			const pickable = s.questionSource === "local" ? allConcepts.filter((c) => c.local) : allConcepts;
			this.sessionConcepts = pickConcepts(pickable, this.concepts, want);
			if (this.sessionConcepts.length === 0) {
				new Notice(
					s.questionSource === "local"
						? "Grill: couldn't build questions from these notes' structure. Add some bold terms, headings, definitions or formulas, or switch questions to AI."
						: "Grill: couldn't find concepts to quiz in these notes.",
					10000,
				);
				this.renderStart();
				return;
			}
			this.targetCount = Math.min(want, this.sessionConcepts.length);

			// Concept targets: difficulty tuned to retrievability. Re-probe an active
			// misconception on at most ONE concept per note, so it isn't over-asked.
			const activeByNote = activeMisconceptionsByNote(this.registry, names);
			const misconceptionUsed = new Set<string>();
			this.targets = this.sessionConcepts.slice(0, this.targetCount).map((c) => {
				let activeMisconception: string | undefined;
				if (!misconceptionUsed.has(c.note)) {
					activeMisconception = activeByNote[c.note]?.[0]?.tag;
					if (activeMisconception) misconceptionUsed.add(c.note);
				}
				return {
					conceptId: c.id,
					note: c.note,
					label: c.label,
					context: c.context,
					targetDifficulty: conceptTargetDifficulty(this.concepts[c.id]),
					activeMisconception,
				};
			});

			if (s.questionSource === "local") {
				this.questions = localQuestions(this.sessionConcepts, this.targetCount);
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
		await this.applyGrade(q, verdict, null, misconceptionTag || undefined);
		// Re-probed a known confusion and got it right: mark it resolved.
		if (q.targetsMisconception && verdict === "correct" && this.registry[q.targetsMisconception]) {
			resolveMisconception(this.registry, q.targetsMisconception);
			this.dirty = true;
		}
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
			misconceptionTag: misconceptionTag || undefined,
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

	/** Record one graded answer: update the concept's schedule, bump the note's
	 * stats, recompute the note aggregate, and persist. `rating` is set for the
	 * self-grade path (its Again/Hard/Good/Easy is the signal); null for AI grading
	 * (verdict + question difficulty drive a difficulty-aware rating). */
	private async applyGrade(
		q: Question,
		verdict: Verdict,
		rating: Rating | null,
		misconceptionTag: string | undefined,
	): Promise<void> {
		const cid = q.conceptId;
		if (cid && this.concepts[cid]) {
			if (rating !== null) recordConceptRating(this.concepts, cid, rating);
			else recordConceptAnswer(this.concepts, cid, verdict, q.difficulty ?? "medium");
		}
		recordNoteStats(this.plugin.mastery, q.node, verdict, misconceptionTag);
		this.recomputeAggregate(q.node);
		this.dirty = true; // flushed at session end / pane close
	}

	/** Persist all session state at once (concepts, mastery, registry). Called at
	 * session end and on pane close, not per answer, to avoid sync churn. */
	private async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.plugin.store.saveConcepts(this.concepts);
		await this.plugin.store.saveMastery(this.plugin.mastery);
		await this.plugin.store.saveRegistry(this.registry);
	}

	async onClose(): Promise<void> {
		await this.flush();
	}

	/** Project the note's concept states back into its note-level status + due date,
	 * then apply the graph-aware prerequisite penalty. */
	private recomputeAggregate(note: string): void {
		const m = this.plugin.mastery[note];
		if (!m) return;
		const agg = noteAggregate(this.conceptsByNote.get(note) ?? [], this.concepts);
		m.aggStatus = agg.aggStatus;
		m.dueAt = agg.dueAt;
		this.applyPrereqPenalty(note, m);
	}

	/** A note can't read as "known" while a tested prerequisite it links to is
	 * struggling. Bounded: only tested-weak prerequisites count. */
	private applyPrereqPenalty(note: string, m: NoteMastery): void {
		if (m.aggStatus !== "known") return;
		const file = this.byName.get(note);
		if (!file) return;
		for (const pre of outgoingBasenames(this.app, file)) {
			const pm = this.plugin.mastery[pre];
			if (pm && statusOf(pm) === "struggling") {
				m.aggStatus = "struggling";
				return;
			}
		}
	}

	private async recordSelfGrade(rating: Rating, answer: string, gaveUp: boolean, hintsUsed: number): Promise<void> {
		const q = this.questions[this.idx];
		const verdict: Verdict = rating === 1 ? "incorrect" : rating === 2 ? "partial" : "correct";
		await this.applyGrade(q, verdict, rating, undefined);
		if (q.targetsMisconception && verdict === "correct" && this.registry[q.targetsMisconception]) {
			resolveMisconception(this.registry, q.targetsMisconception);
			this.dirty = true;
		}
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
