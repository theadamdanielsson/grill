import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "./obsidian-stub";
import { adjudicateBridges, explainQuestion, readDebrief } from "../src/llm";
import { llmCfg } from "./fixtures";

/** Replies that can't be read are asked for once more, not filled in with blanks. */
const cfg = llmCfg();
const replying = (...replies: unknown[]): (() => number) => {
	let calls = 0;
	net.handler = async () => {
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(replies[Math.min(calls, replies.length - 1)]) }] };
		calls++;
		return { status: 200, json, text: "", headers: {} } as any;
	};
	return () => calls;
};
const q = { node: "N", question: "Q?", difficulty: "easy", modelAnswer: "A", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" } } as any;

test("an empty explanation is asked for again, and a second empty one is an error", async () => {
	let calls = replying({ whatWentWrong: "", keyConcept: "", example: "", diagram: "" }, { whatWentWrong: "Mixed up X.", keyConcept: "X is Y.", example: "", diagram: "" });
	const x = await explainQuestion(cfg, q, "note", "a", "", "incorrect");
	assert.equal(calls(), 2);
	assert.equal(x.keyConcept, "X is Y.");
	calls = replying({ whatWentWrong: "", keyConcept: "" });
	await assert.rejects(explainQuestion(cfg, q, "note", "a", "", "incorrect"), /came back empty/);
	assert.equal(calls(), 2);
});

test("a link check without its list of pairs is not read as none related", async () => {
	const pair = [{ a: "A", b: "B", aText: "a", bText: "b", score: 1 }] as any;
	const calls = replying({ nothing: true }, { pairs: [{ n: 1, related: true, bridgeConcept: "shared idea", relationship: "" }] });
	const got = await adjudicateBridges(cfg, pair);
	assert.equal(calls(), 2);
	assert.deepEqual(got.map((c) => c.bridgeConcept), ["shared idea"]);
	replying({ nothing: true });
	await assert.rejects(adjudicateBridges(cfg, pair));
});

test("a debrief is taken only whole: a misconception label with a field missing is refused", () => {
	const debrief = { headline: "Solid on A, shaky on B.", strengths: ["A"], gaps: [{ concept: "c", note: "B", why: "w" }], pattern: "", nextFocus: ["B"] };
	const ok = readDebrief({ debrief, assignments: [{ rawTag: "x", canonTag: "mixes_x", canonLabel: "Mixes up X", note: "B" }] });
	assert.equal(ok.assignments.length, 1);
	assert.equal(ok.debrief.gaps[0].note, "B");
	assert.throws(() => readDebrief({ debrief, assignments: [{ rawTag: "x", canonLabel: "Mixes up X", note: "B" }] }));
	assert.throws(() => readDebrief({ debrief: { ...debrief, headline: "" }, assignments: [] }));
	assert.throws(() => readDebrief({ debrief: { ...debrief, gaps: [{ why: "w" }] }, assignments: [] }));
	// Lists that aren't lists of names are emptied rather than trusted.
	assert.deepEqual(readDebrief({ debrief: { ...debrief, strengths: [1, "A"] }, assignments: [] }).debrief.strengths, ["A"]);
});
