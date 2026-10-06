import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, LEGACY_DEFAULTS, migrateLegacyModels, PROVIDERS, withTimeout } from "../src/llm";
import { stripPdfBoilerplate } from "../src/pdf";
import { ConceptMap, reconcileConcepts } from "../src/concepts";
import type { Concept } from "../src/generate-local";

test("cleanText keeps date and page ranges, drops clause dashes", () => {
	assert.equal(cleanText("World War I (1914–1918)"), "World War I (1914–1918)");
	assert.equal(cleanText("see pp. 3–7"), "see pp. 3–7");
	assert.equal(cleanText("fast — but wrong"), "fast, but wrong");
	assert.equal(cleanText("fast—but wrong"), "fast, but wrong");
	assert.equal(cleanText("this – that"), "this, that");
});

test("migrateLegacyModels moves former defaults and nothing else", () => {
	const models = {
		anthropic: "claude-sonnet-5",
		openai: "gpt-5-mini",
		gemini: "gemini-2.5-flash",
		deepseek: "deepseek-chat",
		ollama: "llama3.1:8b",
		custom: "",
	};
	assert.equal(migrateLegacyModels(models), true);
	assert.equal(models.openai, PROVIDERS.openai.defaultModel);
	assert.equal(models.gemini, PROVIDERS.gemini.defaultModel);
	assert.equal(models.deepseek, PROVIDERS.deepseek.defaultModel);
	assert.equal(models.anthropic, PROVIDERS.anthropic.defaultModel);
	assert.equal(models.ollama, "llama3.1:8b");
	// Idempotent, and a hand-picked model is never touched.
	assert.equal(migrateLegacyModels(models), false);
	const picked = { anthropic: "claude-opus-5", openai: "gpt-6-sol", gemini: "gemini-2.5-pro" };
	assert.equal(migrateLegacyModels(picked), false);
	assert.deepEqual(picked, { anthropic: "claude-opus-5", openai: "gpt-6-sol", gemini: "gemini-2.5-pro" });
});

test("no current default is listed as a legacy default", () => {
	for (const [p, old] of Object.entries(LEGACY_DEFAULTS)) {
		assert.ok(!old!.includes(PROVIDERS[p as keyof typeof PROVIDERS].defaultModel), p);
	}
});

