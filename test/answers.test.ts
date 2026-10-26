import { test } from "node:test";
import assert from "node:assert/strict";
import { answerKind, shuffled } from "../src/screens/answers";

/** A question is answered the way its type says only when its own data supports it;
 * otherwise it falls back to typing, never to an empty widget. */
test("each question gets the widget its data supports", () => {
	const q = (x: Record<string, unknown>) => ({ node: "N", question: "Q", ...x }) as any;
	assert.equal(answerKind(q({ type: "blank", question: "The ___ rises." })), "blank");
	assert.equal(answerKind(q({ type: "blank", question: "No blank here." })), "write");
	assert.equal(answerKind(q({ type: "mc", choices: ["a", "b"] })), "mc");
	assert.equal(answerKind(q({ type: "mc", choices: ["a"] })), "write");
	assert.equal(answerKind(q({ type: "tf" })), "tf");
	assert.equal(answerKind(q({ type: "multi", choices: ["a", "b"], correctChoices: ["a"] })), "multi");
	assert.equal(answerKind(q({ type: "multi", choices: ["a", "b"] })), "write");
	assert.equal(answerKind(q({ type: "match", pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }] })), "match");
	assert.equal(answerKind(q({ type: "draw", drawing: "d.excalidraw.md" })), "draw");
	assert.equal(answerKind(q({ type: "draw" })), "write");
	assert.equal(answerKind(q({})), "write");
});

test("a shuffle keeps every item and leaves the input alone", () => {
	const input = ["a", "b", "c", "d"];
	const out = shuffled(input);
	assert.deepEqual([...out].sort(), input);
	assert.deepEqual(input, ["a", "b", "c", "d"]);
});
