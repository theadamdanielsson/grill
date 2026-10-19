import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResults, parseResult, AgentResult, RecordState, weakSpots } from "../src/record";

/** Answers graded by other agents join the record through applyResults. These pin
 * what they may and may not change. */

const day = 86400_000;

function state(): RecordState {
	const lastSeen = new Date(Date.now() - 10 * day).toISOString();
	return {
		concepts: {
			"GDP::term:recession": {
				note: "GDP", label: "recession", kind: "term", sourceHash: "h",
				correct: 2, partial: 0, incorrect: 0, streak: 2, stability: 8, difficulty: 4,
				lastSeen, dueAt: new Date(Date.now() - day).toISOString(),
				reviewLog: [{ t: lastSeen, elapsedDays: 4, rating: 3 }],
			},
		},
		mastery: { GDP: { correct: 2, partial: 0, incorrect: 0, streak: 2, stability: null, difficulty: null, lastSeen: null, dueAt: null, misconceptions: {} } },
		registry: {},
	};
}

function result(o: Partial<AgentResult>): AgentResult {
	return {
		v: 1, id: Math.random().toString(36).slice(2), at: new Date().toISOString(), via: "Claude Code", session: "s1",
		note: "GDP", question: "Define a recession.", answer: "One bad quarter", verdict: "incorrect", ...o,
	};
}

test("a graded answer moves its concept's schedule like one given in Grill", () => {
	const s = state();
	const before = s.concepts["GDP::term:recession"].dueAt;
	const { applied } = applyResults(s, [result({ conceptId: "GDP::term:recession" })], { allowNew: false });
	const c = s.concepts["GDP::term:recession"];
	assert.equal(applied.length, 1);
	assert.equal(c.incorrect, 1);
	assert.equal(c.streak, 0);
	assert.equal(c.reviewLog!.length, 2);
	assert.equal(c.reviewLog![1].rating, 1);
	assert.notEqual(c.dueAt, before);
	assert.equal(s.mastery.GDP.incorrect, 1);
	assert.equal(weakSpots(s, "GDP", 5).concepts[0].lastAnswerMissed, true);
});

test("in a vault an unknown concept id is not invented, but the answer still counts for its note", () => {
	const s = state();
	const { applied, unknownConcept } = applyResults(s, [result({ conceptId: "GDP::term:made-up", verdict: "correct" })], { allowNew: false });
	assert.equal(Object.keys(s.concepts).length, 1);
	assert.equal(applied.length, 1);
	assert.equal(unknownConcept.length, 1);
	assert.equal(s.mastery.GDP.correct, 3);
});

test("outside a vault a new concept starts its own record", () => {
	const s: RecordState = { concepts: {}, mastery: {}, registry: {} };
	applyResults(s, [result({ note: "src/auth.ts", label: "token refresh", verdict: "correct" })], { allowNew: true });
	const ids = Object.keys(s.concepts);
	assert.deepEqual(ids, ["src/auth.ts::agent:token-refresh"]);
	assert.equal(s.concepts[ids[0]].correct, 1);
	assert.ok(s.concepts[ids[0]].dueAt);
	assert.equal(s.mastery["src/auth.ts"].aggStatus, "struggling", "one answer is not yet known");
});

test("a misconception joins the registry and reopens a resolved one", () => {
	const s = state();
	s.registry.one_quarter_recession = {
		tag: "one_quarter_recession", label: "Thinks one quarter is enough", aliases: [], notes: ["GDP"], count: 2,
		firstSeen: new Date(0).toISOString(), lastSeen: new Date(0).toISOString(), status: "resolved",
	};
	applyResults(s, [result({ conceptId: "GDP::term:recession", misconception: { tag: "one_quarter_recession", label: "" } })], { allowNew: false });
	assert.equal(s.registry.one_quarter_recession.status, "active");
	assert.equal(s.registry.one_quarter_recession.count, 3);
	assert.equal(s.mastery.GDP.misconceptions.one_quarter_recession, 1);
});

