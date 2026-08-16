/** Session synthesis: the end-of-session debrief and the canonical
 * misconception registry.
 *
 * Two problems share this file because they share one LLM call. The grader
 * emits a free-form snake_case tag per wrong answer (sign_error, wrong_sign,
 * signs_error...), so the same confusion never clusters. At session end one
 * call both writes the debrief and maps this session's raw tags onto a
 * per-vault canonical registry, reusing an existing canon when it means the
 * same thing. The raw per-note tags in mastery.json stay the append-only
 * truth; this registry is a recomputable projection over them.
 */

import { Verdict } from "./mastery";

export interface SessionDebrief {
	/** One plain sentence naming the shape of the session. */
	headline: string;
	/** Notes the student clearly knows. */
	strengths: string[];
	/** Notes to revisit, each with the specific concept and why. */
	gaps: { concept: string; note: string; why: string }[];
	/** One underlying confusion that recurred this session, or "". */
	pattern: string;
	/** Notes to study next, drawn from the session's notes. */
	nextFocus: string[];
}

/** One session's headline, logged the moment an AI debrief is produced. The
 * running log this builds up is what synthesizeArc reads for "recent session
 * headlines" and is also the whole basis for active-day counting below — one
 * small persisted list serves both, instead of a separate day tracker plus a
 * separate re-parse of past session note files. */
export interface ArcEntry {
	/** Calendar date the session ended, `YYYY-MM-DD` (local), not a timestamp:
	 * arc cadence counts distinct study days, not sessions or wall-clock time. */
	date: string;
	headline: string;
}

/** A synthesized narrative over many sessions: what's changed, not what happened
 * in any one session (that's SessionDebrief's job). */
export interface Arc {
	/** One plain sentence naming the overall trajectory. */
	headline: string;
	/** Misconceptions that were active and are now resolved, in plain language. */
	resolved: string[];
	/** Misconceptions still active, ranked by recurrence. */
	stillWorking: string[];
	/** One sentence naming a genuine change over time, or "" if there isn't one yet. */
	shift: string;
}

/** True when a stored value is a usable arc log entry (guards loaded data.json). */
export function isArcEntry(v: unknown): v is ArcEntry {
	const e = v as ArcEntry | null;
	return !!e && typeof e.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.headline === "string";
}

/** Distinct calendar days represented in the arc log — the unit arc cadence is
 * gated on. Sessions cluster in bursts (a real vault can log 8 sessions in one
 * afternoon), so counting sessions instead of days would fire the synthesis call
 * roughly hourly during a cram burst and say nothing new each time; days is the
 * unit that actually has time for retention/change to show. */
export function activeDayCount(log: ArcEntry[]): number {
	return new Set(log.map((e) => e.date)).size;
}

/** Days of real study history required before the first arc synthesis — thin
 * evidence (a single day) has nothing to say yet: no misconception has had time
 * to resolve, so `resolved`/`shift` would come back empty every time. */
export const MIN_ACTIVE_DAYS_FOR_ARC = 3;
/** Active days between re-synthesis once the first arc exists. Also day-based
 * for the same reason as activeDayCount. */
export const ACTIVE_DAYS_BETWEEN_ARCS = 3;
/** Cap on how many recent headlines synthesizeArc is given — keeps the call's
 * input small and bounded regardless of vault size or history length, the same
 * reasoning as MISC_SHOWN_CAP in the dashboard. */
export const ARC_LOG_CAP = 12;

/** Append this session's headline to the arc log, deduped to one entry per day
 * (a cram day's last headline wins) and capped to the most recent ARC_LOG_CAP
 * days so the log can't grow unbounded over a long-lived vault. */
export function logArcEntry(log: ArcEntry[], entry: ArcEntry): ArcEntry[] {
	const withoutToday = log.filter((e) => e.date !== entry.date);
	return [...withoutToday, entry].slice(-ARC_LOG_CAP);
}

/** One raw misconception tag from this session mapped to a canonical one. */
export interface TagAssignment {
	rawTag: string;
	canonTag: string;
	canonLabel: string;
	note: string;
}

export interface CanonMisconception {
	tag: string;
	label: string;
	/** raw tags that have mapped here */
	aliases: string[];
	/** note basenames where it has been observed */
	notes: string[];
	/** total raw observations mapped here */
	count: number;
	firstSeen: string;
	lastSeen: string;
	/** 'resolved' is set in step 3 when a re-probe is answered correctly. 'dismissed'
	 * is set by the student from the dashboard, when the tag itself is bad (a grading
	 * misfire, not a real confusion) — unlike 'resolved', a fresh observation of the
	 * same tag does NOT reactivate it (see mergeAssignments), so a bad tag stays out
	 * of the re-probe rotation for good instead of clawing its way back in. */
	status: "active" | "resolved" | "dismissed";
}

