import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedUpTo } from "../src/streamdraw";

test("finishedUpTo: nothing is finished before the first blank line", () => {
	assert.equal(finishedUpTo(""), 0);
	assert.equal(finishedUpTo("A first paragraph still"), 0);
	assert.equal(finishedUpTo("A line\nanother"), 0);
});

test("finishedUpTo: a paragraph is finished once the blank line after it arrives", () => {
	const t = "One.\n\nTwo is being writ";
	assert.equal(t.slice(0, finishedUpTo(t)), "One.\n\n");
	const u = "One.\n\nTwo.\n\nThr";
	assert.equal(u.slice(0, finishedUpTo(u)), "One.\n\nTwo.\n\n");
});

test("finishedUpTo: a blank line inside a code block does not finish it", () => {
	const t = "Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n";
	assert.equal(t.slice(0, finishedUpTo(t)), "Intro.\n\n");
	const closed = t + "```\n\nAfter";
	assert.equal(closed.slice(0, finishedUpTo(closed)), t + "```\n\n");
});

test("finishedUpTo: a line still being written is never cut", () => {
	assert.equal(finishedUpTo("One.\n"), 0);
	assert.equal(finishedUpTo("One.\n\n"), "One.\n\n".length);
});
