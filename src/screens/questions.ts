/** Manage questions: every question Grill has written and kept, grouped by note and
 * searchable, each one editable in place, with the last misses to retry or have
 * explained. Drawn into the pane by the view, which it reaches through its host. */

import { Notice, type App, type TFile } from "obsidian";
import { lastAnswerMissed, missedConceptIds } from "../concepts";
import type GrillPlugin from "../main";
import type { CachedQuestion, QuestionBank } from "../store";

/** What the screen needs of the pane. */
export interface QuestionsHost {
	app(): App;
	plugin(): GrillPlugin;
	bank(): QuestionBank;
	loadBank(): Promise<void>;
	/** A fresh screen to draw on. */
	root(): HTMLElement;
	md(markdown: string, el: HTMLElement): void;
	saveOrNotice(save: Promise<void>): Promise<boolean>;
	eligible(): TFile[];
	test(files: TFile[], conceptIds: string[]): void;
	explain(file: TFile, ask: string): void;
	back(): void;
}

export class QuestionsScreen {
	/** Which list is shown: what was last answered wrong, or everything. */
	private questionsView: "missed" | "all" | null = null;

	constructor(private host: QuestionsHost) {}

	/** Opened afresh: on the misses when there are any. */
	open(): Promise<void> {
		this.questionsView = null;
		return this.render();
	}

