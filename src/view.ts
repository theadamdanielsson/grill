/** Quiz session side panel. */

import { ItemView, MarkdownRenderer, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type GrillPlugin from "./main";
import { adjudicateBridges, ConceptTarget, debriefSession, explainQuestion, formatSatisfies, generateQuestions, Grade, gradeAnswer, LLMConfig, Question, supportsVision, Verdict } from "./llm";
import { Concept, ConceptKind, extractConcepts, localQuestionForConcept, localQuestions } from "./generate-local";
import { BridgeMap, detectBridgeCandidates, pairKey } from "./bridges";
import { buildGraph, formatGrade, gradeScore, type GraphNode } from "./graph";
import { GraphAppearance, LearningMap, MapPalette } from "./mapview";
import type { CachedQuestion, QuestionBank } from "./store";
import {
	ConceptMap,
	ConceptMastery,
	blockedByDailyCap,
	conceptTargetDifficulty,
	conceptTested,
	dueConceptCount,
	noteAggregate,
	pickConcepts,
	priorityNotes,
	recordConceptAnswer,
	recordConceptRating,
	reconcileConcepts,
} from "./concepts";
import { collectNoteImages, ImageInput } from "./images";
import { collectNotePdfText } from "./pdf";
import { safeSlice } from "./text";
import {
	buildDueDateHistogram,
	DueDateHistogram,
	emptyMastery,
	interleaveByFolder,
	NoteMastery,
	pickCandidates,
	QDifficulty,
	Rating,
	recordNoteStats,
	statusOf,
} from "./mastery";
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
	dismissMisconception,
	mergeAssignments,
	MisconceptionRegistry,
	resolveMisconception,
	SessionDebrief,
	topMisconceptions,
} from "./debrief";
import { dueFiles, filesForScope, listFolders, listTags, Scope, untestedFiles } from "./scope";
import { CONFIDENCE_LEVELS, calibrationLine, pushCalibration } from "./calibration";
import { celebrate, playSfx } from "./sfx";
import { speak, stopSpeaking, toSpeechText, ttsAvailable } from "./tts";
import { SessionEntry } from "./store";

export const VIEW_TYPE = "grill-session";

/** Grill's own flame silhouette for the verdict badge (7x10, crisp pixel blocks — the
 * same shape-rendering technique used in the plugin's hero art) instead of a generic
 * Lucide circle-check/circle-x, which every other app also uses. One shape for every
 * verdict; only the badge's own text color (.grill-v-correct/partial/incorrect/skipped)
 * differentiates it, via currentColor, so a Style Settings retint still works. */
const FLAME_ICON_CELLS: [number, number][] = [
	[3, 0],
	[3, 1],
	[4, 1],
	[2, 2],
	[3, 2],
	[4, 2],
	[2, 3],
	[3, 3],
	[4, 3],
	[5, 3],
	[1, 4],
	[2, 4],
	[3, 4],
	[4, 4],
	[5, 4],
	[1, 5],
	[2, 5],
	[3, 5],
	[4, 5],
	[5, 5],
	[1, 6],
	[2, 6],
	[3, 6],
	[4, 6],
	[5, 6],
	[6, 6],
	[1, 7],
	[2, 7],
	[3, 7],
	[4, 7],
	[5, 7],
	[2, 8],
	[3, 8],
	[4, 8],
	[5, 8],
	[2, 9],
	[3, 9],
	[4, 9],
];
/** Builds the flame icon as real SVG DOM nodes, not an innerHTML string — Obsidian's
 * plugin review flags raw innerHTML assignment as unsafe even for fully static,
 * hardcoded content like this, so every cell is its own createElementNS'd <rect>. */
function renderFlameIcon(container: HTMLElement): void {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 7 10");
	svg.setAttribute("shape-rendering", "crispEdges");
	svg.setAttribute("fill", "currentColor");
	for (const [x, y] of FLAME_ICON_CELLS) {
		const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		rect.setAttribute("x", String(x));
		rect.setAttribute("y", String(y));
		rect.setAttribute("width", "1");
		rect.setAttribute("height", "1");
		svg.appendChild(rect);
	}
	container.appendChild(svg);
}

const NOTE_CHAR_CAP = 4000;
/** Sanity ceiling, not a meaningful UX cap, used wherever a session must not be capped
 * by the normal per-sitting settings: a due-only session's question count (due sessions
 * must not be capped by `questionsPerSession` — that setting is for how much a study
 * session asks per sitting, not how much of the due backlog gets cleared, otherwise
 * "Review N due now" silently only reviews the first `questionsPerSession` of them, a
 * note with several due concepts never fully clears in one pass, and the due count can
 * look like it barely moves no matter how many sessions you run) and any explicitly
 * scoped session's note count (`autoNotesPoolCap` below is for auto-selecting a slice
 * of the WHOLE vault, not for truncating notes the user deliberately chose). 200 used to
 * sit here, which was itself a real cap for anyone with a backlog above it (missed a
 * couple weeks across a normal-sized vault) — silently reintroducing the exact bug this
 * constant exists to avoid. 5000 is comfortably past any real due backlog while still
 * bounding the worst case. */
const NO_MEANINGFUL_CAP = 5000;

/** How many notes to scan for an unscoped, auto-selected session — not a setting to
 * hand-tune, since it isn't an independent preference: it's scaled to what the session
 * actually needs to fill (`questionsPerSession`), not the vault size or anything else.
 * A note doesn't guarantee a usable concept, and the due/fresh/rest picker (see
 * reserveFreshSlots) needs real breadth to choose from rather than the bare minimum, so
 * the pool is a multiple of the target, not equal to it — floored so a small session
 * still gets a reasonable pool to pick from, capped by the vault itself. */
function autoNotesPoolCap(questionsPerSession: number, totalNotes: number): number {
	return Math.min(totalNotes, Math.max(questionsPerSession * 2, 15));
}

/** Progress bar segment cap — see progressBar's bucketing comment. */
const MAX_PROGRESS_SEGMENTS = 30;
/** Ascending severity for bucketing multiple questions into one progress segment: a
 * recorded wrong answer outranks "you're currently here", which outranks a recorded
 * correct answer. */
const SEG_SEVERITY = ["grill-seg-correct", "grill-seg-current", "grill-seg-skipped", "grill-seg-partial", "grill-seg-incorrect"];
/** Questions generated per model call. Small batches cut the wait before the
 * first question and let the next batch prefetch while the user answers. */
const BATCH = 2;
/** Deterministic per-session rotation for seedType(): mirrors how targetDifficulty is
 * already assigned server-side rather than left to the model. Left to its own
 * discretion, a model reliably regresses to only 'mc'/'blank'/'write' in practice — a
 * real 15-question session produced zero 'tf'/'multi'/'match' despite explicit
 * instructions offering them (see FORMAT_MIX_INSTRUCTIONS). 5 of 10 slots are 'write',
 * matching the earlier "roughly half write" intent, now enforced by construction
 * instead of hoped for. */
const FORMAT_ROTATION: NonNullable<Question["type"]>[] = [
	"write",
	"mc",
	"write",
	"blank",
	"write",
	"tf",
	"write",
	"multi",
	"write",
	"match",
];
/** Concept kinds broad enough to genuinely support 'multi'/'match' (several related
 * items) — see seedType. */
const BROAD_CONCEPT_KINDS = new Set<ConceptKind>(["heading", "note"]);
/** Most images to pull from a single note, and across a whole session's context,
 * so a screenshot-heavy vault doesn't run up a huge image-token bill. */
const IMAGES_PER_NOTE_CAP = 4;
const CONTEXT_IMAGE_CAP = 12;
/** Reactive prerequisite routing: most detours inserted per session, so a run of
 * wrong answers can't balloon the session or chain endlessly down the link graph. */
const MAX_ROUTES = 3;
/** Most misconception-contagion probes inserted per session — deliberately smaller
 * than MAX_ROUTES since this is a more speculative mechanic (re-probing a raw,
 * not-yet-canonicalized tag on a note it may or may not actually apply to). */
const MAX_CONTAGION = 2;

interface QuestionResult extends SessionEntry {
	hintsUsed: number;
	/** Raw grader misconception tag, if any; consumed by the end-of-session debrief. */
	misconceptionTag?: string;
	/** Set for a missing-link bridge question, with the un-linked partner note, so the
	 * feedback screen can offer to write the link. */
	missingLink?: boolean;
	connectTo?: string;
}

/** A prerequisite reactive-routing candidate, found but not yet committed — used to
 * gate the last-question-of-the-session case behind a consent prompt. */
interface PrereqRoute {
	concept: Concept;
	prereqNote: string;
	local: boolean;
}

/** A misconception-contagion candidate: the same confusion the student just showed on
 * `fromNote`, tested on a linked, not-yet-known neighbor before they naturally hit it
 * there. Found but not yet committed. AI mode only — there's no deterministic way to
 * judge whether a raw grader tag plausibly applies elsewhere without a model in the
 * loop, so this never fires in no-key mode. */
interface ContagionRoute {
	concept: Concept;
	neighborNote: string;
	tag: string;
}

/** A reactive session extension offered but not yet accepted/declined by the student:
 * either a prerequisite route or a misconception-contagion probe. Only one kind can be
 * pending at a time (see submitAnswer/recordSelfGrade — prerequisite takes priority). */
type PendingExtension =
	| { kind: "prerequisite"; route: PrereqRoute; fromNote: string }
	| { kind: "contagion"; route: ContagionRoute; fromNote: string };

/** Most cached question variants kept per concept, to bound questions.json growth. */
const MAX_VARIANTS = 8;
/** Most prior question texts shown to the model when regenerating a concept, so the
 * "already asked, write something different" hint stays a bounded prompt addition
 * even once a concept's bank is near MAX_VARIANTS deep. */
const MAX_PRIOR_SHOWN = 3;
/** Word-overlap (Jaccard) threshold above which a freshly generated question is
 * treated as a near-restatement of an existing bank variant rather than a genuinely
 * new one. Deliberately loose (not exact-match) — models restate with light rewording
 * (swapped synonyms, reordered clauses) far more often than verbatim repeats. */
const NEAR_DUPLICATE_THRESHOLD = 0.75;
/** Cap on learning-graph nodes laid out + drawn, so a huge vault stays responsive. */
const MAP_NODE_CAP = 600;

/** A millisecond gap as the coarsest unit that reads naturally ("13m", "4h", "2d") —
 * for `dueReasonTag`, where the exact minute never matters, only the rough scale. */
function formatAgo(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Lightweight, dependency-free duplicate detector: Jaccard similarity over
 * normalized word sets. Deliberately not exact-string matching — a model asked to
 * write "something different" usually still restates the same question with a
 * synonym swapped or a clause reordered, which exact match would let straight
 * through. Symmetric and cheap enough to run on every generated question. */
function questionSimilarity(a: string, b: string): number {
	const words = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, " ")
				.split(/\s+/)
				.filter(Boolean),
		);
	const wa = words(a);
	const wb = words(b);
	if (!wa.size || !wb.size) return 0;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / (wa.size + wb.size - shared);
}

export class SessionView extends ItemView {
	plugin: GrillPlugin;
	private noteText: Record<string, string> = {};
	private byName = new Map<string, TFile>();
	/** When set, sessions draw only from these files (Grill this note/folder). */
	sessionScope: TFile[] | null = null;
	/** Due-queue sessions (status bar, "Review N due"): only due/struggling
	 * concepts, never padded with untested/known ones to fill a full session. */
	private dueOnly = false;

	private results: QuestionResult[] = [];
	private idx = 0;
	private sessionStart = new Date();

