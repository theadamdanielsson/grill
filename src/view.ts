/** Quiz session side panel. */

import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type GrillPlugin from "./main";
import { adjudicateBridges, ConceptTarget, debriefSession, generateQuestions, Grade, gradeAnswer, LLMConfig, Question, supportsVision, Verdict } from "./llm";
import { Concept, extractConcepts, localQuestionForConcept, localQuestions } from "./generate-local";
import { BridgeMap, detectBridgeCandidates, pairKey } from "./bridges";
import { buildGraph } from "./graph";
import { GraphAppearance, LearningMap, MapPalette } from "./mapview";
import type { CachedQuestion, QuestionBank } from "./store";
import {
	ConceptMap,
	ConceptMastery,
	conceptTargetDifficulty,
	conceptTested,
	noteAggregate,
	pickConcepts,
	recordConceptAnswer,
	recordConceptRating,
	reconcileConcepts,
} from "./concepts";
import { collectNoteImages, ImageInput } from "./images";
import { NoteMastery, pickCandidates, QDifficulty, Rating, recordNoteStats, statusOf } from "./mastery";
import {
	buildSessionGraph,
	expandSelectionWithLinks,
	formatLinksBlock,
	outgoingBasenames,
	SessionGraph,
} from "./links";
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
import { CONFIDENCE_LEVELS, calibrationLine, pushCalibration } from "./calibration";
import { celebrate, playSfx } from "./sfx";
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
/** Reactive prerequisite routing: most detours inserted per session, so a run of
 * wrong answers can't balloon the session or chain endlessly down the link graph. */
const MAX_ROUTES = 3;

interface QuestionResult extends SessionEntry {
	hintsUsed: number;
	/** Raw grader misconception tag, if any; consumed by the end-of-session debrief. */
	misconceptionTag?: string;
	/** Set for a missing-link bridge question, with the un-linked partner note, so the
	 * feedback screen can offer to write the link. */
	missingLink?: boolean;
	connectTo?: string;
}

