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
	fuzzInterval,
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

/** Notes with at least one struggling or currently-due concept, mapped to the
 * earliest relevant dueAt among them (null if the only match is a struggling
 * concept that has no schedule yet). This is the live, concept-level version of
 * the "struggling or overdue" bucket `pickCandidates` prioritizes — computed
 * fresh from concept data directly, the same way `dueNotes` is, and for the
 * same reason: the note-level mastery cache (aggStatus/dueAt) only refreshes
 * when the note is next answered, so relying on it here would silently
 * deprioritize a note whose concepts became due or started struggling since
 * the cache was last set — exactly the notes this bucket exists to surface. */
export function priorityNotes(
	concepts: ConceptMap,
	isEligible: (note: string) => boolean,
	now = new Date(),
): Map<string, string | null> {
	const notes = new Map<string, string | null>();
	for (const cm of Object.values(concepts)) {
		if (!isEligible(cm.note)) continue;
		const overdue = !!cm.dueAt && new Date(cm.dueAt) <= now;
		if (statusOf(cm) !== "struggling" && !overdue) continue;
		const dueAt = overdue ? cm.dueAt : null;
		const existing = notes.get(cm.note);
		if (existing === undefined || (dueAt && (!existing || dueAt < existing))) notes.set(cm.note, dueAt);
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
 * for stats) but simply won't be in `concepts` so they aren't scheduled.
 *
 * "Aren't scheduled" has to be enforced here, not just asserted: dueConceptCount,
 * disperseSiblingDueDates, and rebalanceDueDates all iterate the persisted map
 * directly (not the freshly-extracted list), gated only on `cm.dueAt` — with no other
 * way to tell a stale concept apart from a live one. `concepts` here is authoritative
 * for every note it actually covers (every call site passes a note's COMPLETE current
 * extraction, never a partial one), so any existing record for one of those notes
 * whose id didn't come back this time is a genuine content-based orphan — its heading
 * or definition was edited past recognition. Clear its `dueAt` so it stops counting as
 * due everywhere that gate is checked; stats/streak/review history stay untouched. */
export function reconcileConcepts(map: ConceptMap, concepts: Concept[]): void {
	const freshIds = new Set(concepts.map((c) => c.id));
	const touchedNotes = new Set(concepts.map((c) => c.note));
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
	for (const [id, cm] of Object.entries(map)) {
		if (cm.dueAt && touchedNotes.has(cm.note) && !freshIds.has(id)) cm.dueAt = null;
	}
}

/** AI path: verdict + question difficulty → difficulty-aware rating. `confidence` (0-1,
 * from the opt-in "how sure are you?" check; null when it's off or wasn't answered this
 * time) lets a genuinely-guessed correct answer land as Hard instead of Good/Easy, and
 * `hintsUsed` does the same once real assistance (tier2+) was used — see toRating's doc
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
	easyWeekdays?: ReadonlySet<number>,
): void {
	const cm = map[conceptId];
	if (!cm) return;
	const rating = toRating(verdict, difficulty, confidence, hintsUsed);
	logReview(cm, now, rating);
	applyRating(cm, rating, now, desiredRetention, dueDateHistogram, easyWeekdays);
}

/** Self-grade path: the user's own Again/Hard/Good/Easy rating is the signal. */
export function recordConceptRating(
	map: ConceptMap,
	conceptId: string,
	rating: Rating,
	now = new Date(),
	desiredRetention?: number,
	dueDateHistogram?: DueDateHistogram,
	easyWeekdays?: ReadonlySet<number>,
): void {
	const cm = map[conceptId];
	if (!cm) return;
	logReview(cm, now, rating);
	applyRating(cm, rating, now, desiredRetention, dueDateHistogram, easyWeekdays);
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
/** A note whose concepts were all bulk-studied together (e.g. one scoped session
 * extracting a dozen concepts from a single dense note) matures to "due" as a
 * block too, and without a ceiling here it would swamp a single due-pull —
 * `interleaveByNote` is only fair per round, so once thinner notes run out it
 * just keeps serving the one note with the deep backlog. Cap it instead of
 * dropping it: `due` is sorted by dueAt ascending going in, so this keeps each
 * note's longest-overdue concepts and defers the rest — nothing is lost, it
 * just spreads across this pull and the next one(s) instead of landing in one
 * sitting. */
const MAX_DUE_PER_NOTE = 4;

function capPerNote(concepts: Concept[], maxPerNote: number): Concept[] {
	const counts = new Map<string, number>();
	const out: Concept[] = [];
	for (const c of concepts) {
		const n = counts.get(c.note) ?? 0;
		if (n >= maxPerNote) continue;
		counts.set(c.note, n + 1);
		out.push(c);
	}
	return out;
}
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
		return interleaveByNote(capPerNote(due, MAX_DUE_PER_NOTE)).slice(0, cap);
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
	// Same pile-up risk as the dueOnly branch above (see MAX_DUE_PER_NOTE): a note whose
	// concepts were all bulk-studied together matures to "due/struggling" as a block, and
	// this bucket is priority-ordered ahead of untested/rest, so an uncapped note here
	// would monopolize the session same as it would the due queue.
	const cappedDue = capPerNote(due, MAX_DUE_PER_NOTE);
	// Daily new-concept cap: independent of the per-session cap above, this limits how
	// much brand-new material can enter the schedule in one calendar day, so a few
	// missed days can't leave the due queue permanently outrunning what's reviewable.
	// Untested concepts beyond today's remaining quota simply don't enter this
	// session's pool; due/rest (review of concepts already in the schedule) are
	// unaffected, so a session still fills normally from what's actually due.
	//
	// Interleave BEFORE slicing to `remaining`, not after: `untested` arrives grouped by
	// note (concepts are appended note-by-note, and a note pickCandidates just prioritized
	// sorts first), so slicing first and interleaving after was a no-op — the slice could
	// already be entirely one note's concepts, most often the note just missed, since a
	// miss is exactly what put it first in the priority order feeding this. That silently
	// defeated interleaveByNote's whole purpose: a "mixed" session could actually be one
	// note end to end, and the note you just got wrong would keep winning the slice again
	// next session too.
	let untestedPool = interleaveByNote(untested);
	if (newConceptsPerDay > 0) {
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const remaining = Math.max(0, newConceptsPerDay - newConceptsIntroducedSince(map, todayStart));
		untestedPool = untestedPool.slice(0, remaining);
	}
	return reserveFreshSlots(interleaveByNote(cappedDue), untestedPool, interleaveByNote(rest), cap);
}

/** True when a (non-due) session came back empty ONLY because the daily new-concept
 * cap is spent: the scope DOES hold untested concepts, but the day's new-concept
 * budget is used up and there's nothing due/review to fall back on. Lets the UI say
 * "that's all for today" instead of the misleading "no quizzable concepts here" —
 * which otherwise sends users reformatting notes that are perfectly fine. Only
 * meaningful with a cap set (0 = no cap = never the blocker). */
export function blockedByDailyCap(
	concepts: Concept[],
	map: ConceptMap,
	newConceptsPerDay: number,
	now = new Date(),
): boolean {
	if (newConceptsPerDay <= 0) return false;
	if (!concepts.some((c) => !conceptTested(map[c.id]))) return false;
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	return newConceptsIntroducedSince(map, todayStart) >= newConceptsPerDay;
}

/** Concept-derived note status + soonest due date, over the note's CURRENT concept ids
 * only (orphans excluded). This is what note-level surfaces read. Takes bare ids, not
 * structural `Concept` objects — every one of these is a lookup into `map` anyway, and
 * `map`'s own entries already carry everything else (including `.note`), so a caller
 * that only has the mastery/schedule side loaded (no note text re-parsed) can still
 * call this — see renderMap's aggStatus repair, which does exactly that. */
export function noteAggregate(ids: string[], map: ConceptMap): { aggStatus: NoteStatus; dueAt: string | null } {
	const tested = ids.filter((id) => conceptTested(map[id]));
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
	const known = ids.filter((id) => statusOf(map[id]) === "known").length;
	const coverage = known / Math.max(1, Math.min(ids.length, COVERAGE_TARGET));
	const aggStatus: NoteStatus = coverage >= COVERAGE_KNOWN ? "known" : "struggling";
	let dueAt: string | null = null;
	for (const id of tested) {
		const d = map[id]?.dueAt ?? null;
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

/** Post-session pass: within a note's own concepts, spread due dates that landed
 * close together. `dueDateHistogram` (mastery.ts) already load-balances across the
 * WHOLE vault, but concepts sharing a note share context — they're more likely to be
 * forgotten together than unrelated ones — so keeping siblings apart specifically
 * matters more than vault-wide day-crowding alone catches. (The idea comes from
 * fsrs4anki-helper's "disperse siblings" tool for Anki.)
 *
 * Greedy, not that tool's binary-search maximin optimizer: sort a note's due concepts
 * by their own fuzz-window lower bound, then walk forward assigning each the earliest
 * day that's both inside its own window and at least a day past the previous
 * concept's assigned day. Concepts whose windows don't actually overlap anything
 * fall out to their own original day unchanged, so this only ever touches concepts
 * that were genuinely competing for the same handful of days. Skips concepts under
 * fuzzInterval's own 2.5-day floor (nothing to disperse within) and anything not
 * still comfortably in the future (an already-due or near-due concept's urgency is
 * not this function's to touch). Call once per touched note at session end, not per
 * rating — needs every sibling's CURRENT dueAt at once, not one at a time. */
export function disperseSiblingDueDates(map: ConceptMap, noteNames: Iterable<string>, now: Date): void {
	const byNote = new Map<string, ConceptMastery[]>();
	for (const cm of Object.values(map)) {
		if (!conceptTested(cm) || !cm.dueAt) continue;
		let arr = byNote.get(cm.note);
		if (!arr) byNote.set(cm.note, (arr = []));
		arr.push(cm);
	}
	for (const note of new Set(noteNames)) {
		const siblings = byNote.get(note);
		if (!siblings || siblings.length < 2) continue;
		const windows = siblings
			.map((cm) => {
				const days = (new Date(cm.dueAt as string).getTime() - now.getTime()) / 86400_000;
				if (days < 2.5) return null; // matches fuzzInterval's own no-jitter floor
				const range = days < 7 ? 1 : days * (days < 30 ? 0.15 : 0.05);
				const lo = Math.ceil(Math.max(2, days - range));
				const hi = Math.floor(days + range);
				if (hi <= lo) return null; // no real window to move within
				return { cm, lo, hi, original: Math.round(days) };
			})
			.filter((w): w is { cm: ConceptMastery; lo: number; hi: number; original: number } => w !== null)
			.sort((a, b) => a.lo - b.lo);
		let prev = -Infinity;
		for (const w of windows) {
			const assigned = Math.min(w.hi, Math.max(w.lo, prev + 1));
			prev = assigned;
			// Only touch dueAt (and so only this concept's persisted state) when the
			// dispersed day actually differs — most siblings, most sessions, aren't
			// crowded and shouldn't churn on every save.
			if (assigned !== w.original) {
				w.cm.dueAt = new Date(now.getTime() + assigned * 86400_000).toISOString();
			}
		}
	}
}

/** Rebuild the due-date schedule's day-crowding from scratch, vault-wide. Every
 * future-due concept keeps roughly its own target day — derived from its CURRENT
 * `dueAt`, not recomputed from stability, so this only re-smooths WHEN things land,
 * never reschedules WHAT'S actually due — but gets re-fuzzed through a freshly built,
 * empty histogram instead of whichever partial one it happened to land against when
 * it was originally scheduled. Fixes pile-ups a big import or a long stretch of study
 * can leave behind: a batch of concepts created together each got fuzzed against a
 * histogram that didn't yet reflect what all its OWN siblings would independently
 * pick, so collisions the load-balancer would have caught had it seen the whole
 * picture at once can still slip through. (Same idea as fsrs4anki-helper's `flatten`,
 * scoped to the future queue only — see the skip condition below.)
 *
 * Processes nearer-due concepts first, so they keep first claim on their preferred
 * days, same priority order normal scheduling already gives them. Skips anything not
 * still comfortably in the future: an already-due or near-due concept's urgency is
 * not this function's to touch (matches `disperseSiblingDueDates`'s same floor, for
 * the same reason). On-demand only — a settings-tab button / command, never run
 * automatically. Returns how many concepts actually moved. */
export function rebalanceDueDates(map: ConceptMap, now: Date, easyWeekdays?: ReadonlySet<number>): number {
	const candidates = Object.values(map)
		.filter((cm) => conceptTested(cm) && cm.dueAt)
		.map((cm) => ({ cm, days: (new Date(cm.dueAt as string).getTime() - now.getTime()) / 86400_000 }))
		.filter((c) => c.days >= 2.5) // matches fuzzInterval's own no-jitter floor
		.sort((a, b) => a.days - b.days);
	const histogram: DueDateHistogram = new Map();
	let changed = 0;
	for (const { cm, days } of candidates) {
		const newDueAt = new Date(now.getTime() + fuzzInterval(days, now, histogram, easyWeekdays) * 86400_000).toISOString();
		if (newDueAt !== cm.dueAt) changed++;
		cm.dueAt = newDueAt;
	}
	return changed;
}

export interface TrueRetentionSummary {
	/** Real (non-first-exposure) reviews counted. */
	n: number;
	/** Observed pass rate, 0-1. */
	rate: number;
}

/** Below this many real reviews, an observed rate is too noisy to report —
 * mirrors calibration.ts's own minN=10 for the same reason, doubled since this
 * draws from the whole vault's history rather than one setting's worth of intent. */
const TRUE_RETENTION_MIN_N = 20;

/** Observed pass rate on real (non-first-exposure) reviews across the whole vault:
 * among each concept's `reviewLog` entries after its first, the share rated
 * anything but Again. `desiredRetention` (mastery.ts's FSRS setting) is a PROMISE
 * — "you'll recall this about X% of the time at its due date" — and nothing
 * previously checked whether the schedule is actually keeping it on THIS vault's
 * real material. Distinct from calibration.ts's metric: that's stated confidence
 * vs. outcome (a metacognition check), this is the schedule's own implicit target
 * vs. what actually happened, and needs no opt-in setting since it just reads
 * data already logged. Returns null under `TRUE_RETENTION_MIN_N` reviews. */
export function trueRetention(concepts: ConceptMap): TrueRetentionSummary | null {
	let total = 0;
	let passed = 0;
	for (const cm of Object.values(concepts)) {
		const log = cm.reviewLog;
		if (!log || log.length < 2) continue;
		for (let i = 1; i < log.length; i++) {
			total++;
			if (log[i].rating !== 1) passed++;
		}
	}
	if (total < TRUE_RETENTION_MIN_N) return null;
	return { n: total, rate: passed / total };
}

/** One-line human summary for the session debrief, or "" when there's not enough
 * data yet. `desiredRetentionPct` is the raw "Review frequency" setting value
 * (70-97), not a 0-1 fraction. Points at the FSRS optimizer (optimizer.ts) when
 * the schedule is running noticeably under target — that's the concrete fix a
 * gap like this calls for. */
export function trueRetentionLine(concepts: ConceptMap, desiredRetentionPct: number): string {
	const s = trueRetention(concepts);
	if (!s) return "";
	const observedPct = Math.round(s.rate * 100);
	const targetPct = Math.round(desiredRetentionPct);
	const gap = observedPct - targetPct;
	if (Math.abs(gap) <= 5) {
		return `True retention: ${observedPct}% across your last ${s.n} reviews — tracking your ${targetPct}% target closely.`;
	}
	if (gap < 0) {
		return (
			`True retention: ${observedPct}% across your last ${s.n} reviews, under your ${targetPct}% target. ` +
			`Worth a look: Settings → Personalize FSRS to your own memory, or lowering Review frequency.`
		);
	}
	return (
		`True retention: ${observedPct}% across your last ${s.n} reviews, above your ${targetPct}% target — ` +
		`you could raise Review frequency for fewer, longer-spaced reviews without losing much.`
	);
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
