/** The learning graph: a Grill-owned map of the user's notes, coloured by what they've
 * proven they know and grown by how durably they know it.
 *
 * This module is pure and headless-testable: it takes plain data (note names, undirected
 * links, the concept mastery map, and an "is this pair a proven connection?" predicate) and
 * produces laid-out nodes + tiered edges. The Obsidian-facing side (enumerating links,
 * reading CSS colours, canvas drawing) lives in the view.
 *
 * Node colour is exactly the same 3-bucket split as the start screen's own Untested /
 * Learning / Known stat tiles (renderStart's addStat, backed by concepts.ts's
 * noteAggregate) — deliberately identical logic, not just a similar one, so the map is
 * literally a picture of those three numbers: grey = untested, struggling = "Learning",
 * known = confirmed-known coverage >= 80%. No fourth bucket in between — the dashboard
 * doesn't have one, so the map doesn't either. Node size grows with proven strength (mean
 * FSRS stability of the note's tested concepts). Edges come in three tiers: structural (a
 * link, always shown), inherited (both ends practised), proven (the relationship was
 * quizzed and passed).
 */

import type { ConceptMap, ConceptMastery } from "./concepts";
import { conceptMasteryScore, isLeech, statusOf } from "./mastery";

export type NodeState = "unpracticed" | "struggling" | "known";
export type EdgeTier = "structural" | "inherited" | "proven";

export interface GraphNode {
	id: string; // note basename
	state: NodeState;
	/** Mean FSRS stability of the note's tested concepts (0 when unpractised). */
	strength: number;
	/** Confirmed-known concepts / min(total concepts, COVERAGE_TARGET), 0-1. The same
	 * figure noteAggregate uses to gate "known" — exposed directly so a numeric overlay
	 * can show it without re-deriving. Capped so a content-dense note doesn't need
	 * proportionally more known concepts just to read "covered" than a short one. */
	coverage: number;
	/** Mean per-concept FSRS mastery (retrievability x confidence, see
	 * conceptMasteryScore) across TESTED concepts only — how well you'd recall what
	 * you've actually studied right now, not diluted by concepts you haven't reached
	 * yet and not haunted by an old mistake once it's been solidly re-demonstrated
	 * since. Null when nothing's been tested yet, so a display layer can show "--"
	 * instead of 0%. */
	mastery: number | null;
	/** Most recent lastSeen among the note's tested concepts, or null if untested. */
	lastSeen: string | null;
	/** Soonest dueAt among the note's tested concepts, or null if untested. */
	dueAt: string | null;
	/** Active (unresolved) canonical misconceptions observed on this note. */
	misconceptions: number;
	/** Concepts that keep failing no matter how much they've been reviewed (see
	 * isLeech), distinct from ordinary struggling. */
	leeches: number;
	x: number;
	y: number;
}

export interface GraphEdge {
	a: string;
	b: string;
	tier: EdgeTier;
}

export interface LearningGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** Coverage of confirmed-known concepts for a note to read "known" — matches
 * concepts.ts's noteAggregate exactly (same 0.8 bar, same "count individually
 * confirmed-known concepts" definition), since that function is what the dashboard's
 * headline "Known" stat is built from (view.ts's renderStart, via statusOf reading
 * mastery[note].aggStatus). The map's node colour needs to agree with that number,
 * not with a differently-computed one — a graph showing dozens of "known"-coloured
 * notes while the dashboard says 5 is a worse, more confusing mismatch than the
 * per-node number/colour disagreement this constant used to cause (see MIN_STABILITY
 * below for the rest of that history). */
const COVERAGE_KNOWN = 0.8;
/** Coverage's denominator caps at this many concepts (matches concepts.ts COVERAGE_TARGET). */
const COVERAGE_TARGET = 8;
/** FSRS stability floor (matches mastery.ts MIN_STABILITY). */
const MIN_STABILITY = 0.1;

function conceptTested(cm: ConceptMastery): boolean {
	return cm.correct + cm.partial + cm.incorrect > 0;
}

/** A note's full derived state from its concept mastery records: colour state, proven
 * strength, coverage, mastery, and recency/due timestamps. Strength = mean stability of
 * tested concepts (drives node size).
 *
 * Colour state is `noteAggregate` (concepts.ts), copied exactly — not "inspired by," not
 * "mostly matching": the same `coverage >= 0.8 ? known : struggling` split, on the same
 * definition of coverage, so the map's node counts and the dashboard's Untested/Learning/
 * Known tiles can never read differently. Two things this deliberately does NOT do,
 * because both were tried and made the map read as MORE inconsistent with the dashboard,
 * not less:
 *  - No separate "in-progress" bucket. The dashboard has exactly three numbers; giving
 *    the map a fourth colour with nothing to anchor it to was confusing on its own terms.
 *  - No per-concept "any single struggling concept veto"s the whole note. Real idea (a
 *    good average shouldn't launder one unresolved miss) but it's a DIFFERENT formula
 *    from noteAggregate's plain coverage check, so it could — and did — disagree with the
 *    dashboard's own Known count for the same note.
 *
 * `mastery` (mean retrievability x confidence, see conceptMasteryScore) is still computed
 * and still drives the map's numeric overlay (via gradeScore) — a deliberate, separate,
 * softer number that answers a different question ("how confident right now") than colour
 * does ("known by the same definition as the dashboard"). It was tried as the colour
 * signal too; reverted for the same reason as the veto above. */
