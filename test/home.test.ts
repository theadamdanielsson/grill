import { test } from "node:test";
import assert from "node:assert/strict";
import { missedConceptIds, spreadBacklog, type ConceptMap } from "../src/concepts";
import { matchScope } from "../src/scope";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const day = (n: number): string => new Date(NOW.getTime() + n * 86400_000).toISOString();

/** A tested concept, due `dueIn` days from now, whose last answer had this rating. */
function cm(note: string, dueIn: number, lastRating: number): any {
	return {
		note,
		label: "x",
		kind: "term",
		sourceHash: null,
		correct: lastRating >= 3 ? 1 : 0,
		partial: 0,
		incorrect: lastRating === 1 ? 1 : 0,
		streak: lastRating >= 3 ? 1 : 0,
		stability: 5,
		difficulty: 5,
		lastSeen: day(-10),
		dueAt: day(dueIn),
		reviewLog: [{ t: day(-10), elapsedDays: 0, rating: lastRating }],
	};
}
const all = (): boolean => true;

test("my misses are the concepts last answered wrong that are due again", () => {
	const map: ConceptMap = {
		missedDue: cm("A", -1, 1),
		missedLater: cm("A", 3, 1),
		rightDue: cm("B", -2, 3),
		missedElsewhere: cm("Excluded", -1, 1),
	};
	assert.deepEqual(missedConceptIds(map, (note) => note !== "Excluded", NOW), ["missedDue"]);
});

test("a concept from before review logs counts as missed by its broken streak", () => {
	const old = cm("A", -1, 1);
	delete old.reviewLog;
	assert.deepEqual(missedConceptIds({ old }, all, NOW), ["old"]);
});

test("catching up keeps the most pressing due now and moves the rest out at a steady pace", () => {
	const map: ConceptMap = {
		oldest: cm("A", -9, 3),
		older: cm("A", -6, 3),
		miss: cm("B", -1, 1),
		recent: cm("B", -2, 3),
		newest: cm("C", -0.5, 3),
		future: cm("C", 4, 3),
	};
	const before = structuredClone(map);
	const { kept, moved } = spreadBacklog(map, all, 2, 2, NOW);

	// The miss first, then whatever has waited longest.
	assert.deepEqual(kept, ["miss", "oldest"]);
	assert.equal(moved, 3);
	// What was kept, and what was never due, is as it was.
	for (const id of ["miss", "oldest", "future"]) assert.deepEqual(map[id], before[id]);
	// The rest come back two a day, in the order they had waited.
	assert.equal(map.older.dueAt, day(1));
	assert.equal(map.recent.dueAt, day(1));
	assert.equal(map.newest.dueAt, day(2));
	// Only the due date moved.
	for (const id of ["older", "recent", "newest"]) assert.deepEqual({ ...map[id], dueAt: "" }, { ...before[id], dueAt: "" });
});

test("catching up on a pile that fits moves nothing", () => {
	const map: ConceptMap = { a: cm("A", -1, 3), b: cm("A", -2, 3) };
	const before = structuredClone(map);
	assert.deepEqual(spreadBacklog(map, all, 15, 15, NOW), { kept: ["b", "a"], moved: 0 });
	assert.deepEqual(map, before);
});

const file = (path: string): any => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, "") });
const VAULT = [
	file("Macro/Chapter 1/Output.md"),
	file("Macro/Chapter 2/GDP deflator.md"),
	file("Macro/Chapter 2/Real GDP.md"),
	file("Macro/Chapter 2/Nominal GDP.md"),
	file("Loose note.md"),
];
const names = (r: { files: any[] } | null): string[] => (r ? r.files.map((f) => f.basename) : []);

test("a typed request finds the folder or the notes it names", () => {
	assert.deepEqual(names(matchScope("test me on chapter 2", VAULT)), ["GDP deflator", "Real GDP", "Nominal GDP"]);
	assert.equal(matchScope("Chapter 2", VAULT)?.name, "Chapter 2");
	assert.deepEqual(names(matchScope("gdp deflator", VAULT)), ["GDP deflator"]);
	assert.deepEqual(names(matchScope("quiz me about GDP", VAULT)), ["GDP deflator", "Real GDP", "Nominal GDP"]);
	assert.deepEqual(names(matchScope("macro", VAULT)), ["Output", "GDP deflator", "Real GDP", "Nominal GDP"]);
});

test("a typed request that names nothing in the vault matches nothing", () => {
	assert.equal(matchScope("thermodynamics", VAULT), null);
	assert.equal(matchScope("   ", VAULT), null);
	assert.equal(matchScope("test me on", VAULT), null);
});