	/** Every cached question in the bank, grouped by note and searchable — lets a bad
	 * AI-generated (or no-key/local) question be fixed in place instead of only ever
	 * deleted via "Bad question" mid-review. Authored `> [!grill]` callouts never enter
	 * `questionBank` (`rememberGenerated` skips `c.authored`); entries `rejected` via
	 * "Bad question" do enter it (kept as tombstones, see reportBadQuestion) but are
	 * filtered out below, so this list reads as just the live generated/cached set. */
	async render(): Promise<void> {
		await this.host.loadBank();
		// Plain (non-arcade) styling: this is a dense form/data screen, not one of the
		// three cabinet screens (onboarding/start/dashboard) — reuses the same
		// theme-aware classes (.grill-body, .grill-answer, .grill-mc-btn, ...) the actual
		// review screen already renders on this same plain ground, rather than fighting
		// the arcade screen's fixed dark CRT palette for a form-heavy UI.
		const wrap = this.host.root();
		const screen = wrap.createDiv({ cls: "grill-body" });
		// The same head as the progress screen: what this is, and the way back.
		const header = screen.createDiv({ cls: "grill-meta-row grill-mgmt-header" });
		header.createSpan({ cls: "grill-score", text: "Questions" });
		const back = header.createSpan({ cls: "grill-chip-link", text: "Back" });
		back.onclick = () => this.host.back();

		// Two views of one list: what was last answered wrong, and everything.
		const eligible = this.host.eligible();
		const eligibleNames = new Set(eligible.map((f) => f.basename));
		const missed = new Set(missedConceptIds(this.host.plugin().concepts, (note) => eligibleNames.has(note), new Date(), false));
		const viewsEl = screen.createDiv({ cls: "grill-home-modes grill-mgmt-views", attr: { role: "group", "aria-label": "Which questions" } });
		const actionsEl = screen.createDiv({ cls: "grill-mgmt-actions" });

		const searchEl = screen.createEl("input", {
			cls: "grill-mgmt-search",
			attr: { type: "text", placeholder: "Search questions..." },
		});
		const listEl = screen.createDiv({ cls: "grill-mgmt-list" });

		type Entry = { conceptId: string; q: CachedQuestion };
		const allEntries: Entry[] = [];
		for (const [conceptId, qs] of Object.entries(this.host.bank())) {
			// Rejected ("Bad question") entries are kept in the bank so their text still
			// steers the model away from restating them, but they read as deleted to the
			// student — hide them here rather than let a "deleted" question keep showing
			// up in Manage questions.
			// Nor is an image that was read and found to have nothing worth hiding: that
			// entry only records that it needn't be read again.
			for (const q of qs) if (!q.rejected && !(q.type === "occlusion" && !q.occlusionRegions?.length)) allEntries.push({ conceptId, q });
		}
		const missedEntries = allEntries.filter((e) => missed.has(e.conceptId));
		if (this.questionsView === null) this.questionsView = missed.size ? "missed" : "all";
		const view = this.questionsView;
		for (const [id, label] of [["missed", `Missed (${missed.size})`], ["all", `All (${allEntries.length})`]] as const) {
			const b = viewsEl.createEl("button", { cls: "grill-home-mode", text: label, attr: { type: "button", "aria-pressed": String(view === id) } });
			b.toggleClass("is-on", view === id);
			b.onclick = () => {
				if (this.questionsView === id) return;
				this.questionsView = id;
				void this.render();
			};
		}
		const filesOf = (ids: Iterable<string>): TFile[] => {
			const notes = new Set([...ids].map((id) => this.host.plugin().concepts[id]?.note));
			return eligible.filter((f) => notes.has(f.basename));
		};
		if (view === "missed" && missed.size) {
			const retry = actionsEl.createEl("button", { text: `Retry all ${missed.size}`, cls: "mod-cta grill-submit-btn" });
			retry.onclick = () => this.host.test(filesOf(missed), [...missed]);
		}
		const shown = view === "missed" ? missedEntries : allEntries;

		let cardSeq = 0;
		const renderList = (): void => {
			listEl.empty();
			const term = searchEl.value.trim().toLowerCase();
			const filtered = term
				? shown.filter(
						(e) => e.q.question.toLowerCase().includes(term) || e.q.modelAnswer.toLowerCase().includes(term),
					)
				: shown;
			if (!filtered.length) {
				const empty = listEl.createDiv({ cls: "grill-mgmt-empty" });
				if (view === "missed" && !shown.length) {
					empty.createDiv({ cls: "grill-mgmt-empty-title", text: missed.size ? "Nothing to show for your misses" : "No misses" });
					empty.createDiv({
						cls: "grill-meta",
						text: missed.size
							? "The questions you last missed aren't kept here: they were written by you in a note, or have been replaced."
							: "Nothing you were last asked is marked wrong or skipped.",
					});
				} else if (shown.length) {
					empty.createDiv({ cls: "grill-mgmt-empty-title", text: `No matches for "${searchEl.value.trim()}"` });
					const clear = empty.createEl("button", { text: "Clear search", cls: "grill-quiet-btn" });
					clear.onclick = () => {
						searchEl.value = "";
						renderList();
					};
				} else {
					empty.createDiv({ cls: "grill-mgmt-empty-title", text: "No questions yet" });
					empty.createDiv({
						cls: "grill-meta",
						text: "The questions Grill writes for you show up here after your first test. Questions you write in a note yourself stay in that note.",
					});
				}
				return;
			}
			const byNote = new Map<string, Entry[]>();
			for (const e of filtered) {
				const arr = byNote.get(e.q.node) ?? [];
				arr.push(e);
				byNote.set(e.q.node, arr);
			}
			for (const note of [...byNote.keys()].sort((a, b) => a.localeCompare(b))) {
				const entries = byNote.get(note)!;
				const group = listEl.createDiv({ cls: "grill-mgmt-group" });
				const groupHeader = group.createDiv({ cls: "grill-mgmt-group-header" });
				groupHeader.createSpan({ text: `${note} (${entries.length})` });
				if (view === "missed") {
					// What to do about a note's misses, without leaving the list.
					const ids = [...new Set(entries.map((e) => e.conceptId))];
					const files = filesOf(ids);
					if (files.length) {
						const acts = groupHeader.createSpan({ cls: "grill-mgmt-group-actions" });
						const explain = acts.createSpan({ cls: "grill-chip-link", text: "Explain" });
						explain.onclick = (e) => {
							e.stopPropagation();
							this.host.explain(files[0], "What have I been getting wrong on this note, and what do I need to understand to fix it?");
						};
						const test = acts.createSpan({ cls: "grill-chip-link", text: `Retry ${ids.length}` });
						test.onclick = (e) => {
							e.stopPropagation();
							this.host.test(files, ids);
						};
					}
				}
				const body = group.createDiv({ cls: "grill-mgmt-group-body" });
				groupHeader.onclick = () => body.toggleClass("grill-mgmt-collapsed", !body.hasClass("grill-mgmt-collapsed"));
				for (const entry of entries) {
					this.renderQuestionCard(body, entry.conceptId, entry.q, cardSeq++);
				}
			}
		};
		searchEl.oninput = () => renderList();
		renderList();
	}

	/** One editable card for a single cached question variant. Mutates `q` (a direct
	 * reference into `this.host.bank()[conceptId]`) and writes the bank to disk on
	 * Save — never touches `sourceHash`/`conceptId`, so cache-validity and FSRS/mastery
	 * scheduling (kept separately, keyed by concept id) are unaffected by an edit, the
	 * same "content changes don't reset progress" precedent reconcileConcepts documents
	 * for authored-note edits. */
	private static readonly MGMT_TYPE_LABELS: Record<string, string> = {
		write: "Write",
		mc: "Multiple choice",
		blank: "Fill in the blank",
		tf: "True/False",
		multi: "Select all",
		match: "Match",
		occlusion: "Image",
	};

