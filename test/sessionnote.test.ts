import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionNote, renderAnswer, renderSessionNote, stampOf, STAMP_RE, type AnswerEntry } from "../src/sessionnote";

const entry = (over: Partial<AnswerEntry> = {}): AnswerEntry => ({
	node: "GDP deflator",
	question: "What does the GDP deflator measure?",
	answer: "The price level of\neverything produced.",
	verdict: "partial",
	gaveUp: false,
	feedback: "Close: it is nominal over real GDP.",
	modelAnswer: "Nominal GDP over real GDP, times 100.",
	...over,
});

test("what renderAnswer writes, parseSessionNote reads back, linked or not", () => {
	for (const link of [true, false]) {
		const entries = [entry(), entry({ node: "Okun", verdict: "correct", feedback: "", modelAnswer: "x" }), entry({ node: "IS|LM", gaveUp: true, answer: "" })];
		const text = ["# Grill session", "", ...entries.flatMap((e) => renderAnswer(e, link))].join("\n");
		assert.deepEqual(parseSessionNote(text), [
			{ note: "GDP deflator", question: entry().question, answer: entry().answer, result: "partial", feedback: entry().feedback, expected: entry().modelAnswer },
			{ note: "Okun", question: entry().question, answer: entry().answer, result: "correct", feedback: "", expected: "" },
			{ note: "IS|LM", question: entry().question, answer: "", result: "skipped", feedback: entry().feedback, expected: entry().modelAnswer },
		]);
	}
});

test("a session note's file name is read back as the time it was written", () => {
	const d = new Date(2026, 9, 5, 9, 7);
	const m = STAMP_RE.exec(`${stampOf(d)}.42`);
	assert.deepEqual(m?.slice(1), ["2026-10-05", "09", "07"]);
});

test("a whole session note reads back to its answers, past the debrief, discussion and redo block", () => {
	const text = renderSessionNote(
		[
			{
				...entry(),
				explanation: { whatWentWrong: "Mixed up\nthe two.", keyConcept: "Deflator", example: "", diagram: "flowchart TD\n A --> B" },
				discussion: [
					{ role: "student", text: "Why times 100?" },
					{ role: "tutor", text: "It's an index." },
				],
			},
		],
		{ provider: "anthropic", model: "m", startedAt: new Date(2026, 9, 5, 9, 7) },
		true,
		{ headline: "Good start.", pattern: "", gaps: [], nextFocus: [] } as never,
		[{ node: "GDP deflator", question: "Q?", difficulty: "easy", modelAnswer: "A", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" } } as never],
	);
	assert.match(text, /^---\ndate: 2026-10-05\nscore: 0\/1\n/);
	assert.match(text, /\n# Grill session 2026-10-05 09\.07\n/);
	assert.match(text, /\n## Redo\n\n```grill-redo\n/);
	const [a] = parseSessionNote(text);
	assert.equal(a.note, "GDP deflator");
	assert.equal(a.result, "partial");
	assert.deepEqual(a.asked, ["Why times 100?"]);
});
