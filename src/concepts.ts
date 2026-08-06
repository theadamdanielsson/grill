/** Concept-level scheduling.
 *
 * The scheduling mismatch Grill had: FSRS models one fixed item, but a note is a
 * bag of concepts and each session tests a different, stochastically-generated
 * question. So a multi-concept note got "mastered" off a few lucky questions
 * (the coverage illusion). The fix: schedule per concept — where the item is
 * actually stable — and project a note-level aggregate back out so every
 * existing surface (status bar, due queue, dashboard, graph) keeps working.
 *
 * Concepts are extracted deterministically from note structure (see
 * generate-local.ts), so concept ids never depend on the model. `concepts.json`
 * is the scheduling source of truth; note-level mastery.json keeps its counters
 * and misconceptions for stats and derives its status/dueAt from here.
 */

import { Concept, ConceptKind } from "./generate-local";
import {
	applyRating,
	DueDateHistogram,
	MasteryMap,
	NoteStatus,
	QDifficulty,
	Rating,
	reserveFreshSlots,
	Schedulable,
	statusOf,
	toRating,
	Verdict,
} from "./mastery";

/** One logged review: elapsed time since the previous one and the FSRS rating actually
 * applied. Not read by anything yet — groundwork for eventually fitting FSRS's 17
 * weights (see the fixed defaults in mastery.ts) to this vault's own review data
 * instead of the global defaults, the way Anki's optimizer personalizes per user. */
export interface ReviewLogEntry {
	t: string;
	elapsedDays: number;
	rating: number;
}

export interface ConceptMastery extends Schedulable {
	note: string;
	label: string;
	kind: ConceptKind;
	/** Source hash at last review; a mismatch means the note's content changed. */
	sourceHash: string | null;
	/** Raw review history, logged starting from whenever this field was added —
	 * existing concepts backfill an empty log, not a reconstructed one. Unbounded, like
	 * calibration.ts's buffer: a personal vault's total review count over years is
	 * nothing byte-wise. */
	reviewLog?: ReviewLogEntry[];
}

/** Appends one entry to `cm.reviewLog`, using the elapsed time since its OLD `lastSeen`
 * — must run before `applyRating` overwrites it. Same elapsed-time formula `applyRating`
 * computes internally; duplicated here since it doesn't expose that value back out. */
function logReview(cm: ConceptMastery, now: Date, rating: number): void {
	const elapsedDays = cm.lastSeen ? (now.getTime() - new Date(cm.lastSeen).getTime()) / 86400_000 : 0;
	(cm.reviewLog ??= []).push({ t: now.toISOString(), elapsedDays, rating });
}

export type ConceptMap = Record<string, ConceptMastery>;

/** A note counts as "known" only once this share of its concepts is tested-known,
 * so a note can't look mastered while most of it was never asked about. */
const COVERAGE_KNOWN = 0.8;
/** Coverage's denominator caps at this many concepts, not the note's raw extracted
 * count — otherwise a content-dense note (a long vocab list, a big glossary) needs
 * proportionally more known concepts just to read "covered" than a short one, purely
 * as an artifact of how many candidate concepts extractConcepts happened to find, not
 * anything about how well the note is actually known. ~8 known concepts reads as a
 * representative sample of any note, dense or sparse. */
const COVERAGE_TARGET = 8;

function emptyConcept(c: Concept): ConceptMastery {
	return {
		note: c.note,
		label: c.label,
		kind: c.kind,
		sourceHash: c.sourceHash,
		correct: 0,
		partial: 0,
		incorrect: 0,
		streak: 0,
		stability: null,
		difficulty: null,
		lastSeen: null,
		dueAt: null,
	};
}

/** Count of concepts actually due right now, across whichever notes `isEligible`
 * admits. This is the real size of what a due-only session (see `pickConcepts`'s
 * `dueOnly` branch) will queue — unlike a note-level "due" count (a note's soonest
 * due concept), which undercounts whenever a note has more than one due concept,
 * so the number shown before a due session starts doesn't match what it delivers. */
export function dueConceptCount(concepts: ConceptMap, isEligible: (note: string) => boolean, now = new Date()): number {
	let n = 0;
	for (const cm of Object.values(concepts)) {
		if (!conceptTested(cm) || !cm.dueAt || new Date(cm.dueAt) > now) continue;
		if (!isEligible(cm.note)) continue;
		n++;
	}
	return n;
}

/** Notes with at least one currently-due, tested concept — computed live from concept
 * data directly, the same way graph.ts's own node dueAt already does (min tested
 * concept dueAt, recomputed fresh every call). Deliberately NOT the note-level
 * mastery.dueAt rollup (see noteAggregate): that field is a cache, only refreshed by
 * recomputeAggregate when the note is next answered, so a note whose concept became
 * due since its last visit silently doesn't show up in it until it's touched again —
 * exactly the kind of drift a due-picking function can't afford. */
