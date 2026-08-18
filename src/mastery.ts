/** Per-note mastery state, FSRS-6 scheduling, misconception tracking.
 *
 * Stability/difficulty updates are delegated to `ts-fsrs` (open-spaced-repetition's
 * reference implementation, also what Anki's own FSRS support and
 * obsidian-spaced-repetition are built on) instead of Grill's old from-scratch
 * FSRS-4.5 port — that port had already drifted from the current spec (a stale
 * `init_difficulty` formula, `next_difficulty` missing the "linear damping" fix,
 * frozen FSRS-4.5-era default weights) in ways nothing here would have caught, which
 * is exactly the kind of silent bug a maintained reference implementation doesn't
 * have. Interval computation (`optimalInterval`/`fuzzInterval` below) stays
 * hand-rolled: it's Grill-specific load-balancing behavior ts-fsrs doesn't do, not
 * core FSRS math, and isn't affected by any of the above.
 *
 * Existing persisted `stability`/`difficulty` values need no numeric conversion on
 * upgrade: both fields mean the same thing in FSRS-4.5 and FSRS-6 (stability = days
 * to 90% retrievability; difficulty = 1-10) — what changed is only the update
 * formulas, so old values simply continue forward through the new ones on next
 * review, not a value that needs remapping first.
 */

import { dateDiffInDays, fsrs, type FSRSState, type Grade } from "ts-fsrs";

export type Verdict = "correct" | "partial" | "incorrect";

/** FSRS grade the user gives themselves: 1=again, 2=hard, 3=good, 4=easy. */
export type Rating = 1 | 2 | 3 | 4;

export interface NoteMastery {
	correct: number;
	partial: number;
	incorrect: number;
	/** consecutive correct answers */
	streak: number;
	/** FSRS memory stability (days); null until first answer */
	stability: number | null;
	/** FSRS difficulty, native scale 1 (easiest) - 10 (hardest); null until
	 * first answer. A stored value <= 1 from a pre-fix record (the old code rescaled
	 * this to 0.1-1 and saturated every concept at the clamp ceiling) self-heals on
	 * its next `applyRating` touch — see the guard there. */
	difficulty: number | null;
	lastSeen: string | null; // ISO date
	dueAt: string | null; // ISO date; null = never tested
	/** canonical snake_case misconception tag -> times observed */
	misconceptions: Record<string, number>;
	/** Concept-derived note status, set by the aggregate; preferred by statusOf. */
	aggStatus?: NoteStatus;
	/** Basename of a linked prerequisite that's tested-struggling while THIS note
	 * reads "known" on its own FSRS history, or null. A separate, honest signal —
	 * never overwrites aggStatus, which stays the note's own undisturbed FSRS-derived
	 * status. Set by SessionView.findWeakPrereq in view.ts. */
	weakPrereq?: string | null;
}

export type MasteryMap = Record<string, NoteMastery>;

export type NoteStatus = "untested" | "struggling" | "known";

/** Anti-luck, kept for `conceptTargetDifficulty`'s difficulty ramp; no longer what
 * gates "known" (see `S_SOLID` below) — a raw consecutive-correct streak resets to
 * zero on any single miss, discarding real prior strength, so status now reads off
 * FSRS stability instead, which degrades on a lapse rather than erasing. */
export const KNOWN_MIN_STREAK = 2;
/** FSRS stability (days) a concept must reach to read "known". Calibrated against
 * real data, not just the FSRS formula in the abstract: stability at streak>=2 (the
 * old "known" bar) varies hugely in practice — observed 0.48 to 10+ days across one
 * real vault, median ~5.8 — because it depends on how much time actually elapsed
 * between reviews, not just the count. A higher value (e.g. 9, matching a literal
 * "~2 spaced recalls" back-of-envelope) reads as STRICTER than the old streak gate
 * for a large share of real concepts, which is the wrong direction: the point of
 * this switch was to stop a single lapse from wiping out real prior strength, not to
 * raise the bar. 5 sits at the empirical median, so roughly as many concepts clear
 * it as would have hit streak>=2 before, while first-answer confidence (stability
 * ~1.6-2.2 off one correct) still stays comfortably low (~32-44%) — still
 * provisional, not instant mastery. */
export const S_SOLID = 5;