test("answers are applied oldest first, whatever order the files came in", () => {
	const s = state();
	const t = Date.now();
	applyResults(
		s,
		[
			result({ conceptId: "GDP::term:recession", verdict: "correct", at: new Date(t).toISOString() }),
			result({ conceptId: "GDP::term:recession", verdict: "incorrect", at: new Date(t - 60_000).toISOString() }),
		],
		{ allowNew: false },
	);
	const log = s.concepts["GDP::term:recession"].reviewLog!;
	assert.deepEqual(log.slice(1).map((e) => e.rating > 1), [false, true]);
});

test("files that are not results are refused", () => {
	assert.equal(parseResult(null), null);
	assert.equal(parseResult({ v: 2, id: "x", at: new Date().toISOString(), note: "n", question: "q", verdict: "correct" }), null);
	assert.equal(parseResult({ v: 1, id: "x", at: "not a date", note: "n", question: "q", verdict: "correct" }), null);
	assert.equal(parseResult({ v: 1, id: "x", at: new Date().toISOString(), note: "n", question: "q", verdict: "great" }), null);
	const ok = parseResult({ v: 1, id: "x", at: new Date().toISOString(), note: "n", question: "q", verdict: "partial", difficulty: "brutal", misconception: { tag: "Mixes A & B", label: 3 } });
	assert.ok(ok);
	assert.equal(ok.difficulty, undefined);
	assert.deepEqual(ok.misconception, { tag: "mixes_a_b", label: "" });
	assert.equal(ok.answer, "");
});

import { runRecordQuery, RECORD_RULES } from "../src/recordtools";
import { VAULT_TOOLS, TOOL_RULES, toolLine } from "../src/vaulttools";

test("Chat's record tools read the record and never offer testing", async () => {
	const s = state();
	const port = { state: async () => s };
	const w = (await runRecordQuery(port, "grill_weak_spots", { topic: "GDP" })).content;
	assert.match(w, /^No weak spots on GDP\./, "a concept recalled well is not a weak spot");
	const k = (await runRecordQuery(port, "grill_what_they_know", { topic: "recession" })).content;
	assert.match(k, /^Notes:\n- GDP: /);
	assert.match(k, /Concepts:\n- recession \[GDP\]: /, "one line per concept, in words: no ids, no JSON");
	assert.equal((await runRecordQuery(port, "grill_what_they_know", {})).failed, true);
	assert.equal((await runRecordQuery(undefined, "grill_overview", {})).failed, true);
	const names = VAULT_TOOLS.map((t) => t.name);
	assert.ok(names.includes("grill_weak_spots"));
	assert.ok(!names.includes("grill_questions") && !names.includes("grill_record_answer"));
	assert.ok(TOOL_RULES.includes(RECORD_RULES));
	assert.match(RECORD_RULES, /grill_offer_study/);
	assert.equal(toolLine({ id: "1", name: "grill_weak_spots", input: { topic: "inflation" } }), "Read your weak spots on inflation");
});

import { restoreNoteCounts } from "../src/record";

test("note counts lost to the old map are rebuilt from the concepts, once and never downward", () => {
	const s = state();
	s.mastery.GDP = { ...s.mastery.GDP, correct: 0, partial: 0, incorrect: 0 };
	s.registry.only_here = { tag: "only_here", label: "x", aliases: [], notes: ["GDP"], count: 2, firstSeen: "", lastSeen: "", status: "active" };
	s.registry.shared = { tag: "shared", label: "y", aliases: [], notes: ["GDP", "Inflation"], count: 5, firstSeen: "", lastSeen: "", status: "active" };
	assert.equal(restoreNoteCounts(s), 1);
	assert.equal(s.mastery.GDP.correct, 2);
	assert.deepEqual(s.mastery.GDP.misconceptions, { only_here: 2 }, "a misconception shared between notes can't be split, so it is left out");
	assert.equal(restoreNoteCounts(s), 0, "nothing more to do the second time");
	s.mastery.GDP.correct = 7;
	assert.equal(restoreNoteCounts(s), 0, "counts above the concepts' are kept");
	assert.equal(s.mastery.GDP.correct, 7);
});