	/** Collapsed-by-default shell for one cached question variant: a one-line summary
	 * (type, question preview, meta) that expands into the full editable form on click.
	 * With hundreds of cached questions in a real bank, building every card's textareas
	 * and choice editors up front made the list unusable to scroll — the form itself is
	 * only ever constructed (once, then just shown/hidden) the first time a card is
	 * actually opened. */
	private renderQuestionCard(parent: HTMLElement, conceptId: string, q: CachedQuestion, cardId: number): void {
		const card = parent.createDiv({ cls: "grill-mgmt-card grill-mgmt-card-collapsed" });
		const type = q.type ?? "write";
		const summary = card.createDiv({ cls: "grill-mgmt-card-summary" });
		summary.createSpan({ cls: "grill-chip grill-mgmt-type-chip", text: QuestionsScreen.MGMT_TYPE_LABELS[type] });
		const previewEl = summary.createSpan({ cls: "grill-mgmt-card-preview" });
		this.host.md(q.question, previewEl);
		// How it has gone, from the record on the concept this question tests.
		const cm = this.host.plugin().concepts[conceptId];
		if (cm && cm.correct + cm.partial + cm.incorrect > 0) {
			const missedLast = lastAnswerMissed(cm);
			summary.createSpan({
				cls: `grill-mgmt-card-record${missedLast ? " grill-v-incorrect" : ""}`,
				text: `${cm.correct} right, ${cm.incorrect} missed${missedLast ? " · missed last" : ""}`,
			});
		}
		const body = card.createDiv({ cls: "grill-mgmt-card-body" });
		let built = false;
		summary.onclick = () => {
			const collapsed = card.hasClass("grill-mgmt-card-collapsed");
			if (collapsed && !built) {
				built = true;
				this.buildCardBody(card, body, previewEl, conceptId, q, cardId, type);
			}
			card.toggleClass("grill-mgmt-card-collapsed", !collapsed);
		};
	}