export function dueNotes(concepts: ConceptMap, isEligible: (note: string) => boolean, now = new Date()): Set<string> {
	const notes = new Set<string>();
	for (const cm of Object.values(concepts)) {
		if (!conceptTested(cm) || !cm.dueAt || new Date(cm.dueAt) > now) continue;
		if (!isEligible(cm.note)) continue;
		notes.add(cm.note);
	}
	return notes;
}

export function conceptTested(cm: ConceptMastery | undefined): boolean {
	return !!cm && cm.correct + cm.partial + cm.incorrect > 0;
}

/** Create records for new concepts; existing ones just get their current label/kind/hash
 * refreshed. Editing a note is the student's own call, not a signal to distrust their
 * prior recall of it: a content change does NOT reset or discount stability, difficulty,
 * streak, or dueAt — scheduling is left exactly as it was. Only the hash moves, so the
 * next question generated for this concept reflects the new text; if an edit really did
 * make the old material stale, that's the student's to judge next time it comes up, not
 * an unrequested reset sprung on them now. Orphaned records are left in the map (kept
 * for stats) but simply won't be in `concepts` so they aren't scheduled. */
export function reconcileConcepts(map: ConceptMap, concepts: Concept[]): void {
	for (const c of concepts) {
		const existing = map[c.id];
		if (!existing) {
			map[c.id] = emptyConcept(c);
			continue;
		}
		existing.label = c.label;
		existing.kind = c.kind;
		existing.note = c.note;
		existing.sourceHash = c.sourceHash;
	}
}

/** AI path: verdict + question difficulty → difficulty-aware rating. `confidence` (0-1,
 * from the opt-in "how sure are you?" check; null when it's off or wasn't answered this
 * time) lets a genuinely-guessed correct answer land as Hard instead of Good/Easy, and
 * `hintsUsed` does the same unconditionally when any hint was used — see toRating's doc
 * comment for both. */
export function recordConceptAnswer(
	map: ConceptMap,
	conceptId: string,
	verdict: Verdict,
	difficulty: QDifficulty,
	now = new Date(),
	desiredRetention?: number,
	dueDateHistogram?: DueDateHistogram,
	confidence: number | null = null,
	hintsUsed = 0,
): void {
	const cm = map[conceptId];
	if (!cm) return;
	const rating = toRating(verdict, difficulty, confidence, hintsUsed);
	logReview(cm, now, rating);
	applyRating(cm, rating, now, desiredRetention, dueDateHistogram);
}

/** Self-grade path: the user's own Again/Hard/Good/Easy rating is the signal. */
export function recordConceptRating(
	map: ConceptMap,
	conceptId: string,
	rating: Rating,
	now = new Date(),
	desiredRetention?: number,
	dueDateHistogram?: DueDateHistogram,
): void {
	const cm = map[conceptId];
	if (!cm) return;
	logReview(cm, now, rating);
	applyRating(cm, rating, now, desiredRetention, dueDateHistogram);
}

/** Round-robin concepts across their notes (preserving each note's given order),
 * so a session mixes topics instead of drilling one note then the next
 * (interleaving beats blocking for retention). */
function interleaveByNote(concepts: Concept[]): Concept[] {
	const byNote = new Map<string, Concept[]>();
	const order: string[] = [];
	for (const c of concepts) {
		let arr = byNote.get(c.note);
		if (!arr) {
			arr = [];
			byNote.set(c.note, arr);
			order.push(c.note);
		}
		arr.push(c);
	}
	const out: Concept[] = [];
	for (let round = 0, added = true; added; round++) {
		added = false;
		for (const note of order) {
			const arr = byNote.get(note);
			if (arr && round < arr.length) {
				out.push(arr[round]);
				added = true;
			}
		}
	}
	return out;
}

/** Concept-level candidate selection: due/struggling first, then untested (for
 * coverage), then least-recently-seen known. Each bucket is interleaved across
 * notes so the session mixes topics rather than blocking on one note.
 *
 * `dueOnly` is for the due-queue entry points (status bar, "Review N due"): it
 * must return ONLY concepts whose `dueAt` has actually arrived, never padded
 * with untested or known ones to reach `cap` (otherwise clicking "N due"
 * silently balloons into a full questionsPerSession-length session). It also
 * must NOT fall back to `statusOf(cm) === "struggling"`, unlike the general
 * (non-dueOnly) ordering below: applyRating already keeps `dueAt` in sync (now
 * on a miss, pushed out on a hit), so a concept just answered correctly once
 * would otherwise stay glued to the due queue until its SECOND consecutive
 * correct answer (the "known" streak): a correct answer that looks ignored. */
/** How many concepts in `map` had their first-ever exposure since `todayStart`: total
 * interactions === 1 (this was their only, and therefore first, answer) and that
 * answer was today. Used to cap new-concept introduction per day — see `pickConcepts`. */
function newConceptsIntroducedSince(map: ConceptMap, todayStart: Date): number {
	let n = 0;
	for (const cm of Object.values(map)) {
		if (cm.correct + cm.partial + cm.incorrect !== 1) continue;
		if (cm.lastSeen && new Date(cm.lastSeen) >= todayStart) n++;
	}
	return n;
}

