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
	/** FSRS difficulty 0.1-1; null until first answer */
	difficulty: number | null;
	lastSeen: string | null; // ISO date
	dueAt: string | null; // ISO date; null = never tested
	/** canonical snake_case misconception tag -> times observed */
	misconceptions: Record<string, number>;
}

export type MasteryMap = Record<string, NoteMastery>;

export type NoteStatus = "untested" | "struggling" | "known";

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
	};
}

/** Upgrade records written by older plugin versions in place. */
export function normalizeMastery(map: MasteryMap): MasteryMap {
	for (const [k, v] of Object.entries(map)) {
		map[k] = { ...emptyMastery(), ...v };
	}
	return map;
}

export function statusOf(m: NoteMastery | undefined): NoteStatus {
	if (!m || (m.correct === 0 && m.incorrect === 0 && m.partial === 0)) return "untested";
	return m.streak >= 1 ? "known" : "struggling";
}

// ---------------------------------------------------------------- FSRS-4.5

const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
const DESIRED_RETENTION = 0.9;
const MIN_STABILITY = 0.1;
const MAX_INTERVAL_DAYS = 365;

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

export function retrievability(stability: number, elapsedDays: number): number {
	if (stability <= 0 || elapsedDays <= 0) return 1;
	return Math.pow(1 + elapsedDays / (9 * stability), -1);
}

/** FSRS rating: 1=again, 2=hard, 3=good. (No confidence signal, so no 4.) */
function toRating(verdict: Verdict): number {
	if (verdict === "incorrect") return 1;
	if (verdict === "partial") return 2;
	return 3;
}

function initialStability(rating: number): number {
	return Math.max(MIN_STABILITY, W[0] + W[1] * (rating - 1));
}

function initialDifficulty(rating: number): number {
	return clamp(W[4] - W[5] * (rating - 3), 0.1, 1);
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

function nextDifficulty(difficulty: number, rating: number): number {
	return clamp(difficulty - W[6] * (rating - 3), 0.1, 1);
}

export function optimalInterval(stability: number, desiredRetention = DESIRED_RETENTION): number {
	const interval = Math.round(9 * stability * (1 / desiredRetention - 1));
	return Math.max(1, Math.min(interval, MAX_INTERVAL_DAYS));
}

/** Anki-style interval fuzz so same-session items don't all resurface the same day. */
export function fuzzInterval(days: number): number {
	if (days < 2.5) return days;
	if (days < 7) return Math.max(2, days + (Math.random() - 0.5) * 2);
	const pct = days < 30 ? 0.15 : 0.05;
	const range = days * pct;
	return Math.max(2, days + (Math.random() - 0.5) * 2 * range);
}

// ---------------------------------------------------------------- updates

/** Apply one FSRS rating (1-4) to a note's record, updating stability, difficulty,
 * counters, streak and due date. Shared by the AI-graded and self-graded paths. */
function applyRating(m: NoteMastery, rating: number, now: Date, misconceptionTag?: string): void {
	const elapsedDays = m.lastSeen ? (now.getTime() - new Date(m.lastSeen).getTime()) / 86400_000 : 0;
	if (m.stability === null || m.difficulty === null) {
		m.stability = initialStability(rating);
		m.difficulty = initialDifficulty(rating);
	} else {
		const r = retrievability(m.stability, elapsedDays);
		m.difficulty = nextDifficulty(m.difficulty, rating);
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
		const days = fuzzInterval(optimalInterval(m.stability));
		m.dueAt = new Date(now.getTime() + days * 86400_000).toISOString();
	}

	if (misconceptionTag) {
		m.misconceptions[misconceptionTag] = (m.misconceptions[misconceptionTag] ?? 0) + 1;
	}

	m.lastSeen = now.toISOString();
}

export function recordAnswer(
	map: MasteryMap,
	note: string,
	verdict: Verdict,
	misconceptionTag?: string,
	now = new Date(),
): void {
	const m = map[note] ?? emptyMastery();
	applyRating(m, toRating(verdict), now, misconceptionTag);
	map[note] = m;
}

/** Record a self-graded review (no LLM): the user's own Again/Hard/Good/Easy rating. */
export function recordRating(map: MasteryMap, note: string, rating: Rating, now = new Date()): void {
	const m = map[note] ?? emptyMastery();
	applyRating(m, rating, now);
	map[note] = m;
}

/** Pick up to `cap` candidate notes for a session, by priority:
 *  1. struggling or overdue notes (oldest due first)
 *  2. untested notes
 *  3. known notes not yet due (only if space remains), least-recently-seen first
 */
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
	return [...due, ...untested, ...rest].slice(0, cap);
}

/** Bloom-tier target difficulty per note, given its mastery state. */
export function targetDifficulty(m: NoteMastery | undefined, now = new Date()): string {
	const s = statusOf(m);
	if (s === "untested") return "easy_or_medium_recall";
	if (s === "struggling") return "easy_probe_the_misconception";
	if (m?.dueAt && new Date(m.dueAt) <= now) return "medium_or_hard_application";
	return "medium_recall_or_application";
}

/** Misconception tags seen at least `min` times for a note. */
export function recurringMisconceptions(m: NoteMastery | undefined, min = 2): string[] {
	if (!m) return [];
	return Object.entries(m.misconceptions)
		.filter(([, n]) => n >= min)
		.sort((a, b) => b[1] - a[1])
		.map(([t]) => t);
}

/** Structured per-note state block included in the tutor prompt. */
export function masteryPromptBlock(map: MasteryMap, notes: string[]): string {
	const out: Record<string, unknown> = {};
	for (const n of notes) {
		const m = map[n];
		out[n] = {
			status: statusOf(m),
			correct: m?.correct ?? 0,
			partial: m?.partial ?? 0,
			incorrect: m?.incorrect ?? 0,
			last_seen: m?.lastSeen?.slice(0, 10) ?? null,
			target_difficulty: targetDifficulty(m),
			recurring_misconceptions: recurringMisconceptions(m),
		};
	}
	return JSON.stringify(out, null, 1);
}
