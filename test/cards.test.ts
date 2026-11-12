import { test } from "node:test";
import assert from "node:assert/strict";
import { cardAnswer, cardFor, cardFront, dueCards, verdictForRating } from "../src/cards";
import type { ConceptMap, ConceptMastery } from "../src/concepts";
import type { Question } from "../src/question";
import type { CachedQuestion, QuestionBank } from "../src/store";

const now = new Date("2026-11-12T12:00:00Z");
const cm = (note: string, dueAt: string | null, over: Partial<ConceptMastery> = {}): ConceptMastery =>
	({ note, label: "x", kind: "term", sourceHash: "h1", correct: 1, partial: 0, incorrect: 0, streak: 1, stability: 2, difficulty: 5, lastSeen: null, dueAt, ...over }) as ConceptMastery;
const banked = (question: string, over: Partial<CachedQuestion> = {}): CachedQuestion =>
	({ node: "N", question, difficulty: "easy", modelAnswer: "the answer", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, sourceHash: "h1", timesShown: 0, ...over }) as CachedQuestion;

test("only due, tested concepts with a usable question become cards, longest overdue first", () => {
	const concepts: ConceptMap = {
		a: cm("A", "2026-11-10T00:00:00Z"),
		b: cm("B", "2026-11-01T00:00:00Z"),
		later: cm("A", "2026-11-20T00:00:00Z"),
		untested: cm("A", "2026-11-01T00:00:00Z", { correct: 0 }),
		noq: cm("A", "2026-11-05T00:00:00Z"),
		elsewhere: cm("Excluded", "2026-11-05T00:00:00Z"),
	};
	const bank: QuestionBank = {
		a: [banked("Qa")],
		b: [banked("Qb")],
		later: [banked("Qlater")],
		untested: [banked("Qu")],
		elsewhere: [banked("Qe")],
	};
	const { cards, waiting } = dueCards(concepts, bank, (n) => n !== "Excluded", 10, now);
	assert.deepEqual(cards.map((c) => c.question.question), ["Qb", "Qa"]);
	assert.equal(waiting, 1, "the due concept with no question yet is counted, not shown");
	assert.equal(cards[0].question.conceptId, "b");
	assert.equal(cards[0].question.node, "B");
	assert.equal("sourceHash" in cards[0].question, false, "bank bookkeeping stays out of the question");
});

test("the limit caps cards but not the waiting count", () => {
	const concepts: ConceptMap = { a: cm("A", "2026-11-01T00:00:00Z"), b: cm("B", "2026-11-02T00:00:00Z"), c: cm("C", "2026-11-03T00:00:00Z") };
	const bank: QuestionBank = { a: [banked("Qa")], b: [banked("Qb")] };
	const { cards, waiting } = dueCards(concepts, bank, () => true, 1, now);
	assert.deepEqual(cards.map((c) => c.question.question), ["Qa"]);
	assert.equal(waiting, 1);
});

test("a card is never a rejected, stale, image or drawing question, and rotates by times shown", () => {
	const bank: QuestionBank = {
		x: [
			banked("bad", { rejected: true }),
			banked("old text", { sourceHash: "h0" }),
			banked("picture", { type: "occlusion" }),
			banked("sketch", { type: "draw" }),
			banked("shown twice", { timesShown: 2 }),
			banked("shown once", { timesShown: 1 }),
		],
	};
	assert.equal(cardFor(bank, "x", "h1")?.question, "shown once");
	assert.equal(cardFor({ x: [banked("bad", { rejected: true })] }, "x", "h1"), null);
});

test("both sides show a choice or matching question in its own form", () => {
	const mc = { question: "Which is a stock?", type: "mc", choices: ["GDP", "Capital"], correctChoices: ["Capital"], modelAnswer: "Capital is a stock" } as Question;
	assert.equal(cardFront(mc), "Which is a stock?\n\n- GDP\n- Capital");
	assert.equal(cardAnswer(mc), "Capital");
	const match = { question: "Match them", type: "match", pairs: [{ left: "M1", right: "narrow" }], modelAnswer: "" } as Question;
	assert.equal(cardFront(match), "Match them\n\n- M1");
	assert.equal(cardAnswer(match), "M1: narrow");
	const write = { question: "Define GDP", modelAnswer: "Value of final output" } as Question;
	assert.equal(cardFront(write), "Define GDP");
	assert.equal(cardAnswer(write), "Value of final output");
});

test("ratings map to the note tally", () => {
	assert.deepEqual([1, 2, 3, 4].map((r) => verdictForRating(r as 1 | 2 | 3 | 4)), ["incorrect", "partial", "correct", "correct"]);
});