test("a study offer reaches the pane as a button, or comes back with why it can't", async () => {
	const offered: unknown[] = [];
	const port = { state: async () => state(), offer: (o: unknown) => (offered.push(o), "A button is under your reply.") };
	assert.equal((await runRecordQuery(port, "grill_offer_study", { kind: "notes", notes: ["GDP", 3, ""] })).failed, undefined);
	assert.deepEqual(offered[0], { kind: "notes", notes: ["GDP"] });
	assert.equal((await runRecordQuery(port, "grill_offer_study", { kind: "notes" })).failed, true);
	await runRecordQuery(port, "grill_offer_study", { kind: "misses" });
	assert.deepEqual(offered[1], { kind: "misses" });
	assert.equal((await runRecordQuery({ state: port.state }, "grill_offer_study", { kind: "due" })).failed, true);
});

test("names that would reach Object.prototype or break a session note are refused", () => {
	const base = { v: 1, id: "x", at: new Date().toISOString(), question: "q", verdict: "correct" };
	for (const note of ["__proto__", "constructor", "x\n```dataviewjs", "y".repeat(201)]) assert.equal(parseResult({ ...base, note }), null, note);
	for (const note of ["C# basics", "a|b", "Notes [draft]"]) assert.ok(parseResult({ ...base, note }), `a real note name: ${note}`);
	assert.equal(parseResult({ ...base, note: "GDP", id: "../../z" }), null, "an id is never a path");
	assert.equal(parseResult({ ...base, note: "GDP", conceptId: "__proto__" }), null);
	assert.equal(parseResult({ ...base, note: "GDP", via: "Claude\nprovider: evil" })?.via, "Claudeprovider evil");
	assert.equal(parseResult({ ...base, note: "GDP", misconception: { tag: "constructor", label: "" } })?.misconception, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "correct"), false);
});

test("an answer is never applied twice, counts for its concept's note, and one bad answer stops no other", () => {
	const s = state();
	const good = result({ id: "a1", conceptId: "GDP::term:recession", note: "Somewhere else", verdict: "correct" });
	const first = applyResults(s, [good, { ...good }], { allowNew: false });
	assert.equal(first.applied.length, 1, "the same id twice in one fold");
	assert.equal(first.applied[0].note, "GDP");
	assert.equal(s.mastery["Somewhere else"], undefined);
	const again = applyResults(s, [good], { allowNew: false, seen: new Set(["a1"]) });
	assert.equal(again.applied.length, 0, "already folded on another device or an earlier try");
	assert.equal(s.concepts["GDP::term:recession"].correct, 3);
});

test("a short topic is matched as written, not as everything", () => {
	const s = state();
	s.concepts["AI basics::term:ai"] = { ...s.concepts["GDP::term:recession"], note: "AI basics", label: "AI", reviewLog: [{ t: new Date().toISOString(), elapsedDays: 1, rating: 1 }], incorrect: 1, streak: 0 };
	s.concepts["GDP::term:recession"].reviewLog!.push({ t: new Date().toISOString(), elapsedDays: 1, rating: 1 });
	assert.deepEqual(weakSpots(s, "AI", 10).concepts.map((c) => c.note), ["AI basics"]);
});

import { projectSummaries } from "../src/record";

test("the agents' record is summed up by project, weakest first, newest project first", () => {
	const s: RecordState = { concepts: {}, mastery: {}, registry: {} };
	const t = Date.now();
	applyResults(s, [
		result({ id: "1", note: "cors/lib/index.js", label: "preflight", verdict: "incorrect", at: new Date(t - 5000).toISOString() }),
		result({ id: "2", note: "cors/lib/index.js", label: "vary header", verdict: "correct", at: new Date(t - 4000).toISOString() }),
		result({ id: "3", note: "toolrails/proxy.py", label: "grammar repair", verdict: "partial", at: new Date(t).toISOString() }),
	], { allowNew: true });
	const p = projectSummaries(s.concepts);
	assert.deepEqual(p.map((x) => x.project), ["toolrails", "cors"]);
	const cors = p.find((x) => x.project === "cors")!;
	assert.equal(cors.tested, 2);
	assert.equal(cors.missedLast, 1);
	assert.deepEqual(cors.weakest.map((c) => c.label), ["preflight"]);
	assert.deepEqual(p[0].weakest.map((c) => c.lastAnswer), ["partial"]);
});
