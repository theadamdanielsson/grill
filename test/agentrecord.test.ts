import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetAgentProject, readAgentConcepts } from "../src/agentrecord";
import { concept } from "./fixtures";

test("removing a project takes its concepts, schedule and share of misconceptions, and nothing else", () => {
	const home = mkdtempSync(join(tmpdir(), "grill-home-"));
	const dir = join(home, ".grill", "record");
	mkdirSync(dir, { recursive: true });
	const req = (m: string): unknown => (m === "os" ? { homedir: () => home } : fs);
	writeFileSync(join(dir, "concepts.json"), JSON.stringify({ a: concept({ note: "api/Auth" }), b: concept({ note: "web/Forms" }), c: concept({ note: "api" }) }));
	writeFileSync(join(dir, "mastery.json"), JSON.stringify({ "api/Auth": {}, "web/Forms": {} }));
	writeFileSync(join(dir, "misconceptions.json"), JSON.stringify({ x: { notes: ["api/Auth"] }, y: { notes: ["api/Auth", "web/Forms"] } }));

	forgetAgentProject(req, "api");

	assert.deepEqual(Object.keys(readAgentConcepts(req)), ["b"]);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "mastery.json"), "utf8"))), ["web/Forms"]);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "misconceptions.json"), "utf8")), { y: { notes: ["web/Forms"] } });
});
