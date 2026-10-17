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

test("a record file that can't be read is an error, and is never written over", async () => {
	const repo = mkdtempSync(join(tmpdir(), "grill-repo-"));
	mkdirSync(join(repo, ".grill"));
	const conflict = '<<<<<<< HEAD\n{"a::b": {}}\n=======\n{}\n>>>>>>> other\n';
	writeFileSync(join(repo, ".grill", "concepts.json"), conflict);
	const c = await connect([], repo);
	assert.equal((await call(c, "grill_overview")).error, true);
	const r = await call(c, "grill_record_answer", { note: "x", question: "q", answer: "a", verdict: "correct" });
	assert.equal(r.error, true);
	await c.close();
	assert.equal(readFileSync(join(repo, ".grill", "concepts.json"), "utf8"), conflict);
});

test("in a vault, unknown or mismatched concepts and reserved names are refused", async () => {
	const { root } = makeVault();
	const c = await connect(["--vault", root]);
	assert.equal((await call(c, "grill_record_answer", { note: "__proto__", question: "q", answer: "a", verdict: "incorrect" })).error, true);
	assert.equal((await call(c, "grill_record_answer", { note: "GDP", conceptId: "Inflation::term:bracket-creep", question: "q", answer: "a", verdict: "correct" })).error, true);
	assert.equal((await call(c, "grill_record_answer", { note: "Inflation", conceptId: "constructor", question: "q", answer: "a", verdict: "correct" })).error, true);
	await c.close();
});

test("started in a vault's subfolder, it uses that vault's record", async () => {
	const { root } = makeVault();
	mkdirSync(join(root, "Notes", "Deep"), { recursive: true });
	const c = await connect([], join(root, "Notes", "Deep"));
	assert.equal((await call(c, "grill_overview")).body.concepts.tested, 2);
	await c.close();
	assert.equal(existsSync(join(root, "Notes", "Deep", ".grill")), false);
});

test("three agents writing to one repo lose nothing", async () => {
	const repo = mkdtempSync(join(tmpdir(), "grill-repo-"));
	const clients = await Promise.all([0, 1, 2].map(() => connect([], repo)));
	await Promise.all(
		clients.map((c, k) =>
			Promise.all(Array.from({ length: 15 }, (_, i) => call(c, "grill_record_answer", { note: `f${k}.ts`, label: `c${i}`, question: "q", answer: "a", verdict: "correct" }))),
		),
	);
	await Promise.all(clients.map((c) => c.close()));
	const concepts = JSON.parse(readFileSync(join(repo, ".grill", "concepts.json"), "utf8"));
	assert.equal(Object.keys(concepts).length, 45);
});

test("a note named with # records, and the command can't set the id or time", async () => {
	const { root, g } = makeVault();
	const concepts = JSON.parse(readFileSync(join(g, "concepts.json"), "utf8"));
	concepts["C# basics::term:delegates"] = concept("C# basics", "delegates");
	writeFileSync(join(g, "concepts.json"), JSON.stringify(concepts));
	const c = await connect(["--vault", root]);
	assert.equal((await call(c, "grill_record_answer", { note: "C# basics", conceptId: "C# basics::term:delegates", question: "q", answer: "a", verdict: "correct" })).error, false);
	await c.close();
	const { spawnSync } = await import("node:child_process");
	const out = spawnSync(process.execPath, [bin, "record", '{"note":"Inflation","question":"q","answer":"a","verdict":"correct","id":"../../z","at":"2030-01-01T00:00:00Z"}', "--vault", root], { encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	const files = readdirSync(join(g, "Inbox"));
	assert.equal(files.length, 2);
	for (const f of files) assert.ok(!JSON.parse(readFileSync(join(g, "Inbox", f), "utf8")).at.startsWith("2030"));
	assert.equal(existsSync(join(g, "z.json")), false);
});

test("a repo's own .grill wins over the vault it sits in, and an iCloud placeholder is not an empty record", async () => {
	const { root } = makeVault();
	const repo = join(root, "code", "app");
	mkdirSync(join(repo, ".grill"), { recursive: true });
	writeFileSync(join(repo, ".grill", ".concepts.json.icloud"), "");
	const c = await connect([], repo);
	const o = await call(c, "grill_overview");
	assert.equal(o.error, true, "the record is away in iCloud, not empty");
	assert.equal((await call(c, "grill_record_answer", { note: "x", question: "q", answer: "a", verdict: "correct" })).error, true);
	await c.close();
	assert.equal(existsSync(join(repo, ".grill", "concepts.json")), false);
});
