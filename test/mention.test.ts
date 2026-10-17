import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPick, linkedNames, rankNames, typedAt } from "../src/mention";

test("@ and / are picked up only where they start something", () => {
	assert.deepEqual(typedAt("explain @Infl", 13), { kind: "note", start: 8, query: "Infl" });
	assert.deepEqual(typedAt("@", 1), { kind: "note", start: 0, query: "" });
	assert.equal(typedAt("mail me at a@b.com", 18), null, "an @ inside a word is not a mention");
	assert.equal(typedAt("see @GDP\nand", 12), null, "a line break ends it");
	assert.deepEqual(typedAt("/sum", 4), { kind: "prompt", start: 0, query: "sum" });
	assert.equal(typedAt("what is 1/2", 11), null, "a / later in the text is just a slash");
	assert.deepEqual(typedAt("about @Real Interest", 20), { kind: "note", start: 6, query: "Real Interest" }, "note names have spaces");
});

test("names starting with the query come first, then a word in them, then anywhere", () => {
	const names = ["Inflation rate", "Inflation", "Deflation", "Core inflation (CPI)", "GDP"];
	assert.deepEqual(rankNames(names, "infl"), ["Inflation", "Inflation rate", "Core inflation (CPI)"]);
	assert.deepEqual(rankNames(names, ""), names.slice(0, 5));
});

test("a pick replaces what was typed, and links in a message are read back", () => {
	const t = typedAt("explain @Infl please", 13)!;
	assert.deepEqual(applyPick("explain @Infl please", t, 13, "[[Inflation]] "), { text: "explain [[Inflation]]  please", caret: 22 });
	assert.deepEqual(linkedNames("compare [[GDP]] with [[GDP deflator|the deflator]] and [[GDP]]"), ["GDP", "GDP deflator"]);
});
