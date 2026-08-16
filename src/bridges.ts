/** Missing-link finder: "these two notes should be linked, but aren't."
 *
 * Grill already reads the links you HAVE. This finds the
 * links you're MISSING: pairs of notes that share specific vocabulary yet have no edge
 * between them in the vault graph. Detection is a cheap, offline lexical prefilter that
 * favours recall and is capped; the real precision gate is an LLM adjudicator
 * (`adjudicateBridges` in llm.ts) that keeps only pairs with a genuine relationship. A
 * confirmed pair becomes a bridge question in the normal session loop, and answering it
 * offers to write the `[[link]]` into the graph — Grill augmenting your graph.
 *
 * Everything is keyed by note basename, matching the mastery/graph key space.
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";
import { contentWords } from "./llm";
import { outgoingBasenames } from "./links";

/** A pair the lexical prefilter proposes, with excerpts for the adjudicator. */
export interface RawBridge {
	a: string;
	b: string;
	aText: string;
	bText: string;
	score: number;
}

/** A pair the adjudicator confirmed, annotated with the connection to quiz. */
export interface BridgeCandidate {
	a: string;
	b: string;
	bridgeConcept: string;
	relationship: string;
}

export type BridgeStatus = "suggested" | "answered" | "linked" | "dismissed";

/** Persisted record of a bridge we've surfaced, so it isn't re-adjudicated or
 * re-suggested every session, and so the dashboard can count links made. */
export interface BridgeRecord {
	a: string;
	b: string;
	bridgeConcept: string;
	status: BridgeStatus;
	lastSeen: string;
	/** The text of the last bridge question actually asked for this pair, if any. A
	 * bridge question is otherwise never banked (see rememberGenerated in view.ts —
	 * novel/un-scheduled content, not reused across reviews like a concept question),
	 * so without this a pair that goes unanswered one session and gets re-suggested
	 * the next has no memory at all: same "the model forgets what it already asked"
	 * gap as concepts had before priorQuestions, just on this separate code path. */
	lastQuestion?: string;
}

export type BridgeMap = Record<string, BridgeRecord>;

/** Order-independent key for a note pair. Newline can't appear in a basename. */
export function pairKey(a: string, b: string): string {
	return [a, b].sort().join("\n");
}

/** How many lexical candidates to hand the adjudicator per session (bounds cost). */
export const CANDIDATE_CAP = 5;
/** A pair needs at least this many shared content words to be considered at all. */
const MIN_SHARED = 3;

/** Note pairs eligible for a bridge suggestion at all: not already linked, don't
 * already share a direct neighbour (so they're effectively connected), and not
 * already resolved in `bank` (answered/linked/dismissed). Shared by both the
 * lexical and semantic-embedding prefilters so "what counts as already connected"
 * can't drift between the two. */
function eligibleBridgePairs(
	app: App,
	notes: string[],
	byName: Map<string, TFile>,
	bank: BridgeMap,
): [string, string][] {
	const outgoing = new Map<string, Set<string>>();
	for (const n of notes) {
		const f = byName.get(n);
		outgoing.set(n, new Set(f ? outgoingBasenames(app, f) : []));
	}
	const linked = (a: string, b: string): boolean =>
		(outgoing.get(a)?.has(b) ?? false) || (outgoing.get(b)?.has(a) ?? false);
	const shareNeighbour = (a: string, b: string): boolean => {
		const oa = outgoing.get(a);
		const ob = outgoing.get(b);
		if (!oa || !ob) return false;
		for (const x of oa) if (x !== b && ob.has(x)) return true;
		return false;
	};

	const out: [string, string][] = [];
	for (let i = 0; i < notes.length; i++) {
		for (let j = i + 1; j < notes.length; j++) {
			const a = notes[i];
			const b = notes[j];
			if (a === b) continue;
			if (linked(a, b) || shareNeighbour(a, b)) continue;
			const rec = bank[pairKey(a, b)];
			if (rec && rec.status !== "suggested") continue; // resolved already
			out.push([a, b]);
		}
	}
	return out;
}

