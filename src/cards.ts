/** Flashcards: a quick review of the questions Grill has already written, with no model
 * call. You see the question, show the answer, and rate how well you recalled it. The
 * rating goes into the same concept schedule a graded answer does. Pure: the view draws
 * the cards and records the ratings. */

import { conceptTested, type ConceptMap } from "./concepts";
import type { Rating, Verdict } from "./mastery";
import type { Question } from "./question";
import type { CachedQuestion, QuestionBank } from "./store";

/** Formats a card can't show as plain text on both sides. */
const NOT_A_CARD = new Set(["occlusion", "draw"]);

export interface Card {
	conceptId: string;
	question: Question;
}

/** The banked question to show for one concept, or null when it has none that fits a
 * card. Only questions written for the concept's current note text, never one marked
 * bad, least shown first so a concept with several questions rotates through them. */
export function cardFor(bank: QuestionBank, conceptId: string, sourceHash: string | null): CachedQuestion | null {
	const kept = (bank[conceptId] ?? []).filter(
		(e) => !e.rejected && !NOT_A_CARD.has(e.type ?? "write") && (sourceHash === null || e.sourceHash === sourceHash) && !!e.question,
	);
	if (!kept.length) return null;
	kept.sort((a, b) => a.timesShown - b.timesShown || (a.lastShownAt ?? "").localeCompare(b.lastShownAt ?? ""));
	return kept[0];
}

/** The cards due now: tested concepts whose review date has passed and that have a
 * question to show, longest overdue first, at most `limit`. `waiting` counts the due
 * concepts left out because no question has been written for them yet; a test writes
 * one. */
export function dueCards(
	concepts: ConceptMap,
	bank: QuestionBank,
	isEligible: (note: string) => boolean,
	limit: number,
	now = new Date(),
): { cards: Card[]; waiting: number } {
	const due = Object.entries(concepts)
		.filter(([, cm]) => conceptTested(cm) && !!cm.dueAt && new Date(cm.dueAt) <= now && isEligible(cm.note))
		.sort(([, a], [, b]) => (a.dueAt as string).localeCompare(b.dueAt as string));
	const cards: Card[] = [];
	let waiting = 0;
	for (const [id, cm] of due) {
		const e = cardFor(bank, id, cm.sourceHash);
		if (!e) {
			waiting++;
			continue;
		}
		if (cards.length >= limit) continue;
		const { sourceHash: _h, timesShown: _t, lastShownAt: _l, rejected: _r, ...q } = e;
		cards.push({ conceptId: id, question: { ...q, conceptId: id, node: cm.note } });
	}
	return { cards, waiting };
}

/** What the back of the card says: the answer in the form the question asked for. */
export function cardAnswer(q: Question): string {
	if ((q.type === "mc" || q.type === "multi") && q.correctChoices?.length) return q.correctChoices.join("\n");
	if (q.type === "match" && q.pairs?.length) return q.pairs.map((p) => `${p.left}: ${p.right}`).join("\n");
	return q.modelAnswer;
}

/** The front of the card. A choice question shows its options, since the question
 * text alone often reads "Which of these…". */
export function cardFront(q: Question): string {
	if ((q.type === "mc" || q.type === "multi") && q.choices?.length) return `${q.question}\n\n${q.choices.map((c) => `- ${c}`).join("\n")}`;
	if (q.type === "match" && q.pairs?.length) return `${q.question}\n\n${q.pairs.map((p) => `- ${p.left}`).join("\n")}`;
	return q.question;
}

/** How a rating counts in the note's right/partly/wrong tally. Hard is a pass that
 * took effort, so it counts as partly right; the schedule uses the rating itself. */
export function verdictForRating(r: Rating): Verdict {
	return r === 1 ? "incorrect" : r === 2 ? "partial" : "correct";
}
