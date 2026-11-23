import { test } from "node:test";
import assert from "node:assert/strict";
import { lineCounts, lineDiff, wordDiff } from "../src/worddiff";
import { editRequest, editTokens, fitReplacement } from "../src/editprompt";

const side = (parts: ReturnType<typeof wordDiff>, drop: "added" | "removed"): string =>
	parts
		.filter((p) => p.kind !== drop)
		.map((p) => p.text)
		.join("");

test("a word diff gives both texts back exactly, spacing included", () => {
	const before = "The  central bank\nraises rates when inflation is high.";
	const after = "The central bank\n\nraises the policy rate when inflation runs high.";
	const parts = wordDiff(before, after);
	assert.equal(side(parts, "added"), before);
	assert.equal(side(parts, "removed"), after);
	assert.ok(parts.some((p) => p.kind === "same" && p.text.includes("central bank")));
});

test("only the changed word is marked", () => {
	assert.deepEqual(wordDiff("a quick fox", "a slow fox"), [
		{ kind: "same", text: "a " },
		{ kind: "removed", text: "quick" },
		{ kind: "added", text: "slow" },
		{ kind: "same", text: " fox" },
	]);
});

test("nothing to nothing, and writing at an empty cursor", () => {
	assert.deepEqual(wordDiff("", ""), []);
	assert.deepEqual(wordDiff("", "new text"), [{ kind: "added", text: "new text" }]);
	assert.deepEqual(wordDiff("old", ""), [{ kind: "removed", text: "old" }]);
});

test("two very long texts with nothing in common are shown whole, not compared word by word", () => {
	const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(" ");
	const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join(" ");
	const parts = wordDiff(a, b);
	assert.equal(side(parts, "added"), a);
	assert.equal(side(parts, "removed"), b);
});

test("a line diff keeps a little around each change and counts what it leaves out", () => {
	const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
	const after = before.replace("line 6", "line six");
	assert.deepEqual(lineDiff(before, after, 1), [
		{ kind: "gap", text: "5 lines the same" },
		{ kind: "same", text: "line 5" },
		{ kind: "removed", text: "line 6" },
		{ kind: "added", text: "line six" },
		{ kind: "same", text: "line 7" },
		{ kind: "gap", text: "4 lines the same" },
	]);
	assert.deepEqual(lineCounts(before, after), { added: 1, removed: 1 });
});

test("a new file is all added, a removed one all removed, an unchanged one says nothing", () => {
	assert.deepEqual(lineDiff("", "one\ntwo\n"), [
		{ kind: "added", text: "one" },
		{ kind: "added", text: "two" },
	]);
	assert.deepEqual(lineCounts("one\ntwo", ""), { added: 0, removed: 2 });
	assert.deepEqual(lineDiff("same\ntext", "same\ntext"), []);
});

test("the edit request marks the place and says what to do", () => {
	const text = "# Rates\n\nThe bank raises rates.\n\nMore below.";
	const from = text.indexOf("The bank");
	const to = from + "The bank raises rates.".length;
	const req = editRequest({ note: "Rates", text, from, to, ask: " Make it formal " });
	assert.match(req, /^NOTE: Rates/);
	assert.ok(req.includes("BEFORE THE PASSAGE:\n# Rates"));
	assert.ok(req.includes("THE PASSAGE:\nThe bank raises rates."));
	assert.ok(req.includes("AFTER THE PASSAGE:\n\n\nMore below."));
	assert.ok(req.endsWith("WHAT TO DO:\nMake it formal"));
	assert.ok(!req.includes("YOUR LAST VERSION"));
});

test("an empty passage and a second try are both said", () => {
	const req = editRequest({ note: "N", text: "ab", from: 1, to: 1, ask: "Continue", earlier: "first go" });
	assert.ok(req.includes("THE PASSAGE: (empty"));
	assert.ok(req.includes("YOUR LAST VERSION, which the user wants changed:\nfirst go"));
	const whole = editRequest({ note: "N", text: "", from: 0, to: 0, ask: "Write" });
	assert.ok(whole.includes("(the note starts here)") && whole.includes("(the note ends here)"));
});

test("a reply is fitted to the passage's own spacing, and an added fence comes off", () => {
	assert.equal(fitReplacement("  old words\n", "new words"), "  new words\n");
	assert.equal(fitReplacement("old", "```markdown\nnew\nline\n```"), "new\nline");
	// A passage that is a code block keeps the fence it comes back with.
	assert.equal(fitReplacement("```js\na()\n```", "```js\nb()\n```"), "```js\nb()\n```");
	assert.equal(fitReplacement("", "\n written here \n"), "written here");
	assert.equal(fitReplacement("\n\n", "text"), "text");
});

test("the reply's room grows with the passage, within bounds", () => {
	assert.equal(editTokens(""), 1500);
	assert.equal(editTokens("x".repeat(4000)), 3200);
	assert.equal(editTokens("x".repeat(40_000)), 8000);
});