	/** The actual editable form for a card, built lazily on first expand (see
	 * `renderQuestionCard`). Mutates `q` (a direct reference into
	 * `this.host.bank()[conceptId]`) and writes the bank to disk on Save — never
	 * touches `sourceHash`/`conceptId`, so cache-validity and FSRS/mastery scheduling
	 * (kept separately, keyed by concept id) are unaffected by an edit, the same
	 * "content changes don't reset progress" precedent reconcileConcepts documents for
	 * authored-note edits. */
	private buildCardBody(
		card: HTMLElement,
		body: HTMLElement,
		previewEl: HTMLElement,
		conceptId: string,
		q: CachedQuestion,
		cardId: number,
		type: string,
	): void {
		const meta = body.createDiv({ cls: "grill-meta grill-mgmt-card-meta" });
		meta.setText(
			`shown ${q.timesShown}×` + (q.lastShownAt ? ` · last ${new Date(q.lastShownAt).toLocaleDateString()}` : ""),
		);

		const field = (label: string, value: string, multiline: boolean): HTMLTextAreaElement | HTMLInputElement => {
			body.createDiv({ cls: "grill-block-label", text: label });
			const el = multiline
				? body.createEl("textarea", { cls: "grill-answer grill-mgmt-field" })
				: body.createEl("input", { cls: "grill-mgmt-field", attr: { type: "text" } });
			el.value = value;
			return el;
		};

		const qEl = field("Question", q.question, true) as HTMLTextAreaElement;
		let answerEl: HTMLTextAreaElement | null = null;
		let getChoices: (() => string[]) | null = null;
		let getCorrect: (() => string[]) | null = null;
		let getPairs: (() => { left: string; right: string }[]) | null = null;
		let tfAnswer = /^true$/i.test(q.modelAnswer.trim()) ? "True" : "False";

		if (type === "tf") {
			body.createDiv({ cls: "grill-block-label", text: "Correct answer" });
			const tfRow = body.createDiv({ cls: "grill-mc-row grill-mc-row-tf" });
			for (const choice of ["True", "False"]) {
				const b = tfRow.createEl("button", { text: choice, cls: "grill-mc-btn grill-tf-btn" });
				b.toggleClass("is-selected", tfAnswer === choice);
				b.onclick = () => {
					tfAnswer = choice;
					tfRow.querySelectorAll("button").forEach((x) => x.removeClass("is-selected"));
					b.addClass("is-selected");
				};
			}
		} else if (type === "mc") {
			const ed = this.renderChoiceEditor(body, `grill-mgmt-radio-${cardId}`, q.choices ?? [], new Set([q.modelAnswer]), false);
			getChoices = ed.getChoices;
			getCorrect = ed.getCorrect;
		} else if (type === "multi") {
			const ed = this.renderChoiceEditor(
				body,
				`grill-mgmt-radio-${cardId}`,
				q.choices ?? [],
				new Set(q.correctChoices ?? []),
				true,
			);
			getChoices = ed.getChoices;
			getCorrect = ed.getCorrect;
		} else if (type === "match") {
			getPairs = this.renderPairEditor(body, q.pairs ?? []);
		} else {
			answerEl = field("Answer", q.modelAnswer, true) as HTMLTextAreaElement;
		}
		if (type === "blank") {
			body.createDiv({
				cls: "grill-meta",
				text: 'Answer segments are separated by " / ", one per blank (____), in the same left-to-right order.',
			});
		}

		const hintEls = ["tier1", "tier2", "tier3"].map(
			(tier, i) => field(`Hint ${i + 1}`, q.hints[tier as "tier1" | "tier2" | "tier3"], false) as HTMLInputElement,
		);
		const rubricEl = field("Rubric", q.rubric ?? "", true) as HTMLTextAreaElement;

		const errorEl = body.createDiv({ cls: "grill-mgmt-error" });
		const btnRow = body.createDiv({ cls: "grill-btn-row" });
		const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta grill-submit-btn" });
		const deleteBtn = btnRow.createEl("button", { text: "Delete", cls: "grill-quiet-btn" });

		saveBtn.onclick = async () => {
			errorEl.setText("");
			const question = qEl.value.trim();
			if (!question) {
				errorEl.setText("Question can't be empty.");
				return;
			}

			let modelAnswer = "";
			let choices: string[] | undefined;
			let correctChoices: string[] | undefined;
			let pairs: { left: string; right: string }[] | undefined;

			if (type === "tf") {
				modelAnswer = tfAnswer;
			} else if (type === "mc") {
				choices = getChoices!();
				const correct = getCorrect!();
				if (choices.length < 2) {
					errorEl.setText("Multiple choice needs at least 2 choices.");
					return;
				}
				if (correct.length !== 1) {
					errorEl.setText("Pick exactly one correct choice.");
					return;
				}
				modelAnswer = correct[0];
			} else if (type === "multi") {
				choices = getChoices!();
				correctChoices = getCorrect!();
				if (choices.length < 2) {
					errorEl.setText("Select-all needs at least 2 choices.");
					return;
				}
				if (correctChoices.length < 1) {
					errorEl.setText("Mark at least one choice correct.");
					return;
				}
				if (correctChoices.length >= choices.length) {
					errorEl.setText("At least one choice must be left wrong.");
					return;
				}
				modelAnswer = correctChoices.join(", ");
			} else if (type === "match") {
				pairs = getPairs!();
				if (pairs.length < 2) {
					errorEl.setText("Match needs at least 2 complete pairs.");
					return;
				}
				modelAnswer = pairs.map((p) => `${p.left} → ${p.right}`).join("; ");
			} else {
				modelAnswer = (answerEl?.value ?? "").trim();
				if (!modelAnswer) {
					errorEl.setText("Answer can't be empty.");
					return;
				}
				if (type === "blank") {
					const blanks = (question.match(/_{3,}/g) ?? []).length;
					const segments = modelAnswer.split(" / ").filter((s) => s.trim()).length;
					if (blanks > 0 && segments !== blanks) {
						errorEl.setText(
							`Question has ${blanks} blank(s) but the answer has ${segments} segment(s). They must match.`,
						);
						return;
					}
				}
			}

			q.question = question;
			q.modelAnswer = modelAnswer;
			q.hints = { tier1: hintEls[0].value.trim(), tier2: hintEls[1].value.trim(), tier3: hintEls[2].value.trim() };
			q.rubric = rubricEl.value.trim() || undefined;
			if (choices) q.choices = choices;
			if (correctChoices) q.correctChoices = correctChoices;
			if (pairs) q.pairs = pairs;

			if (!(await this.host.saveOrNotice(this.host.plugin().store.saveQuestionBank(this.host.bank())))) return;
			previewEl.empty();
			this.host.md(q.question, previewEl);
			new Notice("Grill: question saved.", 3000);
		};

		deleteBtn.onclick = async () => {
			const arr = this.host.bank()[conceptId];
			if (arr) {
				const i = arr.indexOf(q);
				if (i >= 0) arr.splice(i, 1);
				if (!arr.length) delete this.host.bank()[conceptId];
			}
			if (!(await this.host.saveOrNotice(this.host.plugin().store.saveQuestionBank(this.host.bank())))) return;
			card.remove();
		};
	}