export function pickConcepts(
	concepts: Concept[],
	map: ConceptMap,
	cap: number,
	dueOnly = false,
	now = new Date(),
	newConceptsPerDay = 0,
): Concept[] {
	if (dueOnly) {
		const due = concepts.filter((c) => {
			const cm = map[c.id];
			return !!cm && conceptTested(cm) && !!cm.dueAt && new Date(cm.dueAt) <= now;
		});
		due.sort((a, b) => (map[a.id]?.dueAt ?? "").localeCompare(map[b.id]?.dueAt ?? ""));
		return interleaveByNote(due).slice(0, cap);
	}
	const due: Concept[] = [];
	const untested: Concept[] = [];
	const rest: Concept[] = [];
	for (const c of concepts) {
		const cm = map[c.id];
		if (!cm || !conceptTested(cm)) {
			untested.push(c);
			continue;
		}
		const s = statusOf(cm);
		if (s === "struggling" || (cm.dueAt && new Date(cm.dueAt) <= now)) due.push(c);
		else rest.push(c);
	}
	due.sort((a, b) => (map[a.id]?.dueAt ?? "").localeCompare(map[b.id]?.dueAt ?? ""));
	rest.sort((a, b) => (map[a.id]?.lastSeen ?? "").localeCompare(map[b.id]?.lastSeen ?? ""));
	// Daily new-concept cap: independent of the per-session cap above, this limits how
	// much brand-new material can enter the schedule in one calendar day, so a few
	// missed days can't leave the due queue permanently outrunning what's reviewable.
	// Untested concepts beyond today's remaining quota simply don't enter this
	// session's pool; due/rest (review of concepts already in the schedule) are
	// unaffected, so a session still fills normally from what's actually due.
	let untestedPool = untested;
	if (newConceptsPerDay > 0) {
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const remaining = Math.max(0, newConceptsPerDay - newConceptsIntroducedSince(map, todayStart));
		untestedPool = untested.slice(0, remaining);
	}
	return reserveFreshSlots(interleaveByNote(due), interleaveByNote(untestedPool), interleaveByNote(rest), cap);
}

/** Concept-derived note status + soonest due date, over the note's CURRENT
 * concepts only (orphans excluded). This is what note-level surfaces read. */
export function noteAggregate(concepts: Concept[], map: ConceptMap): { aggStatus: NoteStatus; dueAt: string | null } {
	const tested = concepts.filter((c) => conceptTested(map[c.id]));
	// "Untested" (grey) means literally untouched: not one concept answered yet. The
	// moment a note has any tested concept it leaves grey for "Learning" (red) and
	// stays there until confirmed-known coverage is high enough to read "known" (green).
	// Note-level status is display/stats only; it does NOT gate what gets scheduled —
	// that runs off each concept's own mastery (see pickCandidates).
	if (tested.length === 0) return { aggStatus: "untested", dueAt: null };
	// Coverage counts CONFIRMED-known concepts (stability >= S_SOLID, see statusOf),
	// not merely answered ones, so a note can't read "known" off one lucky answer per
	// concept. The denominator caps at COVERAGE_TARGET (see its doc comment) rather
	// than the note's raw concept count.
	const known = concepts.filter((c) => statusOf(map[c.id]) === "known").length;
	const coverage = known / Math.max(1, Math.min(concepts.length, COVERAGE_TARGET));
	const aggStatus: NoteStatus = coverage >= COVERAGE_KNOWN ? "known" : "struggling";
	let dueAt: string | null = null;
	for (const c of tested) {
		const d = map[c.id]?.dueAt ?? null;
		if (d && (!dueAt || d < dueAt)) dueAt = d;
	}
	return { aggStatus, dueAt };
}

/** Desirable difficulty, escalated PROGRESSIVELY: one rung per demonstrated
 * recall (streak), not a jump to hard the moment a concept is first known.
 * Because concepts are interleaved (each seen roughly once per session, spaced
 * apart), the streak climbs one step per spaced exposure, so difficulty ramps
 * gradually across sessions rather than within a single drilling one:
 *   untested / lapsed → easy, then medium while it consolidates, then hard once
 *   it has survived several spaced recalls. */
export function conceptTargetDifficulty(cm: ConceptMastery | undefined): QDifficulty {
	if (!cm || !conceptTested(cm)) return "easy"; // first exposure: plain recall
	if (statusOf(cm) === "struggling") return "easy"; // a lapse resets to easy
	if (cm.streak >= 3) return "hard"; // survived several spaced recalls: stretch
	return "medium";
}

/** One-time migration (chosen: reset scheduling, keep stats). Preserve each
 * note's counters + misconceptions; clear its scheduling so it re-builds per
 * concept. Notes read as "untested" until their concepts are actually tested. */
export function migrateResetScheduling(map: MasteryMap): void {
	for (const m of Object.values(map)) {
		if (m.correct + m.partial + m.incorrect > 0) {
			m.aggStatus = "untested";
			m.dueAt = null;
			m.stability = null;
			m.difficulty = null;
			m.streak = 0;
		}
	}
}
