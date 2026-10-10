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

import { learnContext, sessionTitle, stripFrontmatter } from "../src/learn";

test("Learn reads the note without its frontmatter, and a share of each linked note", () => {
	const main = { name: "CPI", text: "---\ntags: [macro]\n---\nThe CPI measures the average price of consumption." };
	const linked = [
		{ name: "GDP deflator", text: "The deflator measures the average price of output." },
		{ name: "Empty", text: "---\nx: 1\n---\n" },
		{ name: "CPI", text: "itself" },
	];
	const ctx = learnContext(main, linked);
	assert.equal(ctx.noteText, "The CPI measures the average price of consumption.");
	assert.equal(ctx.linkedText, "'GDP deflator':\nThe deflator measures the average price of output.");
});

test("Learn keeps what it sends within its budget", () => {
	const long = "x".repeat(50_000);
	const linked = Array.from({ length: 9 }, (_, i) => ({ name: `L${i}`, text: long }));
	const ctx = learnContext({ name: "N", text: long }, linked, { note: 100, linked: 10, maxLinked: 3 });
	assert.equal(ctx.noteText.length, 100);
	assert.equal(ctx.linkedText.split("\n\n").length, 3);
	assert.ok(ctx.linkedText.length < 100);
});

test("frontmatter is only stripped from the top of a note", () => {
	assert.equal(stripFrontmatter("text\n---\nnot: frontmatter\n---\nmore"), "text\n---\nnot: frontmatter\n---\nmore");
});

test("a session is titled by the notes it covered", () => {
	assert.equal(sessionTitle(["GDP deflator", "GDP deflator", "Redo"]), "GDP deflator");
	assert.equal(sessionTitle(["Output", "Real GDP", "Output", "Nominal GDP", "Redo"]), "Output +2");
	assert.equal(sessionTitle(["Redo"]), "");
});

import { learnRecord, parseLearnNote, parseSessionNote } from "../src/learn";

const SESSION_NOTE = `---
date: 2026-10-07
score: 1/3
type: study session
---
# Grill session 2026-10-07 10.41
> [!summary] Debrief
> 1 of 3 solid.

## [[Updated IS-relation]]

When the interest rate increases, what happens next?

> [!quote] Your answer
> Output decreases, which lowers
> investment and consumption.

**Correct.** Correct.

## Updated IS-relation

Describe how this leads to a larger fall in output.

**Skipped.** No penalty for honesty.

**Expected answer:** The multiplier effect.

## GDP deflator

What is the deflator in 2010?

> [!quote] Your answer
> 2.0

**Incorrect.** Not quite.

**Expected answer:** 1.044

> [!question] You asked
> why?

## Redo

\`\`\`grill-redo
{"v":1,"questions":[{"node":"## Not a heading"}]}
\`\`\`
`;

test("a session note reads back as the questions, answers and verdicts it was written from", () => {
	const got = parseSessionNote(SESSION_NOTE);
	assert.deepEqual(got, [
		{ note: "Updated IS-relation", question: "When the interest rate increases, what happens next?", answer: "Output decreases, which lowers\ninvestment and consumption.", result: "correct", feedback: "Correct.", expected: "" },
		{ note: "Updated IS-relation", question: "Describe how this leads to a larger fall in output.", answer: "", result: "skipped", feedback: "No penalty for honesty.", expected: "The multiplier effect." },
		{ note: "GDP deflator", question: "What is the deflator in 2010?", answer: "2.0", result: "incorrect", feedback: "Not quite.", expected: "1.044", asked: ["why?"] },
	]);
});

test("the record for a note says how it has gone and what was answered", () => {
	const text = learnRecord({
		concepts: [
			{ label: "multiplier", correct: 1, partial: 0, incorrect: 2, lastMissed: true },
			{ label: "never asked", correct: 0, partial: 0, incorrect: 0, lastMissed: false },
		],
		misconceptions: [
			{ label: "Confuses levels with growth rates", count: 2, status: "active" },
			{ label: "A grading misfire", count: 1, status: "dismissed" },
		],
		answers: parseSessionNote(SESSION_NOTE).filter((a) => a.note === "Updated IS-relation").map((a) => ({ ...a, when: "2026-10-07" })),
	});
	assert.match(text, /1 right, 0 partly right, 2 wrong or skipped/);
	assert.match(text, /- multiplier: 1 \/ 0 \/ 2, last answer missed/);
	assert.doesNotMatch(text, /never asked/);
	assert.match(text, /Confuses levels with growth rates \(seen 2 times, still open\)/);
	assert.doesNotMatch(text, /misfire/);
	assert.match(text, /2\. \[2026-10-07\] Asked: Describe how this leads/);
	assert.match(text, /Gave no answer \(skipped it or asked for help\)\n   Marked: skipped\. Expected: The multiplier effect\./);
});

test("a note that was never tested has no record", () => {
	assert.equal(learnRecord({ concepts: [{ label: "x", correct: 0, partial: 0, incorrect: 0, lastMissed: false }], misconceptions: [], answers: [] }), "");
});

test("the record carries why an answer was marked down, and what was asked before", () => {
	const text = learnRecord({
		concepts: [],
		misconceptions: [],
		answers: parseSessionNote(SESSION_NOTE).filter((a) => a.note === "GDP deflator"),
		asked: ["why is it an index?", "why?"],
	});
	assert.match(text, /Answered: 2\.0\n   Marked: incorrect\. Expected: 1\.044\n   Feedback given: Not quite\./);
	assert.match(text, /What they have asked about this note before, newest first:\n- why is it an index\?\n- why\?/);
});

test("a saved Learn conversation reads back as the questions that were asked", () => {
	const note = "---\ntype: learn\nnote: \"CPI\"\n---\n# Learn: [[CPI]]\n\n> [!question] You asked\n> what is\n> inflation?\n\n> [!note] Grill\n> A rise in prices.\n\n> [!question] You asked\n> and deflation?\n";
	assert.deepEqual(parseLearnNote(note), ["what is inflation?", "and deflation?"]);
});