export function emptyMastery(): NoteMastery {
	return {
		correct: 0,
		partial: 0,
		incorrect: 0,
		streak: 0,
		stability: null,
		difficulty: null,
		lastSeen: null,
		dueAt: null,
		misconceptions: {},
		weakPrereq: null,
	};
}

/** Upgrade records written by older plugin versions in place. */
export function normalizeMastery(map: MasteryMap): MasteryMap {
	for (const [k, v] of Object.entries(map)) {
		map[k] = { ...emptyMastery(), ...v };
	}
	return map;
}

/** The FSRS fields shared by note-level and concept-level records, so the
 * scheduler can run on either. */
export interface Schedulable {
	correct: number;
	partial: number;
	incorrect: number;
	streak: number;
	stability: number | null;
	difficulty: number | null;
	lastSeen: string | null;
	dueAt: string | null;
	/** Consecutive "Again"s recorded WHILE already a leech (see `isLeech`), reset to 0
	 * the instant a rating lifts it out of leech state — a genuine recovery, not just
	 * one lucky hit on the way there. Undefined/0 = never been a leech, or recovered.
	 * Read by `applyRating` to widen the relearn gap the longer a concept keeps
	 * failing (see `AGAIN_RELEARN_MIN/MAX_MINUTES`'s doc comment), so a genuine leech
	 * gradually stops competing for session slots at ordinary-miss cadence instead of
	 * indefinitely. */
	leechStreak?: number;
}

/** Question difficulty tier, used to make grading difficulty-aware. */
export type QDifficulty = "easy" | "medium" | "hard";

/** Status of a note or concept. Notes prefer a concept-derived `aggStatus` when
 * present (set by the concept aggregate); otherwise fall back to the counters. */
export function statusOf(m: (Schedulable & { aggStatus?: NoteStatus }) | undefined): NoteStatus {
	if (!m) return "untested";
	if (m.aggStatus) return m.aggStatus;
	if (m.correct === 0 && m.incorrect === 0 && m.partial === 0) return "untested";
	// Durable-memory gate, not a streak: a lapse degrades stability (see
	// applyRating's Again branch) rather than zeroing it, so a concept that's been
	// solidly re-demonstrated since an old miss correctly reads "known" again.
	return m.stability !== null && m.stability >= S_SOLID ? "known" : "struggling";
}

// ---------------------------------------------------------------- FSRS-6 (ts-fsrs)

/** Default when the user hasn't set "Review frequency" in settings. Lower = shorter
 * intervals = things come due more often = progress feels faster, at the cost of more
 * reviews; higher = longer intervals, fewer but higher-stakes reviews. */
const DESIRED_RETENTION = 0.9;
export const MIN_STABILITY = 0.1;
const MAX_INTERVAL_DAYS = 365;
/** Relearning gap after an "Again" (rating 1), in minutes — scaled by the concept's
 * OWN post-fail stability rather than a single flat constant (the previous fix):
 * a concept that's still barely holding on after the miss (stability near 0) is
 * shown again almost immediately, one that failed but retained more of its prior
 * strength gets a bit more room, but always same-day, never the day-granularity
 * `optimalInterval` below produces (that function floors at 1 full day, which is
 * far too long for "let me try this again shortly"). Not 0 either way: a concept
 * marked due at the exact fail instant is due again the moment ANY new session
 * opens, however soon that is — session picking always drains the due bucket
 * before untested material, so a handful of early fails in a content-dense note
 * (a long drill sheet) could dominate every session's opening slots indefinitely,
 * with the note's other, never-tested majority never getting a look-in. */
const AGAIN_RELEARN_MIN_MINUTES = 5;
const AGAIN_RELEARN_MAX_MINUTES = 30;
/** Post-fail stability (days) at/above which the relearning gap is already at its
 * max — chosen well under a day, since anything scaling toward day-scale gaps
 * belongs to `optimalInterval`, not this same-day relearn buffer. */
const AGAIN_RELEARN_REFERENCE_STABILITY = 2;
/** Ceiling on how far `leechStreak` widens the relearn gap (see `Schedulable.leechStreak`
 * and `isLeech`): each consecutive Again-while-already-a-leech multiplies the ordinary
 * gap by (1 + streak), so a fresh leech (streak 1) gets 2x, capped here at 9x so a
 * concept that's failed for a very long time still relearns same-day (9 * 30min = 4.5h)
 * rather than sliding toward `optimalInterval`'s day-granularity territory, which would
 * make it indistinguishable from an ordinary spaced-out review. */
