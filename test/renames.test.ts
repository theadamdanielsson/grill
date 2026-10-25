import { test } from "node:test";
import assert from "node:assert/strict";
import { renameInRecord, type KeptByName } from "../src/renames";
import { concept } from "./fixtures";

test("a renamed note takes its whole record with it, and nothing kept under the new name is overwritten", () => {
	const r: KeptByName = {
		mastery: { Old: { correct: 3 } as never, Taken: { correct: 1 } as never },
		concepts: { "Old::term:gdp": concept({ note: "Old", correct: 2 }), "Other::term:x": concept({ note: "Other" }) },
		registry: { mix: { tag: "mix", label: "x", aliases: [], notes: ["Old", "Other"], count: 2, firstSeen: "a", lastSeen: "b", status: "active" } } as never,
		bank: { "Old::term:gdp": [{ node: "Old", question: "q" }] } as never,
		embeddings: { Old: { hash: "h", vector: [1], model: "m" } } as never,
		layout: { Old: { x: 1, y: 2 } },
		bridges: { "Old\nOther": { a: "Old", b: "Other", status: "suggested" } } as never,
	};
	const touched = renameInRecord(r, "Old", "New");
	assert.deepEqual([...touched].sort(), ["bank", "bridges", "concepts", "embeddings", "layout", "mastery", "registry"]);
	assert.deepEqual(Object.keys(r.mastery).sort(), ["New", "Taken"]);
	assert.equal(r.concepts["New::term:gdp"]?.correct, 2);
	assert.equal(r.concepts["New::term:gdp"]?.note, "New");
	assert.deepEqual((r.registry as any).mix.notes, ["New", "Other"]);
	assert.equal((r.bank as any)["New::term:gdp"][0].node, "New");
	assert.deepEqual(Object.keys(r.layout), ["New"]);
	assert.deepEqual(Object.values(r.bridges).map((b: any) => [b.a, b.b]), [["New", "Other"]]);
	assert.equal(renameInRecord(r, "Taken", "New").has("mastery"), false, "New is kept, Taken stays orphaned");
});
