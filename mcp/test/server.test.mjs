// Runs the built server over stdio, as an agent would, against a vault and a repo
// made in a temporary folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = new URL("../dist/grill-mcp.js", import.meta.url).pathname;
const day = 86400_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

function concept(note, label, o = {}) {
	return { note, label, kind: "term", sourceHash: "h", correct: 0, partial: 0, incorrect: 0, streak: 0, stability: null, difficulty: null, lastSeen: null, dueAt: null, ...o };
}

function makeVault(folder = "Grill") {
	const root = mkdtempSync(join(tmpdir(), "grill-vault-"));
	mkdirSync(join(root, ".obsidian", "plugins", "grill"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "grill", "data.json"), JSON.stringify({ settings: { folder } }));
	const g = join(root, folder);
	mkdirSync(g, { recursive: true });
	const concepts = {
		"Inflation::term:bracket-creep": concept("Inflation", "bracket creep", {
			correct: 1, incorrect: 2, stability: 0.5, difficulty: 7, lastSeen: iso(-3 * day), dueAt: iso(-1 * day),
			reviewLog: [{ t: iso(-3 * day), elapsedDays: 1, rating: 1 }],
		}),
		"Inflation::term:nominal-income": concept("Inflation", "nominal income", {
			correct: 5, streak: 3, stability: 40, difficulty: 3, lastSeen: iso(-2 * day), dueAt: iso(30 * day),
			reviewLog: [{ t: iso(-2 * day), elapsedDays: 9, rating: 3 }],
		}),
		"GDP::heading:value-added": concept("GDP", "value added"),
		"GDP::heading:gone": concept("GDP", "an old heading", { orphanedDueAt: iso(day), correct: 1, stability: 3, lastSeen: iso(-day) }),
	};
	writeFileSync(join(g, "concepts.json"), JSON.stringify(concepts));
	writeFileSync(join(g, "mastery.json"), JSON.stringify({ Inflation: { correct: 6, partial: 0, incorrect: 2, streak: 0, stability: null, difficulty: null, lastSeen: null, dueAt: null, misconceptions: {} } }));
	writeFileSync(join(g, "misconceptions.json"), JSON.stringify({
		bracket_creep_conflation: { tag: "bracket_creep_conflation", label: "Mixes up bracket creep with the income-distribution effect", aliases: [], notes: ["Inflation"], count: 3, firstSeen: iso(-9 * day), lastSeen: iso(-3 * day), status: "active" },
	}));
	writeFileSync(join(g, "questions.json"), JSON.stringify({
		"Inflation::term:bracket-creep": [{ node: "Inflation", conceptId: "Inflation::term:bracket-creep", question: "What is bracket creep?", difficulty: "medium", modelAnswer: "Inflation pushing nominal incomes into higher tax brackets.", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, sourceHash: "h", timesShown: 1 }],
		"GDP::heading:value-added": [{ node: "GDP", question: "Define value added.", difficulty: "easy", modelAnswer: "Output minus intermediate inputs.", acceptableAnswers: [], commonErrors: [], hints: { tier1: "", tier2: "", tier3: "" }, sourceHash: "h", timesShown: 0, rejected: true }],
	}));
	return { root, g };
}

async function connect(args, cwd) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [bin, ...args], cwd, stderr: "ignore" });
	const client = new Client({ name: "claude-code", version: "1.0.0" });
	await client.connect(transport);
	return client;
}

const call = async (c, name, args = {}) => {
	const r = await c.callTool({ name, arguments: args });
	return { error: !!r.isError, body: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

test("lists the five tools and says how to use them", async () => {
	const { root } = makeVault();
	const c = await connect(["--vault", root]);
	const names = (await c.listTools()).tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["grill_overview", "grill_questions", "grill_record_answer", "grill_weak_spots", "grill_what_they_know"]);
	assert.match(c.getInstructions(), /ONE at a time/);
	await c.close();
});

test("reads a vault's record, leaving out concepts the note no longer has", async () => {
	const { root } = makeVault();
	const c = await connect(["--vault", root]);
	const o = (await call(c, "grill_overview")).body;
	assert.equal(o.concepts.total, 3);
	assert.equal(o.concepts.tested, 2);
	assert.equal(o.dueNow, 1);
	assert.equal(o.activeMisconceptions[0].tag, "bracket_creep_conflation");

	const w = (await call(c, "grill_weak_spots", { topic: "inflation" })).body;
	assert.equal(w.concepts[0].id, "Inflation::term:bracket-creep");
	assert.equal(w.concepts[0].lastAnswerMissed, true);
	assert.ok(!w.concepts.some((x) => x.id === "Inflation::term:nominal-income"), "a well-known concept is not a weak spot");

	const k = (await call(c, "grill_what_they_know", { topic: "GDP" })).body;
	assert.deepEqual(k.concepts.map((x) => x.id), ["GDP::heading:value-added"]);
	assert.equal(k.concepts[0].recallNow, null);

	const q = (await call(c, "grill_questions", {})).body;
	assert.deepEqual(q.questions.map((x) => x.question), ["What is bracket creep?"], "rejected questions are never served");
	await c.close();
});

test("in a vault an answer goes to the inbox and the record files are untouched", async () => {
	const { root, g } = makeVault("Study/Grill");
	const before = readFileSync(join(g, "concepts.json"), "utf8");
	const c = await connect([], root);
	const r = await call(c, "grill_record_answer", {
		note: "Inflation", conceptId: "Inflation::term:bracket-creep", question: "What is bracket creep?", answer: "When prices rise",
		verdict: "incorrect", misconception: { tag: "Bracket creep = inflation", label: "Thinks bracket creep is inflation itself" },
	});
	assert.equal(r.error, false);
	const bad = await call(c, "grill_record_answer", { note: "Not a note", question: "q", answer: "a", verdict: "correct" });
	assert.equal(bad.error, true);
	await c.close();
	assert.equal(readFileSync(join(g, "concepts.json"), "utf8"), before);
	const inbox = readdirSync(join(g, "Inbox"));
	assert.equal(inbox.length, 1);
	const saved = JSON.parse(readFileSync(join(g, "Inbox", inbox[0]), "utf8"));
	assert.equal(saved.via, "Claude Code");
	assert.equal(saved.misconception.tag, "bracket_creep_inflation");
	assert.equal(saved.verdict, "incorrect");
});

test("in a code repo answers start and update a record of their own", async () => {
	const repo = mkdtempSync(join(tmpdir(), "grill-repo-"));
	const c = await connect([], repo);
	assert.equal((await call(c, "grill_overview")).body.empty, true);
	await call(c, "grill_record_answer", { note: "src/auth.ts", label: "token refresh", question: "What happens on a 401?", answer: "It refreshes the token and retries once", verdict: "correct" });
	await call(c, "grill_record_answer", { note: "src/auth.ts", label: "session expiry", question: "When does a session expire?", answer: "no idea", verdict: "incorrect", modelAnswer: "After 30 days idle." });
	const o = (await call(c, "grill_overview")).body;
	assert.equal(o.concepts.tested, 2);
	const w = (await call(c, "grill_weak_spots", {})).body;
	assert.equal(w.concepts[0].label, "session expiry");
	await c.close();
	assert.ok(existsSync(join(repo, ".grill", "concepts.json")));
	const log = readdirSync(join(repo, ".grill", "Sessions"));
	assert.equal(log.length, 1);
	assert.match(readFileSync(join(repo, ".grill", "Sessions", log[0]), "utf8"), /\*\*Expected answer:\*\* After 30 days idle\./);
});
