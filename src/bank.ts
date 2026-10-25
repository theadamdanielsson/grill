/** The question bank: questions Grill wrote, kept per concept for later reviews. Which
 * one to serve, what to tell the model was asked before, and how new ones are kept. Pure:
 * the view holds the bank and saves it. */

import type { Concept } from "./generate-local";
import type { QDifficulty } from "./mastery";
import { formatSatisfies, type FormatMode, type Question } from "./question";
import type { CachedQuestion, QuestionBank } from "./store";

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

/** A cached question for this concept that is safe to reuse now, or null. Requires a
 * bank entry whose source hash still matches the concept (note unchanged) AND whose
 * format satisfies the current "Question formats" setting (see `formatSatisfies`,
 * the same check fresh generation validates against) — a variant banked back when the
 * student was on Mixed (or before they switched to MC/Write only) must not get rotated
 * back in just because it's the least-shown one; that's how "MC only" quietly kept
 * serving old write-in questions forever. Rotates to the least-shown variant among
 * whatever's left.
 *
 * The entry must also be at the difficulty the concept is due for now (`tier`, from
 * conceptTargetDifficulty via the target). Without that, the first question written
 * for a concept, nearly always an easy one, was the only one it ever got, so the
 * easy-medium-hard ramp never reached the student and a right answer could never
 * earn a hard question's longer interval. An entry from before questions carried a
 * difficulty counts as medium, the same default grading gives it.
 *
 * The model only ever writes a question once per concept and difficulty (per source
 * text — an edit that changes `sourceHash` reopens it): every later review of the
 * same concept at that difficulty reuses that same cached text, forever. A newly
 * written one has passed checkAnswerKeys (llm.ts) before it is banked. Rewording on
 * a schedule used to be the default (a fresh variant once a calendar day had passed
 * since it was last shown, to avoid testing sentence-recognition instead of recall)
 * but in practice this reliably drifted the *content* of the question, not just its
 * phrasing — a real failure mode on precision material like a language drill, where
 * a "fresher" variant can quietly test a different grammar point or invent a wrong
 * answer.
 * This never grows unboundedly regardless: rememberGenerated evicts the oldest
 * past MAX_VARIANTS. */
export function cacheHit(bank: QuestionBank, c: Concept | undefined, tier: QDifficulty, wantFormat: FormatMode): CachedQuestion | null {
	if (!c || c.authored) return null; // authored questions are verbatim, not banked
	const kept = bank[c.id];
	if (!kept || !kept.length) return null;
	const fresh = kept.filter(
		(e) =>
			e.sourceHash === c.sourceHash &&
			!e.rejected &&
			formatSatisfies(e.type, wantFormat) &&
			(e.difficulty ?? "medium") === tier,
	);
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
export function priorQuestions(bank: QuestionBank, c: Concept | undefined): string[] {
	if (!c) return [];
	const kept = bank[c.id];
	if (!kept || !kept.length) return [];
	return kept
		.filter((e) => e.sourceHash === c.sourceHash)
		.sort((a, b) => (b.lastShownAt ?? "").localeCompare(a.lastShownAt ?? ""))
		.slice(0, MAX_PRIOR_SHOWN)
		.map((e) => e.question);
}

/** Bank freshly generated questions per concept for reuse on later reviews. Skips
 * authored (verbatim) and bridge (novel, un-scheduled) questions, prunes stale-hash
 * variants, dedupes near-restatements against what's already banked, and caps the
 * number kept per concept. */
export function rememberGenerated(bank: QuestionBank, qs: Question[], conceptOf: (id: string) => Concept | undefined): boolean {
	let changed = false;
	for (const q of qs) {
		if (!q.conceptId || q.missingLink) continue;
		const c = conceptOf(q.conceptId);
		if (!c || c.authored) continue;
		const kept = (bank[q.conceptId] ?? []).filter((e) => e.sourceHash === c.sourceHash);
		// The model can ignore the "already asked, write something different" prompt
		// hint (priorQuestionsFor) — if what came back is a near-restatement of a
		// variant already banked, treat this as another showing of THAT variant rather
		// than a new one. Keeps rotation genuinely varied and stops MAX_VARIANTS slots
		// filling up with near-duplicates of each other. Only affects what's persisted
		// for future reuse; the question actually served this turn is unchanged.
		// Never folds into a rejected entry — that would silently un-reject a "Bad
		// question" variant just because the model regenerated something similar to
		// it; a near-restatement of a rejected question is banked as its own fresh
		// entry instead, so it can be independently rejected again if still bad.
		// Only a variant at the same difficulty counts: a harder question that reads
		// like the easy one is still the one cacheHit needs at its own difficulty, or
		// it would be written again at every review.
		const dup = kept.find(
			(e) =>
				!e.rejected &&
				(e.difficulty ?? "medium") === q.difficulty &&
				questionSimilarity(e.question, q.question) >= NEAR_DUPLICATE_THRESHOLD,
		);
		if (dup) {
			dup.timesShown += 1;
			dup.lastShownAt = new Date().toISOString();
		} else {
			kept.push({ ...q, sourceHash: c.sourceHash, timesShown: 1, lastShownAt: new Date().toISOString() });
		}
		// Written unconditionally on both paths: `kept` is already pruned to fresh-hash
		// entries above, and skipping this on the dup path would silently stop that
		// pruning from ever landing whenever a batch happens to produce a near-duplicate.
		// Rejected tombstones are exempt from the MAX_VARIANTS cap: a plain slice(-N) on
		// the combined array would eventually push a "Bad question" entry out of the kept
		// window (it never gets touched/re-pushed once rejected, so it only drifts toward
		// the front as fresh variants keep landing) — at which point nothing stops the
		// model from regenerating and re-serving the exact question the student rejected.
		const live = kept.filter((e) => !e.rejected);
		const tombstones = kept.filter((e) => e.rejected);
		bank[q.conceptId] = [...tombstones, ...live.slice(-MAX_VARIANTS)];
		changed = true;
	}
	return changed;
}
