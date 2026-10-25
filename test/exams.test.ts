import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLeft, examCapDays, examFor, examLines, examName, examNewPerDay, examNewQuota, fitDueToExam, folderState, pullInForExams, tickFolder, type Exam } from "../src/exams";
import { pickConcepts, type ConceptMap } from "../src/concepts";
import { learnerBrief } from "../src/brief";
import { concept } from "./fixtures";

const now = new Date(2026, 9, 25, 10, 0); // 25 Oct 2026, 10:00 local
const exam = (folder: string, date: string): Exam => ({ folders: [folder], date });
const tested = (note: string, dueAt: string | null) => concept({ note, kind: "note", correct: 1, streak: 1, stability: 5, difficulty: 5, lastSeen: now.toISOString(), dueAt }) as any;
const untested = (note: string) => ({ ...tested(note, null), correct: 0, streak: 0, stability: null, difficulty: null, lastSeen: null }) as any;
const day = (d: number) => new Date(2026, 9, 25 + d, 10, 0).toISOString();

test("days left count whole days, the exam day is 0 and after it is negative", () => {
	assert.equal(daysLeft(exam("Macro", "2026-11-04"), now), 10);
	assert.equal(daysLeft(exam("Macro", "2026-10-25"), now), 0);
	assert.equal(daysLeft(exam("Macro", "2026-10-24"), now), -1);
	assert.equal(daysLeft(exam("Macro", "not a date"), now), -1);
});

test("a note falls under the deepest exam folder still ahead", () => {
	const exams = [exam("Macro", "2026-12-01"), exam("Macro/Part 2", "2026-11-10"), exam("Old", "2026-01-01")];
	assert.equal(examFor("Macro/Part 2/IS-LM.md", exams, now)?.date, "2026-11-10");
	assert.equal(examFor("Macro/GDP.md", exams, now)?.date, "2026-12-01");
	assert.equal(examFor("Macroeconomics/GDP.md", exams, now), null);
	assert.equal(examFor("Old/a.md", exams, now), null);
});

