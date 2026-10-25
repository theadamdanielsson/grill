/** Progress: what is known, learning and due, the misconceptions still showing, coverage
 * by folder, reviews per day, what other agents tested, and the map. Drawn into the pane
 * by the view, which it reaches through its host. */

import type GrillPlugin from "../main";
import { Notice, Platform, TFile, type App } from "obsidian";
import { daysLeft, examName, inExam, whenWords } from "../exams";
import { ConceptMap, conceptTested, dueConceptCount, missedConceptIds } from "../concepts";
import { statusOf } from "../mastery";
import { dismissMisconception, topMisconceptions } from "../debrief";
import { projectSummaries } from "../record";
import { forgetAgentProject, readAgentConcepts } from "../agentrecord";

/** What the screen needs of the pane. */
export interface DashboardHost {
	app(): App;
	plugin(): GrillPlugin;
	/** A fresh screen to draw on. */
	root(): HTMLElement;
	eligible(): TFile[];
	saveOrNotice(save: Promise<void>): Promise<boolean>;
	openNote(name: string): void;
	test(files: TFile[]): void;
	explain(file: TFile, ask: string): void;
	drawMap(host: HTMLElement): Promise<void>;
	back(): void;
}

export class DashboardScreen {
	/** Whether the coverage list shows every folder, not just the first few. */
	private coverageExpanded = false;

	constructor(private host: DashboardHost) {}

