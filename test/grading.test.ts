import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeStructured } from "../src/grading";
import type { Question } from "../src/question";

const q = (over: Partial<Question>): Question =>
	({ node: "N", question: "?", difficulty: "easy", modelAnswer: "", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, ...over }) as Question;

test("multiple choice and true/false are right only on the answer, in any case", () => {
	assert.equal(gradeStructured(q({ type: "mc", modelAnswer: "Okun's law" }), " okun's LAW ")?.verdict, "correct");
	assert.deepEqual(gradeStructured(q({ type: "tf", modelAnswer: "True" }), "False"), { verdict: "incorrect", feedback: 'Not quite. The answer is "True".' });
});

test("several to pick: all right is correct, a near miss partial, and the misses are named", () => {
	const multi = q({ type: "multi", choices: ["a", "b", "c", "d"], correctChoices: ["a", "b", "c"] });
	assert.equal(gradeStructured(multi, "", ["a", "b", "c"])?.verdict, "correct");
	assert.deepEqual(gradeStructured(multi, "", ["a", "b", "d"]), { verdict: "partial", feedback: '"d" doesn\'t belong. Missing: c.' });
	assert.equal(gradeStructured(multi, "", ["d"])?.verdict, "incorrect");
	assert.equal(gradeStructured(q({ type: "multi", correctChoices: ["a"] }), "", ["a"])?.verdict, "incorrect", "an ungradable question never passes");
});

test("pairs: each wrong pair is named; a written answer is left to the model", () => {
	const match = q({ type: "match", pairs: [{ left: "GDP", right: "output" }, { left: "CPI", right: "prices" }] });
	assert.equal(gradeStructured(match, "", undefined, { GDP: "output", CPI: "prices" })?.verdict, "correct");
	assert.deepEqual(gradeStructured(match, "", undefined, { GDP: "output" }), { verdict: "partial", feedback: '"CPI" should match "prices", not "(unmatched)".' });
	assert.equal(gradeStructured(q({ type: "write" }), "anything"), null);
	assert.equal(gradeStructured(q({}), "anything"), null);
});
