import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "./obsidian-stub";
import { type ConceptTarget, generateQuestions } from "../src/llm";
import { llmCfg } from "./fixtures";

const cfg = llmCfg();
const note = "Okun's law relates the change in unemployment to output growth above its normal rate.";
const target: ConceptTarget = { conceptId: "Okun::term:okuns-law", note: "Okun", label: "Okun's law", context: note, targetDifficulty: "easy" };

/** One question as the model would send it, with or without hints. */
const reply = (hints: boolean) => ({
	n: 1,
	question: "How does Okun's law relate the change in unemployment to output growth?",
	difficulty: "easy",
	modelAnswer: "Unemployment falls when output grows faster than its normal rate.",
	acceptableAnswers: [],
	commonErrors: [],
	...(hints ? { hints: { tier1: "Think about growth.", tier2: "Compare with normal growth.", tier3: "Above normal lowers it." } } : {}),
	targetsMisconception: "",
});

async function ask(hints: boolean | undefined): Promise<{ body: any; questions: Awaited<ReturnType<typeof generateQuestions>> }> {
	let body: any = null;
	net.handler = async (req) => {
		body = JSON.parse(req.body as string);
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ questions: [reply(hints !== false)] }) }] };
		return { status: 200, json, text: "", headers: {} } as any;
	};
	const questions = await generateQuestions(cfg, `NOTE 'Okun':\n${note}`, [target], [], "", "", undefined, "write", {}, hints);
	return { body, questions };
}

const sent = (body: any): string => JSON.stringify(body);
const item = (body: any) => body.output_config.format.schema.properties.questions.items;

test("hints are asked for when the setting is on, and by default", async () => {
	for (const hints of [true, undefined]) {
		const { body, questions } = await ask(hints);
		assert.ok(item(body).properties.hints);
		assert.ok(item(body).required.includes("hints"));
		assert.match(sent(body.system), /- hints: tier1/);
		assert.equal(questions[0].hints.tier1, "Think about growth.");
	}
});

test("with hints off, none are asked for and the question still comes back whole", async () => {
	const { body, questions } = await ask(false);
	assert.equal(item(body).properties.hints, undefined);
	assert.ok(!item(body).required.includes("hints"));
	assert.doesNotMatch(sent(body), /tier1/);
	assert.match(sent(body.system), /- commonErrors:.*\\n- targetsMisconception:/);
	assert.equal(questions.length, 1);
	assert.deepEqual(questions[0].hints, { tier1: "", tier2: "", tier3: "" });
});

test("a concept on an exam is marked so in the request, and the rules say what that means", async () => {
	let body: any = null;
	net.handler = async (req) => {
		body = JSON.parse(req.body as string);
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ questions: [reply(true)] }) }] };
		return { status: 200, json, text: "", headers: {} } as any;
	};
	await generateQuestions(cfg, `NOTE 'Okun':\n${note}`, [{ ...target, examDays: 17 }], [], "", "", undefined, "write", {}, true);
	assert.match(sent(body.messages), /\(aim: easy\) \[exam in 17 days\]/);
	assert.match(sent(body.system), /marked \[exam \.\.\.\], it is on an exam/);
});