	async render(): Promise<void> {
		const wrap = this.host.root();
		const map = this.host.plugin().mastery;
		const eligible = this.host.eligible();

		// grill-dashboard-screen: unique marker (unlike grill-arcade-screen, shared
		// with the start/summary screens) so refreshIfOnDashboard can tell this
		// screen is still open before re-rendering it out from under the user.
		const screen = wrap.createDiv({ cls: "grill-arcade-screen grill-dashboard-screen" });
		const head = screen.createDiv({ cls: "grill-meta-row" });
		head.createSpan({ cls: "grill-score", text: "Your progress" });
		const back = head.createSpan({ cls: "grill-chip-link", text: "Back" });
		back.onclick = () => this.host.back();

		// Stats derived from mastery.json.
		const counts = { untested: 0, struggling: 0, known: 0 };
		let knownShaky = 0;
		for (const f of eligible) {
			const m = map[f.basename];
			counts[statusOf(m)]++;
			if (m) {
				if (m.weakPrereq) knownShaky++;
			}
		}
		// Concept-level, not note-level: matches what clicking into the due queue
		// actually delivers (see GrillPlugin.dueCount's doc comment).
		const eligibleNames = new Set(eligible.map((f) => f.basename));
		const dueNow = dueConceptCount(this.host.plugin().concepts, (note) => eligibleNames.has(note));
		// Accuracy also reads concept-level, not the note-level correct/partial/incorrect
		// counters used above: those exist only for the "known"/"weakPrereq" rollup and
		// aren't reliably kept in sync answer-by-answer the way concepts.json's own
		// scheduling counters are (concept mastery is the thing actually written and
		// verified on every graded answer — see recordConceptAnswer/recordConceptRating).
		let correct = 0, answered = 0;
		for (const cm of Object.values(this.host.plugin().concepts)) {
			if (!eligibleNames.has(cm.note)) continue;
			correct += cm.correct;
			answered += cm.correct + cm.partial + cm.incorrect;
		}
		const accuracy = answered ? Math.round((100 * correct) / answered) : 0;

		const stats = screen.createDiv({ cls: "grill-stats" });
		const stat = (label: string, value: string, tone?: "correct" | "incorrect"): void => {
			const s = stats.createDiv({ cls: tone ? `grill-stat grill-stat-${tone}` : "grill-stat" });
			s.createDiv({ cls: "grill-stat-value", text: value });
			s.createDiv({ cls: "grill-stat-label", text: label });
		};
		stat("due now", String(dueNow));
		// "Due this week" read as a contradiction beside a backlog (178 now, 0 this week).
		// What was last answered wrong is the number that says what to do next.
		stat("missed", String(missedConceptIds(this.host.plugin().concepts, (note) => eligibleNames.has(note), new Date(), false).length), "incorrect");
		stat("known", String(counts.known), "correct");
		// 0% when nothing's been answered, so it reads consistently with the other
		// stats (due/known all show 0 on a fresh vault) rather than a lone dash.
		stat("accuracy", `${accuracy}%`);

		// A note can be honestly "known" on its own FSRS history while resting on a
		// prerequisite that's still shaky (see findWeakPrereq) — surfaced here rather
		// than folded into the "known" count above, which stays a pure, undisturbed
		// FSRS readout.
		if (knownShaky > 0) {
			screen.createDiv({
				cls: "grill-meta",
				text: `${knownShaky} known note${knownShaky === 1 ? "" : "s"} rest${knownShaky === 1 ? "s" : ""} on a shaky prerequisite.`,
			});
		}

		// Shared with "What you keep getting wrong" below: both lists only ever grow
		// (a canonical tag is never deleted, just marked resolved; arc.resolved only
		// accumulates the same way), so past a handful of months of daily use either
		// would otherwise become a permanently-scrolling wall. Cap what's shown to
		// each section's actual purpose, not a lifetime transcript.
		const MISC_SHOWN_CAP = 10;

		// Exams still ahead, soonest first, each with how its concepts stand: the plain
		// sign that the schedule is working toward the date (set in Settings, Study).
		const now = new Date();
		const exams = this.host.plugin().data.settings.exams
			.map((e) => ({ e, left: daysLeft(e, now) }))
			.filter((x) => x.left >= 0)
			.sort((a, b) => a.left - b.left);
		if (exams.length) {
			screen.createDiv({ cls: "grill-section-label", text: exams.length === 1 ? "Exam" : "Exams" });
			const pathOf = new Map(eligible.map((f) => [f.basename, f.path] as const));
			for (const { e, left } of exams) {
				let all = 0, known = 0, untested = 0;
				for (const cm of Object.values(this.host.plugin().concepts)) {
					const path = pathOf.get(cm.note);
					if (!path || !inExam(path, e) || cm.orphanedDueAt) continue;
					all++;
					if (!conceptTested(cm)) untested++;
					else if (statusOf(cm) === "known") known++;
				}
				const card = screen.createDiv({ cls: "grill-card" });
				card.createDiv({ cls: "grill-arc-headline", text: examName(e) });
				const w = whenWords(left);
				card.createDiv({ cls: "grill-meta", text: `${e.date}, ${w}.${all ? ` ${known} of ${all} concepts known, ${untested} not tested yet.` : ""}` });
			}
		}

		// Your arc: synthesized in the background by maybeSynthesizeArc (main.ts),
		// gated on active-day history — absent, quietly, until the vault has enough
		// of it (see MIN_ACTIVE_DAYS_FOR_ARC). Never generated from this render path,
		// so opening the dashboard is never what triggers or waits on the LLM call.
		const arc = this.host.plugin().data.arc?.data;
		if (arc) {
			screen.createDiv({ cls: "grill-section-label", text: "Your arc" });
			const arcCard = screen.createDiv({ cls: "grill-card" });
			arcCard.createDiv({ cls: "grill-arc-headline", text: arc.headline });
			if (arc.shift) arcCard.createDiv({ cls: "grill-meta", text: arc.shift });
			// What has been resolved is listed once, under "Beaten" below.
		}

		// What you keep getting wrong — already-sorted worst/most-recurring first
		// (see MISC_SHOWN_CAP above).
		const reg = await this.host.plugin().store.loadRegistry();
		const top = topMisconceptions(reg, 100);
		const activeAll = top.filter((c) => c.status === "active");
		const beatenAll = top.filter((c) => c.status === "resolved");
		const active = activeAll.slice(0, MISC_SHOWN_CAP);

		screen.createDiv({ cls: "grill-section-label", text: "What you keep getting wrong" });
		const miscCard = screen.createDiv({ cls: "grill-card" });
		if (!active.length) {
			miscCard.createDiv({
				cls: "grill-meta",
				text: beatenAll.length ? "Nothing open right now." : "Nothing recurring yet. It builds up as the grader spots patterns.",
			});
		} else {
			const list = miscCard.createDiv({ cls: "grill-misc-list" });
			for (const c of active) {
				const row = list.createDiv({ cls: "grill-misc-row" });
				const rowHead = row.createDiv({ cls: "grill-misc-head" });
				rowHead.createSpan({ cls: "grill-misc-label", text: c.label });
				const actions = rowHead.createDiv({ cls: "grill-misc-actions" });
				actions.createSpan({ cls: "grill-meta", text: `${c.count}×` });
				// Escape hatch for a bad grading call: the tag itself is wrong, not a real
				// recurring confusion, so re-probing it forever (contagion, the nudge banner)
				// just keeps surfacing a false positive. Dismiss removes it from the rotation
				// for good — unlike a correct re-probe, it won't come back on its own.
				const dismiss = actions.createSpan({ cls: "grill-chip-link grill-misc-dismiss", text: "Dismiss" });
				dismiss.setAttribute("title", "Not a real mistake: stop re-probing this");
				dismiss.onclick = async () => {
					dismissMisconception(reg, c.tag);
					if (!(await this.host.saveOrNotice(this.host.plugin().store.saveRegistry(reg)))) return;
					void this.render();
				};
				if (c.notes.length) {
					const notes = row.createDiv({ cls: "grill-misc-notes" });
					for (const n of c.notes.slice(0, 6)) {
						const chip = notes.createSpan({ cls: "grill-chip grill-chip-link", text: n });
						chip.onclick = () => this.host.openNote(n);
					}
					// Something to do about it: have it explained, or be tested on the notes
					// it showed up in.
					const files = c.notes.flatMap((n) => eligible.filter((f) => f.basename === n));
					if (files.length) {
						const explain = actions.createSpan({ cls: "grill-chip-link", text: "Explain" });
						explain.onclick = () => this.host.explain(files[0], `I keep making this mistake: "${c.label}". Explain what I am getting wrong and how to think about it.`);
						const test = actions.createSpan({ cls: "grill-chip-link", text: "Test" });
						test.onclick = () => this.host.test(files);
					}
				}
			}
			if (activeAll.length > active.length) {
				miscCard.createDiv({ cls: "grill-meta", text: `+${activeAll.length - active.length} more recurring` });
			}
		}
		if (beatenAll.length) {
			// A count that opens: what is behind you needs less room than what is ahead.
			const fold = miscCard.createEl("details", { cls: "grill-beaten" });
			fold.createEl("summary", { cls: "grill-section-label", text: `Beaten: ${beatenAll.length}` });
			const beatenList = fold.createDiv({ cls: "grill-misc-list" });
			for (const c of beatenAll) beatenList.createDiv({ cls: "grill-arc-resolved-row", text: c.label });
		}

		this.agentRecordSection(screen);

		// Concept coverage: honest counts from the per-concept scheduler.
		const cmap = await this.host.plugin().store.loadConcepts();
		const tested = Object.values(cmap).filter((c) => c.correct + c.partial + c.incorrect > 0);
		if (tested.length) {
			const known = tested.filter((c) => statusOf(c) === "known").length;
			screen.createDiv({ cls: "grill-section-label", text: "Concept coverage" });
			const coverageCard = screen.createDiv({ cls: "grill-card" });
			coverageCard.createDiv({
				cls: "grill-meta",
				text: `${tested.length} concepts tested so far: ${known} solid, ${tested.length - known} still shaky.`,
			});
			// Grouped by folder, not by individual note: the graph is already the
			// granular per-note/per-concept view, so this list reads better at a
			// broader stroke — a chapter/topic folder's overall shakiness, not 109
			// individual note rows competing for the same 6 slots. Grill otherwise
			// tracks progress by filename only (see the duplicate-basename warning
			// elsewhere), so folder is resolved here, once, from the live file list
			// rather than being state Grill maintains itself.
			// Keyed by full folder path, not name: two differently-located folders that
			// happen to share a name (e.g. a "Chapter 1" under two different subjects
			// in the same vault) are genuinely different folders and would otherwise
			// silently merge into one misleading row.
			const pathByBasename = new Map(eligible.map((f) => [f.basename, f.parent && f.parent.path !== "/" ? f.parent.path : "/"]));
			const byFolder = new Map<string, { tested: number; known: number }>();
			for (const c of tested) {
				const path = pathByBasename.get(c.note) ?? "?";
				const e = byFolder.get(path) ?? { tested: 0, known: 0 };
				e.tested++;
				if (statusOf(c) === "known") e.known++;
				byFolder.set(path, e);
			}
			// Label with just the folder's own name normally; only fall back to
			// "parent/name" for paths whose bare name collides with another path in
			// this same list, so the common case stays short and only the genuinely
			// ambiguous ones pay for disambiguation.
			const nameOf = (path: string): string => (path === "/" ? this.host.app().vault.getName() : path === "?" ? "Other" : path.split("/").pop() ?? path);
			const nameCounts = new Map<string, number>();
			for (const path of byFolder.keys()) nameCounts.set(nameOf(path), (nameCounts.get(nameOf(path)) ?? 0) + 1);
			const labelOf = (path: string): string => {
				if (path === "/" || path === "?" || (nameCounts.get(nameOf(path)) ?? 0) <= 1) return nameOf(path);
				const segments = path.split("/");
				return segments.slice(-2).join("/");
			};
			// All folders, not just the shakiest few — a note-count cap made sense
			// when the list was 109 individual notes, but a folder is already the
			// broad-strokes unit, so the count that actually needs capping is how
			// many DOM rows get built at once (matters for a genuinely massive
			// vault), not how many folders exist. Same MISC_SHOWN_CAP as the
			// misconception lists, expandable in place rather than a dead-end
			// "+N more" label, since unlike those lists there's no note/tag to click
			// into instead — the only way to see the rest is to reveal them here.
			// Natural/numeric order (Chapter 1, 2, ... 12), not sorted by shakiness:
			// that made sense while only the top few fit and the rest were hidden, but
			// now that every folder is listed, a scannable, predictable order beats a
			// shaky-first ordering that scattered "Chapter 12" in among "Chapter 2"
			// and "Chapter 3".
			const allRows = [...byFolder.entries()]
				.map(([path, e]) => ({ path, folder: labelOf(path), ...e, shaky: e.tested - e.known }))
				.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }));
			const rows = this.coverageExpanded ? allRows : allRows.slice(0, MISC_SHOWN_CAP);
			const list = coverageCard.createDiv({ cls: "grill-meter-list" });
			for (const r of rows) {
				const row = list.createDiv({ cls: "grill-meter-row" });
				// A folder's row starts a test on that folder.
				const inFolder = r.path === "?" ? [] : eligible.filter((f) => (f.parent && f.parent.path !== "/" ? f.parent.path : "/") === r.path);
				if (inFolder.length) {
					row.addClass("grill-meter-row-link");
					row.setAttr("title", `Test ${r.folder}`);
					row.onclick = () => this.host.test(inFolder);
				}
				row.createSpan({ cls: "grill-meter-label", text: r.folder });
				const track = row.createDiv({ cls: "grill-meter-track" });
				const pct = r.tested ? Math.round((100 * r.known) / r.tested) : 0;
				track.createDiv({ cls: "grill-meter-fill" }).setCssStyles({ width: `${pct}%` });
				row.createSpan({ cls: "grill-meter-value", text: `${r.known}/${r.tested}` });
			}
			if (!this.coverageExpanded && allRows.length > rows.length) {
				const more = coverageCard.createDiv({ cls: "grill-chip-link grill-meta", text: `Show ${allRows.length - rows.length} more folders` });
				more.onclick = () => {
					this.coverageExpanded = true;
					void this.render();
				};
			}
		}

		this.renderHeatmap(screen);

		// The map lives here now, off the home screen: one view among the others.
		screen.createDiv({ cls: "grill-section-label", text: "Map" });
		void this.host.drawMap(screen.createDiv({ cls: "grill-map-wrap" }));
	}

	/** What coding agents tested the student on outside the vault (grill-test, through
	 * grill-mcp), from the record in ~/.grill/record. Grill has no notes to test these
	 * from, so it shows them, by project; reviewing happens in the agent. Desktop only. */
	private agentRecordSection(screen: HTMLElement): void {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (!Platform.isDesktopApp || !req) return;
		let concepts: ConceptMap;
		try {
			concepts = readAgentConcepts(req);
		} catch {
			return; // no record yet, or not readable: nothing to show
		}
		const projects = projectSummaries(concepts);
		if (!projects.length) return;
		screen.createDiv({ cls: "grill-section-label", text: "Tested in other agents" });
		const card = screen.createDiv({ cls: "grill-card" });
		card.createDiv({ cls: "grill-meta", text: "Review these in your agent with /grill-test." });
		for (const p of projects) {
			const row = card.createDiv({ cls: "grill-misc-row" });
			const head = row.createDiv({ cls: "grill-misc-head" });
			head.createSpan({ cls: "grill-misc-label", text: p.project });
			const facts = [p.dueNow ? `${p.dueNow} due` : "", p.missedLast ? `${p.missedLast} missed` : "", `${p.tested} tested`].filter(Boolean).join(" · ");
			head.createSpan({ cls: "grill-meta", text: facts });
			// Asked once before it goes: the agent's record has no undo.
			const remove = head.createEl("button", { cls: "grill-quiet-btn grill-agent-remove", text: "Remove", attr: { type: "button", "aria-label": `Remove ${p.project} from the record` } });
			remove.onclick = () => {
				remove.remove();
				const ask = head.createSpan({ cls: "grill-agent-remove-ask" });
				ask.createSpan({ cls: "grill-meta", text: "Remove from the record?" });
				const yes = ask.createEl("button", { cls: "grill-quiet-btn", text: "Remove", attr: { type: "button" } });
				const no = ask.createEl("button", { cls: "grill-quiet-btn", text: "Keep", attr: { type: "button" } });
				no.onclick = () => void this.render();
				yes.onclick = () => {
					try {
						forgetAgentProject(req, p.project);
					} catch (e) {
						new Notice(`Grill: couldn't remove ${p.project} (${e instanceof Error ? e.message : String(e)}).`);
					}
					void this.render();
				};
			};
			for (const c of p.weakest) {
				const line = row.createDiv({ cls: "grill-agent-concept" });
				line.createSpan({ text: c.label });
				const file = c.note.slice(p.project.length + 1);
				if (file) line.createSpan({ cls: "grill-meta", text: ` ${file}` });
			}
		}
	}

	/** GitHub-style grid of reviews done per day, from session-note frontmatter. */
	private renderHeatmap(wrap: HTMLElement): void {
		const pad = (n: number): string => String(n).padStart(2, "0");
		const key = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

		const dir = `${this.host.plugin().store.sessionsDir()}/`;
		const perDay = new Map<string, number>();
		for (const f of this.host.app().vault.getMarkdownFiles()) {
			if (!f.path.startsWith(dir)) continue;
			const fm = this.host.app().metadataCache.getFileCache(f)?.frontmatter;
			const date = typeof fm?.date === "string" ? fm.date : null;
			if (!date) continue;
			const score = typeof fm?.score === "string" ? fm.score : "";
			const total = score.includes("/") ? parseInt(score.split("/")[1], 10) : 1;
			perDay.set(date, (perDay.get(date) ?? 0) + (Number.isNaN(total) ? 1 : total));
		}

		wrap.createDiv({ cls: "grill-section-label", text: "Reviews (last 12 weeks)" });
		const card = wrap.createDiv({ cls: "grill-card" });
		const scroller = card.createDiv({ cls: "grill-heatmap-wrap" });
		const today = new Date();
		const level = (c: number): number => (c === 0 ? 0 : c < 3 ? 1 : c < 6 ? 2 : c < 10 ? 3 : 4);
		const DAYS = 84;
		const WEEKS = DAYS / 7;

		// Month labels: one per week-column, shown only on the column whose oldest (top)
		// day starts a new month — otherwise a label every column would just repeat.
		const monthsRow = scroller.createDiv({ cls: "grill-hm-months" });
		let lastMonth = -1;
		for (let w = 0; w < WEEKS; w++) {
			const dayIndex = DAYS - 1 - w * 7; // the "i" of that column's top (oldest) cell
			const d = new Date(today.getTime() - dayIndex * 86400_000);
			const m = d.getMonth();
			monthsRow.createSpan({ text: m !== lastMonth ? MONTH_NAMES[m] : "" });
			lastMonth = m;
		}

		const grid = scroller.createDiv({ cls: "grill-heatmap" });
		for (let i = DAYS - 1; i >= 0; i--) {
			const d = new Date(today.getTime() - i * 86400_000);
			const k = key(d);
			const count = perDay.get(k) ?? 0;
			const cell = grid.createDiv({ cls: `grill-hm-cell grill-hm-${level(count)}` });
			cell.setAttr("aria-label", `${k}: ${count} review${count === 1 ? "" : "s"}`);
			cell.setAttr("title", `${k}: ${count} review${count === 1 ? "" : "s"}`);
		}

		const legend = card.createDiv({ cls: "grill-hm-legend" });
		legend.createSpan({ text: "Less" });
		for (let lvl = 0; lvl <= 4; lvl++) legend.createDiv({ cls: `grill-hm-cell grill-hm-${lvl}` });
		legend.createSpan({ text: "More" });
	}
}
