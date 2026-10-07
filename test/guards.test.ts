import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Rules about the source itself: things that pass every other test and still break the
// plugin for someone. Run from the repository root, as `npm test` does.

const src = join(process.cwd(), "src");
const files = readdirSync(src).filter((f) => f.endsWith(".ts"));

/** The code on each line, without `//` and block-comment lines: a comment may name
 * the thing that is forbidden. */
function code(file: string): Array<{ line: number; text: string }> {
	return readFileSync(join(src, file), "utf8")
		.split("\n")
		.map((text, i) => ({ line: i + 1, text }))
		.filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text))
		.map(({ line, text }) => ({ line, text: text.replace(/\s\/\/ .*$/, "") }));
}

test("no regex lookbehind: it fails the whole plugin at load on iOS before 16.4", () => {
	assert.ok(files.length > 10, "the source files were found");
	const found: string[] = [];
	for (const file of files) for (const { line, text } of code(file)) if (/\(\?<[=!]/.test(text)) found.push(`src/${file}:${line}`);
	assert.deepEqual(found, [], "split on a marker instead, as pdf.ts and tts.ts do");
});
