/**
 * What a suggestion on the home screen says about itself: one line of fact from the
 * record, under its name. Pure text, so what is claimed can be tested. Nothing here
 * says what matters for an exam; it says what was missed, what has waited, what is
 * untested and how a note has gone.
 */
import type { ConceptMastery } from "./concepts";
import { lastAnswerMissed } from "./concepts";
import { statusOf } from "./mastery";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Oct", from an ISO timestamp or a YYYY-MM-DD date. Empty if it isn't one. */
export function shortDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The first few of a list by name, and how many more there are. */
export function listSome(items: string[], max = 3, more = "more"): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} and ${items.length - max} ${more}`;
}

/** Where the misses are: the notes with the most, each with its count. */
export function missesLine(perNote: Array<[note: string, count: number]>): string {
	const sorted = [...perNote].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return listSome(sorted.map(([n, c]) => `${n} (${c})`), 2, sorted.length - 2 === 1 ? "more note" : "more notes");
}

/** How a note has gone: how many of its tested concepts are known, whether any was
 * missed last time, and when it was last tested. */
export function noteLine(concepts: ConceptMastery[]): string {
	const tested = concepts.filter((c) => c.correct + c.partial + c.incorrect > 0);
	if (!tested.length) return "Not tested yet";
	const known = tested.filter((c) => statusOf(c) === "known").length;
	const missed = tested.filter((c) => lastAnswerMissed(c)).length;
	const last = tested.map((c) => c.lastSeen ?? "").sort().pop();
	const parts = [`${known} of ${tested.length} concept${tested.length === 1 ? "" : "s"} known`];
	if (missed) parts.push(`${missed} missed last time`);
	const when = shortDate(last);
	return parts.join(", ") + (when ? `. Last tested ${when}` : "");
}
