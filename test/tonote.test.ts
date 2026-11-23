import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "./obsidian-stub";
import { canCopy, copyPages, copyRequest, noteBody, noteName, PAGES_PER_REQUEST, readCopy } from "../src/tonote";
import { llmCfg } from "./fixtures";

const page = (n: number) => ({ mediaType: "image/jpeg", dataBase64: `page${n}`, path: `Scans/p${n}.jpg` });

test("a note's name is the title without what a file name cannot hold", () => {
	assert.equal(noteName('IS-LM: the "flat" LM curve / notes #2'), "IS-LM the flat LM curve notes 2");
	assert.equal(noteName("  ..  "), "");
	assert.ok(noteName("x".repeat(200)).length <= 80);
});

test("pictures and PDFs can be copied, notes cannot", () => {
	assert.ok(canCopy("PDF") && canCopy("jpg") && canCopy("png"));
	assert.ok(!canCopy("md") && !canCopy("canvas"));
});

test("a reply with no text is not a copy", () => {
	assert.equal(readCopy({ title: "T", markdown: "  " }), null);
	assert.equal(readCopy(null), null);
	assert.deepEqual(readCopy({ title: "T", markdown: " a " }), { title: "T", markdown: "a" });
});

test("later pages are asked for with how the note ends so far", () => {
	assert.ok(!copyRequest(0, 1, 1, "").includes("so_far"));
	const ask = copyRequest(3, 2, 5, "the last line");
	assert.ok(ask.includes("Pages 4 to 5 of 5") && ask.includes("the last line"));
});

test("pages go a few at a time, as pictures, and the parts are joined", async () => {
	const bodies: any[] = [];
	net.handler = async (req) => {
		const body = JSON.parse(req.body as string);
		bodies.push(body);
		const reply = { title: `Title ${bodies.length}`, markdown: `part ${bodies.length}` };
		return { status: 200, json: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] }, text: "", headers: {} } as any;
	};
	const told: number[] = [];
	const pages = Array.from({ length: PAGES_PER_REQUEST + 1 }, (_, i) => page(i));
	const copy = await copyPages(llmCfg(), pages, (done) => told.push(done));
	assert.equal(bodies.length, 2);
	assert.deepEqual(told, [0, PAGES_PER_REQUEST]);
	assert.deepEqual(copy, { title: "Title 1", markdown: "part 1\n\npart 2" });
	const sent = JSON.stringify(bodies[0]);
	assert.ok(sent.includes("page0") && sent.includes(`page${PAGES_PER_REQUEST - 1}`) && !sent.includes(`page${PAGES_PER_REQUEST}`));
	assert.ok(JSON.stringify(bodies[1]).includes("part 1"));
});

test("the saved note is made inert and links to what it was copied from", () => {
	const body = noteBody("# Heat\n\n```dataviewjs\nalert(1)\n```\n\n![x](https://evil.example/a.png)", ["Scans/p1.jpg", "Scans/p2.jpg"]);
	assert.ok(body.includes("[[Scans/p1.jpg]], [[Scans/p2.jpg]]"));
	assert.ok(!body.includes("```dataviewjs\n"));
	assert.ok(!body.includes("![x](https://evil.example/a.png)"));
});