export type MisconceptionRegistry = Record<string, CanonMisconception>;

/** Fold this session's tag assignments into the canonical registry, in place. */
export function mergeAssignments(
	reg: MisconceptionRegistry,
	assignments: TagAssignment[],
	now = new Date(),
): MisconceptionRegistry {
	const iso = now.toISOString();
	for (const a of assignments) {
		const tag = (a.canonTag || a.rawTag || "").trim();
		if (!tag) continue;
		const existing = reg[tag];
		if (existing) {
			if (a.rawTag && a.rawTag !== tag && !existing.aliases.includes(a.rawTag)) existing.aliases.push(a.rawTag);
			if (a.note && !existing.notes.includes(a.note)) existing.notes.push(a.note);
			existing.count += 1;
			existing.lastSeen = iso;
			if (a.canonLabel && !existing.label) existing.label = a.canonLabel;
			// A fresh observation reactivates a previously resolved confusion.
			if (existing.status === "resolved") existing.status = "active";
		} else {
			reg[tag] = {
				tag,
				label: a.canonLabel || tag.replace(/_/g, " "),
				aliases: a.rawTag && a.rawTag !== tag ? [a.rawTag] : [],
				notes: a.note ? [a.note] : [],
				count: 1,
				firstSeen: iso,
				lastSeen: iso,
				status: "active",
			};
		}
	}
	return reg;
}

/** Mark a canonical misconception resolved: the student re-probed it and got it
 * right. A later fresh observation reactivates it (see mergeAssignments). */
export function resolveMisconception(reg: MisconceptionRegistry, tag: string, now = new Date()): void {
	const c = reg[tag];
	if (c && c.status !== "resolved") {
		c.status = "resolved";
		c.lastSeen = now.toISOString();
	}
}

/** Mark a canonical misconception dismissed: the student says this tag is wrong
 * (a bad grading call, not a real recurring confusion) and it should stop being
 * re-probed. Permanent, unlike resolveMisconception — mergeAssignments only
 * reactivates a 'resolved' tag on a fresh observation, never a dismissed one. */
export function dismissMisconception(reg: MisconceptionRegistry, tag: string, now = new Date()): void {
	const c = reg[tag];
	if (c && c.status !== "dismissed") {
		c.status = "dismissed";
		c.lastSeen = now.toISOString();
	}
}

/** Active canonical misconceptions that involve each of the given notes, so the
 * tutor can deliberately re-probe them and tag the question for resolution. */
export function activeMisconceptionsByNote(
	reg: MisconceptionRegistry,
	notes: string[],
): Record<string, { tag: string; label: string }[]> {
	const want = new Set(notes);
	const out: Record<string, { tag: string; label: string }[]> = {};
	for (const c of Object.values(reg)) {
		if (c.status !== "active") continue;
		for (const n of c.notes) {
			if (want.has(n)) (out[n] ??= []).push({ tag: c.tag, label: c.label });
		}
	}
	return out;
}

/** Canonical misconceptions ranked by how often they recur, active first. */
export function topMisconceptions(reg: MisconceptionRegistry, limit = 10): CanonMisconception[] {
	return Object.values(reg)
		.sort((a, b) => {
			if (a.status !== b.status) return a.status === "active" ? -1 : 1;
			return b.count - a.count;
		})
		.slice(0, limit);
}

/** The minimum a graded entry needs for a no-LLM debrief. QuestionResult satisfies it. */
export interface GradedEntry {
	node: string;
	verdict: Verdict;
	gaveUp: boolean;
	feedback: string;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** No-key / self-grade fallback: a useful debrief built from the results alone,
 * so those users still get a payoff instead of a bare score. */
export function deterministicDebrief(entries: GradedEntry[]): SessionDebrief {
	const correct = entries.filter((e) => e.verdict === "correct");
	const missed = entries.filter((e) => e.verdict !== "correct");
	const missedNotes = uniq(missed.map((e) => e.node));
	const headline =
		missed.length === 0
			? `Clean sweep: ${correct.length} of ${entries.length}.`
			: `${correct.length} of ${entries.length} solid, ${missedNotes.length} to revisit.`;
	return {
		headline,
		strengths: uniq(correct.map((e) => e.node)),
		gaps: missed.map((e) => ({
			concept: e.node,
			note: e.node,
			why: e.gaveUp ? "Skipped." : e.feedback || "Missed.",
		})),
		pattern: "",
		nextFocus: missedNotes,
	};
}