test("withTimeout rejects a hung promise and passes a fast one through", async () => {
	await assert.rejects(withTimeout(new Promise(() => undefined), 20), /didn't answer within/);
	assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
	await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
});

const EXAM_PAGE_1 = [
	"Data Analytics, Mock Exam 1",
	"Instructions to candidates",
	"Time allowed: 25 minutes.",
	"Anyone found with a laptop that is not in airplane mode",
	"will be removed from the exam.",
	"Calculators are not permitted. To correct an answer, cross it out clearly.",
	"Question 1",
	"What does the mean of a sample estimate?",
].join("\n");

test("stripPdfBoilerplate drops an exam's rules and keeps its questions", () => {
	const [first, second] = stripPdfBoilerplate([EXAM_PAGE_1, "Question 2\nDefine variance."]);
	assert.ok(first.includes("Question 1\nWhat does the mean of a sample estimate?"), first);
	assert.ok(first.includes("Data Analytics, Mock Exam 1"));
	assert.ok(!/airplane|25 minutes|cross it out|removed from the exam/i.test(first), first);
	assert.equal(second, "Question 2\nDefine variance.");
});

test("stripPdfBoilerplate keeps case data printed before the questions", () => {
	const page = [
		"Time allowed: 120 minutes. Calculators are permitted to use. Answer all questions.",
		"Case: Nordic Retail AB reports revenue of 540m and EBITDA of 81m in 2025.",
		"Inventories rose from 60m to 95m during the year.",
		"Question 1",
		"Compute the EBITDA margin.",
	].join("\n");
	const [first] = stripPdfBoilerplate([page]);
	assert.ok(first.includes("Nordic Retail AB reports revenue of 540m"), first);
	assert.ok(first.includes("Inventories rose from 60m to 95m"), first);
	assert.ok(!/120 minutes/.test(first));
});

test("stripPdfBoilerplate leaves lectures and papers that mention phones or minutes alone", () => {
	const law = [
		"Lecture 7: Evidence",
		"Courts held that searching mobile phones without a warrant is not permitted.",
		"The same applies to other electronic devices seized on arrest.",
	].join("\n");
	const psych = [
		"Participants completed a test lasting 30 minutes.",
		"Mobile phones were collected beforehand, and",
		"results showed reduced recall under time pressure.",
	].join("\n");
	const lecture = "Lecture 4: Regression\nA calculator is handy for the worked example below.";
	const paper = [
		"Smartphones and Academic Dishonesty in Timed Online Exams",
		"Abstract",
		"We study exams with a time limit where phones and calculators are not allowed to use.",
		"Open-book formats reduced academic dishonesty by a third.",
		"1 Introduction",
	].join("\n");
	const algo = [
		"Lecture 3: Complexity",
		"Each problem has a time limit of 2 seconds.",
		"You are not allowed to use the library sort. Each question is worth 10 points.",
		"The time limit bounds n to about 10^8 operations.",
		"Problem 1",
	].join("\n");
	for (const text of [law, psych, lecture, paper, algo]) assert.deepEqual(stripPdfBoilerplate([text]), [text]);
	assert.deepEqual(stripPdfBoilerplate([]), []);
});

function concept(id: string, kind: Concept["kind"] = "term"): Concept {
	return { id, note: "N", label: id, kind, sourceHash: "h", context: "" };
}

test("reconcile restores a temporarily orphaned concept's due date", () => {
	const map: ConceptMap = {};
	reconcileConcepts(map, [concept("N::a"), concept("N::pdf")]);
	map["N::pdf"].dueAt = "2026-10-01T00:00:00.000Z";
	map["N::pdf"].lastSeen = "2026-09-20T00:00:00.000Z";
	map["N::pdf"].stability = 11;
	// A pass that missed the PDF text orphans it...
	reconcileConcepts(map, [concept("N::a")]);
	assert.equal(map["N::pdf"].dueAt, null);
	// ...and the next full pass brings the exact date back.
	reconcileConcepts(map, [concept("N::a"), concept("N::pdf")], undefined, new Date("2026-09-23T00:00:00.000Z"));
	assert.equal(map["N::pdf"].dueAt, "2026-10-01T00:00:00.000Z");
	assert.equal(map["N::pdf"].orphanedDueAt, undefined);
});

test("reconcile recovers concepts 6.0.x orphaned without a stash", () => {
	const map: ConceptMap = {};
	reconcileConcepts(map, [concept("N::pdf")]);
	Object.assign(map["N::pdf"], { dueAt: null, lastSeen: "2026-09-01T00:00:00.000Z", stability: 10 });
	reconcileConcepts(map, [concept("N::pdf")], undefined, new Date("2026-09-05T00:00:00.000Z"));
	assert.equal(map["N::pdf"].dueAt, "2026-09-11T00:00:00.000Z");
});

test("concepts restored already overdue are spread over the next week, not all due today", () => {
	const map: ConceptMap = {};
	const ids = Array.from({ length: 40 }, (_, i) => `N::c${i}`);
	reconcileConcepts(map, ids.map((id) => concept(id)));
	for (const id of ids) Object.assign(map[id], { dueAt: null, lastSeen: "2026-06-01T00:00:00.000Z", stability: 5 });
	const now = new Date("2026-09-23T00:00:00.000Z");
	reconcileConcepts(map, ids.map((id) => concept(id)), undefined, now);
	const days = new Set(ids.map((id) => Math.round((new Date(map[id].dueAt!).getTime() - now.getTime()) / 86400_000)));
	for (const d of days) assert.ok(d >= 0 && d < 7, String(d));
	assert.ok(days.size >= 4, `only ${days.size} distinct days`);
});

test("reconcile never schedules a never-reviewed concept", () => {
	const map: ConceptMap = {};
	reconcileConcepts(map, [concept("N::new")]);
	reconcileConcepts(map, [concept("N::new")]);
	assert.equal(map["N::new"].dueAt, null);
});

test("reconcile keepKinds protects occlusion concepts from a text-only pass", () => {
	const map: ConceptMap = {};
	reconcileConcepts(map, [concept("N::a"), concept("N::img", "occlusion")]);
	map["N::img"].dueAt = "2026-10-01T00:00:00.000Z";
	reconcileConcepts(map, [concept("N::a")], new Set(["occlusion"]));
	assert.equal(map["N::img"].dueAt, "2026-10-01T00:00:00.000Z");
	reconcileConcepts(map, [concept("N::a")]);
	assert.equal(map["N::img"].dueAt, null);
});