	/** Add/remove choice rows with a radio (`multi=false`, exactly one correct) or
	 * checkbox (`multi=true`, any number correct) per row — shared by the mc and multi
	 * card editors. `groupName` scopes the radio inputs to this card so two mc cards on
	 * the same screen don't cross-select each other. */
	private renderChoiceEditor(
		card: HTMLElement,
		groupName: string,
		initialChoices: string[],
		initialCorrect: Set<string>,
		multi: boolean,
	): { getChoices: () => string[]; getCorrect: () => string[] } {
		card.createDiv({
			cls: "grill-block-label",
			text: multi ? "Choices (check every correct one)" : "Choices (pick the correct one)",
		});
		const list = card.createDiv({ cls: "grill-mgmt-choice-list" });
		const rows: { text: string; correct: boolean }[] = initialChoices.map((c) => ({
			text: c,
			correct: initialCorrect.has(c),
		}));
		const renderRows = (): void => {
			list.empty();
			rows.forEach((r, i) => {
				const row = list.createDiv({ cls: "grill-mgmt-choice-row" });
				const mark = row.createEl("input", {
					attr: multi ? { type: "checkbox" } : { type: "radio", name: groupName },
				});
				mark.checked = r.correct;
				mark.onchange = () => {
					if (multi) {
						r.correct = mark.checked;
					} else {
						for (const o of rows) o.correct = false;
						r.correct = true;
						renderRows();
					}
				};
				const text = row.createEl("input", { cls: "grill-mgmt-choice-text", attr: { type: "text" } });
				text.value = r.text;
				text.oninput = () => (r.text = text.value);
				const remove = row.createEl("button", { text: "×", cls: "grill-quiet-btn grill-mgmt-choice-remove" });
				remove.onclick = () => {
					rows.splice(i, 1);
					renderRows();
				};
			});
		};
		renderRows();
		const addBtn = card.createEl("button", { text: "+ Add choice", cls: "grill-quiet-btn" });
		addBtn.onclick = () => {
			rows.push({ text: "", correct: false });
			renderRows();
		};
		return {
			getChoices: () => rows.map((r) => r.text.trim()).filter(Boolean),
			getCorrect: () => rows.filter((r) => r.correct && r.text.trim()).map((r) => r.text.trim()),
		};
	}

	/** Add/remove left/right pair rows for a "match" card's editor. */
	private renderPairEditor(
		card: HTMLElement,
		initialPairs: { left: string; right: string }[],
	): () => { left: string; right: string }[] {
		card.createDiv({ cls: "grill-block-label", text: "Pairs" });
		const list = card.createDiv({ cls: "grill-mgmt-choice-list" });
		const rows = initialPairs.map((p) => ({ ...p }));
		const renderRows = (): void => {
			list.empty();
			rows.forEach((r, i) => {
				const row = list.createDiv({ cls: "grill-mgmt-choice-row" });
				const left = row.createEl("input", { cls: "grill-mgmt-choice-text", attr: { type: "text" } });
				left.value = r.left;
				left.oninput = () => (r.left = left.value);
				row.createSpan({ text: "→" });
				const right = row.createEl("input", { cls: "grill-mgmt-choice-text", attr: { type: "text" } });
				right.value = r.right;
				right.oninput = () => (r.right = right.value);
				const remove = row.createEl("button", { text: "×", cls: "grill-quiet-btn grill-mgmt-choice-remove" });
				remove.onclick = () => {
					rows.splice(i, 1);
					renderRows();
				};
			});
		};
		renderRows();
		const addBtn = card.createEl("button", { text: "+ Add pair", cls: "grill-quiet-btn" });
		addBtn.onclick = () => {
			rows.push({ left: "", right: "" });
			renderRows();
		};
		return () => rows.map((r) => ({ left: r.left.trim(), right: r.right.trim() })).filter((p) => p.left && p.right);
	}
}