const LEECH_RELEARN_STREAK_CAP = 8;

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

function againRelearnMinutes(postFailStability: number): number {
	const frac = clamp(postFailStability / AGAIN_RELEARN_REFERENCE_STABILITY, 0, 1);
	return Math.round(AGAIN_RELEARN_MIN_MINUTES + frac * (AGAIN_RELEARN_MAX_MINUTES - AGAIN_RELEARN_MIN_MINUTES));
}

/** Shared engine instance: stateless besides its fixed params, so one instance
 * safely serves every concept/note. Left at library defaults — current FSRS-6
 * weights, `enable_short_term: true` (the real fix for same-day repeats: a
 * same-day review, elapsed days t=0, gets a dedicated short-term stability
 * formula instead of being run through the ordinary multi-day one) — UNLESS
 * `configureFSRSWeights` (below) has swapped in this vault's own optimized
 * weights (see optimizer.ts). `request_retention`/`enable_fuzz`/`maximum_interval`
 * are irrelevant either way: Grill never calls the library's own interval/fuzz
 * methods (`next`/`repeat`/`next_interval`), only the lower-level `next_state`,
 * so those params go unused. */
let engine = fsrs();

/** Swap the shared engine's weights: personalized (fit by optimizer.ts from this
 * vault's own review history) or, with `null`, back to the FSRS-6 library
 * defaults. Called once at plugin load with whatever's in settings, and again
 * whenever the optimizer produces a new fit. Every other export in this file
 * reads `engine` through a closure, so nothing needs to know this happened. */
export function configureFSRSWeights(weights: number[] | null): void {
	engine = weights && weights.length ? fsrs({ w: weights }) : fsrs();
}

/** Recall probability right now, per FSRS's own forgetting curve — delegates to the
 * engine's decay/weights so this stays consistent with whatever `next_state` below
 * actually used, rather than a separately hand-rolled formula that could drift from
 * it (the previous version hardcoded the old FSRS-4.5 decay exponent of exactly -1). */
export function retrievability(stability: number, elapsedDays: number): number {
	if (stability <= 0 || elapsedDays <= 0) return 1;
	return engine.forgetting_curve(elapsedDays, stability);
}

/** A concept's current mastery, 0-1: "how likely you'd recall this right now,
 * discounted for how provisional that recall still is." `null` until first tested.
 *
 * retrievability(stability, elapsed) is FSRS's own recency-weighted recall estimate
 * — it decays as time passes since `lastSeen` and jumps back up on review, so it
 * never reads as a frozen lifetime average the way raw correct/incorrect counters
 * do. `confidence` (stability/S_SOLID, capped at 1) is the anti-luck term that
 * replaces the old streak-of-2 gate: a single fresh correct has low stability, so
 * it reads as provisional (~0.18) rather than instant mastery, but stability
 * compounds fast on spaced success and saturates by roughly the second spaced
 * recall — the same "prove it twice" intuition, just continuous and driven by
 * actual memory strength instead of a counter a single lapse wipes to zero. */
export function conceptMasteryScore(m: Schedulable, now = new Date()): number | null {
	if (m.stability === null) return null;
	const elapsedDays = m.lastSeen ? (now.getTime() - new Date(m.lastSeen).getTime()) / 86400_000 : 0;
	const confidence = Math.min(1, m.stability / S_SOLID);
	return retrievability(m.stability, elapsedDays) * confidence;
}

/** A concept that keeps failing no matter how much it's reviewed, distinct from
 * ordinary "struggling" (which just means not yet durable). Anki's leech mechanic,
 * scaled down: Anki's default threshold is 8 lapses, but that assumes a fixed card
 * reviewed far more densely than Grill's AI-generated, spaced-out concepts, so 4 is
 * the practical equivalent here. Requires BOTH real failure volume and a lack of
 * progress (stability still short of S_SOLID) — a concept that failed early but has
 * since climbed past that isn't a leech, it's just a normal recovered lapse. */
export const LEECH_MIN_INCORRECT = 4;
export function isLeech(m: Schedulable): boolean {
	return m.incorrect >= LEECH_MIN_INCORRECT && (m.stability === null || m.stability < S_SOLID);
}

