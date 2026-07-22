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
	/** 'resolved' is set in step 3 when a re-probe is answered correctly. */
	status: "active" | "resolved";
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
