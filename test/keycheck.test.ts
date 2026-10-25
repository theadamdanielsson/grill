import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "./obsidian-stub";
import { checkAnswerKeys, generateQuestions, type ConceptTarget, type Question } from "../src/llm";
import { noteShape, recordConceptAnswer, type ConceptMap } from "../src/concepts";
import { concept, llmCfg } from "./fixtures";

const cfg = llmCfg();
const note = "Okun's law: unemployment falls when output grows faster than its normal rate of about 3 percent.";
const target: ConceptTarget = { conceptId: "Okun::term:okuns-law", note: "Okun", label: "Okun's law", context: note, targetDifficulty: "medium" };

const question = (over: Partial<Question> & { n?: number } = {}) => ({
	n: 1,
	question: "What happens to unemployment when output grows faster than its normal rate?",
	difficulty: "medium",
	modelAnswer: "Unemployment falls.",
	acceptableAnswers: [],
	commonErrors: [],
	hints: { tier1: "a", tier2: "b", tier3: "c" },
	targetsMisconception: "",
	...over,
});

/** Answers each request by the list its schema asks for, and keeps every request. */
function serve(reply: { questions?: () => unknown[]; answers?: () => unknown[]; verdicts?: () => unknown[] }) {
	const seen: { kind: string; body: any }[] = [];
	net.handler = async (req) => {
		const body = JSON.parse(req.body as string);
		const props = body.output_config.format.schema.properties;
		const kind = props.questions ? "questions" : props.answers ? "answers" : "verdicts";
		seen.push({ kind, body });
		const make = reply[kind as keyof typeof reply];
		if (!make) return { status: 400, json: { error: { message: "no" } }, text: "", headers: {} } as any;
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ [kind]: make() }) }] };
		return { status: 200, json, text: "", headers: {} } as any;
	};
	return seen;
}

const ask = (checkKeys: boolean) => generateQuestions(cfg, `NOTE 'Okun':\n${note}`, [target], [], "", "", undefined, "mixed", {}, true, checkKeys);

test("without the check, generation makes one call, as before", async () => {
	const seen = serve({ questions: () => [question()] });
	const qs = await ask(false);
	assert.equal(qs.length, 1);
	assert.deepEqual(seen.map((s) => s.kind), ["questions"]);
});

test("a choice question whose blind pick matches its key passes without a judge", async () => {
	const mc = question({ type: "mc", choices: ["Unemployment falls.", "Unemployment rises."], correctChoices: [] });
	const seen = serve({ questions: () => [mc], answers: () => [{ n: 1, answer: "Unemployment falls", picked: ["unemployment falls"] }] });
	const qs = await ask(true);
	assert.equal(qs.length, 1);
	assert.deepEqual(seen.map((s) => s.kind), ["questions", "answers"]);
	// The blind solver never sees the key.
	assert.doesNotMatch(JSON.stringify(seen[1].body.messages), /key:/);
});

test("a key the judge rejects goes back to the writer with the reason, and the fixed one is kept", async () => {
	let round = 0;
	const seen = serve({
		questions: () => [round++ === 0 ? question({ modelAnswer: "Unemployment rises." }) : question()],
		answers: () => [{ n: 1, answer: "It falls.", picked: [] }],
		verdicts: () => [round === 1 ? { n: 1, keyHolds: false, reason: "The passage says unemployment falls." } : { n: 1, keyHolds: true, reason: "" }],
	});
	const qs = await ask(true);
	assert.deepEqual(seen.map((s) => s.kind), ["questions", "answers", "verdicts", "questions", "answers", "verdicts"]);
	assert.match(JSON.stringify(seen[3].body.messages), /did not hold up against the source \(The passage says unemployment falls\.\)/);
	assert.equal(qs.length, 1);
	assert.equal(qs[0].modelAnswer, "Unemployment falls.");
});

test("a key that fails again on the retry is dropped", async () => {
	serve({
		questions: () => [question({ modelAnswer: "Unemployment rises." })],
		answers: () => [{ n: 1, answer: "It falls.", picked: [] }],
		verdicts: () => [{ n: 1, keyHolds: false, reason: "The passage says it falls." }],
	});
	assert.equal((await ask(true)).length, 0);
});

test("a check that can't run keeps the questions as written", async () => {
	serve({ questions: () => [question()] });
	const qs = await ask(true);
	assert.equal(qs.length, 1);
});

test("match, occlusion and missing-link questions are not checked", async () => {
	const seen = serve({});
	const base = { node: "Okun", conceptId: target.conceptId, question: "q", difficulty: "medium" as const, modelAnswer: "a", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" } };
	const failed = await checkAnswerKeys(cfg, [{ ...base, type: "match" }, { ...base, type: "occlusion" }, { ...base, missingLink: true }], [target]);
	assert.equal(failed.size, 0);
	assert.equal(seen.length, 0);
});

test("an answer's log entry says what difficulty and format it was asked at", () => {
	const map: ConceptMap = {
		c: concept({ note: "Okun", label: "Okun's law", kind: "note" }),
	};
	recordConceptAnswer(map, "c", "correct", "hard", new Date("2026-10-01T10:00:00Z"));
	noteShape(map.c, { tier: "hard", type: "mc", verdict: "correct" });
	const entry = map.c.reviewLog!.at(-1)!;
	assert.equal(entry.rating, 4);
	assert.deepEqual([entry.tier, entry.type, entry.verdict], ["hard", "mc", "correct"]);
});