export function noteState(
	records: ConceptMastery[],
	now = new Date(),
): {
	practiced: boolean;
	state: NodeState;
	strength: number;
	coverage: number;
	mastery: number | null;
	lastSeen: string | null;
	dueAt: string | null;
	leeches: number;
} {
	const tested = records.filter(conceptTested);
	if (!tested.length) {
		return {
			practiced: false,
			state: "unpracticed",
			strength: 0,
			coverage: 0,
			mastery: null,
			lastSeen: null,
			dueAt: null,
			leeches: 0,
		};
	}
	// Coverage denominator caps at COVERAGE_TARGET rather than the note's full concept
	// count, so a note only reads "known" once a REPRESENTATIVE sample is confirmed —
	// not off a couple of lucky answers, but also not scaled by how many candidate
	// concepts happened to get extracted from a dense note.
	let known = 0;
	for (const c of records) {
		if (statusOf(c) === "known") known++;
	}
	let stabSum = 0;
	let masterySum = 0;
	let masteryCount = 0;
	let lastSeen: string | null = null;
	let dueAt: string | null = null;
	for (const c of tested) {
		stabSum += c.stability ?? MIN_STABILITY;
		const m = conceptMasteryScore(c, now);
		if (m !== null) {
			masterySum += m;
			masteryCount += 1;
		}
		if (c.lastSeen && (!lastSeen || c.lastSeen > lastSeen)) lastSeen = c.lastSeen;
		if (c.dueAt && (!dueAt || c.dueAt < dueAt)) dueAt = c.dueAt;
	}
	const coverage = known / Math.max(1, Math.min(records.length, COVERAGE_TARGET));
	const mastery = masteryCount > 0 ? masterySum / masteryCount : null;
	const state: NodeState = coverage >= COVERAGE_KNOWN ? "known" : "struggling";
	const leeches = records.filter(isLeech).length;
	return { practiced: true, state, strength: stabSum / tested.length, coverage, mastery, lastSeen, dueAt, leeches };
}

/** Group the concept map by note basename. */
function conceptsByNote(concepts: ConceptMap): Map<string, ConceptMastery[]> {
	const byNote = new Map<string, ConceptMastery[]>();
	for (const cm of Object.values(concepts)) {
		const arr = byNote.get(cm.note);
		if (arr) arr.push(cm);
		else byNote.set(cm.note, [cm]);
	}
	return byNote;
}

/** Node radius from proven strength, area-proportional (sqrt) and clamped. */
export function nodeRadius(strength: number, minR = 5, maxR = 20, refStability = 30): number {
	const t = Math.min(1, Math.sqrt(Math.max(0, strength)) / Math.sqrt(refStability));
	return minR + (maxR - minR) * t;
}

/** A note's coverage and mastery folded into one 0-1 "how would I do on this right now"
 * score, weighted by `coverageWeight` (0-1: how much finishing the note matters relative
 * to how well you'd currently recall the parts you've actually studied). Null when
 * nothing's been tested yet, so a display layer can show a placeholder instead of a
 * misleading 0. Defaults to mostly `mastery`: coverage is capped (see COVERAGE_TARGET)
 * but still scales with how much of the note is left untouched, which isn't what "how
 * well do I know this" should mean by default. */
export function gradeScore(node: Pick<GraphNode, "coverage" | "mastery">, coverageWeight: number): number | null {
	if (node.mastery === null) return null;
	const w = Math.min(1, Math.max(0, coverageWeight));
	return node.coverage * w + node.mastery * (1 - w);
}

export type GradeFormat = "percent" | "letter";

/** Standard US letter cutoffs, checked high to low. Not user-customizable in v1 — the
 * customization surface is coverageWeight and the percent/letter choice, not the cutoffs
 * themselves. */
const LETTER_CUTOFFS: [number, string][] = [
	[0.93, "A"],
	[0.9, "A-"],
	[0.87, "B+"],
	[0.83, "B"],
	[0.8, "B-"],
	[0.77, "C+"],
	[0.73, "C"],
	[0.7, "C-"],
	[0.6, "D"],
];

/** Render a 0-1 score in the chosen display scale. "--" for an untested (null) score. */
export function formatGrade(score: number | null, format: GradeFormat): string {
	if (score === null) return "--";
	if (format === "percent") return `${Math.round(score * 100)}%`;
	for (const [cutoff, label] of LETTER_CUTOFFS) {
		if (score >= cutoff) return label;
	}
	return "F";
}

/** Build the learning graph (unlaid-out): nodes with state+strength, edges tiered.
 * `links` is a list of undirected note pairs (both ends should be in `notes`). `isProven`
 * answers whether a pair's relationship has been quizzed and passed (default: none, for the
 * pre-proven-edges release). `misconceptions` maps note -> count of active (unresolved)
 * canonical misconceptions observed there, for the misconception colour mode/filter. */