	// Streaming generation state.
	private questions: Question[] = [];
	private targetCount = 0;
	/** Relationships between the session's notes, from their links. */
	private linksBlock = "";
	/** Canonical misconception registry, held for the session (re-probe + resolve). */
	private registry: MisconceptionRegistry = {};
	/** Per-concept scheduling state (the source of truth for scheduling). */
	private concepts: ConceptMap = {};
	/** How many concepts already land on each due date, built once at session start
	 * from the full concept map — lets fuzzInterval spread newly-scheduled reviews
	 * across less-crowded days instead of pure random jitter. See applyGrade. */
	private dueDateHistogram: DueDateHistogram = new Map();
	/** Each selected note's current concepts, for recomputing its aggregate. */
	private conceptsByNote = new Map<string, Concept[]>();
	/** Concept lookup by id, for prebuilt (authored / cached) questions. */
	private conceptById = new Map<string, Concept>();
	/** Missing-link records (which pairs surfaced / were linked), held for the session. */
	private bridges: BridgeMap = {};
	/** Per-concept cache of generated questions, reused across reviews. */
	private questionBank: QuestionBank = {};
	/** True once `questionBank` has been loaded from disk, either by starting a session or
	 * by opening the manage-questions screen — the two share this one in-memory copy so
	 * neither can silently overwrite an edit the other just made. */
	private bankLoaded = false;
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
	/** Set by renderMap once mounted: rebuilds the map from exactly a given note set (or
	 * the whole vault, for null) — see renderMap's own rebuildMap for why this replaced
	 * dimming via setHighlight. Lets renderStart's Custom Study section preview a scope
	 * on the map (defined outside renderMap's closure) without renderMap needing to know
	 * anything about session scope itself. Cleared alongside `map` itself so a stale
	 * closure over a disposed render pass's `canvas`/`graph` can't fire after the screen
	 * moves on. */
	private mapRebuild: ((restrict: Set<string> | null) => void) | null = null;
	/** Stops the in-flight confetti burst, if `celebrate` was called and hasn't
	 * finished on its own yet — invoked from onClose so closing the pane mid-burst
	 * doesn't leave it animating over the app after the view is gone. */
	private confettiStop: (() => void) | null = null;
	/** The concepts this session tests, in order. */
	private sessionConcepts: Concept[] = [];
	/** Concept targets for the AI generator (one question each, by construction). */
	private targets: ConceptTarget[] = [];
	/** Session state changed in memory and needs flushing to disk. Writes are
	 * batched to session end / pane close to avoid a per-answer sync storm. */
	private dirty = false;
	/** Images per note, resolved once when a vision model is in use. */
	private noteImages: Record<string, ImageInput[]> = {};
	/** Whether this session's model can see images at all; per-batch notes text only
	 * warns about un-sendable embeds for notes actually in that batch. */
	private sessionVision = false;
	/** Notes with image embeds that couldn't be sent (no vision support / off), so a
	 * batch touching one of them can say so instead of silently ignoring the image. */
	private notesWithUnsentImages = new Set<string>();
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
	/** Each session note's rank in the session graph's foundationalOrder (lower = more
	 * heavily depended-upon by other session notes), captured once at session setup so
	 * reactive routing — which runs later, per answer — can prefer shoring up the most
	 * globally-connected weak prerequisite over just the first one found. */
	private noteFoundationalRank = new Map<string, number>();
	/** Each session note's undirected neighbors (outgoing + incoming links, deduped),
	 * captured once at session setup for misconception contagion to walk later. */
	private sessionNeighbors = new Map<string, string[]>();
	/** Misconception-contagion budget: probes spent, and neighbors already probed (so
	 * the same neighbor isn't targeted twice in one session). */
	private contagionUsed = 0;
	private contagionNotes = new Set<string>();
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
	/** Snapshot of the just-graded concept's pre-answer FSRS state, taken right before
	 * `applyGrade` mutates it, so a wrong verdict can be corrected via "Mark correct"
	 * without hand-rolling an FSRS "undo": restore this, then replay the exact same
	 * scheduling call with verdict forced to "correct". Single-use and overwritten each
	 * answer (null for self-grade, where the student's own rating IS the ground truth,
	 * and for missing-link questions, which have no concept schedule to correct). */
	private pendingOverride: {
		conceptId: string;
		conceptSnapshot: ConceptMastery;
		note: string;
		originalVerdict: Verdict;
		originalMisconceptionTag: string | undefined;
		difficulty: QDifficulty;
		confidence: number | null;
		hintsUsed: number;
	} | null = null;
	/** The choice clicked on a multiple-choice question, captured for `doAction` to
	 * read as its "answer" — mc has no textarea to read from. */
	private mcPicked = "";

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
		this.registerDomEvent(document, "keydown", (e) => this.handleSessionKeydown(e));
	}

	/** Enter/Space advances past the feedback screen, matching the "press enter to
	 * continue" convention most quiz/flashcard tools use. One persistent listener,
	 * gated by current DOM state rather than re-registered per render (Obsidian's
	 * Component cleanup runs on view close, not on each re-render, so a per-render
	 * registration would accumulate duplicate listeners over a session). Guarded
	 * the way a well-tested reference implementation (obsidian-spaced-repetition's
	 * review keydown handler) does: bail before touching anything unless the key
	 * actually means something right now, so it never fights typing.
	 * `.grill-verdict` only exists once a question has been graded (never during
	 * answering), and `.grill-route-consent` marks the "take one more question?"
	 * sub-screen, which has its own two buttons, not a single "advance" — excluded
	 * so this never fires the wrong one. The button itself is already focused (see
	 * `renderFeedback`'s `btn.focus()`) the moment feedback renders, and a focused
	 * `<button>` natively fires its own click on Enter/Space — so if it's still
	 * focused, do nothing and let that native behavior handle it; this listener is
	 * only a fallback for once focus has moved elsewhere (e.g. clicking the note
	 * chip to peek at it), where nothing would otherwise respond to Enter/Space. */
	private handleSessionKeydown(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key !== "Enter" && e.key !== " ") return;
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
		const root = this.contentEl;
		if (!root.querySelector(".grill-verdict") || root.querySelector(".grill-route-consent")) return;
		const btn = root.querySelector<HTMLButtonElement>(".grill-submit-btn");
		if (!btn || btn.disabled || document.activeElement === btn) return;
		e.preventDefault();
		btn.click();
	}

	/** Called after mastery finishes loading asynchronously post-launch: `this.plugin.mastery`
	 * starts as an empty placeholder and is only populated once `loadMastery()` resolves, so a
	 * pane already open at that point (e.g. persisted open across an app reload) can render its
	 * start screen from the empty placeholder first — showing 0 known/struggling and every note
	 * untested — with nothing to tell it the real data arrived a moment later. Re-render, but
	 * only if still idle on the start screen (checked via a DOM marker, not extra state), so this
	 * never interrupts an active question, loading screen, or summary. */
	refreshIfOnStartScreen(): void {
		if (this.contentEl.querySelector(".grill-scope-header")) this.renderStart();
	}

	/** Public entry so the plugin can force the first-run screen on install. */
	showOnboarding(): void {
		this.renderOnboarding();
	}

	/** Push the current colour/number-overlay settings into an already-open graph, without
	 * the re-layout a full re-render would cause — so changing a display setting doesn't
	 * jostle the simulation or lose the user's dragged positions. No-op if the graph isn't
	 * currently on screen. */
	updateMapDisplay(): void {
		if (!this.map) return;
		const s = this.plugin.data.settings;
		this.map.setColorMode(s.graphColorMode);
		this.map.setNumberDisplay(s.graphNumberMode, s.graphCoverageWeight / 100);
	}

	/** First-run: choose which folders are Grill's study material + graph. */
	private renderOnboarding(): void {
		const wrap = this.root(true);
		// First impression, one-time, non-interactive-heavy — the same full cabinet as
		// the start screen, not the subtle touch reserved for the actual study flow.
		const screen = wrap.createDiv({ cls: "grill-arcade-screen" });
		screen.createDiv({ cls: "grill-arcade-mark", text: "GRILL" });
		screen.createDiv({ cls: "grill-score", text: "Welcome to Grill" });

		const how = screen.createEl("ul", { cls: "grill-onboard-how" });
		const point = (lead: string, rest: string): void => {
			const li = how.createEl("li");
			li.createEl("strong", { text: lead });
			li.appendText(` ${rest}`);
		};
		point("Quiz yourself", "on your own notes. Grill writes the questions.");
		point("Watch your map fill in", "as you prove what you know.");
		point("Study anything", "in one folder, a tag, or the whole vault.");

		// The default (AI questions + AI grading) needs a key, and onboarding used to
		// never ask — a fresh install with no key clicked "Get grilled" and hit a dead
		// Notice on its very first try. Asking here means the no-key path is a conscious
		// pick, not a discovery made by failing.
		screen.createDiv({ cls: "grill-section-label", text: "How do you want to study?" });
		let mode: "ai" | "local" = "ai";
		const modeBox = screen.createDiv({ cls: "grill-mode-choice" });
		const aiCard = modeBox.createDiv({ cls: "grill-mode-card is-active" });
		aiCard.createDiv({ cls: "grill-mode-title", text: "AI-powered" });
		aiCard.createDiv({
			cls: "grill-meta",
			text: "AI writes and grades questions from your notes. Needs an API key — add one in Settings after this.",
		});
		const localCard = modeBox.createDiv({ cls: "grill-mode-card" });
		localCard.createDiv({ cls: "grill-mode-title", text: "Fully offline" });
		localCard.createDiv({
			cls: "grill-meta",
			text: "Questions built from your notes' own structure, graded by you. No key, no cost, nothing leaves your vault.",
		});
		const pickMode = (m: "ai" | "local"): void => {
			mode = m;
			aiCard.toggleClass("is-active", m === "ai");
			localCard.toggleClass("is-active", m === "local");
		};
		aiCard.onclick = () => pickMode("ai");
		localCard.onclick = () => pickMode("local");

		screen.createDiv({ cls: "grill-section-label", text: "Which folders should Grill study?" });
		screen.createEl("p", {
			cls: "grill-meta",
			text: "Tick some, or leave them all unticked to use your whole vault. You can change this any time in settings.",
		});

		const folderRoot = `${this.plugin.data.settings.folder}/`;
		const eligible = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(folderRoot));
		const folders = listFolders(eligible);
		const chosen = new Set<string>();

		if (!folders.length) {
			screen.createEl("p", { cls: "grill-meta", text: "No folders found — Grill will use your whole vault." });
		} else {
			const boxes: HTMLInputElement[] = [];
			const controls = screen.createDiv({ cls: "grill-onboard-controls" });
			const selectAll = controls.createEl("a", { cls: "grill-chip-link", text: "Select all" });
			const clear = controls.createEl("a", { cls: "grill-chip-link", text: "Clear" });
			const list = screen.createDiv({ cls: "grill-onboard-folders" });
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

		const btn = screen.createEl("button", { text: "Get started", cls: "mod-cta grill-start-btn grill-primary-cta" });
		btn.onclick = async () => {
			this.plugin.data.settings.includedFolders = [...chosen];
			if (mode === "local") {
				this.plugin.data.settings.questionSource = "local";
				this.plugin.data.settings.gradingMode = "self";
			}
			this.plugin.data.settings.onboarded = true;
			await this.plugin.persist();
			this.plugin.refreshStatusBar();
			this.renderStart();
		};
	}

	/** `arcade` is true only for the three screens that build a `.grill-arcade-screen`
	 * child (onboarding, start, dashboard) — it drives their cabinet-fills-the-pane
	 * layout via a plain class toggle here rather than a `:has()` selector in CSS,
	 * which the same three callers would otherwise force the browser to re-evaluate
	 * against every layout change. */
	private root(arcade = false): HTMLElement {
		// Tear down the map's canvas loop / observers whenever a screen re-renders.
		this.map?.dispose();
		this.map = null;
		this.mapRebuild = null;
		// A read-aloud from the previous screen shouldn't keep talking over this one.
		stopSpeaking();
		const el = this.contentEl;
		el.empty();
		el.addClass("grill-view");
		el.toggleClass("grill-arcade-mode", arcade);
		const wrap = el.createDiv({ cls: "grill-wrap" });
		wrap.toggleClass("grill-compact", this.plugin.data.settings.compact);
		wrap.toggleClass("grill-arcade-mode", arcade);
		return wrap;
	}

	/** `sourcePath` is what Obsidian resolves relative `[[wikilinks]]` against — without
	 * it (the old hardcoded `""`), a link in a question/hint/answer/debrief resolves as
	 * if written at the vault root, so it breaks the moment the target note isn't
	 * uniquely named there (any subfoldered or duplicate-basename vault). Callers with a
	 * concrete note in scope should pass its path; only truly note-less content (a
	 * synthetic message with no user-authored links in it) should fall back to "". */
	private md(markdown: string, el: HTMLElement, sourcePath = ""): void {
		void MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
	}

	private openNote(name: string): void {
		void this.app.workspace.openLinkText(name, "", false);
	}

	/** Load `questionBank` on demand for screens that need it without a session active
	 * (the manage-questions screen) — a no-op once a session (or a prior call here) has
	 * already loaded it, so it's safe to call from multiple entry points. */
	private async ensureQuestionBank(): Promise<void> {
		if (this.bankLoaded) return;
		this.questionBank = await this.plugin.store.loadQuestionBank();
		this.bankLoaded = true;
	}

	// ------------------------------------------------------------ screens

	/** All notes eligible for quizzing, ignoring the current session scope. */
	private allEligible(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => !this.plugin.isExcluded(f.path));
	}

	private renderStart(): void {
		const wrap = this.root(true);
		const map = this.plugin.mastery;
		const eligible = this.allEligible();

		// The arcade cabinet: everything on this screen lives on the lit CRT ground,
		// framed in the banner's gold/ember double border. See .grill-arcade-screen.
		const screen = wrap.createDiv({ cls: "grill-arcade-screen" });
		screen.createDiv({ cls: "grill-arcade-mark", text: "GRILL" });

		const statsEl = screen.createDiv({ cls: "grill-stats grill-start-stats" });
		const addStat = (label: string, tone?: "correct" | "incorrect"): HTMLElement => {
			const tile = statsEl.createDiv({ cls: tone ? `grill-stat grill-stat-${tone}` : "grill-stat" });
			const value = tile.createDiv({ cls: "grill-stat-value" });
			tile.createDiv({ cls: "grill-stat-label", text: label });
			return value;
		};
		const notesStat = addStat("Notes");
		const knownStat = addStat("Known", "correct");
		const strugglingStat = addStat("Learning", "incorrect");
		const untestedStat = addStat("Untested");
		const showCounts = (files: TFile[]): void => {
			const counts = { untested: 0, struggling: 0, known: 0 };
			for (const f of files) counts[statusOf(map[f.basename])]++;
			notesStat.setText(String(files.length));
			knownStat.setText(String(counts.known));
			strugglingStat.setText(String(counts.struggling));
			untestedStat.setText(String(counts.untested));
		};
		showCounts(eligible);

		// Highest-intent action first: one tap straight into the due queue. Mobile
		// has no status bar, so this is the due signal there too.
		// `due` (notes) seeds which notes' concepts get extracted for the session;
		// the button's own count is concept-level, matching what that session
		// actually queues (see GrillPlugin.dueCount's doc comment) rather than the
		// smaller number of notes that merely CONTAIN a due concept.
		const due = dueFiles(eligible, this.plugin.concepts);
		const dueNames = new Set(due.map((f) => f.basename));
		const dueNow = dueConceptCount(this.plugin.concepts, (note) => dueNames.has(note));
		// The due-CTA row (and the manage-questions pencil riding alongside it) only makes
		// sense once there's actually history to act on — a brand new vault with nothing
		// ever reviewed has no due queue AND an empty question bank, so there's nothing
		// for either button to do yet. Once something HAS been reviewed, though, the row
		// stays up even at zero due (relabeled "No reviews for now") rather than vanishing
		// and reappearing — the pencil's target (the question bank) doesn't go away just
		// because you're caught up today.
		const everReviewed = Object.values(this.plugin.concepts).some((cm) => conceptTested(cm));
		if (everReviewed) {
			// The pencil is a full separate button (not clipped into the due-CTA's edge —
			// that made it read as a bare icon and cut its own hover highlight off against
			// the due-CTA's rounded corner). Two CSS-only attempts at matching its height to
			// the due-CTA's own (shared font-size/padding math, then an absolute-positioned
			// overlay) each made things worse — an icon-only button just doesn't produce the
			// same line-box height as a text button from the same font-size/padding. Once
			// both buttons actually exist in the DOM below, the due-CTA's real rendered
			// height is read directly and applied to the pencil — an exact match with
			// nothing left to approximate.
			const ctaRow = screen.createDiv({ cls: "grill-cta-row" });
			const cta = ctaRow.createEl("button", {
				text: dueNow ? `Review ${dueNow} due now` : "No reviews for now",
				cls: "mod-cta grill-due-cta",
			});
			if (dueNow) {
				cta.onclick = () => {
					this.sessionScope = due;
					this.dueOnly = true;
					void this.startSession();
				};
			} else {
				cta.disabled = true;
			}
			const manageBtn = ctaRow.createEl("button", { cls: "grill-manage-btn", attr: { "aria-label": "Manage questions" } });
			setIcon(manageBtn, "pencil");
			manageBtn.onclick = () => void this.renderManageQuestions();
			manageBtn.style.height = `${cta.offsetHeight}px`;
		}

		// The primary action, right after the due-CTA and nothing else — no scope picker
		// between them, and its own onclick never reads any scope state: "Get grilled"
		// always means the full engine-picked mix, unconditionally, whatever's ticked or
		// clicked anywhere else on this screen. Scoping used to sit here, between the two
		// main buttons, and used to relabel this exact button ("Grill N selected") based
		// on ambient state a stray click elsewhere could set — which visually reads as
		// "part of the flow" regardless of being collapsed by default: the very fact
		// something sits next to the primary CTA implies it belongs there (progressive
		// disclosure's own framing — see NN/G). Established SRS prior art agrees: Anki's
		// deck screen is Study Now alone, with Custom Study a distinct, clearly secondary
		// button below it that builds a whole separate temporary deck rather than
		// modifying the main flow; obsidian-spaced-repetition doesn't even surface
		// scoping in its main review command, only as an entirely separate one. Custom
		// study now lives below this button as its own bounded section with its own
		// commit action, same reasoning: the default, no-scope path (the engine picking
		// due + fresh material itself) is what most sessions should be, and it shouldn't
		// be readable-past or accidentally tickable into misfiring.
		const grillBtn = screen.createEl("button", { text: "Get grilled", cls: "mod-cta grill-start-btn grill-primary-cta" });
		grillBtn.onclick = () => {
			this.sessionScope = null;
			this.dueOnly = false;
			void this.startSession();
		};

		// Custom study: tick any combination of folders, tags, the current note, or
		// "Untested", to draw a session from exactly that instead of the engine's own
		// mix. Ticked scopes combine by union. A bounded card with its own header, its
		// own preview line, and its own commit button — deliberately NOT a relabeling of
		// "Get grilled" above: the selection lives in a closure-local variable, not
		// instance state, so nothing outside this card can read or set it, and nothing
		// happens until "Study N selected" is actually clicked. Collapsed by default —
		// the map below is the main focus, not this picker.
		const active = this.app.workspace.getActiveFile();
		const activeEligible = !!active && active.extension === "md" && !this.plugin.isExcluded(active.path);
		const folders = listFolders(eligible);
		const tags = listTags(this.app);
		const untested = untestedFiles(eligible, this.plugin.concepts);
		const hasScopeOptions = activeEligible || untested.length > 0 || folders.length > 0 || tags.length > 0;

		if (hasScopeOptions) {
			const customStudyCard = screen.createDiv({ cls: "grill-card grill-custom-study" });
			const scopeHeader = customStudyCard.createDiv({ cls: "grill-scope-header grill-scope-toggle" });
			scopeHeader.createSpan({ cls: "grill-section-label", text: "Custom study" });
			// A dropdown-style caret, not a collapse arrow: signals "this opens a list of
			// options" the way a native <select> would, right next to the label it opens.
			scopeHeader.createSpan({ cls: "grill-scope-caret", text: "⌄" });
			const scopeSummary = scopeHeader.createSpan({ cls: "grill-meta grill-scope-summary", text: "Whole vault" });

			const scopeBox = customStudyCard.createDiv({ cls: "grill-onboard-folders grill-scope-collapsed" });
			// Siblings of scopeBox, not children of it: scopeBox clips to a fixed peek
			// height while collapsed (see .grill-scope-collapsed), so a commit button
			// living inside it could end up invisible right after ticking a box in the
			// collapsed peek. Living just below it, they're always reachable.
			const scopePreview = customStudyCard.createDiv({ cls: "grill-meta grill-scope-preview" });
			const commitBtn = customStudyCard.createEl("button", { text: "Study selected", cls: "grill-secondary-btn grill-scope-commit" });
			commitBtn.style.display = "none";

			let scopedFiles: TFile[] | null = null;
			const previewScope = (files: TFile[] | null, summary: string): void => {
				scopedFiles = files;
				scopeSummary.setText(summary);
				this.mapRebuild?.(files ? new Set(files.map((f) => f.basename)) : null);
				if (files) {
					showCounts(files);
					const counts = { untested: 0, struggling: 0, known: 0 };
					for (const f of files) counts[statusOf(map[f.basename])]++;
					scopePreview.setText(
						`${files.length} note${files.length === 1 ? "" : "s"} — ${counts.known} known, ${counts.struggling} learning, ${counts.untested} untested`,
					);
					commitBtn.setText(`Study ${files.length} selected`);
					commitBtn.style.display = "";
				} else {
					showCounts(eligible);
					scopePreview.setText("");
					commitBtn.style.display = "none";
				}
			};
			commitBtn.onclick = () => {
				if (scopedFiles?.length) void this.startScopedSession(scopedFiles, false);
			};
			const checked: Scope[] = [];
			const recompute = (): void => {
				if (!checked.length) {
					previewScope(null, "Whole vault");
					return;
				}
				const byPath = new Map<string, TFile>();
				for (const scope of checked) {
					for (const f of filesForScope(this.app, scope, eligible, this.plugin.concepts)) byPath.set(f.path, f);
				}
				// "filter(s)", not "selected": the button below already says "Study N
				// selected" for the resolved file count — reusing the same word here for a
				// different number (how many boxes are ticked) read as two contradictory
				// answers to "how many are selected?" sitting a few lines apart.
				previewScope([...byPath.values()], `${checked.length} filter${checked.length === 1 ? "" : "s"}`);
			};
			const addScopeRow = (parent: HTMLElement, label: string, scope: Scope): void => {
				const row = parent.createDiv({ cls: "grill-onboard-row" });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.onchange = () => {
					if (cb.checked) checked.push(scope);
					else {
						const i = checked.findIndex((s) => s.kind === scope.kind && s.id === scope.id);
						if (i >= 0) checked.splice(i, 1);
					}
					recompute();
				};
				const lbl = row.createEl("label", { text: label });
				lbl.onclick = () => cb.click();
			};

			if (activeEligible && active) {
				addScopeRow(scopeBox, `Current note: ${active.basename}`, { kind: "note", id: active.path });
			}
			if (untested.length) addScopeRow(scopeBox, `Untested (${untested.length})`, { kind: "untested", id: "untested" });
			if (folders.length) {
				scopeBox.createDiv({ cls: "grill-scope-group", text: "Folders" });
				for (const path of folders) addScopeRow(scopeBox, path, { kind: "folder", id: path });
			}
			if (tags.length) {
				scopeBox.createDiv({ cls: "grill-scope-group", text: "Tags" });
				for (const t of tags) addScopeRow(scopeBox, `${t.tag} (${t.count})`, { kind: "tag", id: t.tag });
			}
			scopeHeader.onclick = () => {
				scopeBox.toggleClass("grill-scope-collapsed", !scopeBox.hasClass("grill-scope-collapsed"));
			};
		}

		// The learning graph: your notes, coloured in by what you've proven you know.
		const mapWrap = screen.createDiv({ cls: "grill-map-wrap" });
		void this.renderMap(mapWrap);

		const dash = screen.createDiv({ cls: "grill-meta grill-dash-link" });
		const dashLink = dash.createSpan({ cls: "grill-chip-link", text: "View your progress" });
		dashLink.onclick = () => this.showDashboard();

		const recent = this.recentSessions();
		if (recent.length) {
			screen.createDiv({ cls: "grill-section-label", text: "Recent sessions" });
			const list = screen.createDiv({ cls: "grill-recent" });
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
	/** The graph now lives inside the arcade screen (see .grill-arcade-screen), which is
	 * a fixed dark palette by design, not the active theme — so unlike before, this
	 * reads Grill's own arcade tokens rather than theme/semantic ones. Canvas can't
	 * resolve CSS variables itself, so they're still resolved here via getComputedStyle
	 * and handed over as plain color strings; the fallbacks are the arcade hexes
	 * directly, not theme-neutral guesses. */
	private mapPalette(): MapPalette {
		const view = this.contentEl.ownerDocument.defaultView ?? window;
		const cs = view.getComputedStyle(this.contentEl);
		const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
		return {
			known: v("--grill-gold-lit", "#ffe98a"),
			struggling: v("--grill-flame-hot", "#ff5a1f"),
			inProgress: v("--grill-accent", "#ff8c2b"),
			unpracticed: "#4a3018",
			edge: v("--grill-grid", "#3a1c0a"),
			edgeInherited: v("--grill-ember-dark", "#5c1400"),
			edgeProven: v("--grill-gold", "#ffd23f"),
			text: v("--grill-gold-lit", "#ffe98a"),
			ring: v("--grill-gold", "#ffd23f"),
			surface: v("--grill-screen-deep", "#0f0904"),
		};
	}

	/** Draw the learning graph over the eligible notes into `host`. Loads concepts + saved
	 * positions, builds and (re)lays out the graph, persists positions, and mounts the
	 * canvas controller. Bounded to MAP_NODE_CAP nodes (practised notes + neighbours).
	 * Purely a display: its filter chips (including "Untested") only ever restrict what's
	 * drawn here (see `rebuildMap` below), never the session scope — that's Custom
	 * Study's job now (renderStart), a deliberately separate action from "Get grilled". */
	private async renderMap(host: HTMLElement): Promise<void> {
		const toolbar = host.createDiv({ cls: "grill-graph-toolbar" });
		const canvas = host.createEl("canvas", { cls: "grill-graph" });
		const status = host.createDiv({ cls: "grill-meta grill-map-status", text: "Loading your graph…" });
		try {
			const eligible = this.allEligible();
			const nameSet = new Set(eligible.map((f) => f.basename));
			const concepts = await this.plugin.store.loadConcepts();
			// Repair a stale note-level aggStatus/dueAt cache: submitAnswer's recomputeAggregate
			// keeps plugin.mastery in sync with concepts.json going forward, but any note whose
			// cache drifted before that — an interrupted session, an older version, concepts
			// touched by some other path — stays wrong indefinitely otherwise, since nothing
			// else ever re-derives it. Confirmed in the wild: 14 notes in one real vault sat on
			// a cached aggStatus of "untested" despite having tested (and in some cases
			// individually graded) concepts, so the "Untested" filter kept including notes the
			// map itself drew with a real grade badge — the two disagreeing because one trusted
			// a stale cache and the other read the ground truth. The map is already loading
			// that ground truth (`concepts`) to draw from, so re-deriving and healing the cache
			// here is free; only notes that actually disagree get written back.
			const idsByNote = new Map<string, string[]>();
			for (const [id, cm] of Object.entries(concepts)) {
				if (!nameSet.has(cm.note)) continue;
				(idsByNote.get(cm.note) ?? idsByNote.set(cm.note, []).get(cm.note)!).push(id);
			}
			let masteryRepaired = false;
			for (const [note, ids] of idsByNote) {
				const agg = noteAggregate(ids, concepts);
				const m = (this.plugin.mastery[note] ??= emptyMastery());
				if (m.aggStatus !== agg.aggStatus || m.dueAt !== agg.dueAt) {
					m.aggStatus = agg.aggStatus;
					m.dueAt = agg.dueAt;
					masteryRepaired = true;
				}
			}
			if (masteryRepaired) void this.plugin.store.saveMastery(this.plugin.mastery);
			const practiced = new Set<string>();
			for (const cm of Object.values(concepts)) {
				if (nameSet.has(cm.note) && cm.correct + cm.partial + cm.incorrect > 0) practiced.add(cm.note);
			}
			const registry = await this.plugin.store.loadRegistry();
			const activeByNote = activeMisconceptionsByNote(registry, [...nameSet]);
			const misconceptionCounts: Record<string, number> = {};
			for (const [note, tags] of Object.entries(activeByNote)) misconceptionCounts[note] = tags.length;

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

			const graph = buildGraph(names, links, concepts, undefined, misconceptionCounts);

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
			const s = this.plugin.data.settings;

			/** (Re)builds and mounts the map from either the full node universe (`restrict`
			 * null) or a filtered one: EXACTLY the matched notes, nothing else — still
			 * passed through the same MAP_NODE_CAP safety net as the full view. Neighbours
			 * of the match were included here at first, for context, but on a heavily
			 * cross-linked vault (this note alone has 49 backlinks) that reliably pulled
			 * most of the vault back in behind the matches, reproducing the exact hairball
			 * the filter exists to get rid of. A link between two matches still draws (see
			 * `mapLinks` below); a match with no matched neighbour just draws unconnected,
			 * which is correct for "here's what's actually due", not a bug. A large vault's
			 * filter chips used to only dim non-matches (`setHighlight`) while still drawing
			 * and laying out every node regardless — harmless at a few dozen notes, but at
			 * hundreds the whole graph stays an unreadable mass no matter what's toggled,
			 * since dimming doesn't reduce what the force layout has to fit on screen.
			 * Rebuilding with a genuinely smaller node set is the actual fix. */
			const rebuildMap = (restrict: Set<string> | null): void => {
				let mapNames = names;
				let mapLinks = links;
				if (restrict && restrict.size) {
					mapNames = restrict.size > MAP_NODE_CAP ? [...restrict].slice(0, MAP_NODE_CAP) : [...restrict];
					const keptSet = new Set(mapNames);
					mapLinks = allLinks.filter(([a, b]) => keptSet.has(a) && keptSet.has(b));
				}
				const g = restrict && restrict.size ? buildGraph(mapNames, mapLinks, concepts, undefined, misconceptionCounts) : graph;
				let mapSettled = g.nodes.length > 0;
				for (const n of g.nodes) {
					const p = saved[n.id];
					if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
						n.x = p.x;
						n.y = p.y;
					} else {
						mapSettled = false;
					}
				}
				this.map?.dispose();
				this.map = new LearningMap(
					canvas,
					g,
					this.mapPalette(),
					(id) => this.openNote(id),
					(pos) => void this.plugin.store.saveGraphLayout(pos),
					mapSettled,
					appearance,
					{
						colorMode: s.graphColorMode,
						numberMode: s.graphNumberMode,
						coverageWeight: s.graphCoverageWeight / 100,
					},
				);
				// No dimming needed anymore: every drawn node already IS the match (or the
				// whole vault, when restrict is null) — nothing left to distinguish.
			};
			this.mapRebuild = rebuildMap;
			rebuildMap(null);
			// Smarter filtering: toggleable chips that isolate a subset of the graph by a
			// signal colour alone can't cleanly show at once (e.g. "just what's overdue").
			// Multiple active filters union (matches any), matching the scope picker's own
			// combine rule. Always matched against the FULL graph (never the currently
			// -displayed, possibly already-filtered one), so toggling a second filter on
			// unions against the whole vault, not just whatever the first filter left visible.
			const degree = new Map<string, number>();
			for (const [a, b] of links) {
				degree.set(a, (degree.get(a) ?? 0) + 1);
				degree.set(b, (degree.get(b) ?? 0) + 1);
			}
			const nowMs = Date.now();
			const STALE_DAYS = 14;
			const filterDefs: { kind: string; label: string; match: (n: GraphNode) => boolean }[] = [
				{ kind: "due", label: "Due", match: (n) => !!n.dueAt && new Date(n.dueAt).getTime() <= nowMs },
				// Ground-truth from the graph's own node state (same source renderMap's
				// aggStatus repair pass heals plugin.mastery against), not a second,
				// independently-computed "untested" set — see untestedFiles in scope.ts for
				// the one true definition, which this agrees with by construction.
				{ kind: "untested", label: "Untested", match: (n) => n.state === "unpracticed" },
				{ kind: "struggling", label: "Learning", match: (n) => n.state === "struggling" },
				{
					kind: "stale",
					label: `Stale (${STALE_DAYS}d+)`,
					match: (n) =>
						n.state !== "unpracticed" &&
						!!n.lastSeen &&
						(nowMs - new Date(n.lastSeen).getTime()) / 86_400_000 >= STALE_DAYS,
				},
				{ kind: "misconceptions", label: "Misconceptions", match: (n) => n.misconceptions > 0 },
				{ kind: "leeches", label: "Stuck", match: (n) => n.leeches > 0 },
				{ kind: "orphan", label: "Unlinked", match: (n) => (degree.get(n.id) ?? 0) === 0 },
			];
			const activeFilters = new Set<string>();
			const matchedSet = (): GraphNode[] =>
				graph.nodes.filter((n) => filterDefs.some((f) => activeFilters.has(f.kind) && f.match(n)));
			const chipRow = toolbar.createDiv({ cls: "grill-filter-row" });
			const readout = toolbar.createDiv({ cls: "grill-meta grill-filter-readout" });
			const updateReadout = (): void => {
				if (!activeFilters.size) {
					readout.setText("");
					return;
				}
				// Phrased as what the filter DID (narrowed the map to these), not as a due
				// count restated in the same words as the "Review N due now" button above —
				// the two answer different questions (go review vs. see where on the map),
				// so the text shouldn't read like the same fact said twice.
				const matched = matchedSet();
				let text = `Showing ${matched.length} note${matched.length === 1 ? "" : "s"}`;
				if (s.graphNumberMode !== "off") {
					const scored = matched
						.map((n) => gradeScore(n, s.graphCoverageWeight / 100))
						.filter((v): v is number => v !== null);
					if (scored.length) {
						const avg = scored.reduce((a, b) => a + b, 0) / scored.length;
						text += `, averaging ${formatGrade(avg, s.graphNumberMode)}`;
					}
				}
				readout.setText(text);
			};
			const createFilterChip = (f: (typeof filterDefs)[number]): void => {
				const chip = chipRow.createEl("button", { cls: "grill-filter-chip", text: f.label });
				chip.onclick = () => {
					if (activeFilters.has(f.kind)) activeFilters.delete(f.kind);
					else activeFilters.add(f.kind);
					chip.toggleClass("is-active", activeFilters.has(f.kind));
					rebuildMap(activeFilters.size ? new Set(matchedSet().map((n) => n.id)) : null);
					updateReadout();
				};
			};
			// Untested used to be a special case here — its own chip that changed the
			// session scope (via onSelectScope) rather than just the map, sitting one click
			// from "Get grilled" with no visual difference from its purely-cosmetic
			// siblings. Folded into filterDefs above like the rest: purely a map display
			// now. Studying just what's untested is still possible, deliberately, via
			// Custom Study's own "Untested" checkbox (renderStart) instead.
			for (const f of filterDefs) createFilterChip(f);

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
		const wrap = this.root(true);
		const map = this.plugin.mastery;
		const eligible = this.allEligible();

		const screen = wrap.createDiv({ cls: "grill-arcade-screen" });
		const head = screen.createDiv({ cls: "grill-meta-row" });
		head.createSpan({ cls: "grill-score", text: "Your progress" });
		const back = head.createSpan({ cls: "grill-chip-link", text: "Back" });
		back.onclick = () => this.renderStart();

		// Stats derived from mastery.json.
		const counts = { untested: 0, struggling: 0, known: 0 };
		let correct = 0, answered = 0, dueWeek = 0, knownShaky = 0;
		const now = Date.now();
		const weekMs = 7 * 86400_000;
		for (const f of eligible) {
			const m = map[f.basename];
			counts[statusOf(m)]++;
			if (m) {
				correct += m.correct;
				answered += m.correct + m.partial + m.incorrect;
				if (m.weakPrereq) knownShaky++;
				if (m.dueAt) {
					const d = new Date(m.dueAt).getTime();
					if (d > now && d <= now + weekMs) dueWeek++;
				}
			}
		}
		// Concept-level, not note-level: matches what clicking into the due queue
		// actually delivers (see GrillPlugin.dueCount's doc comment).
		const eligibleNames = new Set(eligible.map((f) => f.basename));
		const dueNow = dueConceptCount(this.plugin.concepts, (note) => eligibleNames.has(note));
		const accuracy = answered ? Math.round((100 * correct) / answered) : 0;

		const stats = screen.createDiv({ cls: "grill-stats" });
		const stat = (label: string, value: string, tone?: "correct" | "incorrect"): void => {
			const s = stats.createDiv({ cls: tone ? `grill-stat grill-stat-${tone}` : "grill-stat" });
			s.createDiv({ cls: "grill-stat-value", text: value });
			s.createDiv({ cls: "grill-stat-label", text: label });
		};
		stat("due now", String(dueNow));
		stat("due this week", String(dueWeek));
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

		// What you keep getting wrong. Both lists only ever grow (a canonical tag is
		// never deleted, just marked resolved), so past a handful of months of daily
		// use this section would otherwise become a permanently-scrolling wall. Cap
		// what's shown — already-sorted worst/most-recurring first — to the section's
		// actual purpose: today's live problems, not a lifetime transcript.
		const MISC_SHOWN_CAP = 10;
		const reg = await this.plugin.store.loadRegistry();
		const top = topMisconceptions(reg, 100);
		const activeAll = top.filter((c) => c.status === "active");
		const beatenAll = top.filter((c) => c.status === "resolved");
		const active = activeAll.slice(0, MISC_SHOWN_CAP);
		const beaten = beatenAll.slice(0, MISC_SHOWN_CAP);

		screen.createDiv({ cls: "grill-section-label", text: "What you keep getting wrong" });
		const miscCard = screen.createDiv({ cls: "grill-card" });
		if (!active.length) {
			miscCard.createDiv({ cls: "grill-meta", text: "Nothing recurring yet. It builds up as the grader spots patterns." });
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
				dismiss.setAttribute("title", "Not a real mistake — stop re-probing this");
				dismiss.onclick = async () => {
					dismissMisconception(reg, c.tag);
					await this.plugin.store.saveRegistry(reg);
					void this.renderDashboard();
				};
				if (c.notes.length) {
					const notes = row.createDiv({ cls: "grill-misc-notes" });
					for (const n of c.notes.slice(0, 6)) {
						const chip = notes.createSpan({ cls: "grill-chip grill-chip-link", text: n });
						chip.onclick = () => this.openNote(n);
					}
				}
			}
			if (activeAll.length > active.length) {
				miscCard.createDiv({ cls: "grill-meta", text: `+${activeAll.length - active.length} more recurring` });
			}
		}
		if (beaten.length) {
			const more = beatenAll.length - beaten.length;
			const suffix = more > 0 ? `, and ${more} more` : "";
			miscCard.createDiv({
				cls: "grill-meta grill-misc-beaten",
				text: `Beaten: ${beaten.map((c) => c.label).join(", ")}${suffix}`,
			});
		}

		// Concept coverage: honest counts from the per-concept scheduler.
		const cmap = await this.plugin.store.loadConcepts();
		const tested = Object.values(cmap).filter((c) => c.correct + c.partial + c.incorrect > 0);
		if (tested.length) {
			const known = tested.filter((c) => statusOf(c) === "known").length;
			screen.createDiv({ cls: "grill-section-label", text: "Concept coverage" });
			const coverageCard = screen.createDiv({ cls: "grill-card" });
			coverageCard.createDiv({
				cls: "grill-meta",
				text: `${tested.length} concepts tested so far: ${known} solid, ${tested.length - known} still shaky.`,
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
			const list = coverageCard.createDiv({ cls: "grill-meter-list" });
			for (const r of rows) {
				const row = list.createDiv({ cls: "grill-meter-row" });
				const link = row.createSpan({ cls: "grill-meter-label grill-chip-link", text: r.note });
				link.onclick = () => this.openNote(r.note);
				const track = row.createDiv({ cls: "grill-meter-track" });
				const pct = r.tested ? Math.round((100 * r.known) / r.tested) : 0;
				track.createDiv({ cls: "grill-meter-fill" }).setCssStyles({ width: `${pct}%` });
				row.createSpan({ cls: "grill-meter-value", text: `${r.known}/${r.tested}` });
			}
		}

		// Missing links Grill has helped you connect.
		const bridges = await this.plugin.store.loadBridges();
		const linked = Object.values(bridges).filter((b) => b.status === "linked").length;
		if (linked > 0) {
			screen.createDiv({ cls: "grill-section-label", text: "Connections made" });
			screen.createDiv({
				cls: "grill-card grill-meta",
				text: `Grill has helped you link ${linked} pair${linked === 1 ? "" : "s"} of notes you hadn't connected.`,
			});
		}

		this.renderHeatmap(screen);
	}

	// ------------------------------------------------------------ manage questions

	/** Every cached question in the bank, grouped by note and searchable — lets a bad
	 * AI-generated (or no-key/local) question be fixed in place instead of only ever
	 * deleted via "Bad question" mid-review. Authored `> [!grill]` callouts never enter
	 * `questionBank` (`rememberGenerated` skips `c.authored`), so this list is already
	 * just the generated/cached set — nothing here needs filtering out. */
	private async renderManageQuestions(): Promise<void> {
		await this.ensureQuestionBank();
		// Plain (non-arcade) styling: this is a dense form/data screen, not one of the
		// three cabinet screens (onboarding/start/dashboard) — reuses the same
		// theme-aware classes (.grill-body, .grill-answer, .grill-mc-btn, ...) the actual
		// review screen already renders on this same plain ground, rather than fighting
		// the arcade screen's fixed dark CRT palette for a form-heavy UI.
		const wrap = this.root();
		const screen = wrap.createDiv({ cls: "grill-body" });
		const header = screen.createDiv({ cls: "grill-mgmt-header" });
		const back = header.createEl("button", { text: "← Back", cls: "grill-secondary-btn" });
		back.onclick = () => this.renderStart();
		header.createDiv({ cls: "grill-mgmt-title", text: "Manage questions" });

		const searchEl = screen.createEl("input", {
			cls: "grill-mgmt-search",
			attr: { type: "text", placeholder: "Search questions..." },
		});
		const listEl = screen.createDiv({ cls: "grill-mgmt-list" });

		type Entry = { conceptId: string; q: CachedQuestion };
		const allEntries: Entry[] = [];
		for (const [conceptId, qs] of Object.entries(this.questionBank)) {
			for (const q of qs) allEntries.push({ conceptId, q });
		}

		let cardSeq = 0;
		const renderList = (): void => {
			listEl.empty();
			const term = searchEl.value.trim().toLowerCase();
			const filtered = term
				? allEntries.filter(
						(e) => e.q.question.toLowerCase().includes(term) || e.q.modelAnswer.toLowerCase().includes(term),
					)
				: allEntries;
			if (!filtered.length) {
				const empty = listEl.createDiv({ cls: "grill-mgmt-empty" });
				if (allEntries.length) {
					empty.createDiv({ cls: "grill-mgmt-empty-title", text: `No matches for "${searchEl.value.trim()}"` });
					const clear = empty.createEl("button", { text: "Clear search", cls: "grill-quiet-btn" });
					clear.onclick = () => {
						searchEl.value = "";
						renderList();
					};
				} else {
					empty.createDiv({ cls: "grill-mgmt-empty-title", text: "Nothing cached yet" });
					empty.createDiv({
						cls: "grill-meta",
						text:
							"Cached AI-generated (and no-key/local) questions show up here once you've reviewed some. " +
							"Authored \"> [!grill]\" questions aren't listed here — edit those directly in the note.",
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
	 * reference into `this.questionBank[conceptId]`) and writes the bank to disk on
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
		summary.createSpan({ cls: "grill-chip grill-mgmt-type-chip", text: SessionView.MGMT_TYPE_LABELS[type] });
		const previewEl = summary.createSpan({ cls: "grill-mgmt-card-preview", text: q.question });
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
	 * `this.questionBank[conceptId]`) and writes the bank to disk on Save — never
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
							`Question has ${blanks} blank(s) but the answer has ${segments} segment(s) — they must match.`,
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

			await this.plugin.store.saveQuestionBank(this.questionBank);
			previewEl.setText(q.question);
			new Notice("Grill: question saved.", 3000);
		};

		deleteBtn.onclick = async () => {
			const arr = this.questionBank[conceptId];
			if (arr) {
				const i = arr.indexOf(q);
				if (i >= 0) arr.splice(i, 1);
				if (!arr.length) delete this.questionBank[conceptId];
			}
			await this.plugin.store.saveQuestionBank(this.questionBank);
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

	/** GitHub-style grid of reviews done per day, from session-note frontmatter. */
	private renderHeatmap(wrap: HTMLElement): void {
		const pad = (n: number): string => String(n).padStart(2, "0");
		const key = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

	private renderLoading(title: string, detail: string): void {
		const wrap = this.root();
		const box = wrap.createDiv({ cls: "grill-loading" });
		setIcon(box.createDiv({ cls: "grill-flame-spin" }), "flame");
		box.createEl("p", { text: title, cls: "grill-loading-title" });
		box.createEl("p", { text: detail, cls: "grill-meta" });
	}

	/** Milliseconds a wait must run before the full loading screen takes over. A call
	 * that resolves faster than this (a cache-warm generation, an already-fast grade)
	 * never shows it at all — swapping to a loading screen and immediately swapping
	 * away again reads as flicker, not feedback. The click that started the wait
	 * already got its own instant acknowledgment (the button that triggered it
	 * disables synchronously, before this ever runs), so nothing here is needed for
	 * "did my click register" — this only gates the heavier, "this is genuinely
	 * taking a moment" screen-takeover. */
	private static readonly LOADING_DEBOUNCE_MS = 350;

	/** Run `work`, only rendering the loading screen if it's still running after the
	 * debounce window. */
	private async withDebouncedLoading<T>(title: string, detail: string, work: () => Promise<T>): Promise<T> {
		const timer = window.setTimeout(() => this.renderLoading(title, detail), SessionView.LOADING_DEBOUNCE_MS);
		try {
			return await work();
		} finally {
			window.clearTimeout(timer);
		}
	}

	private progressBar(wrap: HTMLElement): void {
		if (!this.plugin.data.settings.showProgress) return;
		const bar = wrap.createDiv({ cls: "grill-progress" });
		// One flex segment per question, each separated by a fixed CSS gap, doesn't scale:
		// a due session can run to 200+ questions (see the end-session escape hatch above),
		// and past a few dozen the fixed gaps alone overflow the bar's width, breaking the
		// layout instead of showing progress. Beyond MAX_PROGRESS_SEGMENTS, consecutive
		// questions are bucketed into one segment, colored by the worst thing in it —
		// SEG_SEVERITY ranks a recorded wrong answer above "you're currently here" above a
		// recorded correct answer, so one miss in a bucket doesn't get averaged away by the
		// rest of it going well.
		const bucketSize = Math.max(1, Math.ceil(this.targetCount / MAX_PROGRESS_SEGMENTS));
		for (let start = 0; start < this.targetCount; start += bucketSize) {
			const end = Math.min(start + bucketSize, this.targetCount);
			let cls: string | null = null;
			for (let i = start; i < end; i++) {
				const r = this.results[i];
				const rCls = r
					? r.gaveUp
						? "grill-seg-skipped"
						: r.verdict === "correct"
							? "grill-seg-correct"
							: r.verdict === "partial"
								? "grill-seg-partial"
								: "grill-seg-incorrect"
					: i === this.idx
						? "grill-seg-current"
						: null;
				if (rCls && (!cls || SEG_SEVERITY.indexOf(rCls) > SEG_SEVERITY.indexOf(cls))) cls = rCls;
			}
			const seg = bar.createDiv({ cls: "grill-seg" });
			if (cls) seg.addClass(cls);
		}
	}

	/** The long-session escape hatch: a due queue can run to 50+ questions, and without
	 * this the only way out mid-run is closing the pane outright — which works (onClose
	 * flushes), but looks and feels like abandoning progress rather than a supported way
	 * to stop. Every question already answered already updated its schedule in memory
	 * (see applyGrade); this just surfaces the same path a full session's last question
	 * takes, early. */
	private renderEndSessionLink(card: HTMLElement): void {
		const row = card.createDiv({ cls: "grill-end-session-row" });
		const link = row.createSpan({ cls: "grill-chip-link", text: "End session for now" });
		link.onclick = () => void this.endSessionEarly();
	}

	/** Stop short of the full target count: keep every question already answered (its
	 * schedule update already applied — see applyGrade), close out the session exactly
	 * as reaching the last question would (session note, debrief, summary screen), and
	 * simply never reach the rest. They stay due/untested, to resurface next session. */
	private async endSessionEarly(): Promise<void> {
		if (!this.results.length) {
			this.renderStart();
			return;
		}
		this.targetCount = this.results.length;
		await this.finishSession();
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
		// Only the generic case needs this — a bridge/routed/contagion question already
		// explains itself below in plain language, and stacking a due-reason on top of
		// that would just repeat the same point in a second voice.
		if (!q.connectTo && !q.routedFrom && !q.contagionFrom) {
			const reason = this.dueReasonTag(q.conceptId);
			if (reason) meta.createSpan({ cls: `grill-due-reason ${reason.cls}`, text: reason.text });
		}
		this.renderEndSessionLink(card);

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
				this.md(`You missed **${q.routedFrom}** — checking a foundation it builds on`, routed.createDiv({ cls: "grill-meta" }), q.node);
			}
		}

		// Misconception contagion: make the probe legible ("you showed the same mistake
		// on X, checking if it applies here too"). Honour "hide note name" as above.
		if (q.contagionFrom) {
			const contagion = card.createDiv({ cls: "grill-routed" });
			if (this.plugin.data.settings.hideNoteName) {
				contagion.createSpan({ cls: "grill-meta", text: "Checking whether a mistake from another note shows up here too" });
			} else {
				this.md(
					`You showed the same kind of mistake on **${q.contagionFrom}** — checking if it applies here too`,
					contagion.createDiv({ cls: "grill-meta" }),
					q.node,
				);
			}
		}

		const qEl = card.createDiv({ cls: "grill-question" });
		// Loose match (3+ underscores): the same tolerance questionDefect already
		// validates against, in case a model writes ___ or _____ instead of ____.
		// Up to three per question (questionDefect caps it); each gets its own input.
		const blankMatches = q.type === "blank" ? [...q.question.matchAll(/_{3,}/g)] : [];
		const isBlank = blankMatches.length > 0;
		const isMc = q.type === "mc" && !!q.choices && q.choices.length >= 2;
		const isTf = q.type === "tf";
		const isMulti = q.type === "multi" && !!q.choices && q.choices.length >= 2 && !!q.correctChoices?.length;
		const isMatch = q.type === "match" && !!q.pairs && q.pairs.length >= 2;
		const blankInputs: HTMLInputElement[] = [];
		if (isBlank) {
			// Plain text, not markdown: each blank splits the surrounding text around a
			// live input, which markdown rendering can't be interleaved with reliably.
			let cursor = 0;
			for (const m of blankMatches) {
				qEl.createSpan({ text: q.question.slice(cursor, m.index) });
				blankInputs.push(qEl.createEl("input", { cls: "grill-blank-input", attr: { type: "text" } }));
				cursor = (m.index ?? 0) + m[0].length;
			}
			qEl.createSpan({ text: q.question.slice(cursor) });
		} else {
			this.md(q.question, qEl, q.node);
		}

		if (ttsAvailable()) {
			// Derived from the raw markdown, not qEl's rendered text: MarkdownRenderer.render
			// (see `md` above) resolves asynchronously, so qEl's textContent isn't reliably
			// populated yet at this point in the render. Placed after qEl, not inside it, so
			// it trails the question instead of sitting in its own column pushing text over.
			const speakText = toSpeechText(q.question);
			const speakBtn = card.createEl("button", {
				cls: "clickable-icon grill-tts-btn",
				attr: { "aria-label": "Read question aloud", type: "button" },
			});
			setIcon(speakBtn, "volume-2");
			speakBtn.onclick = () => {
				const s = this.plugin.data.settings;
				speak(speakText, { lang: s.ttsLanguage, voiceURI: s.ttsVoiceURI });
			};
		}

		const selfGrade = this.plugin.data.settings.gradingMode === "self";
		const hintBox = card.createDiv({ cls: "grill-hintbox" });
		let hintsUsed = 0;
		const hints = [q.hints.tier1, q.hints.tier2, q.hints.tier3].filter(Boolean);

		// Assigned below; declared early so the mc/tf choice buttons (built before the
		// hint/skip row, and which auto-submit on click) can already call it.
		let doAction: (giveUp: boolean) => void = () => undefined;
		// True once doAction has run once for this question. Disabling the row's buttons
		// (below) blocks a second *click* — browsers don't dispatch click to a disabled
		// button — but does nothing for the keyboard entry points (Cmd/Ctrl+Enter on the
		// textarea, Enter on the last blank input), which call doAction directly and can
		// double-fire on key repeat. This flag is the actual guard; the button-disabling
		// is just the visible feedback.
		let actionTaken = false;

		let ta: HTMLTextAreaElement | null = null;
		const multiSelected = new Set<string>();
		const matchPicks: Record<string, string> = {};
		if (isMc || isTf) {
			const mcRow = card.createDiv({ cls: isTf ? "grill-mc-row grill-mc-row-tf" : "grill-mc-row" });
			const options = isTf ? ["True", "False"] : [...(q.choices as string[])].sort(() => Math.random() - 0.5);
			for (const choice of options) {
				const b = mcRow.createEl("button", { text: choice, cls: isTf ? "grill-mc-btn grill-tf-btn" : "grill-mc-btn" });
				b.onclick = () => {
					mcRow.querySelectorAll("button").forEach((other) => (other.disabled = true));
					this.mcPicked = choice;
					doAction(false);
				};
			}
		} else if (isMulti) {
			// Select all that apply: togglable options, an explicit Submit gathers them
			// (unlike mc/tf, a single click can't be "the answer" here).
			const multiRow = card.createDiv({ cls: "grill-multi-row" });
			const options = [...(q.choices as string[])].sort(() => Math.random() - 0.5);
			for (const choice of options) {
				const b = multiRow.createEl("button", { text: choice, cls: "grill-multi-btn" });
				b.onclick = () => {
					if (multiSelected.has(choice)) {
						multiSelected.delete(choice);
						b.removeClass("is-selected");
					} else {
						multiSelected.add(choice);
						b.addClass("is-selected");
					}
				};
			}
		} else if (isMatch) {
			// Matching: fixed-order left column of prompts, shuffled right-column pool.
			// Tap a left row to arm it, then tap a right option to assign the pair;
			// tapping an already-assigned left row lets you reassign it before Submit.
			const pairs = q.pairs as { left: string; right: string }[];
			const matchWrap = card.createDiv({ cls: "grill-match-wrap" });
			const leftCol = matchWrap.createDiv({ cls: "grill-match-col" });
			const rightCol = matchWrap.createDiv({ cls: "grill-match-col grill-match-pool" });
			const slots = new Map<string, HTMLElement>();
			const leftRows = new Map<string, HTMLElement>();
			const rightBtns = new Map<string, HTMLButtonElement>();
			let armed: string | null = null;
			const setArmed = (left: string | null) => {
				armed = left;
				for (const [l, lrow] of leftRows) lrow.toggleClass("is-armed", l === left);
			};
			for (const p of pairs) {
				const lrow = leftCol.createDiv({ cls: "grill-match-row" });
				lrow.createSpan({ cls: "grill-match-label", text: p.left });
				slots.set(p.left, lrow.createDiv({ cls: "grill-match-slot", text: "Tap a match →" }));
				leftRows.set(p.left, lrow);
				lrow.onclick = () => setArmed(armed === p.left ? null : p.left);
			}
			const assignTo = (leftKey: string, right: string, btn: HTMLButtonElement) => {
				const prev = matchPicks[leftKey];
				if (prev) rightBtns.get(prev)?.removeClass("is-used");
				matchPicks[leftKey] = right;
				btn.addClass("is-used");
				slots.get(leftKey)!.setText(right);
				setArmed(null);
			};
			const shuffledRight = [...pairs.map((p) => p.right)].sort(() => Math.random() - 0.5);
			for (const right of shuffledRight) {
				const b = rightCol.createEl("button", { text: right, cls: "grill-match-btn" });
				b.onclick = () => {
					if (b.hasClass("is-used") || !armed) return;
					assignTo(armed, right, b);
				};
				rightBtns.set(right, b);
			}
		} else if (!isBlank) {
			ta = card.createEl("textarea", {
				cls: "grill-answer",
				attr: {
					rows: "5",
					placeholder: selfGrade
						? "Answer from memory, or just think it through, then reveal... (Cmd/Ctrl+Enter)"
						: "Answer from memory... (Cmd/Ctrl+Enter to submit)",
				},
			});
		}
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
		if (!isMc && !isTf) {
			const submit = row.createEl("button", { text: selfGrade ? "Show answer" : "Submit", cls: "mod-cta grill-submit-btn" });
			submit.onclick = () => doAction(false);
		}
		if (hints.length) {
			const hintBtn = row.createEl("button", { text: "Hint", cls: "grill-hint-btn" });
			hintBtn.onclick = () => {
				if (hintsUsed < hints.length) {
					const h = hintBox.createDiv({ cls: "grill-hint" });
					this.md(`*Hint ${hintsUsed + 1}:* ${hints[hintsUsed]}`, h, q.node);
					hintsUsed += 1;
					if (hintsUsed >= hints.length) hintBtn.disabled = true;
				}
			};
		}
		const skip = row.createEl("button", { text: "I don't know", cls: "grill-quiet-btn" });
		// Authored questions are the user's own writing, verbatim from the note — nothing
		// generated to flag, nothing cached to purge.
		if (!q.authored) {
			const bad = row.createEl("button", { text: "Bad question", cls: "grill-quiet-btn grill-bad-question-btn" });
			bad.setAttribute("title", "Wrong, broken, or nonsensical — delete it and move on, no penalty");
			bad.onclick = () => {
				row.querySelectorAll("button").forEach((b) => (b.disabled = true));
				void this.reportBadQuestion();
			};
		}

		doAction = (giveUp: boolean) => {
			// Instant ack regardless of entry point (Submit click, Cmd/Ctrl+Enter, the
			// blank-input Enter chain, "I don't know") and blocks a double-submit while
			// grading runs. mc/tf buttons disable their own row separately on click,
			// before doAction even runs; this covers submit/hint/skip uniformly. The
			// actionTaken check (not just the disabling below) is what actually blocks
			// a second call — see its declaration above.
			if (actionTaken) return;
			actionTaken = true;
			row.querySelectorAll("button").forEach((b) => (b.disabled = true));
			let answer = "";
			if (!giveUp) {
				if (isMc || isTf) answer = this.mcPicked;
				else if (isMulti) answer = [...multiSelected].join(", ");
				else if (isMatch)
					answer = (q.pairs ?? []).map((p) => `${p.left} → ${matchPicks[p.left] ?? "(unmatched)"}`).join("; ");
				else if (isBlank) answer = blankInputs.map((el) => el.value.trim()).join(" / ");
				else answer = ta?.value.trim() ?? "";
			}
			if (selfGrade) this.revealForSelfGrade(answer, giveUp, hintsUsed);
			else
				void this.submitAnswer(
					answer,
					giveUp,
					hintsUsed,
					isMulti ? [...multiSelected] : undefined,
					isMatch ? matchPicks : undefined,
				);
		};
		skip.onclick = () => doAction(true);
		if (ta) {
			ta.addEventListener("keydown", (e) => {
				if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doAction(false);
			});
			ta.focus();
		} else if (blankInputs.length) {
			blankInputs.forEach((el, i) => {
				el.addEventListener("keydown", (e) => {
					if (e.key !== "Enter") return;
					if (i < blankInputs.length - 1) blankInputs[i + 1].focus();
					else doAction(false);
				});
			});
			blankInputs[0].focus();
		}
	}

	/** Why THIS question is showing up right now — new material, a recent miss due back
	 * immediately, a plain overdue review, or just "review" for a comfortably-scheduled
	 * reshow (a same-day repeat, an authored question, a redo). Reuses the verdict
	 * labels' own color vocabulary (grill-v-correct/partial/incorrect) for severity
	 * rather than correctness: a concept due back minutes after a miss reads with the
	 * same urgency as an incorrect answer, a plain overdue review the same as partial —
	 * so a note resurfacing right after you missed it reads as the schedule working, not
	 * a bug (see the interleaving fix earlier this session, which this is the visible
	 * half of). Null when there's nothing to say: no concept (a bridge/connections
	 * question already explains itself above), or mid-replay, where nothing is really
	 * "due" at all. */
	private dueReasonTag(conceptId: string | undefined, now = new Date()): { text: string; cls: string } | null {
		if (this.replayMode || !conceptId) return null;
		const cm = this.concepts[conceptId];
		if (!cm) return null;
		if (!conceptTested(cm)) return { text: "New", cls: "grill-v-skipped" };
		const overdue = !!cm.dueAt && new Date(cm.dueAt).getTime() <= now.getTime();
		if (statusOf(cm) === "struggling" && overdue) {
			const elapsed = cm.lastSeen ? now.getTime() - new Date(cm.lastSeen).getTime() : 0;
			return { text: `Missed ${formatAgo(elapsed)} ago`, cls: "grill-v-incorrect" };
		}
		if (overdue) {
			const elapsed = cm.dueAt ? now.getTime() - new Date(cm.dueAt).getTime() : 0;
			return { text: `Overdue ${formatAgo(elapsed)}`, cls: "grill-v-partial" };
		}
		return { text: "Review", cls: "grill-v-skipped" };
	}

	private verdictLabel(r: QuestionResult): { text: string; cls: string } {
		if (r.gaveUp) return { text: "Skipped, marked for review", cls: "grill-v-skipped" };
		if (r.verdict === "correct") return { text: "Correct", cls: "grill-v-correct" };
		if (r.verdict === "partial") return { text: "Partially correct", cls: "grill-v-partial" };
		return { text: "Incorrect", cls: "grill-v-incorrect" };
	}

	private renderFeedback(r: QuestionResult, pendingExtension: PendingExtension | null = null): void {
		if (this.plugin.data.settings.sounds) playSfx(r.verdict); // correct / partial / incorrect
		const wrap = this.root();
		this.progressBar(wrap);
		const card = wrap.createDiv({ cls: "grill-body" });
		const meta = card.createDiv({ cls: "grill-meta-row" });
		meta.createSpan({ cls: "grill-meta", text: `Question ${this.idx + 1} of ${this.targetCount}` });
		const chip = meta.createSpan({ cls: "grill-chip grill-chip-link", text: r.node });
		chip.onclick = () => this.openNote(r.node);
		chip.setAttr("aria-label", "Open note");
		// Not on the route-consent screen (the last question only): its own "No" already
		// ends the session the same way.
		if (!pendingExtension) this.renderEndSessionLink(card);

		const qEl = card.createDiv({ cls: "grill-question grill-question-small" });
		this.md(r.question, qEl, r.node);

		// The verdict card: badge + your answer + grader feedback — "what happened".
		const verdictCard = card.createDiv({ cls: "grill-flow-card grill-verdict-card" });
		const v = this.verdictLabel(r);
		const badgeRow = verdictCard.createDiv({ cls: "grill-verdict-row" });
		const badge = badgeRow.createDiv({ cls: `grill-verdict-badge ${v.cls}` });
		renderFlameIcon(badge.createSpan({ cls: "grill-verdict-icon" }));
		badge.createSpan({ text: v.text });
		// The grader/deterministic path got this one wrong: single-use, so it's only
		// offered right after the answer that produced it (see pendingOverride's doc
		// comment) — not on an older question, and never for self-grade (your own
		// rating already is the ground truth there).
		if (r.verdict !== "correct" && this.pendingOverride) {
			const markBtn = badgeRow.createEl("button", { text: "Mark correct", cls: "grill-quiet-btn" });
			markBtn.onclick = () => {
				markBtn.disabled = true;
				void this.markCorrect(r);
			};
		}
		// Same single-use restriction as "Mark correct" (pendingOverride), same
		// authored/bridge exclusion as the pre-answer version, and skipped on the
		// route-consent screen — discarding the question there would pull the rug out
		// from under the yes/no choice being offered below.
		if (!pendingExtension && !this.questions[this.idx].authored && this.pendingOverride) {
			const badBtn = badgeRow.createEl("button", { text: "Bad question", cls: "grill-quiet-btn" });
			badBtn.setAttribute("title", "Wrong, broken, or nonsensical — delete it and move on, no penalty");
			badBtn.onclick = () => {
				badBtn.disabled = true;
				void this.discardAnsweredQuestion(r);
			};
		}
		if (!r.gaveUp && r.answer) {
			verdictCard.createDiv({ cls: "grill-block-label", text: "Your answer" });
			const ans = verdictCard.createDiv({ cls: "grill-your-answer" });
			this.md(`> ${r.answer.split("\n").join("\n> ")}`, ans, r.node);
		}
		if (r.feedback) {
			const fb = verdictCard.createDiv({ cls: "grill-feedback" });
			// Display-only split on the grader's own "line 1 / line 2" convention (see
			// GRADER_RULES) — no schema change, just rendering each line as its own block
			// when the model included the break, one block otherwise.
			for (const line of r.feedback.split("\n").map((l) => l.trim()).filter(Boolean)) {
				this.md(line, fb.createDiv({ cls: "grill-feedback-line" }), r.node);
			}
		}

		// The review card: expected answer + on-demand explanation — "what to study".
		// Only rendered when it would actually have something in it.
		const showExpectedAnswer = r.verdict !== "correct" && !!r.modelAnswer;
		const showExplain = !pendingExtension && this.canExplain(r);
		if (showExpectedAnswer || showExplain) {
			const reviewCard = card.createDiv({ cls: "grill-flow-card grill-review-card" });
			if (showExpectedAnswer) {
				reviewCard.createDiv({ cls: "grill-block-label", text: "Expected answer" });
				this.md(r.modelAnswer, reviewCard.createDiv({ cls: "grill-model-answer" }), r.node);
			}
			if (showExplain) this.offerExplanation(reviewCard, r);
		}

		if (r.missingLink && r.connectTo) this.offerLink(card, r.node, r.connectTo);

		if (pendingExtension) {
			this.renderRouteConsentInto(card, pendingExtension);
			return;
		}
		const btn = card.createEl("button", {
			text: this.idx + 1 < this.targetCount ? "Next question" : "Finish session",
			cls: "mod-cta grill-submit-btn",
		});
		btn.onclick = () => {
			btn.disabled = true; // instant ack, independent of whether a wait follows; also blocks a double-click
			void this.goToQuestion(this.idx + 1);
		};
		btn.focus();
	}

	/** The consent step for extending a session past its agreed length: this was going
	 * to be the last question, but either the missed note builds on a weak prerequisite,
	 * or the same confusion might apply to a linked neighbor. Ask before inserting it
	 * rather than silently growing the session — declining ends the session normally,
	 * straight into the review/summary screen. */
	private renderRouteConsentInto(card: HTMLElement, pending: PendingExtension): void {
		const box = card.createDiv({ cls: "grill-route-consent" });
		const message =
			pending.kind === "prerequisite"
				? `That was the last question of this session. It builds on **${pending.route.prereqNote}**, which you're still catching up on — take one more question to shore up that foundation?`
				: `That was the last question of this session. The same mistake might also apply to **${pending.route.neighborNote}**, a linked note — take one more question to check?`;
		this.md(message, box);
		const row = card.createDiv({ cls: "grill-btn-row grill-btn-row-fill" });
		const yes = row.createEl("button", { text: "Yes, one more", cls: "mod-cta" });
		yes.onclick = () => {
			yes.disabled = true;
			no.disabled = true;
			if (pending.kind === "prerequisite") this.commitRoutedTarget(pending.route, pending.fromNote);
			else this.commitContagionTarget(pending.route, pending.fromNote);
			void this.goToQuestion(this.idx + 1);
		};
		const no = row.createEl("button", { text: "No, go to review" });
		no.onclick = () => void this.finishSession();
	}

	/** Whether "Explain this" has anything to offer: an LLM is configured and this isn't a
	 * replay (noteText isn't loaded then). Available on every verdict, including correct
	 * — a correct answer can still want a fuller "why" than the terse grader feedback
	 * gave. Shared between `renderFeedback` (deciding whether to render the review card
	 * at all) and `offerExplanation` itself, so the two checks can't drift apart. */
	private canExplain(r: QuestionResult): boolean {
		return !this.replayMode && !!this.plugin.llmConfig();
	}

	/** "Explain this": the rescue action for when the feedback/hints/expected-answer above
	 * still leave the student stuck — one contextual LLM call, not a chat, rendered inline
	 * as three labeled parts instead of one prose blob. */
	private offerExplanation(card: HTMLElement, r: QuestionResult): void {
		if (!this.canExplain(r)) return;
		const cfg = this.plugin.llmConfig()!;
		const q = this.questions[this.idx]; // same source Question that produced r
		const box = card.createDiv({ cls: "grill-explain-box" });
		const btn = box.createEl("button", { text: "Explain this", cls: "grill-hint-btn" });
		btn.onclick = async () => {
			btn.disabled = true;
			// Named stages, not a frozen "Explaining...", matching loadNextBatch's own
			// "say what it's actually doing" approach (see withDebouncedLoading's callers) —
			// there's no real token stream to show (requestUrl is a buffered, non-streaming
			// call), so this is honest staged status text, not a fake typing animation.
			btn.setText("Reading your answer and the note...");
			const stageTimer = window.setTimeout(() => btn.setText("Writing an explanation..."), 1200);
			try {
				const hintsShown = [q.hints.tier1, q.hints.tier2, q.hints.tier3].slice(0, r.hintsUsed).filter(Boolean);
				const explanation = await explainQuestion(
					cfg,
					q,
					this.noteText[r.node] ?? "",
					r.answer,
					r.feedback,
					r.verdict,
					hintsShown,
					this.noteImages[r.node] ?? [],
					this.sessionPersona,
					this.sessionInstructions,
				);
				const out = box.createDiv({ cls: "grill-explanation" });
				this.explanationBlock(out, "What went wrong", explanation.whatWentWrong, r.node);
				this.explanationBlock(out, "Key concept", explanation.keyConcept, r.node);
				this.explanationBlock(out, "Example", explanation.example, r.node);
				await this.renderDiagramBlock(out, explanation.diagram);
				await this.renderRelevantImage(out, explanation.relevantImagePath);
				btn.remove();
			} catch (e) {
				new Notice(`Grill: ${(e as Error).message}`, 8000);
				btn.disabled = false;
				btn.setText("Explain this");
			} finally {
				window.clearTimeout(stageTimer);
			}
		};
	}

	/** One labeled sub-block of a structured Explanation; skipped when the model left the
	 * field empty (the `example` field's documented empty-string case). */
	private explanationBlock(parent: HTMLElement, label: string, text: string, sourcePath: string): void {
		if (!text) return;
		const block = parent.createDiv({ cls: "grill-explanation-block" });
		block.createDiv({ cls: "grill-block-label", text: label });
		this.md(text, block, sourcePath);
	}

	/** Renders the model's optional Mermaid diagram. Mermaid parses asynchronously after
	 * MarkdownRenderer.render's own promise resolves, and a malformed diagram (an LLM
	 * output, not vetted syntax) renders as an inline error box rather than throwing —
	 * so this renders off-screen first and only promotes the result if an actual <svg>
	 * appeared, silently dropping the block otherwise instead of showing broken output. */
	private async renderDiagramBlock(parent: HTMLElement, diagram: string): Promise<void> {
		if (!diagram) return;
		const scratch = document.createElement("div");
		scratch.addClass("grill-diagram-scratch");
		document.body.appendChild(scratch);
		try {
			await MarkdownRenderer.render(this.app, "```mermaid\n" + diagram + "\n```", scratch, "", this);
			let svg: Element | null = null;
			for (let i = 0; i < 10 && !svg; i++) {
				await new Promise((r) => window.setTimeout(r, 150));
				svg = scratch.querySelector("svg");
			}
			if (!svg) return;
			const block = parent.createDiv({ cls: "grill-explanation-block" });
			block.createDiv({ cls: "grill-block-label", text: "Diagram" });
			block.createDiv({ cls: "grill-diagram" }).appendChild(svg.cloneNode(true));
		} finally {
			scratch.remove();
		}
	}

	/** Shows the single note-embedded image the model judged relevant to this specific
	 * question ("" for the common case of none — see Explanation.relevantImagePath).
	 * Renders a real `![[embed]]` first so Obsidian's native click-to-zoom works, same
	 * as any other embed in the vault; only falls back to a plain <img> if that embed
	 * doesn't hydrate in time (a custom ItemView doesn't always resolve `.internal-embed`
	 * placeholders the way the main markdown view does). */
	private async renderRelevantImage(parent: HTMLElement, path: string): Promise<void> {
		if (!path) return;
		const dest = this.app.vault.getAbstractFileByPath(path);
		if (!(dest instanceof TFile)) return;
		const block = parent.createDiv({ cls: "grill-explanation-block" });
		block.createDiv({ cls: "grill-block-label", text: "From your note" });
		const holder = block.createDiv({ cls: "grill-note-images" });
		await MarkdownRenderer.render(this.app, `![[${dest.path}]]`, holder, dest.path, this);
		let hydrated = false;
		for (let i = 0; i < 10; i++) {
			if (holder.querySelector("img")) {
				hydrated = true;
				break;
			}
			await new Promise((r) => window.setTimeout(r, 100));
		}
		if (!hydrated) {
			holder.empty();
			holder.createEl("img", { attr: { src: this.app.vault.getResourcePath(dest) } });
		}
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
			if (perfect && s.sounds) this.confettiStop = celebrate(this.contentEl.ownerDocument);
			this.renderSummary(null, debrief);
			return;
		}
		const s = this.plugin.data.settings;
		const cfg = this.plugin.llmConfig();
		const usedAI = this.plugin.usesAI();
		const sessionNodes = [...new Set(this.results.map((r) => r.node))];

		let debrief = deterministicDebrief(this.results);
		if (cfg && usedAI && s.sessionDebrief && sessionNodes.length > 0) {
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
				const out = await this.withDebouncedLoading(
					"Writing your debrief",
					"Summarising how the session went.",
					() =>
						debriefSession(
							cfg,
							transcript,
							sessionNodes,
							existingCanon,
							rawTags,
							this.sessionPersona,
							this.sessionInstructions,
						),
				);
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
				dueOnly: this.dueOnly,
			},
			s.linkSessions,
			debrief,
			this.questions.slice(0, this.results.length),
		);
		// A perfect run (every question correct, nothing given up) gets a fanfare and
		// confetti; any other completed session gets a gentle finish cue.
		const perfect = this.results.length > 0 && this.results.every((r) => r.verdict === "correct" && !r.gaveUp);
		if (s.sounds) playSfx(perfect ? "perfect" : "complete");
		if (perfect && s.sounds) this.confettiStop = celebrate(this.contentEl.ownerDocument);
		this.renderSummary(note, debrief);
	}

	private renderDebrief(card: HTMLElement, debrief: SessionDebrief, sourcePath: string): void {
		const box = card.createDiv({ cls: "grill-debrief" });
		if (debrief.headline) this.md(debrief.headline, box.createDiv({ cls: "grill-debrief-headline" }), sourcePath);
		if (debrief.pattern) {
			const p = box.createDiv({ cls: "grill-debrief-pattern" });
			this.md(`**Recurring pattern:** ${debrief.pattern}`, p, sourcePath);
		}
		if (debrief.gaps.length) {
			const gaps = box.createDiv({ cls: "grill-debrief-gaps" });
			gaps.createDiv({ cls: "grill-debrief-label", text: "To review" });
			for (const g of debrief.gaps) {
				const row = gaps.createDiv({ cls: "grill-debrief-gap" });
				// A real wikilink inline, not a separate chip: Obsidian's own markdown
				// renderer resolves and makes [[note]] clickable, so the note reference
				// reads as part of the sentence instead of a disconnected element after it.
				// Sourced from the gap's own note (not the session note): each gap can name
				// a different note than the one the session summary is for, and a self-link
				// always resolves cleanly regardless of vault structure.
				this.md(`**${g.concept}** — ${g.why} ([[${g.note}]])`, row.createDiv({ cls: "grill-debrief-gap-text" }), g.note);
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
			if (line) this.md(line, box.createDiv({ cls: "grill-debrief-calibration grill-meta" }), sourcePath);
		}
	}

	private renderSummary(note: TFile | null, debrief?: SessionDebrief): void {
		const wrap = this.root();
		this.progressBar(wrap);
		// The "high score" moment — studying is over by this point, so unlike the
		// question flow itself, this can wear the full cabinet without competing with
		// active reading/typing.
		const screen = wrap.createDiv({ cls: "grill-arcade-screen" });
		const card = screen.createDiv({ cls: "grill-body" });
		const right = this.results.filter((r) => r.verdict === "correct").length;
		if (this.dueOnly) card.createDiv({ cls: "grill-meta", text: "Due review" });
		card.createDiv({ cls: "grill-score", text: `${right} of ${this.results.length} correct` });

		if (debrief) {
			card.createDiv({ cls: "grill-divider" });
			this.renderDebrief(card, debrief, note?.path ?? "");
			card.createDiv({ cls: "grill-divider" });
		}

		card.createDiv({ cls: "grill-section-label", text: "Session results" });
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
		const btnRow = card.createDiv({ cls: "grill-btn-row grill-start-btn grill-btn-row-fill" });
		const again = btnRow.createEl("button", { text: "Study again", cls: "mod-cta grill-primary-cta" });
		again.setAttr("aria-label", "Start a new adaptive session");
		again.onclick = () => void this.startSession();
		// Redo the exact same questions with no generation (grading still per the setting).
		const redoable = this.questions.slice(0, this.results.length).filter((q) => !q.missingLink);
		if (redoable.length) {
			const redo = btnRow.createEl("button", { text: "Redo these", cls: "grill-secondary-btn" });
			redo.setAttr("aria-label", "Redo the same questions with no AI generation");
			redo.onclick = () => void this.startReplay(redoable);
		}
		const menu = btnRow.createEl("button", { text: "Back to menu", cls: "grill-menu-btn" });
		menu.onclick = () => {
			this.sessionScope = null;
			this.dueOnly = false;
			this.renderStart();
		};
	}

	// ------------------------------------------------------------ session logic

	private mdFiles(): TFile[] {
		const all = this.sessionScope ?? this.app.vault.getMarkdownFiles();
		return all.filter((f) => !this.plugin.isExcluded(f.path));
	}

	/** Entry point for "Grill this note/folder" and the due queue: scope the
	 * session and start. `dueOnly` is true only for the due-queue callers
	 * (status bar, "Review due notes" command); "Grill this note/folder" is a
	 * full scoped session, never due-only. */
	async startScopedSession(files: TFile[], dueOnly = false): Promise<void> {
		this.sessionScope = files;
		this.dueOnly = dueOnly;
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
		this.dueOnly = false;
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
		this.noteFoundationalRank = new Map();
		this.sessionNeighbors = new Map();
		this.contagionUsed = 0;
		this.contagionNotes.clear();
		this.dirty = false;
		this.bankDirty = false;
		this.bridgesDirty = false;
		this.registry = {};
		this.concepts = {};
		this.conceptsByNote = new Map();
		this.conceptById = new Map();
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
			// If two eligible files share this basename (see duplicateBasenames in
			// scope.ts — Grill can't otherwise tell them apart), resolve deterministically
			// by path instead of whichever the vault happens to enumerate first, so a
			// replay doesn't silently pull text from a different file each time it's run.
			const f = this.app.vault
				.getMarkdownFiles()
				.filter((file) => file.basename === n && !this.plugin.isExcluded(file.path))
				.sort((a, b) => a.path.localeCompare(b.path))[0];
			if (f) {
				this.byName.set(n, f);
				const raw = await this.app.vault.cachedRead(f);
				this.noteText[n] = raw.length > NOTE_CHAR_CAP ? safeSlice(raw, NOTE_CHAR_CAP) + "\n[truncated]" : raw;
			} else {
				this.noteText[n] = "";
			}
		}
		this.renderQuestion();
	}

	/** Notes text + images for exactly this batch's targets, not the whole session's
	 * notes: a batch is 1-2 concepts, almost always from 1-2 notes, so sending every
	 * other session note's full text and images on every batch call was pure waste
	 * (and, with no prompt caching in this codebase, paid in full on every call). */
	private notesForBatch(batch: ConceptTarget[]): { text: string; images: ImageInput[] } {
		const names = new Set<string>();
		for (const t of batch) {
			names.add(t.note);
			if (t.connectTo) names.add(t.connectTo);
		}
		const withImageWarning = [...names].some((n) => this.notesWithUnsentImages.has(n));
		let text = [...names]
			.filter((n) => this.noteText[n])
			.map((n) => `=== NOTE: ${n} ===\n${this.noteText[n].trim()}`)
			.join("\n\n");
		if (!this.sessionVision && withImageWarning) {
			text +=
				"\n\nNote: some of these notes embed images that cannot be shown to this model. " +
				"Do not write questions that depend on reading an image; quiz only on the text above.";
		}
		const images = [...names].flatMap((n) => this.noteImages[n] ?? []).slice(0, CONTEXT_IMAGE_CAP);
		return { text, images };
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
					// Every target here is about to be generated fresh (isPrebuilt/cacheHit
					// already ruled out reuse) — tell the model what's already been asked for
					// each one so it doesn't reconverge on the same phrasing (see priorQuestionsFor).
					// Bridge targets carry their own priorQuestions, set when appendBridgeTargets
					// pushed them (their conceptId is a synthetic "__bridge__:pair" key, not a
					// real concept, so priorQuestionsFor would look it up in the concept bank,
					// find nothing, and wrongly clobber it back to empty).
					for (const t of batch) if (!t.bridge) t.priorQuestions = this.priorQuestionsFor(t.conceptId);
					const { text: batchNotesText, images: batchImages } = this.notesForBatch(batch);
					// Tally formats already generated this session (not just this batch), so a
					// batch several calls in can be steered toward whichever types haven't
					// shown up yet instead of the model defaulting to mc/blank every time.
					const formatCounts: Partial<Record<string, number>> = {};
					for (const q of this.questions) {
						const t = q.type ?? "write";
						formatCounts[t] = (formatCounts[t] ?? 0) + 1;
					}
					const qs = await generateQuestions(
						cfg,
						batchNotesText,
						batch,
						batchImages,
						this.sessionInstructions,
						this.linksBlock,
						this.sessionPersona,
						this.plugin.data.settings.questionFormats,
						formatCounts,
					);
					// The cursor already advanced past this whole batch (targets consumed,
					// not questions produced — see above), so any target the validator
					// dropped, partially or entirely, is never coming back. Shrink the
					// promised total to match, or "Question N of targetCount" and the
					// progress bar keep counting a slot that will never be shown.
					const shortfall = batch.length - qs.length;
					if (shortfall > 0) this.targetCount = Math.max(this.questions.length, this.targetCount - shortfall);
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
	 * bank entry whose source hash still matches the concept (note unchanged) AND whose
	 * format satisfies the current "Question formats" setting (see `formatSatisfies`,
	 * the same check fresh generation validates against) — a variant banked back when the
	 * student was on Mixed (or before they switched to MC/Write only) must not get rotated
	 * back in just because it's the least-shown one; that's how "MC only" quietly kept
	 * serving old write-in questions forever. Rotates to the least-shown variant among
	 * whatever's left.
	 *
	 * The model only ever writes a question once per concept (per source text — an edit
	 * that changes `sourceHash` reopens it): every later review of the same concept
	 * reuses that same cached text, forever. Rewording on a schedule used to be the
	 * default (a fresh variant once a calendar day had passed since it was last shown,
	 * to avoid testing sentence-recognition instead of recall) but in practice this
	 * reliably drifted the *content* of the question, not just its phrasing — a real
	 * failure mode on precision material like a language drill, where a "fresher"
	 * variant can quietly test a different grammar point or invent a wrong answer.
	 * This never grows unboundedly regardless: rememberGenerated evicts the oldest
	 * past MAX_VARIANTS. */
	private cacheHit(conceptId: string): CachedQuestion | null {
		const c = this.conceptById.get(conceptId);
		if (!c || c.authored) return null; // authored questions are verbatim, not banked
		const bank = this.questionBank[conceptId];
		if (!bank || !bank.length) return null;
		const wantFormat = this.plugin.data.settings.questionFormats;
		const fresh = bank.filter((e) => e.sourceHash === c.sourceHash && formatSatisfies(e.type, wantFormat));
		if (!fresh.length) return null;
		fresh.sort(
			(a, b) => a.timesShown - b.timesShown || (a.lastShownAt ?? "").localeCompare(b.lastShownAt ?? ""),
		);
		return fresh[0];
	}

	/** Question texts already on record for this exact concept (same source text),
	 * most-recently-shown first, capped to MAX_PRIOR_SHOWN — passed to the model as
	 * "already asked, don't restate" context so a regenerated variant is actually new.
	 * Stale-hash entries (note has since changed) are excluded: they describe content
	 * the model isn't being asked about anymore. */
	private priorQuestionsFor(conceptId: string): string[] {
		const c = this.conceptById.get(conceptId);
		if (!c) return [];
		const bank = this.questionBank[conceptId];
		if (!bank || !bank.length) return [];
		return bank
			.filter((e) => e.sourceHash === c.sourceHash)
			.sort((a, b) => (b.lastShownAt ?? "").localeCompare(a.lastShownAt ?? ""))
			.slice(0, MAX_PRIOR_SHOWN)
			.map((e) => e.question);
	}

	/** Whether a target needs no model call (user-authored, or a cache hit). Must agree
	 * with buildPrebuilt: an authored concept counts only if it actually has a question,
	 * otherwise loadNextBatch could spin on a target it can neither build nor batch. A
	 * contagion target never counts a cache hit as prebuilt: a stale cached question
	 * predates the misconception tag it's meant to re-probe and likely doesn't test it
	 * at all, so contagion always forces a fresh, tag-aware generation call. */
	private isPrebuilt(t: ConceptTarget): boolean {
		const c = this.conceptById.get(t.conceptId);
		if (c?.authored) return !!c.local;
		if (t.contagionFrom) return false;
		return this.cacheHit(t.conceptId) !== null;
	}

	/** Build a target's question without a model call: the verbatim authored question,
	 * or a rotated cache hit (bumping its use counters). Null when generation is needed. */
	private buildPrebuilt(t: ConceptTarget): Question | null {
		const c = this.conceptById.get(t.conceptId);
		if (c?.authored) {
			const q = localQuestionForConcept(c, conceptTargetDifficulty(this.concepts[c.id]));
			if (q) {
				q.routedFrom = t.routedFrom ?? q.routedFrom;
				q.contagionFrom = t.contagionFrom ?? q.contagionFrom;
			}
			return q;
		}
		if (t.contagionFrom) return null; // see isPrebuilt: never serve a stale cache hit here
		const hit = this.cacheHit(t.conceptId);
		if (!hit) return null;
		hit.timesShown += 1;
		hit.lastShownAt = new Date().toISOString();
		this.bankDirty = true;
		// Strip cache metadata, and set (never fall back to) this serve's own routing
		// label: a cache hit's stored routedFrom/contagionFrom describes why IT was
		// inserted whenever it was first generated, not why this target is being served
		// now — falling back to the cached value would leak a stale "you missed X" or
		// "same mistake as X" banner into a later, unrelated normal-scheduling serve.
		const { sourceHash: _sh, timesShown: _ts, lastShownAt: _ls, ...q } = hit;
		return { ...q, routedFrom: t.routedFrom, contagionFrom: t.contagionFrom };
	}

	/** Cache freshly generated questions per concept for reuse on later reviews. Skips
	 * authored (verbatim) and bridge (novel, un-scheduled) questions, prunes stale-hash
	 * variants, dedupes near-restatements against what's already banked, and caps the
	 * number kept per concept. */
	private rememberGenerated(qs: Question[]): void {
		for (const q of qs) {
			if (!q.conceptId || q.missingLink) continue;
			const c = this.conceptById.get(q.conceptId);
			if (!c || c.authored) continue;
			const kept = (this.questionBank[q.conceptId] ?? []).filter((e) => e.sourceHash === c.sourceHash);
			// The model can ignore the "already asked, write something different" prompt
			// hint (priorQuestionsFor) — if what came back is a near-restatement of a
			// variant already banked, treat this as another showing of THAT variant rather
			// than a new one. Keeps rotation genuinely varied and stops MAX_VARIANTS slots
			// filling up with near-duplicates of each other. Only affects what's persisted
			// for future reuse; the question actually served this turn is unchanged.
			const dup = kept.find((e) => questionSimilarity(e.question, q.question) >= NEAR_DUPLICATE_THRESHOLD);
			if (dup) {
				dup.timesShown += 1;
				dup.lastShownAt = new Date().toISOString();
			} else {
				kept.push({ ...q, sourceHash: c.sourceHash, timesShown: 1, lastShownAt: new Date().toISOString() });
			}
			// Written unconditionally on both paths: `kept` is already pruned to fresh-hash
			// entries above, and skipping this on the dup path would silently stop that
			// pruning from ever landing whenever a batch happens to produce a near-duplicate.
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
				// Re-suggesting a pair that was suggested but never reached last time (session
				// ended before it came up): carry its lastQuestion forward through this
				// re-suggestion (nothing has answered it yet, so nothing new to record over
				// it) and pass it to the model as an "already asked" hint — a bridge question
				// is never banked (see rememberGenerated), so without this the model has no
				// memory of it and can regenerate a near-identical one every time it resurfaces.
				this.bridges[key] = {
					a: c.a,
					b: c.b,
					bridgeConcept: c.bridgeConcept,
					status: "suggested",
					lastSeen: now,
					lastQuestion: prev?.lastQuestion,
				};
				this.bridgesDirty = true;
				this.targets.push({
					conceptId: `__bridge__:${key}`,
					note: c.a,
					label: c.bridgeConcept,
					context: `${safeSlice(this.noteText[c.a] ?? "", 600)}\n\n${safeSlice(this.noteText[c.b] ?? "", 600)}`,
					targetDifficulty: "hard",
					connectTo: c.b,
					bridge: true,
					bridgeConcept: c.bridgeConcept,
					priorQuestions: prev?.lastQuestion ? [prev.lastQuestion] : undefined,
				});
				this.targetCount += 1;
				added += 1;
			}
		} catch {
			// Bridges are a bonus; never fail the session over them.
		}
	}

	/** Record that a bridge question was answered (or its link written), keyed by the
	 * note pair, so the pair isn't re-surfaced and the dashboard can count links made.
	 * `lastQuestion` (passed on the "answered" call, which always has the question in
	 * scope) is kept so a pair that goes unanswered and gets re-suggested later can
	 * tell the model what it already asked — see appendBridgeTargets. */
	private recordBridgeResult(fromNote: string, toNote: string, status: "answered" | "linked", lastQuestion?: string): void {
		const key = pairKey(fromNote, toNote);
		const rec = this.bridges[key];
		const now = new Date().toISOString();
		if (rec) {
			if (rec.status !== "linked") rec.status = status; // a written link is terminal
			rec.lastSeen = now;
			if (lastQuestion) rec.lastQuestion = lastQuestion;
		} else {
			this.bridges[key] = { a: fromNote, b: toNote, bridgeConcept: "", status, lastSeen: now, lastQuestion };
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
			// Name what's actually happening rather than a static "just a moment" — a
			// blank spinner reads as stuck; naming the concept it's drawing on doesn't
			// make the call any faster, but a visible, specific target measurably cuts
			// how slow a wait *feels*, especially the very first calls of a session
			// against fresh content (no prompt-cache hit yet — see generateQuestions'
			// cacheable/rest split in llm.ts, which only pays off on a note's 2nd+ touch).
			const next = this.targets[this.planCursor];
			try {
				await this.withDebouncedLoading(
					"Writing your next question",
					next ? `On ${next.note}: ${next.label}` : "Just a moment.",
					() => this.loadNextBatch(),
				);
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

	/** "Bad question": the current question is wrong, broken, or nonsensical — an AI
	 * generation defect, not something to hold against the student. Purges the specific
	 * cached variant so it can never be served again (a fresh one will be generated next
	 * time this concept comes up), drops it from this session without recording an
	 * answer or touching the concept's schedule, and shrinks the promised total by one
	 * — same shortfall handling loadNextBatch already uses when the validator drops a
	 * target. */
	private async reportBadQuestion(): Promise<void> {
		const q = this.questions[this.idx];
		if (q.conceptId) {
			const bank = this.questionBank[q.conceptId];
			if (bank) {
				const kept = bank.filter((e) => e.question !== q.question);
				if (kept.length !== bank.length) {
					this.questionBank[q.conceptId] = kept;
					this.bankDirty = true;
				}
			}
		}
		this.questions.splice(this.idx, 1);
		this.targetCount = Math.max(this.questions.length, this.targetCount - 1);
		new Notice("Grill: question deleted. Won't come back, and it doesn't count against you.");
		await this.flush();
		await this.goToQuestion(this.idx);
	}

	private async startSession(): Promise<void> {
		this.replayMode = false;
		const s = this.plugin.data.settings;
		const needsKey = this.plugin.usesAI();
		const cfg = this.plugin.llmConfig();
		if (needsKey && !cfg) {
			// A one-click way out, not just instructions to go find it in Settings: this is
			// the exact dead end a fresh no-key install used to hit on its very first "Get
			// grilled" click, before onboarding asked about AI vs. offline — this covers
			// anyone who picked AI then, or never saw that screen (upgraded from an older
			// version), and just wants to keep going right now.
			new Notice(
				createFragment((frag) => {
					frag.appendText("Grill: set an API key in settings, or ");
					const link = frag.createEl("a", { text: "switch to no-key mode" });
					link.onclick = async (e) => {
						e.preventDefault();
						s.questionSource = "local";
						s.gradingMode = "self";
						await this.plugin.persist();
						new Notice('Grill: switched to no-key mode. Click "Get grilled" again.', 6000);
						this.renderStart();
					};
					frag.appendText(" now.");
				}),
				10000,
			);
			return;
		}
		const files = this.mdFiles();
		if (files.length === 0) {
			// A deliberate scope (right-click "Grill this note/folder", or a specific
			// note/folder picked in the panel) that comes up empty almost always means
			// it's outside Grill's configured folders, not that the vault has no notes
			// at all — that generic message was actively misleading for this case, so
			// tell the student what's actually wrong instead.
			const scoped = this.sessionScope && this.sessionScope.length > 0;
			new Notice(
				scoped
					? "Grill: everything you picked is outside Grill's configured folders. Check Settings → Grill → \"Grill's folders\", or Excluded folders."
					: "Grill: no markdown notes in this vault.",
				8000,
			);
			return;
		}
		this.sessionStart = new Date();
		this.renderLoading("Preparing your session", "Choosing which notes to quiz you on.");
		try {
			this.plugin.mastery = await this.plugin.store.loadMastery();
			this.registry = await this.plugin.store.loadRegistry();
			this.bridges = await this.plugin.store.loadBridges();
			this.questionBank = await this.plugin.store.loadQuestionBank();
			this.bankLoaded = true;
			this.bankDirty = false;
			this.bridgesDirty = false;
			const instr = await this.plugin.store.loadInstructions();
			this.sessionPersona = instr.persona;
			this.sessionInstructions = instr.preferences;
			// If two files here share a basename (see duplicateBasenames in scope.ts —
			// Grill's mastery/concepts persistence can't tell them apart either way),
			// resolve deterministically by path — first-wins, sorted — rather than
			// whichever the vault happened to enumerate/filter to last.
			this.byName = new Map();
			for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
				if (!this.byName.has(f.basename)) this.byName.set(f.basename, f);
			}
			const byName = this.byName;
			// Loaded here, ahead of pickCandidates below, so it can prioritize off live
			// concept data (see priorityNotes) instead of the note-level mastery cache.
			this.concepts = this.plugin.concepts = await this.plugin.store.loadConcepts();
			// Interleave by folder before priority-bucketing: pickCandidates's untested
			// bucket preserves input order, so a scope spanning multiple folders would
			// otherwise collapse onto whichever folder sorts first (see interleaveByFolder).
			const orderedNames = interleaveByFolder([...byName.keys()], (n) => byName.get(n)?.parent?.path ?? "");
			// autoNotesPoolCap exists to bound an AUTO-selected slice of the whole
			// vault (the unscoped "let Grill choose" session) — it has no business
			// truncating a session the user explicitly scoped themselves ("Grill this
			// note/folder", or the due queue): `sessionScope` already narrowed `byName`
			// to exactly what they picked, so capping the seed here would silently drop
			// notes they deliberately chose before concepts are even picked (same class
			// of bug as the questionsPerSession cap below). Scoped sessions still get a
			// large ceiling, not truly unbounded, as a sanity cap on reading/extracting
			// an unreasonable number of full notes in one go.
			const notesCap = this.sessionScope ? NO_MEANINGFUL_CAP : autoNotesPoolCap(s.questionsPerSession, byName.size);
			const priority = priorityNotes(this.concepts, (note) => byName.has(note));
			const seed = pickCandidates(orderedNames, this.plugin.mastery, notesCap, priority);
			const names = expandSelectionWithLinks(this.app, seed, byName, this.plugin.mastery, notesCap);
			const vision = !!cfg && s.questionSource === "ai" && s.sendImages && supportsVision(cfg.provider, cfg.model);
			this.sessionVision = vision;
			this.noteText = {};
			this.noteImages = {};
			this.notesWithUnsentImages = new Set();
			this.conceptsByNote = new Map();
			for (const n of names) {
				const file = byName.get(n);
				if (!file) continue;
				const raw = await this.app.vault.cachedRead(file);
				// A note that only embeds a PDF (`![[worksheet.pdf]]`) has real content, just
				// none of it in the note's own markdown text — pull the PDF's text in as if
				// it were typed there, so it's not invisible to both the structural parser and
				// the AI prompt below (see pdf.ts; a no-op for notes with no PDF embeds).
				const pdfText = await collectNotePdfText(this.app, file);
				const text = pdfText ? `${raw}\n\n${pdfText}` : raw;
				// Extract concepts from the FULL note; only the prompt context is truncated.
				this.conceptsByNote.set(n, extractConcepts(n, text, this.plugin.data.settings.questionFormats));
				this.noteText[n] = text.length > NOTE_CHAR_CAP ? safeSlice(text, NOTE_CHAR_CAP) + "\n[truncated]" : text;
				if (vision) {
					const imgs = await collectNoteImages(this.app, file, IMAGES_PER_NOTE_CAP);
					if (imgs.length) this.noteImages[n] = imgs;
				} else if (this.app.metadataCache.getFileCache(file)?.embeds?.length) {
					this.notesWithUnsentImages.add(n);
				}
			}
			// "Send images" is on, but the chosen model can't actually read them: the
			// session still runs fine (the model is told to quiz text only), but silently
			// — with no visible sign the toggle isn't doing anything for this model, it
			// reads as "images are broken" rather than "this model doesn't support vision".
			if (cfg && s.questionSource === "ai" && s.sendImages && !supportsVision(cfg.provider, cfg.model) && this.notesWithUnsentImages.size > 0) {
				new Notice(
					`Grill: ${cfg.model} can't read images, so this session will quiz on text only. Switch to a vision model (Claude, GPT-4o/5, Gemini, or a vision Ollama model) to include them.`,
					8000,
				);
			}

			const selectedFiles = names.map((n) => byName.get(n)).filter((f): f is TFile => !!f);
			const graph = buildSessionGraph(this.app, selectedFiles);
			this.linksBlock = formatLinksBlock(graph, this.plugin.mastery);
			this.noteFoundationalRank = new Map(graph.foundationalOrder.map((n, i) => [n, i]));
			this.sessionNeighbors = new Map(
				Object.entries(graph.adjacency).map(([n, adj]) => [n, [...new Set([...adj.linksTo, ...adj.linkedFrom])]]),
			);

			// Concept layer: reconcile the extracted concepts (create new ones,
			// re-open any whose source text changed), then pick which to test.
			// Same object handed to the plugin so in-session rating updates (mutated
			// in place, not reassigned) stay visible to its due-count/dashboard readers
			// without a separate re-sync. (Loaded earlier, above, so pickCandidates could
			// use it too — not reloaded here.)
			const allConcepts: Concept[] = [];
			for (const cs of this.conceptsByNote.values()) allConcepts.push(...cs);
			reconcileConcepts(this.concepts, allConcepts);
			this.conceptById = new Map(allConcepts.map((c) => [c.id, c]));
			// Snapshot of the whole vault's due-date distribution, not just this
			// session's concepts — a newly-scheduled review should spread against
			// everything already due, not just what happens to be in today's batch.
			this.dueDateHistogram = buildDueDateHistogram(Object.values(this.concepts).map((c) => c.dueAt));

			this.questions = [];
			this.results = [];
			this.idx = 0;
			this.pending = null;
			this.routesUsed = 0;
			this.routedNotes.clear();
			this.contagionUsed = 0;
			this.contagionNotes.clear();
			this.planCursor = 0;
			const want = this.dueOnly ? NO_MEANINGFUL_CAP : Math.max(1, s.questionsPerSession);

			// No-key mode can only use concepts that carry a deterministic question.
			const pickable = s.questionSource === "local" ? allConcepts.filter((c) => c.local) : allConcepts;
			this.sessionConcepts = pickConcepts(pickable, this.concepts, want, this.dueOnly, new Date(), s.newConceptsPerDay);
			if (this.sessionConcepts.length === 0) {
				const cappedOut =
					!this.dueOnly && blockedByDailyCap(pickable, this.concepts, s.newConceptsPerDay, new Date());
				new Notice(
					cappedOut
						? `Grill: that's all the new material for today — you've hit your daily limit of ${s.newConceptsPerDay} new concepts. Come back tomorrow, or raise "New concepts per day" in Settings.`
						: s.questionSource === "local"
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
			const mixFormats = s.questionFormats !== "write";
			// "mc" is a fixed single format, not a rotation: every target is forced to
			// "mc" directly rather than going through seedType's FORMAT_ROTATION (which
			// exists to vary formats — the opposite of what "mc only" asks for).
			this.targets = this.sessionConcepts.slice(0, this.targetCount).map((c, i) => {
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
					targetType: !mixFormats ? undefined : s.questionFormats === "mc" ? "mc" : this.seedType(c.kind, i),
					activeMisconception,
				};
			});

			if (s.questionSource === "local") {
				this.questions = localQuestions(this.sessionConcepts, this.targetCount, (c) =>
					conceptTargetDifficulty(this.concepts[c.id]),
				);
				this.renderQuestion();
				return;
			}

			// Missing-link finder: append up to N bridge questions as a capstone (AI only).
			if (s.graphInsights && s.bridgesPerSession > 0 && cfg) {
				await this.appendBridgeTargets(cfg, names, s.bridgesPerSession);
			}

			// A due review's targets are, by construction, concepts that have already been
			// tested before — so in the common case every one of them already has a cached
			// (or authored) question and this needs no model call at all. Only show the
			// "writing questions" loading screen, with its "reading N notes" LLM messaging,
			// when there's actually at least one target that isn't prebuilt: otherwise
			// nothing is being read or written, and the screen is just a misleading flash
			// before a session that's about to resolve instantly from cache (see
			// loadNextBatch: a fully-prebuilt run resolves synchronously).
			if (this.targets.some((t) => !this.isPrebuilt(t))) {
				this.renderLoading(
					"Writing your questions",
					`${cfg!.model} is reading ${names.length} notes. This usually takes a few seconds.`,
				);
			}
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

	private async submitAnswer(
		answer: string,
		gaveUp: boolean,
		hintsUsed: number,
		multiPicks?: string[],
		matchPicks?: Record<string, string>,
	): Promise<void> {
		const q = this.questions[this.idx];
		let verdict: Verdict;
		let feedback: string;
		let misconceptionTag = "";
		if (gaveUp) {
			// Zero-cost path: the rubric was generated with the question.
			verdict = "incorrect";
			feedback = "No penalty for honesty. Read the expected answer, then the note; this comes back next session.";
		} else if (q.type === "mc" || q.type === "tf") {
			// Unambiguous, structured formats: grade instantly, no LLM round-trip needed.
			verdict = answer.trim().toLowerCase() === q.modelAnswer.trim().toLowerCase() ? "correct" : "incorrect";
			feedback = verdict === "correct" ? "Correct." : `Not quite. The answer is "${q.modelAnswer}".`;
		} else if (q.type === "multi") {
			// Name the specific misses/extras instead of just dumping the model answer a
			// second time — the "Expected answer" block below already shows that string
			// verbatim, so repeating it here added nothing and read as two systems
			// disagreeing rather than one giving you the actual diagnosis.
			const norm = (s: string) => s.trim().toLowerCase();
			const correctChoices = q.correctChoices ?? [];
			const chosenChoices = multiPicks ?? [];
			const correct = new Set(correctChoices.map(norm));
			const chosen = new Set(chosenChoices.map(norm));
			let hits = 0;
			for (const c of correct) if (chosen.has(c)) hits++;
			const misses = correct.size - hits;
			const extraItems = chosenChoices.filter((c) => !correct.has(norm(c)));
			const missedItems = correctChoices.filter((c) => !chosen.has(norm(c)));
			const wrong = misses + extraItems.length;
			if (wrong === 0) verdict = "correct";
			else if (hits > 0 && wrong <= Math.max(1, Math.ceil(correct.size / 2))) verdict = "partial";
			else verdict = "incorrect";
			if (verdict === "correct") {
				feedback = "Correct — every one.";
			} else {
				const lines: string[] = [];
				if (extraItems.length) {
					lines.push(`"${extraItems.join('", "')}" ${extraItems.length > 1 ? "don't" : "doesn't"} belong.`);
				}
				if (missedItems.length) lines.push(`Missing: ${missedItems.join(", ")}.`);
				feedback = lines.join(" ");
			}
		} else if (q.type === "match") {
			const pairs = q.pairs ?? [];
			const wrongPairs = pairs.filter(
				(p) => (matchPicks?.[p.left] ?? "").trim().toLowerCase() !== p.right.trim().toLowerCase(),
			);
			const hits = pairs.length - wrongPairs.length;
			verdict = hits === pairs.length ? "correct" : hits > 0 ? "partial" : "incorrect";
			feedback =
				verdict === "correct"
					? "Every pair correct."
					: wrongPairs
							.map((p) => `"${p.left}" should match "${p.right}", not "${matchPicks?.[p.left] || "(unmatched)"}".`)
							.join(" ");
		} else {
			const cfg = this.plugin.llmConfig();
			if (!cfg) return;
			try {
				const g = await this.withDebouncedLoading(
					"Grading your answer",
					"Checking it against your note and the rubric.",
					() => this.gradeMaybeCareful(cfg, q, answer),
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
		await this.applyGrade(q, verdict, null, misconceptionTag || undefined, hintsUsed);
		this.captureConfidence(verdict);
		// Missed it: route to a weak prerequisite next, if this note builds on one, or
		// check whether the same confusion applies to a linked neighbor. Mid-session this
		// happens silently (organic growth); on what would have been the last question,
		// ask first rather than silently extending past the agreed count. Prerequisite
		// routing takes priority — only offer contagion when there's no prerequisite to
		// offer, so the student is never asked twice in the same turn.
		let pendingExtension: PendingExtension | null = null;
		if (verdict === "incorrect") {
			if (this.idx + 1 >= this.targetCount) {
				const route = this.findPrerequisiteRoute(q.node);
				if (route) pendingExtension = { kind: "prerequisite", route, fromNote: q.node };
				else if (misconceptionTag) {
					const contagion = this.findContagionRoute(q.node, misconceptionTag);
					if (contagion) pendingExtension = { kind: "contagion", route: contagion, fromNote: q.node };
				}
			} else {
				this.maybeRouteToPrerequisite(q.node);
				if (misconceptionTag) this.maybeSpreadMisconception(q.node, misconceptionTag);
			}
		}
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
		this.renderFeedback(r, pendingExtension);
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
		this.md(q.question, qEl, q.node);

		const revealCard = card.createDiv({ cls: "grill-flow-card grill-review-card" });
		if (!gaveUp && answer) {
			revealCard.createDiv({ cls: "grill-block-label", text: "Your answer" });
			const ans = revealCard.createDiv({ cls: "grill-your-answer" });
			this.md(`> ${answer.split("\n").join("\n> ")}`, ans, q.node);
		}
		revealCard.createDiv({ cls: "grill-block-label", text: "Answer" });
		this.md(q.modelAnswer, revealCard.createDiv({ cls: "grill-model-answer" }), q.node);

		// Self-grade never scores until a rating button below is clicked, so this is
		// still "before answering" as far as the schedule is concerned — same simple
		// delete-and-move-on as the pre-answer version, no snapshot to restore.
		if (!q.authored) {
			const badRow = card.createDiv({ cls: "grill-btn-row" });
			const badBtn = badRow.createEl("button", { text: "Bad question", cls: "grill-quiet-btn" });
			badBtn.setAttribute("title", "Wrong, broken, or nonsensical — delete it and move on, no penalty");
			badBtn.onclick = () => {
				badRow.querySelectorAll("button").forEach((b) => (b.disabled = true));
				void this.reportBadQuestion();
			};
		}

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
		hintsUsed = 0,
	): Promise<void> {
		// Cleared by default; only the AI/deterministic-verdict path below (re)populates
		// it. Never carries over from a previous question.
		this.pendingOverride = null;
		// Replay is practice-only: never touch the schedule or stats.
		if (this.replayMode) return;
		// A missing-link bridge question is outside FSRS scheduling: it isn't a note
		// concept, so it must not touch concept or note mastery. Record the pair instead.
		if (q.missingLink) {
			if (q.connectTo) this.recordBridgeResult(q.node, q.connectTo, "answered", q.question);
			return;
		}
		const cid = q.conceptId;
		if (cid && this.concepts[cid]) {
			const retention = this.plugin.data.settings.desiredRetention / 100;
			if (rating !== null) {
				// Self-grade: the student's own Again/Hard/Good/Easy already IS the ground
				// truth (no third-party verdict to second-guess), so no override snapshot.
				recordConceptRating(this.concepts, cid, rating, new Date(), retention, this.dueDateHistogram);
			} else {
				// Snapshot the pre-answer state before mutating it — see pendingOverride's
				// doc comment. structuredClone is safe here: ConceptMastery is plain JSON
				// data (numbers/strings/a flat array), nothing that doesn't survive a clone.
				this.pendingOverride = {
					conceptId: cid,
					conceptSnapshot: structuredClone(this.concepts[cid]),
					note: q.node,
					originalVerdict: verdict,
					originalMisconceptionTag: misconceptionTag,
					difficulty: q.difficulty ?? "medium",
					confidence: this.pendingConfidence,
					hintsUsed,
				};
				recordConceptAnswer(
					this.concepts,
					cid,
					verdict,
					q.difficulty ?? "medium",
					new Date(),
					retention,
					this.dueDateHistogram,
					// Read before captureConfidence (called after applyGrade returns) clears it —
					// a genuinely-guessed correct answer should land as Hard, not Good/Easy.
					this.pendingConfidence,
					hintsUsed,
				);
			}
		}
		recordNoteStats(this.plugin.mastery, q.node, verdict, misconceptionTag);
		this.recomputeAggregate(q.node);
		this.dirty = true; // flushed at session end / pane close
	}

	/** "Mark correct": the deterministic/AI grader got this one wrong. Restores the
	 * concept to its pre-answer snapshot (see pendingOverride) and replays the exact
	 * same scheduling call with verdict forced to "correct" — no hand-rolled FSRS
	 * "undo" math, just the normal correct-path logic run from the real prior state.
	 * Also corrects the note-level counters/misconception tally, then re-renders the
	 * feedback screen from scratch so the badge, "Expected answer" visibility, and
	 * everything else fall out consistently rather than being patched by hand.
	 *
	 * Known, accepted limitation: if the wrong verdict already triggered a
	 * prerequisite-routing or misconception-contagion question spliced into the
	 * session, this does not un-splice it. Asking one extra check question that turns
	 * out to have been unnecessary is harmless; unwinding it mid-flight risks
	 * desyncing planCursor against the questions array. Not chasing that edge case. */
	private async markCorrect(r: QuestionResult): Promise<void> {
		const o = this.pendingOverride;
		if (!o || r.verdict === "correct") return;
		const cm = this.concepts[o.conceptId];
		if (cm) {
			Object.assign(cm, structuredClone(o.conceptSnapshot));
			const retention = this.plugin.data.settings.desiredRetention / 100;
			recordConceptAnswer(
				this.concepts,
				o.conceptId,
				"correct",
				o.difficulty,
				new Date(),
				retention,
				this.dueDateHistogram,
				o.confidence,
				o.hintsUsed,
			);
		}
		// Correct note-level counters: undo the wrong bucket, credit the right one, and
		// remove the misconception tally if a tag was recorded off the wrong verdict.
		const m = this.plugin.mastery[o.note];
		if (m) {
			if (o.originalVerdict === "partial") m.partial = Math.max(0, m.partial - 1);
			else if (o.originalVerdict === "incorrect") m.incorrect = Math.max(0, m.incorrect - 1);
			m.correct += 1;
			if (o.originalMisconceptionTag) {
				const remaining = (m.misconceptions[o.originalMisconceptionTag] ?? 0) - 1;
				if (remaining <= 0) delete m.misconceptions[o.originalMisconceptionTag];
				else m.misconceptions[o.originalMisconceptionTag] = remaining;
			}
		}
		this.recomputeAggregate(o.note);
		// Same object reference already sitting in this.results, so the session summary
		// and end-of-session debrief transcript see the correction for free.
		r.verdict = "correct";
		r.feedback = "Marked correct by you.";
		r.misconceptionTag = undefined;
		this.pendingOverride = null;
		this.dirty = true;
		await this.flush();
		this.renderFeedback(r, null);
	}

	/** "Bad question", after the fact: the pre-answer version (`reportBadQuestion`)
	 * only covers a question deleted before it's scored — but a wrong, broken, or
	 * nonsensical question is just as often obvious only once you've read the
	 * feedback. Restores the concept to its pre-answer snapshot (see pendingOverride,
	 * the same mechanism "Mark correct" uses) instead of re-scoring it, undoes the
	 * note-level counters/misconception tally, purges the cached variant so it's
	 * never served again, and drops it from the session and its results/debrief
	 * transcript — exactly as if it had never been asked. Same single-use
	 * restriction as "Mark correct": only available right after the answer that
	 * produced it. */
	private async discardAnsweredQuestion(r: QuestionResult): Promise<void> {
		const o = this.pendingOverride;
		if (!o) return;
		const cm = this.concepts[o.conceptId];
		if (cm) Object.assign(cm, structuredClone(o.conceptSnapshot));
		const m = this.plugin.mastery[o.note];
		if (m) {
			if (o.originalVerdict === "correct") m.correct = Math.max(0, m.correct - 1);
			else if (o.originalVerdict === "partial") m.partial = Math.max(0, m.partial - 1);
			else m.incorrect = Math.max(0, m.incorrect - 1);
			if (o.originalMisconceptionTag) {
				const remaining = (m.misconceptions[o.originalMisconceptionTag] ?? 0) - 1;
				if (remaining <= 0) delete m.misconceptions[o.originalMisconceptionTag];
				else m.misconceptions[o.originalMisconceptionTag] = remaining;
			}
		}
		this.recomputeAggregate(o.note);
		const bank = this.questionBank[o.conceptId];
		if (bank) {
			const kept = bank.filter((e) => e.question !== r.question);
			if (kept.length !== bank.length) {
				this.questionBank[o.conceptId] = kept;
				this.bankDirty = true;
			}
		}
		const ri = this.results.lastIndexOf(r);
		if (ri !== -1) this.results.splice(ri, 1);
		this.questions.splice(this.idx, 1);
		this.targetCount = Math.max(this.questions.length, this.targetCount - 1);
		this.pendingOverride = null;
		this.dirty = true;
		new Notice("Grill: question deleted. Won't come back, and it doesn't count against you.");
		await this.flush();
		await this.goToQuestion(this.idx);
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
		this.mapRebuild = null;
		this.confettiStop?.();
		this.confettiStop = null;
		stopSpeaking();
		await this.flush();
	}

	/** Project the note's concept states back into its note-level status + due date,
	 * and separately flag (without disturbing aggStatus) whether it rests on a
	 * shaky prerequisite. */
	private recomputeAggregate(note: string): void {
		const m = this.plugin.mastery[note];
		if (!m) return;
		const ids = (this.conceptsByNote.get(note) ?? []).map((c) => c.id);
		const agg = noteAggregate(ids, this.concepts);
		m.aggStatus = agg.aggStatus;
		m.dueAt = agg.dueAt;
		m.weakPrereq = this.findWeakPrereq(note, m);
	}

	/** A note can read "known" on its own FSRS history while a tested prerequisite it
	 * links to is struggling. Surfaced as a separate signal (NoteMastery.weakPrereq),
	 * never folded into aggStatus — the note's own status stays honest, and due-queue
	 * selection / prerequisite routing keep reading pure statusOf, unperturbed by this.
	 * Bounded: only tested-weak prerequisites count; first one found wins. */
	private findWeakPrereq(note: string, m: NoteMastery): string | null {
		if (m.aggStatus !== "known") return null;
		const file = this.byName.get(note);
		if (!file) return null;
		for (const pre of outgoingBasenames(this.app, file)) {
			if (this.genuinelyStruggling(pre)) return pre;
		}
		return null;
	}

	/** Genuinely shaky, not merely mid-learning: a miss is on record and the note
	 * hasn't re-consolidated to "known". Note-level statusOf "struggling" is too broad
	 * for a weak-foundation flag — since the status rework it also covers touched-but-
	 * not-yet-known notes, which are progressing fine and shouldn't read as shaky. */
	private genuinelyStruggling(note: string): boolean {
		const m = this.plugin.mastery[note];
		return !!m && m.incorrect + m.partial > 0 && statusOf(m) !== "known";
	}

	/** Structural difficulty seed: a brand-new (untested) concept starts one rung up
	 * (medium, not easy) when its note builds only on foundations the student has
	 * already confirmed. No point lobbing the easiest possible question at an advanced
	 * note whose prerequisites are solid. Seeds DIFFICULTY only, never mastery, so it
	 * can't create a coverage illusion; any shaky prerequisite keeps it easy. */
	private seedType(kind: ConceptKind, index: number): Question["type"] {
		const t = FORMAT_ROTATION[index % FORMAT_ROTATION.length];
		// 'multi'/'match' need several distinct related items, which only a broader
		// concept has (a whole heading/section, or the whole-note fallback) — an atomic
		// single-fact concept (a vocab card, a definition, a formula, a bare term) can't
		// genuinely support them, so substitute the nearest structured alternative
		// rather than silently skipping that slot in the rotation.
		if ((t === "multi" || t === "match") && !BROAD_CONCEPT_KINDS.has(kind)) return t === "multi" ? "mc" : "blank";
		return t;
	}

	private seedDifficulty(cm: ConceptMastery | undefined, note: string, graph: SessionGraph): QDifficulty {
		const base = conceptTargetDifficulty(cm);
		if (base !== "easy" || conceptTested(cm)) return base; // only seed the first exposure
		const prereqs = graph.adjacency[note]?.linksTo ?? [];
		if (!prereqs.length) return base;
		if (prereqs.some((p) => this.genuinelyStruggling(p))) return "easy"; // genuinely shaky foundation: stay easy
		return prereqs.some((p) => statusOf(this.plugin.mastery[p]) === "known") ? "medium" : base; // a solid foundation: start up
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

	/** A note's position in the session graph's foundationalOrder — lower is more
	 * heavily depended-upon by other session notes. Notes outside the session graph
	 * (shouldn't normally happen for a routing candidate, but not guaranteed) sort last,
	 * so the tie-break only ever activates between two notes it actually has data for. */
	private foundationalRank(note: string): number {
		return this.noteFoundationalRank.get(note) ?? Number.MAX_SAFE_INTEGER;
	}

	/** Reactive DOWN-on-failure routing: after a wrong answer mid-session, if the missed
	 * note builds on a prerequisite the student is weak on, insert a question about that
	 * prerequisite next so they shore up the foundation before moving on — no confirmation,
	 * since the session hasn't reached its agreed length yet. Bounded to MAX_ROUTES per
	 * session, never the same prerequisite twice, and only when the prerequisite is in
	 * this session with a weak, not-already-planned concept. When the wrong answer is on
	 * what was going to be the LAST question, callers should use `findPrerequisiteRoute` +
	 * `commitRoutedTarget` instead, so the student can be asked before the session grows
	 * past what they agreed to. */
	private maybeRouteToPrerequisite(fromNote: string): void {
		const route = this.findPrerequisiteRoute(fromNote);
		if (route) this.commitRoutedTarget(route, fromNote);
	}

	/** Pure lookup for reactive routing: is there a weak, not-yet-planned,
	 * not-already-routed prerequisite the missed note builds on? Does not mutate any
	 * session state, so it's safe to call just to see what WOULD be offered. */
	private findPrerequisiteRoute(fromNote: string): PrereqRoute | null {
		if (this.replayMode) return null; // no generation or plan mutation during a replay
		if (this.routesUsed >= MAX_ROUTES) return null;
		const file = this.byName.get(fromNote);
		if (!file) return null;
		const local = this.plugin.data.settings.questionSource === "local";
		const planned = new Set(this.targets.map((t) => t.conceptId));
		// Weakest-first, same as before; among equally-weak candidates, prefer the one
		// more heavily depended-upon by other session notes (shoring it up pays off
		// across the whole session, not just this one edge). In a sparse vault every
		// candidate ranks equally (or is unranked), so this tie-break is a no-op and
		// behavior is identical to before.
		const prereqs = outgoingBasenames(this.app, file)
			.filter((p) => p !== fromNote && this.byName.has(p) && !this.routedNotes.has(p))
			.sort((a, b) => this.noteWeakness(a) - this.noteWeakness(b) || this.foundationalRank(a) - this.foundationalRank(b));
		for (const p of prereqs) {
			if (this.noteWeakness(p) === 2) break; // sorted weakest-first: the rest are known
			const concept = (this.conceptsByNote.get(p) ?? []).find(
				(c) => !planned.has(c.id) && (!local || c.local) && statusOf(this.concepts[c.id]) !== "known",
			);
			if (concept) return { concept, prereqNote: p, local };
		}
		return null;
	}

	/** Commit a route found by `findPrerequisiteRoute`: splice it in as the next question
	 * and account for it (never offer the same prerequisite twice, bound to MAX_ROUTES).
	 * Returns false if a question couldn't actually be built for it, in which case nothing
	 * was committed. */
	private commitRoutedTarget(route: PrereqRoute, fromNote: string): boolean {
		if (!this.insertRoutedTarget(route.concept, fromNote, route.local)) return false;
		this.routedNotes.add(route.prereqNote);
		this.routesUsed += 1;
		return true;
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
			// and splice it in as the very next question. Matches the AI path's explicit
			// "easy" above — a shaky-foundation prerequisite check, not a stretch question.
			const built = localQuestions([concept], 1, () => "easy");
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

	/** Reactive misconception contagion: after a wrong answer mid-session, if the missed
	 * note's confusion might apply to a linked neighbor, insert a question testing that
	 * neighbor for the same tag next — no confirmation needed mid-session, same as
	 * prerequisite routing. AI mode only. */
	private maybeSpreadMisconception(fromNote: string, tag: string): void {
		const route = this.findContagionRoute(fromNote, tag);
		if (route) this.commitContagionTarget(route, fromNote);
	}

	/** Pure lookup for misconception contagion: is there an untested/struggling,
	 * in-session, not-yet-planned, not-yet-probed neighbor of `fromNote` worth checking
	 * for the same confusion? AI mode only — no deterministic way to judge relevance
	 * without a model in the loop. Does not mutate any session state. */
	private findContagionRoute(fromNote: string, tag: string): ContagionRoute | null {
		if (this.replayMode) return null;
		if (this.plugin.data.settings.questionSource === "local") return null;
		if (this.contagionUsed >= MAX_CONTAGION) return null;
		const planned = new Set(this.targets.map((t) => t.conceptId));
		const neighbors = (this.sessionNeighbors.get(fromNote) ?? [])
			.filter((n) => n !== fromNote && this.byName.has(n) && !this.contagionNotes.has(n))
			.sort((a, b) => this.noteWeakness(a) - this.noteWeakness(b) || this.foundationalRank(a) - this.foundationalRank(b));
		for (const n of neighbors) {
			if (this.noteWeakness(n) === 2) break; // known: no point re-probing there
			const concept = (this.conceptsByNote.get(n) ?? []).find(
				(c) => !planned.has(c.id) && statusOf(this.concepts[c.id]) !== "known",
			);
			if (concept) return { concept, neighborNote: n, tag };
		}
		return null;
	}

	/** Commit a contagion candidate found by `findContagionRoute`: splice it into the
	 * not-yet-generated plan (AI mode only, so always via `targets`) and account for it
	 * (never probe the same neighbor twice, bounded to MAX_CONTAGION). */
	private commitContagionTarget(route: ContagionRoute, fromNote: string): void {
		this.targets.splice(this.planCursor, 0, {
			conceptId: route.concept.id,
			note: route.concept.note,
			label: route.concept.label,
			context: route.concept.context,
			targetDifficulty: "easy",
			activeMisconception: route.tag,
			contagionFrom: fromNote,
		});
		this.targetCount += 1;
		this.contagionNotes.add(route.neighborNote);
		this.contagionUsed += 1;
	}

	private async recordSelfGrade(rating: Rating, answer: string, gaveUp: boolean, hintsUsed: number): Promise<void> {
		const q = this.questions[this.idx];
		const verdict: Verdict = rating === 1 ? "incorrect" : rating === 2 ? "partial" : "correct";
		if (this.plugin.data.settings.sounds) playSfx(verdict);
		await this.applyGrade(q, verdict, rating, undefined);
		// Self-grade never produces a misconceptionTag (no AI grader call), so contagion
		// can't trigger here — only prerequisite routing applies to this path.
		let pendingRoute: PendingExtension | null = null;
		if (verdict === "incorrect") {
			if (this.idx + 1 >= this.targetCount) {
				const route = this.findPrerequisiteRoute(q.node);
				if (route) pendingRoute = { kind: "prerequisite", route, fromNote: q.node };
			} else {
				this.maybeRouteToPrerequisite(q.node);
			}
		}
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
		if (pendingRoute) this.renderRouteConsent(pendingRoute);
		else await this.goToQuestion(this.idx + 1);
	}

	/** Standalone version of the route-consent step for the self-grade path, which has
	 * no separate feedback screen to append into (see `renderRouteConsentInto` for the
	 * AI-graded path's inline version). */
	private renderRouteConsent(pending: PendingExtension): void {
		const wrap = this.root();
		this.progressBar(wrap);
		const card = wrap.createDiv({ cls: "grill-body" });
		this.renderRouteConsentInto(card, pending);
	}
}
