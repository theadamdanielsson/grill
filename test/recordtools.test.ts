import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseResult, RESULT_VERSION } from "../src/record";
import { RECORD_TOOL_RE, RECORD_TOOLS, recordTool, zodShape } from "../src/recordtools";

test("the answer the grill-test skill shows an agent recording is one the record takes", () => {
	const skill = readFileSync("skills/grill-test/SKILL.md", "utf8");
	const example = /npx -y grill-mcp record <<'EOF'\n\s*(\{.*\})\n/.exec(skill)?.[1];
	assert.ok(example, "the skill shows an example");
	// As grill-mcp's record command fills it in.
	const r = parseResult({ ...JSON.parse(example), v: RESULT_VERSION, id: "abc", at: new Date().toISOString() });
	assert.equal(r?.verdict, "partial");
	assert.equal(r?.misconception?.tag, "confuses_refresh_with_reauth");
});

test("the zod a tool is offered with over MCP checks what its JSON Schema says", () => {
	const know = z.object(zodShape(z, recordTool("grill_what_they_know")));
	assert.equal(know.safeParse({ topic: "GDP", limit: 10 }).success, true);
	assert.equal(know.safeParse({}).success, false, "the topic is required");
	assert.equal(know.safeParse({ topic: "" }).success, false);
	assert.equal(know.safeParse({ topic: "GDP", limit: 51 }).success, false);
	assert.equal(z.object(zodShape(z, recordTool("grill_weak_spots"))).safeParse({}).success, true);
	const offer = z.object(zodShape(z, recordTool("grill_offer_study")));
	assert.equal(offer.safeParse({ kind: "notes", notes: ["GDP"] }).success, true);
	assert.equal(offer.safeParse({ kind: "later" }).success, false);
	for (const t of RECORD_TOOLS) assert.doesNotThrow(() => zodShape(z, t));
});

test("a read of the record is recognised by name, in a title or in code", () => {
	assert.ok(RECORD_TOOL_RE.test("mcp__grill__grill_weak_spots"));
	assert.ok(RECORD_TOOL_RE.test("await grill.grill_what_they_know({topic})"));
	assert.ok(!RECORD_TOOL_RE.test("grill_record_answer"));
});
