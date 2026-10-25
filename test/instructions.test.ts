import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineLinks, INSTRUCTIONS_TEMPLATE, splitInstructions } from "../src/instructions";
import { DEFAULT_PERSONA } from "../src/persona";

test("the template reads as the default persona and no preferences", () => {
	assert.deepEqual(splitInstructions(INSTRUCTIONS_TEMPLATE), { persona: DEFAULT_PERSONA, preferences: "" });
});

test("preferences stop at the reference documents, and an old file with no headings is all preferences", () => {
	const raw = "## Persona\nStrict.\n## Preferences\n<!-- how -->Short answers.\n## Reference documents\n```grill-documents\n{}\n```";
	assert.deepEqual(splitInstructions(raw), { persona: "Strict.", preferences: "Short answers." });
	assert.deepEqual(splitInstructions("Be kind."), { persona: "", preferences: "Be kind." });
});

test("a linked note is read in once, under a shared budget", async () => {
	const notes: Record<string, string> = { Rubric: "---\na: 1\n---\nMark hard.", Gone: "" };
	const read = async (l: string) => notes[l] ?? null;
	const out = await inlineLinks("See [[Rubric]] and [[Rubric|again]] and [[Missing]].", read, { left: 4 });
	assert.equal(out, 'See [[Rubric]] and [[Rubric|again]] and [[Missing]].\n\nReferenced note "Rubric":\nMark\n[truncated]');
});
