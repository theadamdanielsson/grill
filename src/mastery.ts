/** Per-note mastery state, FSRS-4.5 scheduling, misconception tracking.
 *
 * Default parameters from open-spaced-repetition/fsrs4.5.
 */

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
	/** FSRS difficulty, native FSRS-4.5 scale 1 (easiest) - 10 (hardest); null until
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
	// nextStabilityAfterFailure) rather than zeroing it, so a concept that's been
	// solidly re-demonstrated since an old miss correctly reads "known" again.
	return m.stability !== null && m.stability >= S_SOLID ? "known" : "struggling";
}

// ---------------------------------------------------------------- FSRS-4.5

const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
/** Default when the user hasn't set "Review frequency" in settings. Lower = shorter
 * intervals = things come due more often = progress feels faster, at the cost of more
 * reviews; higher = longer intervals, fewer but higher-stakes reviews. */
const DESIRED_RETENTION = 0.9;
export const MIN_STABILITY = 0.1;
const MAX_INTERVAL_DAYS = 365;

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

export function retrievability(stability: number, elapsedDays: number): number {
	if (stability <= 0 || elapsedDays <= 0) return 1;
	return Math.pow(1 + elapsedDays / (9 * stability), -1);
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
 * straight back to the difficulty-tag heuristic, unchanged. */
export function toRating(verdict: Verdict, difficulty: QDifficulty = "medium", confidence: number | null = null): number {
	if (verdict === "incorrect") return 1;
	if (verdict === "partial") return 2;
	if (confidence !== null && confidence <= LOW_CONFIDENCE) return 2;
	return difficulty === "hard" ? 4 : 3;
}

/** S0(G) = w[G-1], the real FSRS-4.5 4-point initial-stability lookup — four
 * independent values, one per first rating, not an interpolation between two. */
function initialStability(rating: number): number {
	return Math.max(MIN_STABILITY, W[rating - 1]);
}

function initialDifficulty(rating: number): number {
	return clamp(W[4] - W[5] * (rating - 3), 1, 10);
}

function nextStabilityAfterSuccess(stability: number, difficulty: number, r: number, rating: number): number {
	const sinFactor = Math.exp(W[8]) * (11 - difficulty) * Math.pow(stability, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1);
	// Hard (2) shrinks the gain; Easy (4) enlarges it. Good (3) is neutral.
	const ratingBonus = rating === 2 ? W[15] : rating === 4 ? W[16] : 1;
	return Math.max(MIN_STABILITY, stability * (1 + sinFactor * ratingBonus));
}

function nextStabilityAfterFailure(stability: number, difficulty: number, r: number): number {
	return Math.max(
		MIN_STABILITY,
		W[11] * Math.pow(difficulty, -W[12]) * (Math.pow(stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)),
	);
}

/** D' = w7*D0(4) + (1-w7)*clamp(D - w6*(G-3), 1, 10) — the real FSRS-4.5
 * mean-reversion term, gently pulling difficulty back toward the "brand-new Easy
 * card" anchor each review instead of letting it drift unbounded. */
function nextDifficulty(difficulty: number, rating: number): number {
	const reverted = clamp(difficulty - W[6] * (rating - 3), 1, 10);
	return clamp(W[7] * initialDifficulty(4) + (1 - W[7]) * reverted, 1, 10);
}

export function optimalInterval(stability: number, desiredRetention = DESIRED_RETENTION): number {
	const interval = Math.round(9 * stability * (1 / desiredRetention - 1));
	return Math.max(1, Math.min(interval, MAX_INTERVAL_DAYS));
}

function dayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
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
		const key = dueAt.slice(0, 10);
		hist.set(key, (hist.get(key) ?? 0) + 1);
	}
	return hist;
}

/** Anki-style interval fuzz so same-session items don't all resurface the same day.
 * With a due-date histogram supplied, picks the least-crowded whole day within the
 * jitter window instead of a random offset in it — smooths review load across days
 * rather than merely avoiding an exact-day collision. (The idea comes from
 * obsidian-spaced-repetition's load-balancing histogram, which that plugin built
 * but only wired into its legacy SM-2 path, never its FSRS one — this wires it all
 * the way through.) Ties broken randomly among equally least-crowded days. Falls
 * back to the original pure-random jitter when no histogram is given, or the
 * window is too narrow to have more than one whole-day candidate. */