/** Propose un-linked note pairs that share specific vocabulary, ranked by a
 * rarity-weighted overlap so shared jargon counts and shared filler ("system",
 * "example") does not. Pure and offline; the adjudicator decides what's real. */
export function detectBridgeCandidates(
	app: App,
	notes: string[],
	byName: Map<string, TFile>,
	noteText: Record<string, string>,
	bank: BridgeMap,
	cap: number = CANDIDATE_CAP,
): RawBridge[] {
	// Content-word set per note, and document frequency across the session's notes.
	const words = new Map<string, Set<string>>();
	const df = new Map<string, number>();
	for (const n of notes) {
		const set = contentWords(noteText[n] ?? "");
		words.set(n, set);
		for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
	}

	// A shared word is "specific" when it appears in few of the session's notes.
	const specificMax = Math.max(2, Math.floor(notes.length * 0.34));

	const out: RawBridge[] = [];
	for (const [a, b] of eligibleBridgePairs(app, notes, byName, bank)) {
		const wa = words.get(a);
		const wb = words.get(b);
		if (!wa || !wb) continue;
		let shared = 0;
		let specific = 0;
		let score = 0;
		for (const w of wa) {
			if (!wb.has(w)) continue;
			shared++;
			const freq = df.get(w) ?? 1;
			score += 1 / freq; // rarer shared words weigh more
			if (freq <= specificMax) specific++;
		}
		if (shared < MIN_SHARED || specific < 1) continue;
		out.push({ a, b, aText: noteText[a] ?? "", bText: noteText[b] ?? "", score });
	}
	out.sort((x, y) => y.score - x.score);
	return out.slice(0, cap);
}

/** A shared content word appearing in more than this fraction of the vault's notes
 * is filler ("system", "example"), not domain jargon — mirrors the lexical
 * detector's own `specificMax`, expressed as a similarity floor instead: pairs
 * below this cosine similarity aren't conceptually close enough to bother the
 * adjudicator with. */
const MIN_SEMANTIC_SIMILARITY = 0.5;

function cosineSimilarity(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embedding-based candidate source: catches pairs with strong conceptual overlap
 * but too little shared vocabulary to pass the lexical detector's `MIN_SHARED`
 * gate — the blind spot `detectBridgeCandidates` names in its own doc comment.
 * Additive, not a replacement: the lexical detector stays the free, always-on
 * baseline; this only contributes candidates for notes with a cached vector in
 * `embeddings` (see store.ts's embeddings.json / llm.ts's embedTexts — populating
 * that cache needs a configured provider that supports embeddings, so this simply
 * returns nothing for the vault's not-yet-embedded notes rather than erroring).
 * Same `RawBridge` shape as the lexical detector (`score` = cosine similarity, a
 * different scale) — the caller concatenates both lists rather than merging them
 * into one ranking (see view.ts's `appendBridgeTargets`). */
export function detectSemanticBridgeCandidates(
	app: App,
	notes: string[],
	byName: Map<string, TFile>,
	noteText: Record<string, string>,
	bank: BridgeMap,
	embeddings: Record<string, number[]>,
	cap: number = CANDIDATE_CAP,
): RawBridge[] {
	const out: RawBridge[] = [];
	for (const [a, b] of eligibleBridgePairs(app, notes, byName, bank)) {
		const va = embeddings[a];
		const vb = embeddings[b];
		if (!va || !vb) continue;
		const score = cosineSimilarity(va, vb);
		if (score < MIN_SEMANTIC_SIMILARITY) continue;
		out.push({ a, b, aText: noteText[a] ?? "", bText: noteText[b] ?? "", score });
	}
	out.sort((x, y) => y.score - x.score);
	return out.slice(0, cap);
}