test("a review waits at most half the time left, and the cap stops the day before", () => {
	assert.equal(examCapDays(20), 10);
	assert.equal(examCapDays(2), 1);
	assert.equal(examCapDays(1), null);
	const cm = { dueAt: day(30) };
	fitDueToExam(cm, 10, now);
	assert.equal(cm.dueAt, new Date(now.getTime() + 5 * 86400_000).toISOString());
	const miss = { dueAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
	fitDueToExam(miss, 10, now);
	assert.equal(miss.dueAt, new Date(now.getTime() + 10 * 60_000).toISOString());
});

test("concepts due after the exam are brought in, spread over the second half of the time left", () => {
	const map: ConceptMap = {};
	for (let i = 0; i < 40; i++) map[`M::c${i}`] = tested("M", day(60));
	map["M::soon"] = tested("M", day(2));
	map["Other::c"] = tested("Other", day(60));
	const moved = pullInForExams(map, (n) => (n === "M" ? 10 : null), now);
	assert.equal(moved, 40);
	const eve = new Date(2026, 9, 25 + 9).getTime();
	const days = new Set<number>();
	for (let i = 0; i < 40; i++) {
		const t = new Date(map[`M::c${i}`].dueAt!).getTime();
		assert.ok(t <= eve && t >= eve - 5 * 86400_000);
		days.add(t);
	}
	assert.ok(days.size > 1, "not all on one day");
	assert.equal(map["M::soon"].dueAt, day(2));
	assert.equal(map["Other::c"].dueAt, day(60));
	// Running it again moves nothing.
	assert.equal(pullInForExams(map, (n) => (n === "M" ? 10 : null), now), 0);
});

test("new material is paced to be covered a day before the exam", () => {
	assert.equal(examNewPerDay(30, 11), 3);
	assert.equal(examNewPerDay(5, 1), 5);
	assert.equal(examNewPerDay(0, 10), 0);
});

test("an exam's new concepts come in ahead of others and past the daily cap", () => {
	const concepts = [
		...Array.from({ length: 6 }, (_, i) => ({ id: `Other::n${i}`, note: "Other", label: "", context: "", kind: "note" })),
		...Array.from({ length: 6 }, (_, i) => ({ id: `M::n${i}`, note: "M", label: "", context: "", kind: "note" })),
	] as any[];
	const map: ConceptMap = Object.fromEntries(concepts.map((c) => [c.id, untested(c.note)]));
	const quota = examNewQuota(concepts, map, (n) => (n === "M" ? 3 : null));
	assert.equal(quota.perDay, 3);
	const picked = pickConcepts(concepts, map, 10, false, now, 2, { share: 1, alwaysGuarantee: true }, true, quota);
	const exam = picked.filter((c) => c.note === "M").length;
	const other = picked.filter((c) => c.note === "Other").length;
	assert.equal(exam, 3);
	assert.equal(other, 2);
	// Without an exam, only the daily cap.
	assert.equal(pickConcepts(concepts, map, 10, false, now, 2, { share: 1, alwaysGuarantee: true }, true).length, 2);
});

const ALL = ["Attachments", "Macro", "Macro/Chapter 1", "Macro/Chapter 2", "Macro/Chapter 18"];

test("ticking a folder takes in what is inside it; unticking one inside leaves it out", () => {
	let sel = tickFolder([], "Macro", true, ALL);
	assert.deepEqual(sel, ["Macro"]);
	sel = tickFolder(sel, "Macro/Chapter 18", false, ALL);
	assert.deepEqual(sel, ["Macro/Chapter 1", "Macro/Chapter 2"]);
	assert.equal(folderState(sel, "Macro", ALL), "partial");
	assert.equal(folderState(sel, "Macro/Chapter 1", ALL), "on");
	assert.equal(folderState(sel, "Macro/Chapter 18", ALL), "off");
	assert.equal(folderState(sel, "", ALL), "partial");
	assert.equal(examName({ folders: sel, date: "2026-12-01" }), "Chapter 1, Chapter 2");
	// Several folders, side by side.
	sel = tickFolder(sel, "Attachments", true, ALL);
	assert.deepEqual(sel, ["Attachments", "Macro/Chapter 1", "Macro/Chapter 2"]);
});

test("the whole vault ticks everything, and unticking a folder keeps the rest", () => {
	let sel = tickFolder([], "", true, ALL);
	assert.deepEqual(sel, [""]);
	assert.equal(examName({ folders: sel, date: "2026-12-01" }), "Whole vault");
	sel = tickFolder(sel, "Attachments", false, ALL);
	assert.deepEqual(sel, ["Macro"]);
	const e: Exam = { folders: sel, date: "2026-12-01" };
	assert.equal(examFor("Macro/Chapter 1/GDP.md", [e], now), e);
	assert.equal(examFor("Attachments/a.md", [e], now), null);
});

test("where exams overlap, the narrower one wins", () => {
	const whole: Exam = { folders: [""], date: "2026-12-01" };
	const part: Exam = { folders: ["Macro/Chapter 1"], date: "2026-11-10" };
	assert.equal(examFor("Macro/Chapter 1/GDP.md", [whole, part], now), part);
	assert.equal(examFor("Macro/Chapter 2/x.md", [whole, part], now), whole);
});

test("exams still ahead read as one line each, soonest first", () => {
	const lines = examLines([{ folders: [""], date: "2026-11-11" }, { folders: ["Macro/Chapter 1"], date: "2026-10-26" }, { folders: ["Old"], date: "2026-01-01" }], now);
	assert.deepEqual(lines, ["Chapter 1: 2026-10-26, tomorrow", "Whole vault: 2026-11-11, in 17 days"]);
});

test("the digest every chat and agent reads names the exams", () => {
	const text = learnerBrief({ state: { concepts: {}, mastery: {}, registry: {} } as any, exams: ["Whole vault: 2026-11-11, in 17 days"], now });
	assert.match(text, /Exams the student has coming up[^\n]*\n- Whole vault: 2026-11-11, in 17 days/);
});