export function fuzzInterval(days: number, now = new Date(), histogram?: DueDateHistogram): number {
	if (days < 2.5) return days;
	const range = days < 7 ? 1 : days * (days < 30 ? 0.15 : 0.05);
	if (histogram) {
		const loDay = Math.ceil(Math.max(2, days - range));
		const hiDay = Math.floor(days + range);
		if (hiDay > loDay) {
			let best: number[] = [];
			let bestCount = Infinity;
			for (let d = loDay; d <= hiDay; d++) {
				const count = histogram.get(dayKey(new Date(now.getTime() + d * 86400_000))) ?? 0;
				if (count < bestCount) {
					bestCount = count;
					best = [d];
				} else if (count === bestCount) {
					best.push(d);
				}
			}
			const chosen = best[Math.floor(Math.random() * best.length)];
			// Reserve the chosen day immediately so several ratings applied in the same
			// session (a whole batch coming due together) spread out against each other,
			// not just against days that were already crowded before the session started.
			histogram.set(dayKey(new Date(now.getTime() + chosen * 86400_000)), bestCount + 1);
			return chosen;
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
 * original pure-random fuzz. */
export function applyRating(
	m: Schedulable,
	rating: number,
	now: Date,
	desiredRetention = DESIRED_RETENTION,
	dueDateHistogram?: DueDateHistogram,
): void {
	const elapsedDays = m.lastSeen ? (now.getTime() - new Date(m.lastSeen).getTime()) / 86400_000 : 0;
	if (m.stability === null || m.difficulty === null) {
		m.stability = initialStability(rating);
		m.difficulty = initialDifficulty(rating);
	} else {
		const r = retrievability(m.stability, elapsedDays);
		// Self-heal: a stored difficulty <= 1 is a legacy value from the pre-fix
		// [0.1,1]-scale formula, which saturated to exactly 1.0 for every rating and
		// therefore carries no real signal to preserve. Reseed it via the corrected
		// initial-difficulty formula on this touch rather than rescaling it (a
		// proportional rescale would map that saturated ceiling to the HARDEST end of
		// the real scale, which is backwards). The fixed formulas can never themselves
		// emit a value <= 1 (their floor is ~1.03), so this can never misfire against
		// genuine post-fix data on any later touch.
		m.difficulty = m.difficulty <= 1 ? initialDifficulty(rating) : nextDifficulty(m.difficulty, rating);
		m.stability =
			rating === 1
				? nextStabilityAfterFailure(m.stability, m.difficulty, r)
				: nextStabilityAfterSuccess(m.stability, m.difficulty, r, rating);
	}

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

	if (rating === 1) {
		m.dueAt = now.toISOString(); // immediately due again
	} else {
		const days = fuzzInterval(optimalInterval(m.stability, desiredRetention), now, dueDateHistogram);
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
 *  1. struggling or overdue notes (oldest due first)
 *  2. untested notes
 *  3. known notes not yet due (only if space remains), least-recently-seen first
 */
/** Share of a capped candidate pool reserved for untested material, regardless of how
 * large the due/struggling backlog is. Without this, "struggling" candidates (anything
 * not yet confirmed known — see `statusOf`) queue-jump ahead of every untested one with
 * no limit on how many of them there can be, so in a large vault a handful of hard notes
 * can permanently fill the entire cap and starve the rest of the vault out of rotation
 * forever: confirmed in the wild on a 460-note vault where 84% of notes had zero
 * exposure after 32 sessions because a few "struggling" grammar notes never stopped
 * winning priority. Reserving a minimum share guarantees fresh content keeps entering
 * rotation even when the review backlog alone could fill every session. */
const NEW_CONTENT_RESERVE_SHARE = 0.3;

/** Build a capped, priority-ordered selection from three priority-ordered buckets,
 * guaranteeing `fresh` a minimum share of `cap` (see `NEW_CONTENT_RESERVE_SHARE`)
 * instead of letting `priority` crowd it out entirely when the backlog is large.
 * Leftover room (priority smaller than its allotment, or fresh smaller than its
 * reserve) is backfilled from whatever's left, in priority > fresh > overflow order. */
export function reserveFreshSlots<T>(priority: T[], fresh: T[], overflow: T[], cap: number): T[] {
	const freshReserve = Math.min(fresh.length, Math.ceil(cap * NEW_CONTENT_RESERVE_SHARE));
	const priorityTaken = priority.slice(0, Math.max(0, cap - freshReserve));
	const freshTaken = fresh.slice(0, freshReserve);
	const filler = [...priority.slice(priorityTaken.length), ...fresh.slice(freshTaken.length), ...overflow];
	return [...priorityTaken, ...freshTaken, ...filler].slice(0, cap);
}

export function pickCandidates(allNotes: string[], map: MasteryMap, cap: number, now = new Date()): string[] {
	const due: string[] = [];
	const untested: string[] = [];
	const rest: string[] = [];
	for (const n of allNotes) {
		const m = map[n];
		const s = statusOf(m);
		if (s === "untested") untested.push(n);
		else if (s === "struggling" || (m?.dueAt && new Date(m.dueAt) <= now)) due.push(n);
		else rest.push(n);
	}
	due.sort((a, b) => (map[a]?.dueAt ?? "").localeCompare(map[b]?.dueAt ?? ""));
	rest.sort((a, b) => (map[a]?.lastSeen ?? "").localeCompare(map[b]?.lastSeen ?? ""));
	return reserveFreshSlots(due, untested, rest, cap);
}
