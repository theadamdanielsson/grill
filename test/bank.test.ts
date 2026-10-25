import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheHit, priorQuestions, rememberGenerated } from "../src/bank";
import type { Concept } from "../src/generate-local";
import type { Question } from "../src/question";
import type { QuestionBank } from "../src/store";

const c = { id: "N::term:gdp", note: "N", label: "GDP", kind: "term", sourceHash: "h1", context: "" } as Concept;
const q = (question: string, over: Partial<Question> = {}): Question =>
	({ node: "N", conceptId: c.id, question, difficulty: "easy", modelAnswer: "a", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, ...over }) as Question;

test("a written question is kept, a near-restatement counts as another showing, and the least shown is served", () => {
	const bank: QuestionBank = {};
	assert.equal(rememberGenerated(bank, [q("What does GDP measure in an economy?")], () => c), true);
	rememberGenerated(bank, [q("What does GDP measure in the economy?")], () => c);
	assert.equal(bank[c.id].length, 1, "a restatement is not a new variant");
	assert.equal(bank[c.id][0].timesShown, 2);
	rememberGenerated(bank, [q("Name the three ways to compute GDP.")], () => c);
	assert.equal(cacheHit(bank, c, "easy", "mixed")?.question, "Name the three ways to compute GDP.");
	assert.equal(cacheHit(bank, c, "hard", "mixed"), null, "only at the difficulty asked for");
	assert.equal(cacheHit(bank, { ...c, sourceHash: "h2" }, "easy", "mixed"), null, "not once the note changed");
	assert.deepEqual(priorQuestions(bank, { ...c, sourceHash: "h2" }), []);
});

test("a rejected question is never folded into, served, or pushed out by newer ones", () => {
	const bank: QuestionBank = { [c.id]: [{ ...q("Bad one about GDP?"), sourceHash: "h1", timesShown: 1, rejected: true } as never] };
	for (let i = 0; i < 12; i++) rememberGenerated(bank, [q(`Question number ${i} on a different aspect ${"x".repeat(i)}`)], () => c);
	assert.ok(bank[c.id].some((e) => e.rejected), "the tombstone stays");
	assert.equal(bank[c.id].filter((e) => !e.rejected).length, 8);
	assert.notEqual(cacheHit(bank, c, "easy", "mixed")?.question, "Bad one about GDP?");
	assert.equal(rememberGenerated(bank, [q("x", { missingLink: true } as never)], () => c), false);
});
