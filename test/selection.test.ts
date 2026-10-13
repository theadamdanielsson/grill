import { test } from "node:test";
import assert from "node:assert/strict";
import { promptMessage, promptText, quoteSelection, SELECTION_ASKS, SELECTION_MAX, selectionMessage } from "../src/selection";

test("a selection is quoted line by line, blank lines kept inside the quote", () => {
	assert.equal(quoteSelection("  one\r\n\r\ntwo  "), "> one\n>\n> two");
});

test("a long selection is cut at a line and marked as cut", () => {
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the passage`).join("\n");
	const quoted = quoteSelection(lines);
	assert.ok(quoted.length < SELECTION_MAX + 900);
	assert.ok(quoted.endsWith("> [...]"));
	// Cut at a whole line: the last quoted line is one of the passage's.
	assert.match(quoted.split("\n").at(-2) ?? "", /^> line \d+ of the passage$/);
});

test("one long line with nowhere to cut is still cut", () => {
	const quoted = quoteSelection("x".repeat(SELECTION_MAX * 2));
	assert.equal(quoted, `> ${"x".repeat(SELECTION_MAX)}\n> [...]`);
});

test("each ask says what to do above the passage; only ask is left open", () => {
	for (const { id } of SELECTION_ASKS) {
		const message = selectionMessage(id, "Okun's law");
		assert.ok(message.includes("\n\n> Okun's law"), id);
		assert.equal(message.endsWith("\n\n"), id === "ask", id);
	}
	assert.match(selectionMessage("rewrite", "x"), /rewritten text only/);
});

test("nothing selected, nothing to send", () => {
	assert.equal(selectionMessage("explain", "  \n "), "");
});

test("a saved prompt is the note without its properties", () => {
	assert.equal(promptText("---\ntags: [x]\n---\n\nMake this shorter.\n"), "Make this shorter.");
	assert.equal(promptText("Make this shorter."), "Make this shorter.");
});

test("a saved prompt takes the selection where it says, or underneath", () => {
	assert.equal(promptMessage("Translate to Swedish:\n{{selection}}\nKeep the headings.", "one\ntwo"), "Translate to Swedish:\n\n> one\n> two\n\nKeep the headings.");
	assert.equal(promptMessage("Make this shorter.", "one"), "Make this shorter.\n\n> one");
});

test("a saved prompt with nothing selected is sent as written", () => {
	assert.equal(promptMessage("Summarise {{selection}} briefly.", ""), "Summarise briefly.");
	assert.equal(promptMessage("List the open questions.", "  "), "List the open questions.");
	assert.equal(promptMessage("---\na: 1\n---\n", "x"), "");
});