/** A stated confidence at or below this reads as "I was guessing" — matches
 * calibration.ts's CONFIDENCE_LEVELS "Guessing" value (0.3) exactly, not just close to
 * it, so a correct-but-guessed answer reliably lands as Hard below. Not imported from
 * calibration.ts to avoid a scheduling-math module depending on a UI-labels module;
 * this file just needs the number, which is a stable, deliberate constant on both sides. */
const LOW_CONFIDENCE = 0.3;

/** Verdict → FSRS rating (1=again, 2=hard, 3=good, 4=easy), difficulty-aware on
 * the reward side only: a hard question answered right is stronger evidence, so
 * it earns a longer interval (rating 4). A miss or partial is never upgraded into
 * a success — doing so would extend the interval on a wrong answer, which the
 * 4-point scale can't avoid, so failures always re-show soon.
 *
 * `confidence` (0-1, from the opt-in "how sure are you?" check) fills a real gap in
 * AI-graded mode: without it, a correct answer can only ever land as Good or Easy,
 * never Hard — there's no way to record "I got it right, but I was guessing," which
 * self-grade mode's native Again/Hard/Good/Easy buttons can express directly. A
 * genuinely low-confidence correct answer is real evidence the recall was effortful,
 * so it earns Hard instead of Good/Easy. Only overrides on that one clear signal
 * (exactly "Guessing", not the middling "Think so") so it doesn't second-guess a
 * confident answer; `null` (the check is off, or wasn't answered this time) falls
 * straight back to the difficulty-tag heuristic, unchanged.
 *
 * `hintsUsed` closes the same gap, with no setting to opt into: a correct answer
 * reached only after real assistance isn't independent recall. But tier1 is
 * deliberately just "a one-sentence conceptual nudge" (see TUTOR_RULES in llm.ts) —
 * capping on that alone was too aggressive in practice, penalizing a nudge as hard
 * as revealing the actual concept or a partial step, and stalling stability growth
 * for students who lean on a light nudge often. Only tier2+ (the underlying concept
 * or a real step toward the answer) counts as assistance strong enough to cap. */
export function toRating(
	verdict: Verdict,
	difficulty: QDifficulty = "medium",
	confidence: number | null = null,
	hintsUsed = 0,
): number {
	if (verdict === "incorrect") return 1;
	if (verdict === "partial") return 2;
	if ((confidence !== null && confidence <= LOW_CONFIDENCE) || hintsUsed > 1) return 2;
	return difficulty === "hard" ? 4 : 3;
}

export function optimalInterval(stability: number, desiredRetention = DESIRED_RETENTION): number {
	const interval = Math.round(9 * stability * (1 / desiredRetention - 1));
	return Math.max(1, Math.min(interval, MAX_INTERVAL_DAYS));
}

/** Local calendar day (not UTC): the day-crowding histogram/easy-weekday check below
 * both reason about "which day" and "which weekday" a candidate falls on in the
 * user's own local sense of a day, since that's what "Light review days: Sunday"
 * actually means to them. Using `.toISOString().slice(0,10)` here (UTC) used to
 * disagree with `candidate.getDay()` (already local, a few lines down) for anyone
 * not on UTC — for a large chunk of most days, the UTC calendar date is already the
 * next (or previous) one relative to local time, so the histogram bucket and the
 * "is this an easy weekday" check could silently reason about two different days. */
function dayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** How many concepts already land on a given due date (YYYY-MM-DD), built once per
 * session from the full concept map (see loadNextBatch's caller in view.ts) so
 * fuzzInterval's day choice can prefer the least-crowded day within its jitter
 * window instead of pure randomness. Optional everywhere it's threaded through:
 * omitting it is the original pure-random fuzz, unaffected. */
export type DueDateHistogram = Map<string, number>;

export function buildDueDateHistogram(dueAts: Iterable<string | null>): DueDateHistogram {
	const hist: DueDateHistogram = new Map();
	for (const dueAt of dueAts) {
		if (!dueAt) continue;
		// Must bucket exactly the way dayKey does (local calendar day) — dueAt is a
		// UTC ISO timestamp, so slicing its first 10 characters would silently switch
		// back to UTC-day bucketing here while fuzzInterval's own lookup (below) uses
		// dayKey's local day, breaking the very match this histogram exists to enable.
		const key = dayKey(new Date(dueAt));
		hist.set(key, (hist.get(key) ?? 0) + 1);
	}
	return hist;
}

/** Added to a candidate day's real histogram count before comparison when that day
 * falls on a user-designated "easy" weekday (see `fuzzInterval`'s `easyWeekdays`) —
 * large enough that any ordinary day's real count (single/low-double digits even in
 * an active vault) always wins the comparison when one's available in the window, but
 * finite so an easy day is still chosen (least-bad among equals) rather than the
 * function failing when EVERY candidate day in the window happens to be an easy one. */
const EASY_DAY_PENALTY = 1000;

/** Anki-style interval fuzz so same-session items don't all resurface the same day.
 * With a due-date histogram supplied, picks the least-crowded whole day within the
 * jitter window instead of a random offset in it — smooths review load across days
 * rather than merely avoiding an exact-day collision. (The idea comes from
 * obsidian-spaced-repetition's load-balancing histogram, which that plugin built
 * but only wired into its legacy SM-2 path, never its FSRS one — this wires it all
 * the way through.) Ties broken randomly among equally least-crowded days. Falls
 * back to the original pure-random jitter when no histogram is given, or the
 * window is too narrow to have more than one whole-day candidate.
 *
 * `easyWeekdays` (0=Sunday..6=Saturday, from the "Light review days" setting) makes
 * those weekdays read as artificially crowded for THIS comparison only — the
 * histogram itself still records each day's real count (see the `.set` below), so a
 * later call with a different/empty `easyWeekdays` (or none at all) isn't misled by a
 * penalty that was never really there. Anki's own scheduler and true-recall (a
 * comparable Obsidian plugin) both call this "easy days"; this is the same idea
 * layered on Grill's own per-day load-balancing rather than a flat daily review cap. */
export function fuzzInterval(
	days: number,
	now = new Date(),
	histogram?: DueDateHistogram,
	easyWeekdays?: ReadonlySet<number>,
): number {
	if (days < 2.5) return days;
	const range = days < 7 ? 1 : days * (days < 30 ? 0.15 : 0.05);
	if (histogram) {
		const loDay = Math.ceil(Math.max(2, days - range));
		const hiDay = Math.floor(days + range);
		if (hiDay > loDay) {
			let best: { day: number; realCount: number }[] = [];
			let bestEffective = Infinity;
			for (let d = loDay; d <= hiDay; d++) {
				const candidate = new Date(now.getTime() + d * 86400_000);
				const realCount = histogram.get(dayKey(candidate)) ?? 0;
				const effective = easyWeekdays?.has(candidate.getDay()) ? realCount + EASY_DAY_PENALTY : realCount;
				if (effective < bestEffective) {
					bestEffective = effective;
					best = [{ day: d, realCount }];
				} else if (effective === bestEffective) {
					best.push({ day: d, realCount });
				}
			}
			const chosen = best[Math.floor(Math.random() * best.length)];
			// Reserve the chosen day immediately so several ratings applied in the same
			// session (a whole batch coming due together) spread out against each other,
			// not just against days that were already crowded before the session started.
			// Stores the REAL count, never the easy-day-penalized one (see doc comment).
			histogram.set(dayKey(new Date(now.getTime() + chosen.day * 86400_000)), chosen.realCount + 1);
			return chosen.day;
		}
	}
	return Math.max(2, days + (Math.random() - 0.5) * 2 * range);
}

// ---------------------------------------------------------------- updates

/** Apply one FSRS rating (1-4) to any schedulable record, updating stability,
 * difficulty, counters, streak and due date. Runs at note or concept level.
 * `desiredRetention` is the user's "Review frequency" setting (falls back to the
 * FSRS-standard 0.9 default when omitted, e.g. for callers that don't thread settings
 * through). `dueDateHistogram`, when passed, load-balances the fuzzed due date
 * against everything else already due (see `fuzzInterval`); omit it for the
 * original pure-random fuzz. `easyWeekdays`, passed through to `fuzzInterval`, steers
 * the fuzzed due date off those weekdays where a same-crowdedness alternative exists. */
export function applyRating(
	m: Schedulable,
	rating: number,
	now: Date,
	desiredRetention = DESIRED_RETENTION,
	dueDateHistogram?: DueDateHistogram,
	easyWeekdays?: ReadonlySet<number>,
): void {
	// ts-fsrs's own calendar-day diff (midnight to midnight, not a continuous ms-based
	// count), floored to >=0 defensively — next_state throws on a negative t, which a
	// stale/replayed lastSeen could otherwise produce. This convention matters: it's
	// what makes t===0 (same calendar day) trigger the engine's dedicated short-term
	// stability formula instead of the ordinary multi-day one.
	const t = m.lastSeen ? Math.max(0, dateDiffInDays(new Date(m.lastSeen), now)) : 0;
	// Self-heal: a stored difficulty <= 1 is a legacy value from a pre-FSRS-4.5-era
	// [0.1,1]-scale bug that saturated every concept at the clamp ceiling, so it
	// carries no real signal to preserve — treat it as untested (null memory state)
	// so the engine reseeds both fields via its own init formulas on this touch,
	// exactly as if this were the concept's first-ever rating.
	const legacyDifficulty = m.difficulty !== null && m.difficulty <= 1;
	const memory: FSRSState | null =
		m.stability === null || m.difficulty === null || legacyDifficulty
			? null
			: { stability: m.stability, difficulty: m.difficulty };
	const next = engine.next_state(memory, t, rating as Grade);
	m.stability = next.stability;
	m.difficulty = next.difficulty;

	// Again (1) counts wrong and breaks the streak; Hard (2) is a partial;
	// Good (3) and Easy (4) both count as a correct recall.
	if (rating >= 3) {
		m.correct += 1;
		m.streak += 1;
	} else if (rating === 2) {
		m.partial += 1;
	} else {
		m.incorrect += 1;
		m.streak = 0;
	}

	// Track BEFORE computing the relearn gap below, so a streak that just started
	// (this Again is what tipped it into leech territory) already widens THIS gap,
	// not only the next one — isLeech reads the just-updated incorrect/stability above.
	m.leechStreak = rating === 1 && isLeech(m) ? (m.leechStreak ?? 0) + 1 : 0;

	if (rating === 1) {
		// Relearn shortly, not this instant — scaled by the concept's own new (lower)
		// stability, not a flat constant (see AGAIN_RELEARN_MIN/MAX_MINUTES), and widened
		// further the longer it's been a leech (see LEECH_RELEARN_STREAK_CAP) so a genuine
		// leech gradually stops competing for session slots at ordinary-miss cadence.
		const leechMultiplier = 1 + Math.min(m.leechStreak, LEECH_RELEARN_STREAK_CAP);
		m.dueAt = new Date(now.getTime() + againRelearnMinutes(m.stability) * leechMultiplier * 60_000).toISOString();
	} else {
		const days = fuzzInterval(optimalInterval(m.stability, desiredRetention), now, dueDateHistogram, easyWeekdays);
		m.dueAt = new Date(now.getTime() + days * 86400_000).toISOString();
	}

	m.lastSeen = now.toISOString();
}

/** Bump a note's cumulative counters and misconception tally (stats + registry).
 * Note scheduling (status/dueAt) is derived from concepts, not set here. */
export function recordNoteStats(
	map: MasteryMap,
	note: string,
	verdict: Verdict,
	misconceptionTag?: string,
): void {
	const m = map[note] ?? emptyMastery();
	if (verdict === "correct") m.correct += 1;
	else if (verdict === "partial") m.partial += 1;
	else m.incorrect += 1;
	if (misconceptionTag) {
		m.misconceptions[misconceptionTag] = (m.misconceptions[misconceptionTag] ?? 0) + 1;
	}
	map[note] = m;
}

/** Round-robin note names across a grouping key (their parent folder), preserving
 * each group's relative order. Candidate selection below is order-sensitive for
 * untested notes (first-come, no re-sort), so without this a scope spanning
 * several folders collapses onto whichever folder sorts first: it fills the
 * whole session cap before a later folder is ever reached. */
export function interleaveByFolder(names: string[], folderOf: (name: string) => string): string[] {
	const byFolder = new Map<string, string[]>();
	const order: string[] = [];
	for (const n of names) {
		const folder = folderOf(n);
		let arr = byFolder.get(folder);
		if (!arr) {
			arr = [];
			byFolder.set(folder, arr);
			order.push(folder);
		}
		arr.push(n);
	}
	const out: string[] = [];
	for (let round = 0, added = true; added; round++) {
		added = false;
		for (const folder of order) {
			const arr = byFolder.get(folder);
			if (arr && round < arr.length) {
				out.push(arr[round]);
				added = true;
			}
		}
	}
	return out;
}

/** Pick up to `cap` candidate notes for a session, by priority:
 *  1. struggling or overdue notes (oldest due first) — from `priority`, the live
 *     concept-level signal (see `priorityNotes` in concepts.ts), NOT the note-level
 *     mastery cache: that cache only refreshes when a note is next answered, so it
 *     silently misses notes whose concepts became due/struggling since their last visit.
 *  2. untested notes
 *  3. known notes not yet due (only if space remains), least-recently-seen first
 */
/** How `reserveFreshSlots` weighs new/untested material against a due/struggling
 * backlog — user-configurable (see "New material" settings in main.ts), not a fixed
 * constant. Modeled directly on Anki's own v3 scheduler, the actual reference
 * implementation FSRS was built for: by default new cards are capped by whatever room
 * is left in the review limit after the backlog is served (reviews win, new material
 * shrinks as backlog grows — the opposite of always-guaranteed), with an explicit
 * opt-in, `alwaysGuarantee`, mirroring Anki's real "New cards ignore review limit"
 * toggle for a student who wants new material every session regardless of backlog
 * size. `share` still bounds how much of a session new material can claim even when
 * it isn't backlog-starved, same role the old fixed 0.3 played, just user-set now. */
export interface FreshContentPolicy {
	/** 0-1: the ceiling on new/untested material's portion of one session, whenever
	 * it's allowed to claim any room at all. */
	share: number;
	/** Anki calls this "New cards ignore review limit." Off (Anki's default, and
	 * this plugin's): the backlog is served first, and new material only gets
	 * whatever's left within `share`'s ceiling — a backlog that already fills the
	 * whole session leaves zero room for new material, same as reviews winning a
	 * genuine backlog in any real SRS tool. On: new material always gets its full
	 * `share`, no matter how large the backlog is (this plugin's old, only, silent
	 * behavior — now an explicit, visible choice instead of the default). */
	alwaysGuarantee: boolean;
}

/** Build a capped, priority-ordered selection from three priority-ordered buckets.
 * `policy` decides how much of `cap` untested `fresh` material can claim relative to
 * the `priority` (due/struggling) backlog — see `FreshContentPolicy`. Leftover room
 * (priority smaller than its allotment, or fresh smaller than its reserve) is
 * backfilled from whatever's left, in priority > fresh > overflow order. */
export function reserveFreshSlots<T>(priority: T[], fresh: T[], overflow: T[], cap: number, policy: FreshContentPolicy): T[] {
	const shareCeiling = Math.min(fresh.length, Math.ceil(cap * policy.share));
	// Anki's actual rule ("only 10 new cards appear if 190 of your 200 review slots are
	// already full"): room for fresh material is whatever's genuinely left after the
	// backlog is served, not a slice guaranteed to exist regardless of backlog size.
	const roomLeft = Math.max(0, cap - priority.length);
	const freshReserve = policy.alwaysGuarantee ? shareCeiling : Math.min(shareCeiling, roomLeft);
	const priorityTaken = priority.slice(0, Math.max(0, cap - freshReserve));
	const freshTaken = fresh.slice(0, freshReserve);
	const filler = [...priority.slice(priorityTaken.length), ...fresh.slice(freshTaken.length), ...overflow];
	return [...priorityTaken, ...freshTaken, ...filler].slice(0, cap);
}

export function pickCandidates(
	allNotes: string[],
	map: MasteryMap,
	cap: number,
	priority: Map<string, string | null> = new Map(),
	policy: FreshContentPolicy = { share: 0.3, alwaysGuarantee: false },
): string[] {
	const due: string[] = [];
	const untested: string[] = [];
	const rest: string[] = [];
	for (const n of allNotes) {
		if (priority.has(n)) due.push(n);
		else if (statusOf(map[n]) === "untested") untested.push(n);
		else rest.push(n);
	}
	due.sort((a, b) => (priority.get(a) ?? "").localeCompare(priority.get(b) ?? ""));
	rest.sort((a, b) => (map[a]?.lastSeen ?? "").localeCompare(map[b]?.lastSeen ?? ""));
	return reserveFreshSlots(due, untested, rest, cap, policy);
}
