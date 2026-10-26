/** Reactive routing within a session: after a wrong answer, a question on a weak
 * prerequisite the missed note builds on, or on a linked neighbour that may share the
 * same confusion. Which note to route to, and the per-session budget, are decided here;
 * putting the question into the session is the view's. */

import type { Concept } from "./generate-local";

/** Reactive prerequisite routing: most detours inserted per session, so a run of
 * wrong answers can't balloon the session or chain endlessly down the link graph. */
export const MAX_ROUTES = 3;
/** Most misconception-contagion probes inserted per session — deliberately smaller
 * than MAX_ROUTES since this is a more speculative mechanic (re-probing a raw,
 * not-yet-canonicalized tag on a note it may or may not actually apply to). */
export const MAX_CONTAGION = 2;

/** A prerequisite reactive-routing candidate, found but not yet committed — used to
 * gate the last-question-of-the-session case behind a consent prompt. */
export interface PrereqRoute {
	concept: Concept;
	prereqNote: string;
}

/** A misconception-contagion candidate: the same confusion the student just showed on
 * `fromNote`, tested on a linked, not-yet-known neighbor before they naturally hit it
 * there. Found but not yet committed. AI mode only — there's no deterministic way to
 * judge whether a raw grader tag plausibly applies elsewhere without a model in the
 * loop, so this never fires in no-key mode. */
export interface ContagionRoute {
	concept: Concept;
	neighborNote: string;
	tag: string;
}

/** A reactive session extension offered but not yet accepted/declined by the student:
 * either a prerequisite route or a misconception-contagion probe. Only one kind can be
 * pending at a time (see submitAnswer/recordSelfGrade — prerequisite takes priority). */
export type PendingExtension =
	| { kind: "prerequisite"; route: PrereqRoute; fromNote: string }
	| { kind: "contagion"; route: ContagionRoute; fromNote: string };

/** What routing reads of the session and the record. */
export interface RouteLookup {
	/** The notes a note links to. */
	prereqsOf(note: string): string[];
	/** The note is one of this session's. */
	inSession(note: string): boolean;
	/** Struggling (0) before untested (1) before known (2). */
	weakness(note: string): number;
	conceptsOf(note: string): Concept[];
	/** The concept is known on its own record. */
	known(conceptId: string): boolean;
	/** Concepts already in the session's plan. */
	planned: ReadonlySet<string>;
}

export class SessionRouting {
	private routesUsed = 0;
	private routedNotes = new Set<string>();
	private contagionUsed = 0;
	private contagionNotes = new Set<string>();
	/** Each session note's rank in the session graph's foundationalOrder (lower = more
	 * heavily depended-upon by other session notes), captured once at session setup so
	 * reactive routing — which runs later, per answer — can prefer shoring up the most
	 * globally-connected weak prerequisite over just the first one found. */
	private rank = new Map<string, number>();
	/** Each session note's undirected neighbors (outgoing + incoming links, deduped),
	 * captured once at session setup for misconception contagion to walk later. */
	private neighbors = new Map<string, string[]>();

	/** A new session: budgets spent on nothing, and no graph yet. */
	reset(): void {
		this.resetBudget();
		this.rank = new Map();
		this.neighbors = new Map();
	}

	/** The budgets back to full, keeping the session graph. */
	resetBudget(): void {
		this.routesUsed = 0;
		this.routedNotes.clear();
		this.contagionUsed = 0;
		this.contagionNotes.clear();
	}

	/** The session graph's order and links, for ranking and for finding neighbours. */
	setGraph(foundationalOrder: string[], adjacency: Record<string, { linksTo: string[]; linkedFrom: string[] }>): void {
		this.rank = new Map(foundationalOrder.map((n, i) => [n, i]));
		this.neighbors = new Map(Object.entries(adjacency).map(([n, adj]) => [n, [...new Set([...adj.linksTo, ...adj.linkedFrom])]]));
	}

	/** A note's position in the session graph's foundationalOrder — lower is more
	 * heavily depended-upon by other session notes. Notes outside the session graph
	 * (shouldn't normally happen for a routing candidate, but not guaranteed) sort last,
	 * so the tie-break only ever activates between two notes it actually has data for. */
	private foundationalRank(note: string): number {
		return this.rank.get(note) ?? Number.MAX_SAFE_INTEGER;
	}

	/** The first weak, not-yet-planned concept among `candidates`, weakest note first and,
	 * among equally weak notes, the one more of the session depends on. */
	private firstWeak(candidates: string[], look: RouteLookup): { concept: Concept; note: string } | null {
		const sorted = [...candidates].sort((a, b) => look.weakness(a) - look.weakness(b) || this.foundationalRank(a) - this.foundationalRank(b));
		for (const n of sorted) {
			if (look.weakness(n) === 2) break; // sorted weakest-first: the rest are known
			const concept = look.conceptsOf(n).find((c) => !look.planned.has(c.id) && !look.known(c.id));
			if (concept) return { concept, note: n };
		}
		return null;
	}

	/** Is there a weak, not-yet-planned, not-already-routed prerequisite the missed note
	 * builds on? Changes nothing, so it's safe to call just to see what WOULD be offered.
	 * Weakest first; among equally weak ones, the one more heavily depended upon by other
	 * session notes (shoring it up pays off across the whole session). */
	findPrerequisite(fromNote: string, look: RouteLookup): PrereqRoute | null {
		if (this.routesUsed >= MAX_ROUTES) return null;
		const prereqs = look.prereqsOf(fromNote).filter((p) => p !== fromNote && look.inSession(p) && !this.routedNotes.has(p));
		const hit = this.firstWeak(prereqs, look);
		return hit && { concept: hit.concept, prereqNote: hit.note };
	}

	/** Is there an untested or struggling, in-session, not-yet-planned, not-yet-probed
	 * neighbor of `fromNote` worth checking for the same confusion? Changes nothing. */
	findContagion(fromNote: string, tag: string, look: RouteLookup): ContagionRoute | null {
		if (this.contagionUsed >= MAX_CONTAGION) return null;
		const near = (this.neighbors.get(fromNote) ?? []).filter((n) => n !== fromNote && look.inSession(n) && !this.contagionNotes.has(n));
		const hit = this.firstWeak(near, look);
		return hit && { concept: hit.concept, neighborNote: hit.note, tag };
	}

	/** A prerequisite route was taken: never the same prerequisite twice, at most MAX_ROUTES. */
	tookPrerequisite(route: PrereqRoute): void {
		this.routedNotes.add(route.prereqNote);
		this.routesUsed += 1;
	}

	/** A neighbour was probed: never the same one twice, at most MAX_CONTAGION. */
	tookContagion(route: ContagionRoute): void {
		this.contagionNotes.add(route.neighborNote);
		this.contagionUsed += 1;
	}
}
