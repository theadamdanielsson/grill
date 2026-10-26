import { test } from "node:test";
import assert from "node:assert/strict";
import { requeueForContext } from "../src/sessionplan";

/** "Add context" sends the questions not yet shown back to be written again. */
const t = (id: string, extra = {}) => ({ conceptId: id, note: "N", ...extra });
const q = (id: string) => ({ conceptId: id, node: "N" });

test("questions after the current one go back into the plan at the cursor", () => {
	const targets = [t("a"), t("b"), t("c", { lastDefectReason: "too long" }), t("d")];
	const questions = [q("a"), q("b"), q("c")];
	const n = requeueForContext(questions, targets, 0, 3, false);
	assert.equal(n, 2);
	assert.deepEqual(questions.map((x) => x.conceptId), ["a"]);
	assert.deepEqual(targets.map((x) => x.conceptId), ["a", "b", "c", "b", "c", "d"]);
	assert.equal("lastDefectReason" in targets[4], false);
});

test("the question on screen goes too when asked", () => {
	const targets = [t("a"), t("b")];
	const questions = [q("a"), q("b")];
	assert.equal(requeueForContext(questions, targets, 0, 2, true), 2);
	assert.deepEqual(questions, []);
	assert.deepEqual(targets.map((x) => x.conceptId), ["a", "b", "a", "b"]);
});

test("a question with no target of its own stays rather than being lost", () => {
	const targets = [t("a")];
	const questions = [q("a"), q("bridge")];
	assert.equal(requeueForContext(questions, targets, 0, 1, false), 0);
	assert.deepEqual(questions.map((x) => x.conceptId), ["a", "bridge"]);
	assert.deepEqual(targets.map((x) => x.conceptId), ["a"]);
});
