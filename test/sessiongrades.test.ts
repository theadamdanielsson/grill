import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionGrades } from "../src/sessiongrades";

/** The grade bookkeeping on its own, without a view: what can be taken back and when.
 * The end-to-end cases (a taken-back answer leaves the record exactly as it was, Mark
 * correct ends where a correct answer would have) are in record.test.ts. */
const ID = "N::a";

function setup() {
	const state = {
		concepts: {
			[ID]: { note: "N", label: "a", kind: "term", sourceHash: null, correct: 1, partial: 0, incorrect: 0, streak: 1, stability: 3, difficulty: 5, lastSeen: "2026-10-01T10:00:00.000Z", dueAt: "2026-10-04T10:00:00.000Z" },
		} as Record<string, any>,
		mastery: {} as Record<string, any>,
		registry: {} as Record<string, any>,
		calibration: [] as { c: number; ok: number }[],
		recomputed: [] as string[],
		persisted: 0,
	};
	const grades = new SessionGrades({
		concepts: () => state.concepts,
		mastery: () => state.mastery,
		registry: () => state.registry,
		calibration: () => state.calibration,
		persist: () => void state.persisted++,
		examLeft: () => null,
		recall: () => 0.9,
		histogram: () => new Map(),
		easyDays: () => new Set(),
		recompute: (note) => void state.recomputed.push(note),
	});
	const q = { node: "N", question: "Q?", difficulty: "medium", modelAnswer: "A", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, conceptId: ID } as any;
	return { state, grades, q };
}

test("an AI grade can be taken back once, and only once", () => {
	const { state, grades, q } = setup();
	const before = structuredClone(state.concepts[ID]);
	grades.grade(q, "incorrect", null, "mixes-up-x", 0, undefined, null);
	assert.equal(state.mastery.N.incorrect, 1);
	assert.notEqual(grades.last, null);

	assert.equal(grades.undo()?.originalVerdict, "incorrect");
	assert.deepEqual(state.concepts[ID], before);
	assert.equal(state.mastery.N.incorrect, 0);
	assert.deepEqual(state.mastery.N.misconceptions, {});
	assert.equal(grades.undo(), null);
	assert.deepEqual(state.recomputed, ["N", "N"]);
});

test("a self-grade leaves nothing to take back", () => {
	const { grades, q } = setup();
	grades.grade(q, "correct", 3, undefined, 0, undefined, null);
	assert.equal(grades.last, null);
	assert.equal(grades.markCorrect(), false);
	assert.equal(grades.undo(), null);
});

test("Mark correct does nothing to an answer already graded correct", () => {
	const { state, grades, q } = setup();
	grades.grade(q, "correct", null, undefined, 0, undefined, null);
	const after = structuredClone(state.concepts[ID]);
	assert.equal(grades.markCorrect(), false);
	assert.deepEqual(state.concepts[ID], after);
	assert.equal(state.mastery.N.correct, 1);
});

test("a partial marked correct moves the note's count to correct", () => {
	const { state, grades, q } = setup();
	grades.grade(q, "partial", null, "tag", 0, undefined, null);
	assert.equal(grades.markCorrect(), true);
	assert.deepEqual([state.mastery.N.correct, state.mastery.N.partial], [1, 0]);
	assert.deepEqual(state.mastery.N.misconceptions, {});
	assert.equal(grades.last, null);
});

test("taking back an answer that added a confidence point removes it and saves", () => {
	const { state, grades, q } = setup();
	state.calibration.push({ c: 1, ok: 1 });
	grades.grade(q, "correct", null, undefined, 0, undefined, 1);
	grades.last!.calibrated = true;
	grades.undo();
	assert.deepEqual(state.calibration, []);
	assert.equal(state.persisted, 1);
});