/** Most cached question variants kept per concept, to bound questions.json growth. */
const MAX_VARIANTS = 8;
/** Cap on learning-graph nodes laid out + drawn, so a huge vault stays responsive. */
const MAP_NODE_CAP = 600;

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
	/** Concept lookup by id, for prebuilt (authored / cached) questions. */
	private conceptById = new Map<string, Concept>();
	/** Missing-link records (which pairs surfaced / were linked), held for the session. */
	private bridges: BridgeMap = {};
	/** Per-concept cache of generated questions, reused across reviews. */
	private questionBank: QuestionBank = {};
	/** Question bank / bridges changed in memory and need flushing (separate from
	 * `dirty`, which flushes concepts/mastery/registry). */
	private bankDirty = false;
	private bridgesDirty = false;
	/** Replay ("Redo this quiz") of a saved session's questions: same questions, no
	 * generation, and practice-only — grading and feedback run, but nothing is written to
	 * the schedule, stats, or misconception registry. */
	private replayMode = false;
	/** The live learning-graph canvas controller on the start screen, if any. */
	private map: LearningMap | null = null;
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
	/** The user's persona override (Grill/Instructions.md), or "" to use the engine default. */
	private sessionPersona = "";
	/** The user's question/grading preferences (Grill/Instructions.md), if any. */
	private sessionInstructions = "";
	/** In-flight batch generation, if any. */
	private pending: Promise<void> | null = null;
	/** Reactive routing budget: detours spent, and prerequisites already routed to
	 * (so the same foundation isn't inserted twice in one session). */
	private routesUsed = 0;
	private routedNotes = new Set<string>();
	/** How many of `targets` have been handed to generation so far. Tracked separately
	 * from `questions.length` because the quality validator can drop a generated
	 * question, so one target need not yield exactly one question — keying the next
	 * batch off questions.length would re-generate (and duplicate) already-tried
	 * concepts. `questions` is just the delivered queue; it is NOT positionally
	 * coupled to `targets`. */
	private planCursor = 0;
	/** The confidence the user picked for the current question (0..1), or null. Only
	 * used when the confidence check is on; captured into calibration on grade. */
	private pendingConfidence: number | null = null;

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
		if (!this.plugin.data.settings.onboarded) this.renderOnboarding();
		else this.renderStart();
	}

	/** Public entry so the plugin can force the first-run screen on install. */
	showOnboarding(): void {
		this.renderOnboarding();
	}

	/** First-run: choose which folders are Grill's study material + graph. */
	private renderOnboarding(): void {
		const wrap = this.root();
		wrap.createDiv({ cls: "grill-score", text: "Welcome to Grill" });

		const how = wrap.createEl("ul", { cls: "grill-onboard-how" });
		const point = (lead: string, rest: string): void => {
			const li = how.createEl("li");
			li.createEl("strong", { text: lead });
			li.appendText(` ${rest}`);
		};
		point("Quiz yourself", "on your own notes — Grill writes the questions.");
		point("Watch your map fill in", "as you prove what you know.");
		point("Study anything", "— one folder, a tag, or the whole vault.");

		wrap.createDiv({ cls: "grill-section-label", text: "Which folders should Grill study?" });
		wrap.createEl("p", {
			cls: "grill-meta",
			text: "Tick some, or leave them all unticked to use your whole vault. You can change this any time in settings.",
		});

		const folderRoot = `${this.plugin.data.settings.folder}/`;
		const eligible = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(folderRoot));
		const folders = listFolders(eligible);
		const chosen = new Set<string>();

		if (!folders.length) {
			wrap.createEl("p", { cls: "grill-meta", text: "No folders found — Grill will use your whole vault." });
		} else {
			const boxes: HTMLInputElement[] = [];
			const controls = wrap.createDiv({ cls: "grill-onboard-controls" });
			const selectAll = controls.createEl("a", { cls: "grill-chip-link", text: "Select all" });
			const clear = controls.createEl("a", { cls: "grill-chip-link", text: "Clear" });
			const list = wrap.createDiv({ cls: "grill-onboard-folders" });
			for (const path of folders) {
				const row = list.createDiv({ cls: "grill-onboard-row" });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.onchange = () => {
					if (cb.checked) chosen.add(path);
					else chosen.delete(path);
				};
				boxes.push(cb);
				const label = row.createEl("label", { text: path });
				label.onclick = () => cb.click();
			}
			selectAll.onclick = () => {
				for (const p of folders) chosen.add(p);
				for (const b of boxes) b.checked = true;
			};
			clear.onclick = () => {
				chosen.clear();
				for (const b of boxes) b.checked = false;
			};
		}

		const btn = wrap.createEl("button", { text: "Get started", cls: "mod-cta grill-start-btn grill-primary-cta" });
		btn.onclick = async () => {
			this.plugin.data.settings.includedFolders = [...chosen];
			this.plugin.data.settings.onboarded = true;
			await this.plugin.persist();
			this.plugin.refreshStatusBar();
			this.renderStart();
		};
	}

	private root(): HTMLElement {
		// Tear down the map's canvas loop / observers whenever a screen re-renders.
		this.map?.dispose();
		this.map = null;
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
				this.map?.setHighlight(null);
			} else {
				const files = filesForScope(this.app, scope, eligible, map);
				this.pendingScope = files;
				showCounts(files);
				this.map?.setHighlight(new Set(files.map((f) => f.basename)));
			}
		};

		const btn = wrap.createEl("button", { text: "Get grilled", cls: "mod-cta grill-start-btn grill-primary-cta" });
		btn.onclick = () => {
			this.sessionScope = this.pendingScope;
			void this.startSession();
		};

		// The learning graph: your notes, coloured in by what you've proven you know.
		const mapWrap = wrap.createDiv({ cls: "grill-map-wrap" });
		void this.renderMap(mapWrap);

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

	/** Inherit the user's Obsidian graph settings (graph.json) so the learning graph looks
	 * like the graph they've already tuned. Missing/invalid → sensible defaults. */
	private async readGraphAppearance(): Promise<Partial<GraphAppearance>> {
		try {
			const path = `${this.app.vault.configDir}/graph.json`;
			if (!(await this.app.vault.adapter.exists(path))) return {};
			const g = JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, unknown>;
			const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
			const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
			return {
				textFade: clamp(num(g.textFadeMultiplier, 0), -3, 3),
				nodeScale: clamp(num(g.nodeSizeMultiplier, 1), 0.3, 4),
				lineScale: clamp(num(g.lineSizeMultiplier, 1), 0.3, 4),
			};
		} catch {
			return {};
		}
	}

	/** Node/edge colours resolved from the current theme (canvas can't read CSS vars). */
	private mapPalette(): MapPalette {
		const view = this.contentEl.ownerDocument.defaultView ?? window;
		const cs = view.getComputedStyle(this.contentEl);
		const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
		return {
			known: v("--grill-correct", "#3aa675"),
			struggling: v("--grill-incorrect", "#e5484d"),
			inProgress: v("--grill-partial", "#e0913a"),
			unpracticed: v("--text-faint", "#8a8a8a"),
			edge: v("--background-modifier-border", "#3a3a3a"),
			edgeInherited: v("--text-muted", "#9a9a9a"),
			edgeProven: v("--interactive-accent", "#ff7a45"),
			text: v("--text-normal", "#eaeaea"),
			ring: v("--interactive-accent", "#ff7a45"),
		};
	}

	/** Draw the learning graph over the eligible notes into `host`. Loads concepts + saved
	 * positions, builds and (re)lays out the graph, persists positions, and mounts the
	 * canvas controller. Bounded to MAP_NODE_CAP nodes (practised notes + neighbours). */
	private async renderMap(host: HTMLElement): Promise<void> {
		const canvas = host.createEl("canvas", { cls: "grill-graph" });
		const status = host.createDiv({ cls: "grill-meta grill-map-status", text: "Loading your graph…" });
		try {
			const eligible = this.allEligible();
			const nameSet = new Set(eligible.map((f) => f.basename));
			const concepts = await this.plugin.store.loadConcepts();
			const practiced = new Set<string>();
			for (const cm of Object.values(concepts)) {
				if (nameSet.has(cm.note) && cm.correct + cm.partial + cm.incorrect > 0) practiced.add(cm.note);
			}

			// Undirected links among eligible notes.
			const linkSeen = new Set<string>();
			const allLinks: [string, string][] = [];
			const neigh = new Map<string, Set<string>>();
			for (const f of eligible) {
				const a = f.basename;
				for (const b of outgoingBasenames(this.app, f)) {
					if (a === b || !nameSet.has(b)) continue;
					const key = a < b ? `${a} ${b}` : `${b} ${a}`;
					if (linkSeen.has(key)) continue;
					linkSeen.add(key);
					allLinks.push([a, b]);
					(neigh.get(a) ?? neigh.set(a, new Set()).get(a)!).add(b);
					(neigh.get(b) ?? neigh.set(b, new Set()).get(b)!).add(a);
				}
			}

			// Node universe, capped: practised notes + their neighbours first, then fill.
			let names = [...nameSet];
			let capped = false;
			if (names.length > MAP_NODE_CAP) {
				capped = true;
				const keep = new Set<string>(practiced);
				for (const p of practiced) for (const n of neigh.get(p) ?? []) keep.add(n);
				for (const n of names) {
					if (keep.size >= MAP_NODE_CAP) break;
					keep.add(n);
				}
				names = [...keep].slice(0, MAP_NODE_CAP);
			}
			const keepSet = new Set(names);
			const links = allLinks.filter(([a, b]) => keepSet.has(a) && keepSet.has(b));

			const graph = buildGraph(names, links, concepts);

			// Restore saved positions (the live sim starts calm when it has them all, or
			// settles organically when there are new nodes).
			const saved = await this.plugin.store.loadGraphLayout();
			let settled = graph.nodes.length > 0;
			for (const n of graph.nodes) {
				const p = saved[n.id];
				if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
					n.x = p.x;
					n.y = p.y;
				} else {
					settled = false;
				}
			}

			status.remove();
			if (!graph.nodes.length) {
				host.createDiv({
					cls: "grill-meta grill-map-status",
					text: "No notes in Grill's folders yet — add some, or widen Grill's folders in settings.",
				});
				return;
			}
			const appearance = await this.readGraphAppearance();
			this.map?.dispose();
			this.map = new LearningMap(
				canvas,
				graph,
				this.mapPalette(),
				(id) => this.openNote(id),
				(pos) => void this.plugin.store.saveGraphLayout(pos),
				settled,
				appearance,
			);
			if (capped) {
				host.createDiv({
					cls: "grill-meta grill-map-status",
					text: `Showing ${names.length} of ${nameSet.size} notes (the ones you've studied and their neighbours).`,
				});
			}
		} catch (e) {
			status.setText(`Grill: couldn't draw the graph. ${(e as Error).message}`);
		}
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
		// 0% when nothing's been answered, so it reads consistently with the other
		// stats (due/known all show 0 on a fresh vault) rather than a lone dash.
		stat("accuracy", `${accuracy}%`);

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

		// Missing links Grill has helped you connect.
		const bridges = await this.plugin.store.loadBridges();
		const linked = Object.values(bridges).filter((b) => b.status === "linked").length;
		if (linked > 0) {
			wrap.createDiv({ cls: "grill-section-label", text: "Connections made" });
			wrap.createDiv({
				cls: "grill-meta",
				text: `Grill has helped you link ${linked} pair${linked === 1 ? "" : "s"} of notes you hadn't connected.`,
			});
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
		this.pendingConfidence = null;
		const q = this.questions[this.idx];
		const card = wrap.createDiv({ cls: "grill-body" });
		const meta = card.createDiv({ cls: "grill-meta-row" });
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.targetCount}` });
		if (!this.plugin.data.settings.hideNoteName) meta.createSpan({ cls: "grill-chip", text: q.node });

		// Connections mode: make the bridge legible. Names are the point of the mode,
		// but honour "hide note name" so we never leak the answer.
		if (q.connectTo) {
			const bridge = card.createDiv({ cls: "grill-bridge" });
			const hidden = this.plugin.data.settings.hideNoteName;
			if (hidden) {
				bridge.createSpan({
					cls: "grill-meta",
					text: q.missingLink
						? "Two of your notes that aren't linked yet"
						: "Connecting two of your linked notes",
				});
			} else {
				bridge.createSpan({ cls: "grill-meta", text: q.missingLink ? "A connection you haven't made yet" : "Bridging" });
				bridge.createSpan({ cls: "grill-chip", text: q.node });
				bridge.createSpan({ cls: "grill-bridge-arrow", text: "↔" });
				bridge.createSpan({ cls: "grill-chip", text: q.connectTo });
			}
		}

		// Reactive routing: make the detour legible ("you missed X, so here's a
		// foundation it builds on"). Honour "hide note name" so we never leak it.
		if (q.routedFrom) {
			const routed = card.createDiv({ cls: "grill-routed" });
			if (this.plugin.data.settings.hideNoteName) {
				routed.createSpan({ cls: "grill-meta", text: "Shoring up a foundation of the note you just missed" });
			} else {
				routed.createSpan({ cls: "grill-meta", text: "You missed" });
				routed.createSpan({ cls: "grill-chip", text: q.routedFrom });
				routed.createSpan({ cls: "grill-meta", text: "— checking a foundation it builds on" });
			}
		}

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
		// Confidence check (opt-in, AI grading only): predict how sure you are before
		// the grade lands, so calibration compares your confidence to an objective mark.
		if (this.plugin.data.settings.confidenceCheck && !selfGrade) {
			const conf = card.createDiv({ cls: "grill-confidence" });
			conf.createSpan({ cls: "grill-meta", text: "How sure are you?" });
			const btns: HTMLButtonElement[] = [];
			for (const lvl of CONFIDENCE_LEVELS) {
				const b = conf.createEl("button", { text: lvl.label, cls: "grill-conf-btn" });
				b.onclick = () => {
					this.pendingConfidence = lvl.value;
					for (const other of btns) other.removeClass("mod-cta");
					b.addClass("mod-cta");
				};
				btns.push(b);
			}
		}

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
		if (this.plugin.data.settings.sounds) playSfx(r.verdict); // correct / partial / incorrect
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

		if (r.missingLink && r.connectTo) this.offerLink(card, r.node, r.connectTo);

		const btn = card.createEl("button", {
			text: this.idx + 1 < this.targetCount ? "Next question" : "Finish session",
			cls: "mod-cta",
		});
		btn.onclick = () => void this.goToQuestion(this.idx + 1);
		btn.focus();
	}

	/** A missing-link question offers to write the `[[link]]` into the graph — the
	 * "AI augments your graph" payoff. Button-gated: only an explicit click edits the
	 * note. Idempotent, and reflects an already-written link. */
	private offerLink(card: HTMLElement, fromNote: string, toNote: string): void {
		const box = card.createDiv({ cls: "grill-bridge-link" });
		if (this.bridges[pairKey(fromNote, toNote)]?.status === "linked") {
			box.createSpan({ cls: "grill-meta", text: `Linked ${fromNote} and ${toNote}.` });
			return;
		}
		box.createSpan({ cls: "grill-meta", text: "These two notes aren't linked yet." });
		const btn = box.createEl("button", { text: `Link ${fromNote} ↔ ${toNote}`, cls: "grill-connections-btn" });
		btn.onclick = async () => {
			const f = this.byName.get(fromNote);
			if (!f) {
				new Notice("Grill: couldn't find the note to link.");
				return;
			}
			btn.disabled = true;
			const ok = await this.plugin.store.linkNotes(f, toNote);
			if (ok) {
				this.recordBridgeResult(fromNote, toNote, "linked");
				await this.flush();
				btn.setText(`Linked ${fromNote} ↔ ${toNote}`);
				new Notice(`Grill: linked ${fromNote} and ${toNote}.`);
			} else {
				btn.disabled = false;
				new Notice("Grill: couldn't write the link.");
			}
		};
	}

	private async finishSession(): Promise<void> {
		// A replay writes nothing: no new session note, no AI debrief, just a plain summary.
		if (this.replayMode) {
			const s = this.plugin.data.settings;
			const debrief = deterministicDebrief(this.results);
			const perfect = this.results.length > 0 && this.results.every((r) => r.verdict === "correct" && !r.gaveUp);
			if (s.sounds) playSfx(perfect ? "perfect" : "complete");
			if (perfect && s.sounds) celebrate(this.contentEl.ownerDocument);
			this.renderSummary(null, debrief);
			return;
		}
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
				const out = await debriefSession(cfg, transcript, sessionNodes, existingCanon, rawTags, this.sessionPersona);
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
			this.questions.slice(0, this.results.length),
		);
		// A perfect run (every question correct, nothing given up) gets a fanfare and
		// confetti; any other completed session gets a gentle finish cue.
		const perfect = this.results.length > 0 && this.results.every((r) => r.verdict === "correct" && !r.gaveUp);
		if (s.sounds) playSfx(perfect ? "perfect" : "complete");
		if (perfect && s.sounds) celebrate(this.contentEl.ownerDocument);
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
		// Metacognitive calibration (opt-in): over/underconfidence across recent answers.
		if (this.plugin.data.settings.confidenceCheck) {
			const line = calibrationLine(this.plugin.data.calibration);
			if (line) this.md(line, box.createDiv({ cls: "grill-debrief-calibration grill-meta" }));
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
		// Redo the exact same questions with no generation (grading still per the setting).
		const redoable = this.questions.slice(0, this.results.length).filter((q) => !q.missingLink);
		if (redoable.length) {
			const redo = btnRow.createEl("button", { text: "Redo these" });
			redo.setAttr("aria-label", "Redo the same questions with no AI generation");
			redo.onclick = () => void this.startReplay(redoable);
		}
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

	/** Redo a saved session's questions verbatim (from a note's grill-redo block): no
	 * generation, no scheduling writes, graded per the current setting. Practice, not a
	 * review. */
	async startReplay(questions: Question[]): Promise<void> {
		const s = this.plugin.data.settings;
		const cfg = this.plugin.llmConfig();
		if (s.gradingMode === "ai" && !cfg) {
			new Notice('Grill: to redo with AI grading, set an API key, or switch grading to "I mark myself".', 8000);
			return;
		}
		const qs = questions.filter((q) => q && q.question && !q.missingLink);
		if (!qs.length) {
			new Notice("Grill: no questions to redo in this session.");
			return;
		}
		this.replayMode = true;
		this.sessionScope = null;
		this.sessionStart = new Date();
		this.questions = qs.map((q) => ({ ...q }));
		this.targets = [];
		this.results = [];
		this.idx = 0;
		this.pending = null;
		this.targetCount = this.questions.length;
		this.planCursor = 0;
		this.routesUsed = 0;
		this.routedNotes.clear();
		this.dirty = false;
		this.bankDirty = false;
		this.bridgesDirty = false;
		this.registry = {};
		this.concepts = {};
		this.conceptsByNote = new Map();
		this.conceptById = new Map();
		this.contextImages = [];
		this.noteImages = {};
		this.pendingConfidence = null;
		// Grading tone comes from the persona/instructions.
		const instr = await this.plugin.store.loadInstructions();
		this.sessionPersona = instr.persona;
		this.sessionInstructions = instr.preferences;
		// Current text of each quizzed note, so AI grading still has context.
		this.noteText = {};
		this.byName = new Map();
		for (const n of new Set(this.questions.map((q) => q.node))) {
			const f = this.app.vault
				.getMarkdownFiles()
				.find((file) => file.basename === n && !this.plugin.isExcluded(file.path));
			if (f) {
				this.byName.set(n, f);
				const raw = await this.app.vault.cachedRead(f);
				this.noteText[n] = raw.length > NOTE_CHAR_CAP ? raw.slice(0, NOTE_CHAR_CAP) + "\n[truncated]" : raw;
			} else {
				this.noteText[n] = "";
			}
		}
		this.renderQuestion();
	}

	/** Generate the next batch of questions and append them. At most one batch
	 * runs at a time; concurrent callers share the same in-flight promise. */
	private loadNextBatch(): Promise<void> {
		if (this.pending) return this.pending;
		if (this.questions.length >= this.targetCount) return Promise.resolve();
		if (this.planCursor >= this.targets.length) return Promise.resolve();
		const cfg = this.plugin.llmConfig();
		if (!cfg) return Promise.resolve();
		const run = async (): Promise<void> => {
			// Pull plan targets from the cursor until at least one question is delivered
			// (a generated batch can be fully dropped by the validator) or the plan is
			// exhausted. Advance the cursor by targets consumed, not questions produced,
			// so drops never cause a concept to be generated twice. Prebuilt targets
			// (user-authored, or a cache hit) cost no model call and yield immediately.
			while (this.planCursor < this.targets.length && this.questions.length < this.targetCount) {
					const pre = this.buildPrebuilt(this.targets[this.planCursor]);
					if (pre) {
						this.questions.push(pre);
						this.planCursor += 1;
						break; // made progress; yield so the UI can render
					}
					// Gather a run of consecutive generation-needing targets for one call.
					const batch: ConceptTarget[] = [];
					while (
						this.planCursor < this.targets.length &&
						batch.length < BATCH &&
						!this.isPrebuilt(this.targets[this.planCursor])
					) {
						batch.push(this.targets[this.planCursor]);
						this.planCursor += 1;
					}
					if (!batch.length) continue; // next loop handles the prebuilt target
					const qs = await generateQuestions(
						cfg,
						this.notesConcat,
						batch,
						this.contextImages,
						this.sessionInstructions,
						this.linksBlock,
						"standard",
						this.sessionPersona,
					);
					if (qs.length) {
						this.rememberGenerated(qs);
						for (const q of qs) this.questions.push(q);
						break;
					}
				}
			};
			// A fully-prebuilt (authored/cached) run resolves synchronously, so clearing
			// `pending` must happen AFTER this assignment, not inside run() (which would run
			// before it and leave a stale resolved promise wedged in `pending`, freezing the
			// queue). Clear it on settle, guarding against a newer in-flight run.
			const p = run();
			this.pending = p;
			void p.catch(() => undefined).finally(() => {
				if (this.pending === p) this.pending = null;
			});
			return p;
		}

	/** A cached question for this concept that is safe to reuse now, or null. Requires a
	 * bank entry whose source hash still matches the concept (note unchanged); rotates to
	 * the least-shown variant. With "reuse generated questions" set above 0, a variant
	 * that has been shown that many times forces a miss so a fresh variant is written. */
	private cacheHit(conceptId: string): CachedQuestion | null {
		const c = this.conceptById.get(conceptId);
		if (!c || c.authored) return null; // authored questions are verbatim, not banked
		const bank = this.questionBank[conceptId];
		if (!bank || !bank.length) return null;
		const fresh = bank.filter((e) => e.sourceHash === c.sourceHash);
		if (!fresh.length) return null;
		fresh.sort(
			(a, b) => a.timesShown - b.timesShown || (a.lastShownAt ?? "").localeCompare(b.lastShownAt ?? ""),
		);
		const pick = fresh[0];
		const regen = this.plugin.data.settings.regenerateEvery;
		if (regen > 0 && pick.timesShown >= regen && bank.length < MAX_VARIANTS) return null; // add variety
		return pick;
	}

	/** Whether a target needs no model call (user-authored, or a cache hit). Must agree
	 * with buildPrebuilt: an authored concept counts only if it actually has a question,
	 * otherwise loadNextBatch could spin on a target it can neither build nor batch. */
	private isPrebuilt(t: ConceptTarget): boolean {
		const c = this.conceptById.get(t.conceptId);
		if (c?.authored) return !!c.local;
		return this.cacheHit(t.conceptId) !== null;
	}

	/** Build a target's question without a model call: the verbatim authored question,
	 * or a rotated cache hit (bumping its use counters). Null when generation is needed. */
	private buildPrebuilt(t: ConceptTarget): Question | null {
		const c = this.conceptById.get(t.conceptId);
		if (c?.authored) {
			const q = localQuestionForConcept(c);
			if (q) q.routedFrom = t.routedFrom ?? q.routedFrom;
			return q;
		}
		const hit = this.cacheHit(t.conceptId);
		if (!hit) return null;
		hit.timesShown += 1;
		hit.lastShownAt = new Date().toISOString();
		this.bankDirty = true;
		// Strip cache metadata; carry this session's routing label onto the reused question.
		const { sourceHash: _sh, timesShown: _ts, lastShownAt: _ls, ...q } = hit;
		return { ...q, routedFrom: t.routedFrom ?? q.routedFrom };
	}

	/** Cache freshly generated questions per concept for reuse on later reviews. Skips
	 * authored (verbatim) and bridge (novel, un-scheduled) questions, prunes stale-hash
	 * variants, and caps the number kept per concept. */
	private rememberGenerated(qs: Question[]): void {
		for (const q of qs) {
			if (!q.conceptId || q.missingLink) continue;
			const c = this.conceptById.get(q.conceptId);
			if (!c || c.authored) continue;
			const kept = (this.questionBank[q.conceptId] ?? []).filter((e) => e.sourceHash === c.sourceHash);
			kept.push({ ...q, sourceHash: c.sourceHash, timesShown: 1, lastShownAt: new Date().toISOString() });
			this.questionBank[q.conceptId] = kept.slice(-MAX_VARIANTS);
			this.bankDirty = true;
		}
	}

	/** Missing-link finder: propose un-linked note pairs, confirm the real ones with the
	 * model, and append up to `max` as bridge questions (a capstone at the session's end).
	 * A bonus feature: any failure is swallowed so it never breaks a session. */
	private async appendBridgeTargets(cfg: LLMConfig, names: string[], max: number): Promise<void> {
		try {
			const cands = detectBridgeCandidates(this.app, names, this.byName, this.noteText, this.bridges);
			if (!cands.length) return;
			const confirmed = await adjudicateBridges(cfg, cands, this.sessionPersona);
			let added = 0;
			const now = new Date().toISOString();
			for (const c of confirmed) {
				if (added >= max) break;
				const key = pairKey(c.a, c.b);
				const prev = this.bridges[key];
				if (prev && prev.status !== "suggested") continue; // already resolved
				this.bridges[key] = { a: c.a, b: c.b, bridgeConcept: c.bridgeConcept, status: "suggested", lastSeen: now };
				this.bridgesDirty = true;
				this.targets.push({
					conceptId: `__bridge__:${key}`,
					note: c.a,
					label: c.bridgeConcept,
					context: `${(this.noteText[c.a] ?? "").slice(0, 600)}\n\n${(this.noteText[c.b] ?? "").slice(0, 600)}`,
					targetDifficulty: "hard",
					connectTo: c.b,
					bridge: true,
					bridgeConcept: c.bridgeConcept,
				});
				this.targetCount += 1;
				added += 1;
			}
		} catch {
			// Bridges are a bonus; never fail the session over them.
		}
	}

	/** Record that a bridge question was answered (or its link written), keyed by the
	 * note pair, so the pair isn't re-surfaced and the dashboard can count links made. */
	private recordBridgeResult(fromNote: string, toNote: string, status: "answered" | "linked"): void {
		const key = pairKey(fromNote, toNote);
		const rec = this.bridges[key];
		const now = new Date().toISOString();
		if (rec) {
			if (rec.status !== "linked") rec.status = status; // a written link is terminal
			rec.lastSeen = now;
		} else {
			this.bridges[key] = { a: fromNote, b: toNote, bridgeConcept: "", status, lastSeen: now };
		}
		this.bridgesDirty = true;
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
		this.replayMode = false;
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
			this.bridges = await this.plugin.store.loadBridges();
			this.questionBank = await this.plugin.store.loadQuestionBank();
			this.bankDirty = false;
			this.bridgesDirty = false;
			const instr = await this.plugin.store.loadInstructions();
			this.sessionPersona = instr.persona;
			this.sessionInstructions = instr.preferences;
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
			const graph = buildSessionGraph(this.app, selectedFiles);
			this.linksBlock = formatLinksBlock(graph, this.plugin.mastery);

			// Concept layer: reconcile the extracted concepts (create new ones,
			// re-open any whose source text changed), then pick which to test.
			this.concepts = await this.plugin.store.loadConcepts();
			const allConcepts: Concept[] = [];
			for (const cs of this.conceptsByNote.values()) allConcepts.push(...cs);
			reconcileConcepts(this.concepts, allConcepts);
			this.conceptById = new Map(allConcepts.map((c) => [c.id, c]));

			this.questions = [];
			this.results = [];
			this.idx = 0;
			this.pending = null;
			this.routesUsed = 0;
			this.routedNotes.clear();
			this.planCursor = 0;
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
					targetDifficulty: this.seedDifficulty(this.concepts[c.id], c.note, graph),
					activeMisconception,
				};
			});

			if (s.questionSource === "local") {
				this.questions = localQuestions(this.sessionConcepts, this.targetCount);
				this.renderQuestion();
				return;
			}

			// Missing-link finder: append up to N bridge questions as a capstone (AI only).
			if (s.graphInsights && s.bridgesPerSession > 0 && cfg) {
				await this.appendBridgeTargets(cfg, names, s.bridgesPerSession);
			}

			this.renderLoading(
				"Writing your questions",
				`${cfg!.model} is reading ${names.length} notes. This usually takes a few seconds.`,
			);
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
				const g = await this.gradeMaybeCareful(cfg, q, answer);
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
		this.captureConfidence(verdict);
		// Missed it: route to a weak prerequisite next, if this note builds on one.
		if (verdict === "incorrect") this.maybeRouteToPrerequisite(q.node);
		// Re-probed a known confusion and got it right: mark it resolved.
		if (q.targetsMisconception && verdict === "correct" && this.registry[q.targetsMisconception]) {
			resolveMisconception(this.registry, q.targetsMisconception);
			this.dirty = true;
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
			missingLink: q.missingLink,
			connectTo: q.connectTo,
		};
		this.results.push(r);
		this.renderFeedback(r);
	}

	/** Grade one answer. With "careful grading" on, run a small consensus and keep the
	 * strictest verdict, since the measured failure of LLM grading is over-leniency
	 * (marking a weak answer correct), which would quietly corrupt the FSRS signal. */
	private async gradeMaybeCareful(cfg: LLMConfig, q: Question, answer: string): Promise<Grade> {
		const once = (): Promise<Grade> =>
			gradeAnswer(
				cfg,
				q,
				this.noteText[q.node] ?? "",
				answer,
				this.noteImages[q.node] ?? [],
				this.sessionInstructions,
				this.sessionPersona,
			);
		if (!this.plugin.data.settings.carefulGrade) return once();
		const grades = await Promise.all([once(), once(), once()]);
		const rank: Record<Verdict, number> = { incorrect: 0, partial: 1, correct: 2 };
		grades.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
		return grades[0]; // strictest verdict (and its feedback) wins
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

		if (q.missingLink && q.connectTo) this.offerLink(card, q.node, q.connectTo);
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
		// Replay is practice-only: never touch the schedule or stats.
		if (this.replayMode) return;
		// A missing-link bridge question is outside FSRS scheduling: it isn't a note
		// concept, so it must not touch concept or note mastery. Record the pair instead.
		if (q.missingLink) {
			if (q.connectTo) this.recordBridgeResult(q.node, q.connectTo, "answered");
			return;
		}
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
		if (this.dirty) {
			this.dirty = false;
			await this.plugin.store.saveConcepts(this.concepts);
			await this.plugin.store.saveMastery(this.plugin.mastery);
			await this.plugin.store.saveRegistry(this.registry);
		}
		if (this.bankDirty) {
			this.bankDirty = false;
			await this.plugin.store.saveQuestionBank(this.questionBank);
		}
		if (this.bridgesDirty) {
			this.bridgesDirty = false;
			await this.plugin.store.saveBridges(this.bridges);
		}
	}

	async onClose(): Promise<void> {
		this.map?.dispose();
		this.map = null;
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

	/** Structural difficulty seed: a brand-new (untested) concept starts one rung up
	 * (medium, not easy) when its note builds only on foundations the student has
	 * already confirmed. No point lobbing the easiest possible question at an advanced
	 * note whose prerequisites are solid. Seeds DIFFICULTY only, never mastery, so it
	 * can't create a coverage illusion; any shaky prerequisite keeps it easy. */
	private seedDifficulty(cm: ConceptMastery | undefined, note: string, graph: SessionGraph): QDifficulty {
		const base = conceptTargetDifficulty(cm);
		if (base !== "easy" || conceptTested(cm)) return base; // only seed the first exposure
		const prereqs = graph.adjacency[note]?.linksTo ?? [];
		if (!prereqs.length) return base;
		const statuses = prereqs.map((p) => statusOf(this.plugin.mastery[p]));
		if (statuses.some((s) => s === "struggling")) return "easy"; // shaky foundation: stay easy
		return statuses.some((s) => s === "known") ? "medium" : base; // a solid foundation: start up
	}

	/** Record the current question's confidence-vs-outcome point, if the confidence
	 * check is on and the user picked a level. Persists immediately so it survives a
	 * mid-session close. */
	private captureConfidence(verdict: Verdict): void {
		if (this.replayMode) return; // practice-only: don't record calibration
		if (!this.plugin.data.settings.confidenceCheck || this.pendingConfidence === null) return;
		const ok = verdict === "correct" ? 1 : verdict === "partial" ? 0.5 : 0;
		pushCalibration(this.plugin.data.calibration, this.pendingConfidence, ok);
		this.pendingConfidence = null;
		void this.plugin.persist();
	}

	/** Weakness rank for a note: struggling (0) before untested (1) before known (2). */
	private noteWeakness(note: string): number {
		const st = statusOf(this.plugin.mastery[note]);
		return st === "struggling" ? 0 : st === "untested" ? 1 : 2;
	}

	/** Reactive DOWN-on-failure routing: after a wrong answer, if the missed note
	 * builds on a prerequisite the student is weak on, insert a question about that
	 * prerequisite next so they shore up the foundation before moving on. Bounded to
	 * MAX_ROUTES per session, never the same prerequisite twice, and only when the
	 * prerequisite is in this session with a weak, not-already-planned concept. */
	private maybeRouteToPrerequisite(fromNote: string): void {
		if (this.replayMode) return; // no generation or plan mutation during a replay
		if (this.routesUsed >= MAX_ROUTES) return;
		const file = this.byName.get(fromNote);
		if (!file) return;
		const local = this.plugin.data.settings.questionSource === "local";
		const planned = new Set(this.targets.map((t) => t.conceptId));
		const prereqs = outgoingBasenames(this.app, file)
			.filter((p) => p !== fromNote && this.byName.has(p) && !this.routedNotes.has(p))
			.sort((a, b) => this.noteWeakness(a) - this.noteWeakness(b));
		for (const p of prereqs) {
			if (this.noteWeakness(p) === 2) break; // sorted weakest-first: the rest are known
			const concept = (this.conceptsByNote.get(p) ?? []).find(
				(c) => !planned.has(c.id) && (!local || c.local) && statusOf(this.concepts[c.id]) !== "known",
			);
			if (!concept) continue;
			if (this.insertRoutedTarget(concept, fromNote, local)) {
				this.routedNotes.add(p);
				this.routesUsed += 1;
				return;
			}
			// Couldn't build a question for this prerequisite; try the next one.
		}
	}

	/** Splice a routed prerequisite concept in as the next question, preserving the
	 * targets<->questions position coupling. Returns false if it couldn't build one. */
	private insertRoutedTarget(concept: Concept, fromNote: string, local: boolean): boolean {
		const target: ConceptTarget = {
			conceptId: concept.id,
			note: concept.note,
			label: concept.label,
			context: concept.context,
			targetDifficulty: "easy", // a shaky foundation: plain recall
			routedFrom: fromNote,
		};
		if (local) {
			// No lazy generation in no-key mode: build the deterministic question now
			// and splice it in as the very next question.
			const built = localQuestions([concept], 1);
			if (!built.length) return false; // no deterministic question for this concept
			built[0].routedFrom = fromNote;
			this.questions.splice(this.idx + 1, 0, built[0]);
		} else {
			// AI mode: put the prerequisite at the front of the not-yet-generated plan
			// so it is the next question written. `questions` is not positionally coupled
			// to `targets`, so this cannot desync a prefetch that is already in flight.
			this.targets.splice(this.planCursor, 0, target);
		}
		this.targetCount += 1;
		return true;
	}

	private async recordSelfGrade(rating: Rating, answer: string, gaveUp: boolean, hintsUsed: number): Promise<void> {
		const q = this.questions[this.idx];
		const verdict: Verdict = rating === 1 ? "incorrect" : rating === 2 ? "partial" : "correct";
		if (this.plugin.data.settings.sounds) playSfx(verdict);
		await this.applyGrade(q, verdict, rating, undefined);
		if (verdict === "incorrect") this.maybeRouteToPrerequisite(q.node);
		if (q.targetsMisconception && verdict === "correct" && this.registry[q.targetsMisconception]) {
			resolveMisconception(this.registry, q.targetsMisconception);
			this.dirty = true;
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
			missingLink: q.missingLink,
			connectTo: q.connectTo,
		});
		await this.goToQuestion(this.idx + 1);
	}
}
