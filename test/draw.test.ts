import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "./obsidian-stub";
import { generateDrawQuestion, gradeAnswer } from "../src/llm";
import { type LLMConfig } from "../src/providers";
import { type Question } from "../src/question";
import { llmCfg } from "./fixtures";

const cfg = llmCfg();
const note = "IS-LM: IS slopes down, LM is flat at the policy rate. A fiscal expansion shifts IS right.";

/** Answer every model call with `reply`, keeping the last request body. */
function answerWith(reply: unknown): { body: () => any } {
	let body: any = null;
	net.handler = async (req) => {
		body = JSON.parse(req.body as string);
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] };
		return { status: 200, json, text: "", headers: {} } as any;
	};
	return { body: () => body };
}

const drawQ: Question = {
	node: "IS-LM",
	question: "Draw the IS-LM diagram and show a fiscal expansion.",
	difficulty: "medium",
	modelAnswer: "IS down, LM flat at the policy rate, IS shifts right, Y rises, i unchanged.",
	acceptableAnswers: [],
	commonErrors: [],
	hints: { tier1: "", tier2: "", tier3: "" },
	type: "draw",
	drawing: "Grill/Drawings/IS-LM.excalidraw.md",
};
const drawing = { mediaType: "image/png", dataBase64: "AAAA", path: drawQ.drawing as string };
const notePicture = { mediaType: "image/png", dataBase64: "BBBB", path: "Attachments/islm.png" };

test("a drawn answer is graded with the drawing first and the drawing rules", async () => {
	const call = answerWith({ verdict: "partial", feedback: "IS shifts left.", misconceptionTag: "reverses_directionality" });
	const g = await gradeAnswer(cfg, drawQ, note, "IS\nIS'\nLM", [drawing, notePicture]);
	assert.equal(g.verdict, "partial");
	const content = call.body().messages.at(-1).content;
	const images = content.filter((b: any) => b.type === "image");
	assert.deepEqual(images.map((b: any) => b.source.data), ["AAAA", "BBBB"]);
	const text = JSON.stringify(content);
	assert.match(text, /DRAWING the student made from memory/);
	assert.match(text, /It is the FIRST image/);
	assert.match(text, /never by pixel coordinates/);
	// The rules ride in the request, so the cached system prompt is the same for every answer.
	assert.doesNotMatch(JSON.stringify(call.body().system), /DRAWING the student made/);
});

test("a written answer is graded without the drawing rules", async () => {
	const call = answerWith({ verdict: "correct", feedback: "Right.", misconceptionTag: "" });
	await gradeAnswer(cfg, { ...drawQ, type: "write", drawing: undefined }, note, "IS shifts right and Y rises.");
	assert.doesNotMatch(JSON.stringify(call.body()), /DRAWING the student made/);
});

test("a draw question is written from the note, or refused when there is nothing to draw", async () => {
	answerWith({ question: "Draw IS-LM and show a fiscal expansion.", modelAnswer: "IS shifts right along a flat LM.", commonErrors: [], hints: { tier1: "a", tier2: "b", tier3: "c" } });
	const q = await generateDrawQuestion(cfg, "IS-LM", note);
	assert.equal(q?.type, "draw");
	assert.equal(q?.node, "IS-LM");
	answerWith({ question: "", modelAnswer: "", commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" } });
	assert.equal(await generateDrawQuestion(cfg, "IS-LM", note), null);
});

test("an agent engine is sent the pictures only when it reads them", async () => {
	const seen: number[] = [];
	const agent = async (_s: string, _u: string, _schema: Record<string, unknown>, _sig: AbortSignal, images: unknown[]) => {
		seen.push(images.length);
		return { verdict: "correct", feedback: "Right.", misconceptionTag: "" };
	};
	const base: LLMConfig = { provider: "custom", apiKey: "", model: "Claude Code", agent };
	await gradeAnswer({ ...base, agentImages: true }, drawQ, note, "IS", [drawing, notePicture]);
	await gradeAnswer({ ...base, agentImages: false }, drawQ, note, "IS", [drawing, notePicture]);
	assert.deepEqual(seen, [2, 0]);
});

test("a verdict the grader didn't give is asked for again, then refused, never read as incorrect", async () => {
	const q = { ...drawQ, type: "write" as const };
	let calls = 0;
	const replies = [{ verdict: "Correct", feedback: "x", misconceptionTag: "" }, { verdict: "partial", feedback: "Half.", misconceptionTag: " mixes_up " }];
	net.handler = async () => {
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(replies[Math.min(calls++, 1)]) }] };
		return { status: 200, json, text: "", headers: {} } as any;
	};
	assert.deepEqual(await gradeAnswer(cfg, q, note, "IS"), { verdict: "partial", feedback: "Half.", misconceptionTag: "mixes_up" });
	assert.equal(calls, 2);
	answerWith({ verdict: "maybe", feedback: "", misconceptionTag: "" });
	await assert.rejects(gradeAnswer(cfg, q, note, "IS"), /verdict couldn't be read/);
});