export function buildGraph(
	notes: string[],
	links: [string, string][],
	concepts: ConceptMap,
	isProven: (a: string, b: string) => boolean = () => false,
	misconceptions: Record<string, number> = {},
	now = new Date(),
): LearningGraph {
	const byNote = conceptsByNote(concepts);
	const inUniverse = new Set(notes);
	const practiced = new Set<string>();
	const nodes: GraphNode[] = notes.map((id) => {
		const info = noteState(byNote.get(id) ?? [], now);
		if (info.practiced) practiced.add(id);
		return {
			id,
			state: info.state,
			strength: info.strength,
			coverage: info.coverage,
			mastery: info.mastery,
			lastSeen: info.lastSeen,
			dueAt: info.dueAt,
			misconceptions: misconceptions[id] ?? 0,
			leeches: info.leeches,
			x: 0,
			y: 0,
		};
	});

	// Dedupe undirected edges; tier each.
	const seen = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const [a, b] of links) {
		if (a === b || !inUniverse.has(a) || !inUniverse.has(b)) continue;
		const key = a < b ? `${a} ${b}` : `${b} ${a}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const tier: EdgeTier = isProven(a, b)
			? "proven"
			: practiced.has(a) && practiced.has(b)
				? "inherited"
				: "structural";
		edges.push({ a, b, tier });
	}

	seedPositions(nodes);
	return { nodes, edges };
}

/** Deterministic initial positions on a golden-angle spiral (no RNG, so layout is stable
 * and testable). Overwritten by any persisted position before rendering. */
function seedPositions(nodes: GraphNode[]): void {
	const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.399963 rad
	const spacing = 40;
	for (let i = 0; i < nodes.length; i++) {
		const r = spacing * Math.sqrt(i + 1);
		const a = i * golden;
		nodes[i].x = r * Math.cos(a);
		nodes[i].y = r * Math.sin(a);
	}
}

export interface LayoutOptions {
	iterations?: number;
	/** Ideal edge length. */
	k?: number;
	/** Pull toward the origin, keeps disconnected components from drifting away. */
	gravity?: number;
}

/** In-place Fruchterman-Reingold-style force layout. Deterministic (no RNG): repulsion
 * between all node pairs, spring attraction along edges, mild gravity to the centre, with
 * a cooling schedule. O(n^2) per iteration — the caller caps node count. */
export function runLayout(graph: LearningGraph, opts: LayoutOptions = {}): void {
	const nodes = graph.nodes;
	const n = nodes.length;
	if (n < 2) return;
	const k = opts.k ?? 60;
	const iterations = opts.iterations ?? 300;
	const gravity = opts.gravity ?? 0.02;
	const k2 = k * k;
	let temp = k * 2; // max displacement, cooled each iteration

	const adj = new Map<string, number>();
	nodes.forEach((nd, i) => adj.set(nd.id, i));

	for (let iter = 0; iter < iterations; iter++) {
		const dx = new Float64Array(n);
		const dy = new Float64Array(n);

		// Repulsion (all pairs).
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				let ddx = nodes[i].x - nodes[j].x;
				let ddy = nodes[i].y - nodes[j].y;
				let dist2 = ddx * ddx + ddy * ddy;
				if (dist2 < 0.01) {
					// Coincident: nudge deterministically by index so they separate.
					ddx = ((i % 7) - 3) * 0.1 + 0.05;
					ddy = ((j % 7) - 3) * 0.1 + 0.05;
					dist2 = ddx * ddx + ddy * ddy;
				}
				const dist = Math.sqrt(dist2);
				const force = k2 / dist2; // repulsive magnitude
				const fx = (ddx / dist) * force;
				const fy = (ddy / dist) * force;
				dx[i] += fx;
				dy[i] += fy;
				dx[j] -= fx;
				dy[j] -= fy;
			}
		}

		// Attraction along edges.
		for (const e of graph.edges) {
			const i = adj.get(e.a);
			const j = adj.get(e.b);
			if (i === undefined || j === undefined) continue;
			const ddx = nodes[i].x - nodes[j].x;
			const ddy = nodes[i].y - nodes[j].y;
			const dist = Math.max(0.01, Math.sqrt(ddx * ddx + ddy * ddy));
			const force = dist2ByK(dist, k);
			const fx = (ddx / dist) * force;
			const fy = (ddy / dist) * force;
			dx[i] -= fx;
			dy[i] -= fy;
			dx[j] += fx;
			dy[j] += fy;
		}

		// Gravity + integrate with temperature-limited step.
		for (let i = 0; i < n; i++) {
			dx[i] -= nodes[i].x * gravity;
			dy[i] -= nodes[i].y * gravity;
			const disp = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
			const step = Math.min(disp, temp);
			nodes[i].x += (dx[i] / disp) * step;
			nodes[i].y += (dy[i] / disp) * step;
		}
		temp = Math.max(k * 0.05, temp * 0.97); // cool
	}
}

function dist2ByK(dist: number, k: number): number {
	return (dist * dist) / k;
}
