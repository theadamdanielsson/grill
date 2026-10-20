/** grill-mcp: Grill's record of what you know, for any agent that speaks MCP.
 *
 * In a vault it reads the Grill folder the plugin keeps and writes each graded answer
 * as its own file in `<folder>/Inbox/`, which the plugin folds into the record. In a
 * code repo (no vault) it keeps a record of its own in `.grill/` and folds answers in
 * itself. See src/record.ts for both halves.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
	AgentResult,
	INBOX_DIR,
	RESULT_VERSION,
	RecordState,
	applyResults,
	overview,
	parseResult,
	questionsToAsk,
	toTag,
	weakSpots,
	whatTheyKnow,
	has,
} from "../../src/record";
import { learnerBrief } from "../../src/brief";
import { safeMarkdown } from "../../src/safemd";
import type { QuestionBank } from "../../src/store";

declare const GRILL_MCP_VERSION: string;

interface Where {
	/** The folder holding concepts.json and the rest. */
	folder: string;
	/** True in an Obsidian vault: the plugin owns the record files there. */
	vault: boolean;
	/** In the record in the home folder: the project the agent is working in. Its
	 * concepts are named with it, and reads keep to it. */
	project?: string;
}

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

/** The Grill folder's name, from the plugin's settings when they say. */
function grillFolderName(vault: string): string {
	try {
		const data = JSON.parse(readFileSync(join(vault, ".obsidian", "plugins", "grill", "data.json"), "utf8"));
		const f = data?.settings?.folder;
		if (typeof f === "string" && f.trim()) return f.trim().replace(/^\/+|\/+$/g, "");
	} catch {
		/* no plugin settings: the default */
	}
	return "Grill";
}

export function locate(): Where {
	const vault = argValue("--vault") ?? process.env.GRILL_VAULT;
	if (vault) return { folder: join(resolve(vault), grillFolderName(resolve(vault))), vault: true };
	const dir = argValue("--dir");
	if (dir) return { folder: resolve(dir), vault: false };
	// ~/.grill also holds what the plugin installs (opencode): the record has a folder of its own.
	const home = process.env.GRILL_HOME ? resolve(process.env.GRILL_HOME) : join(homedir(), ".grill", "record");
	// Started inside a vault, even in one of its subfolders, is that vault's record. A
	// project that already keeps a record of its own in .grill uses that.
	const cwd = process.cwd();
	for (let at = cwd; ; at = dirname(at)) {
		if (!sameFolder(at, homedir()) && existsSync(join(at, ".grill"))) return { folder: join(at, ".grill"), vault: false };
		// A vault counts only if Grill is in it: in any other vault there is no record of
		// Grill's to add to, and every answer would be refused.
		if (existsSync(join(at, ".obsidian")) && hasGrill(at)) return { folder: join(at, grillFolderName(at)), vault: true };
		if (dirname(at) === at) break;
	}
	// Otherwise one record for the person, in their home folder, never in the project:
	// it is theirs, not the codebase's, and goes with them from project to project.
	return { folder: home, vault: false, project: projectName(cwd) };
}

/** Whether Grill is installed in this vault, or has a record there. */
function hasGrill(vault: string): boolean {
	const folder = join(vault, grillFolderName(vault));
	return existsSync(join(vault, ".obsidian", "plugins", "grill", "manifest.json")) || existsSync(join(folder, "concepts.json")) || existsSync(join(folder, "mastery.json"));
}

/** Whether two paths are one folder, through symlinks (/var and /private/var on a Mac). */
function sameFolder(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

/** The project's name: its git root's folder name, or the folder's own. */
function projectName(cwd: string): string {
	for (let at = cwd; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) return basename(at);
		if (dirname(at) === at) break;
	}
	return basename(cwd);
}

/** What reads see: in the home record, only the current project's concepts. */
function inView(where: Where, s: RecordState & { bank: QuestionBank }): RecordState & { bank: QuestionBank } {
	if (!where.project) return s;
	const mine = (note: string) => note.startsWith(`${where.project}/`);
	const pick = <T extends { note: string }>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([, v]) => mine(v.note)));
	return {
		concepts: pick(s.concepts),
		mastery: Object.fromEntries(Object.entries(s.mastery).filter(([n]) => mine(n))),
		registry: Object.fromEntries(Object.entries(s.registry).filter(([, r]) => r.notes.some(mine))),
		bank: s.bank,
	};
}

function readJSON<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new RecordUnreadable(path);
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new RecordUnreadable(path);
	}
}

class RecordUnreadable extends Error {
	constructor(readonly path: string) {
		super(`${path} can't be read right now (it may be being written or synced). Nothing was changed; try again in a moment.`);
	}
}

/** Written next to its target under a dot name (which Obsidian doesn't index), then
 * moved into place, so nobody ever reads half a file. */
function writeAtomic(path: string, data: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${randomUUID()}.tmp`);
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

function load(where: Where): RecordState & { bank: QuestionBank } {
	// A file iCloud has taken off this computer is not there, but it is not gone either:
	// read as empty, the next write would leave two records to collide.
	for (const f of ["concepts.json", "mastery.json", "misconceptions.json", "questions.json"]) {
		if (existsSync(join(where.folder, `.${f}.icloud`))) throw new RecordUnreadable(join(where.folder, f));
	}
	if (existsSync(join(where.folder, "mastery.json")) && !existsSync(join(where.folder, "concepts.json"))) throw new RecordUnreadable(join(where.folder, "concepts.json"));
	return {
		concepts: readJSON(join(where.folder, "concepts.json"), {}),
		mastery: readJSON(join(where.folder, "mastery.json"), {}),
		registry: readJSON(join(where.folder, "misconceptions.json"), {}),
		bank: readJSON(join(where.folder, "questions.json"), {}),
	};
}

/** Friendly names for the clients people use; anything else keeps its own. */
function agentName(client: string | undefined): string {
	const c = (client ?? "").toLowerCase();
	if (c.includes("claude-code") || c === "claude code") return "Claude Code";
	if (c.includes("claude")) return "Claude";
	if (c.includes("codex")) return "Codex";
	if (c.includes("cursor")) return "Cursor";
	if (c.includes("opencode")) return "opencode";
	if (c.includes("copilot")) return "Copilot";
	return client?.slice(0, 40) || "Agent";
}

const INSTRUCTIONS = `Grill keeps a record of what this person knows: every concept from their notes they have been tested on, how likely they are to recall it today, what they got wrong last time, and the misconceptions they keep showing.

Use it in two ways.
1. To help them: at the start of a conversation about what they study, call grill_digest once for a short summary of the record. Before explaining something, call grill_what_they_know or grill_weak_spots on the topic and pitch the explanation at their level. Name the specific confusion if the record shows one.
2. To test them, when they ask to be tested or grilled: get questions from grill_questions. Ask ONE at a time and wait for the answer. Never show the expected answer before they answer. Grade strictly against the expected answer and acceptable answers: "correct", "partial" or "incorrect". Then tell them the verdict and what was missing, and call grill_record_answer for that answer before asking the next question. When an answer shows a confusion the record already names (the misconceptions in grill_weak_spots or grill_what_they_know), record it under that same tag rather than a new one. If there are no stored questions, write your own from their notes and record those too.

Recorded answers update their schedule in Grill, the same as answers given inside Grill.`;

/** For a chat inside Grill, where Test does the testing: the record to read, nothing to
 * quiz with or write. */
const CHAT_INSTRUCTIONS = `Grill keeps a record of what this person knows: every concept from their notes they have been tested on, how likely they are to recall it today, what they got wrong last time, and the misconceptions they keep showing. Before explaining something, call grill_what_they_know or grill_weak_spots on the topic and pitch the explanation at their level; name the specific confusion if the record shows one. Read the record with these tools, not from Grill's files. Don't quiz them here: testing is Grill's Test, where answers are graded and scheduled.`;

export function buildServer(where: Where, chatOnly = false): McpServer {
	const session = randomUUID();
	const server = new McpServer({ name: "grill", version: typeof GRILL_MCP_VERSION === "string" ? GRILL_MCP_VERSION : "0.0.0" }, { instructions: chatOnly ? CHAT_INSTRUCTIONS : INSTRUCTIONS });
	const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
	const empty = () =>
		json({
			empty: true,
			message: where.vault
				? `No Grill record in ${where.folder} yet. The person has not been tested in Grill in this vault.`
				: `No record yet${where.project ? ` for ${where.project}` : ""}. Answers recorded with grill_record_answer start one, in ${where.folder}.`,
		});
	const hasRecord = (s: RecordState) => Object.keys(s.concepts).length + Object.keys(s.mastery).length > 0;
	/** A record file that can't be read is said, never answered as an empty record. */
	const guarded =
		<A,>(run: (a: A) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>) =>
		async (a: A) => {
			try {
				return await run(a);
			} catch (e) {
				return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
			}
		};

	server.registerTool(
		"grill_overview",
		{
			title: "Overview of what they know",
			description: "A summary of the person's record: how many concepts are tested, known and still being learned, how many are due now or fading this week, their weakest notes, and their active misconceptions.",
			inputSchema: {},
		},
		guarded(async () => {
			const s = inView(where, load(where));
			return hasRecord(s) ? json(overview(s)) : empty();
		}),
	);

	server.registerTool(
		"grill_weak_spots",
		{
			title: "Weak spots",
			description: "Concepts the person got wrong or only partly right last time, keeps missing, or is likely to have forgotten, weakest first, with their active misconceptions. Optionally limited to a topic (matched on note names and concept labels).",
			inputSchema: {
				topic: z.string().optional().describe("A topic, note name or concept. Leave out for the whole record."),
				limit: z.number().int().min(1).max(50).optional(),
			},
		},
		guarded(async ({ topic, limit }: { topic?: string; limit?: number }) => {
			const s = inView(where, load(where));
			return hasRecord(s) ? json(weakSpots(s, topic, limit ?? 15)) : empty();
		}),
	);

	server.registerTool(
		"grill_what_they_know",
		{
			title: "What they know about a topic",
			description: "Everything the record holds on a topic: each matching concept with its status, chance of recall today, past answers and when it is due, the notes it comes from, and related misconceptions. Use before explaining something, to pitch it at their level.",
			inputSchema: {
				topic: z.string().min(1).describe("A topic, note name or concept."),
				limit: z.number().int().min(1).max(60).optional(),
			},
		},
		guarded(async ({ topic, limit }: { topic: string; limit?: number }) => {
			const s = inView(where, load(where));
			return hasRecord(s) ? json(whatTheyKnow(s, topic, limit ?? 25)) : empty();
		}),
	);

	if (chatOnly) return server;

	// Grill's own Chat already starts with the digest, so it is offered only outside it.
	server.registerTool(
		"grill_digest",
		{
			title: "Digest of the record",
			description: "Grill's record in a few hundred words, the same digest Grill's own Chat starts with: how much is tested and due, the confusions that still show in recent answers, the weakest concepts with what they wrote last time, confusions fixed lately, and notes that are fully known. Read it once at the start of a conversation about what they study.",
			inputSchema: {
				note: z.string().optional().describe("A note to rank the weakest concepts toward. Leave out for the whole record."),
			},
		},
		guarded(async ({ note }: { note?: string }) => {
			const s = inView(where, load(where));
			if (!hasRecord(s)) return empty();
			const text = learnerBrief({ state: s, ...(note ? { focus: { note, near: [] } } : {}) });
			return { content: [{ type: "text" as const, text: text || "Nothing has been tested yet." }] };
		}),
	);

	server.registerTool(
		"grill_questions",
		{
			title: "Questions to ask",
			description: "Questions Grill already wrote for the concepts most worth testing now (due or weak first), each with its expected answer, acceptable answers and common errors for grading. Ask them one at a time and never reveal the expected answer before the person answers.",
			inputSchema: {
				topic: z.string().optional().describe("A topic or note name. Leave out to pick from the whole record."),
				limit: z.number().int().min(1).max(20).optional(),
			},
		},
		guarded(async ({ topic, limit }: { topic?: string; limit?: number }) => {
			const s = inView(where, load(where));
			if (!hasRecord(s)) return empty();
			const qs = questionsToAsk(s, s.bank, topic, limit ?? 5);
			if (!qs.length) return json({ questions: [], message: "No stored questions match. Write your own from their notes, ask them one at a time, and record each answer." });
			return json({ questions: qs });
		}),
	);

	server.registerTool(
		"grill_record_answer",
		{
			title: "Record an answer",
			description: "Record one graded answer so it counts in the person's Grill record and schedule. Call once per question, right after grading it. Use the conceptId and note from grill_questions or grill_weak_spots when you have them.",
			inputSchema: {
				note: z.string().min(1).max(200).describe("The note (or, in a code repo, the file or topic) the question was about."),
				conceptId: z.string().max(300).optional().describe("The concept id from another grill tool, when the question came from one."),
				label: z.string().optional().describe("A short name for the concept, when there is no conceptId."),
				question: z.string().min(1),
				answer: z.string().describe("What the person answered, in their words."),
				verdict: z.enum(["correct", "partial", "incorrect"]),
				difficulty: z.enum(["easy", "medium", "hard"]).optional(),
				feedback: z.string().optional().describe("What you told them: what was right and what was missing."),
				modelAnswer: z.string().optional().describe("The expected answer."),
				misconception: z
					.object({ tag: z.string().min(1).describe("snake_case name for the confusion, e.g. confuses_stock_with_flow"), label: z.string().describe("One plain sentence describing it.") })
					.optional()
					.describe("Only when the answer showed a specific, nameable confusion. If the record already names it (see the misconceptions other grill tools return), use that tag."),
			},
		},
		guarded(async (a: Record<string, any>) => {
			const via = agentName(server.server.getClientVersion()?.name);
			const raw: AgentResult = {
				v: RESULT_VERSION,
				id: randomUUID(),
				at: new Date().toISOString(),
				via,
				session,
				...(a.conceptId ? { conceptId: a.conceptId } : {}),
				note: a.note,
				...(a.label ? { label: a.label } : {}),
				question: a.question,
				answer: a.answer,
				verdict: a.verdict,
				...(a.difficulty ? { difficulty: a.difficulty } : {}),
				...(a.feedback ? { feedback: a.feedback } : {}),
				...(a.modelAnswer ? { modelAnswer: a.modelAnswer } : {}),
				...(a.misconception ? { misconception: { tag: toTag(a.misconception.tag), label: a.misconception.label } } : {}),
			};
			const r = parseResult(raw);
			if (!r) return { isError: true, content: [{ type: "text" as const, text: "That answer could not be recorded: check note, question and verdict." }] };
			if (where.vault) {
				const s = inView(where, load(where));
				const why = notInVault(s, r);
				if (why) return { isError: true, content: [{ type: "text" as const, text: why }] };
				writeAtomic(join(where.folder, INBOX_DIR, `${r.at.replace(/[:.]/g, "-")}-${r.id.slice(0, 8)}.json`), JSON.stringify(r, null, 1));
				return json({ recorded: true, note: "Grill adds this to the record within a few seconds while it is open, or the next time it starts." });
			}
			recordInRepo(where, r);
			return json({ recorded: true });
		}),
	);

	return server;
}

/** Why a vault won't take this answer, or "" when it will. A vault's concepts come from
 * the plugin, so the answer must be about a note it knows, and about the note its
 * concept belongs to. */
function notInVault(s: RecordState, r: AgentResult): string {
	if (r.conceptId) {
		if (!has(s.concepts, r.conceptId)) return `"${r.conceptId}" is not a concept in the Grill record. Use a conceptId from another grill tool, or leave it out.`;
		if (s.concepts[r.conceptId].note !== r.note) return `That concept belongs to the note "${s.concepts[r.conceptId].note}", not "${r.note}".`;
		return "";
	}
	if (has(s.mastery, r.note) || Object.values(s.concepts).some((c) => c.note === r.note)) return "";
	return `"${r.note}" is not a note in the Grill record. Use a note name or conceptId returned by another grill tool.`;
}

/** One writer at a time on a repo's record: two agents in one repository would
 * otherwise each write back what they read, and lose the other's answers. */
function withLock<T>(folder: string, run: () => T): T {
	mkdirSync(folder, { recursive: true });
	const lock = join(folder, ".lock");
	const until = Date.now() + 5000;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch {
			// A lock left by a writer that died is taken over after 15 seconds.
			// Moved aside under a name of its own first, so of two waiters who both see it
			// stale, only one removes it; the other's rename fails and it waits on.
			try {
				if (Date.now() - statSync(lock).mtimeMs > 15_000) {
					const aside = `${lock}.${randomUUID()}`;
					renameSync(lock, aside);
					unlinkSync(aside);
				}
			} catch {
				/* taken over or gone meanwhile */
			}
			if (Date.now() > until) throw new Error("The record is busy: another agent is writing to it. Try again.");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
	try {
		return run();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			/* already gone */
		}
	}
}

/** Outside a vault there is no plugin, so the answer goes straight into the record,
 * and into a day's log the person can read. */
function recordInRepo(where: Where, r: AgentResult): void {
	// In the home record a concept carries its project's name: "cors/lib/index.js".
	const p = where.project;
	const named = p && !r.note.startsWith(`${p}/`) ? { ...r, note: `${p}/${r.note}`, ...(r.conceptId && !r.conceptId.startsWith(`${p}/`) ? { conceptId: `${p}/${r.conceptId}` } : {}) } : r;
	withLock(where.folder, () => writeRepoRecord(where, named));
}

function writeRepoRecord(where: Where, r: AgentResult): void {
	const s = load(where);
	const { failed } = applyResults(s, [r], { allowNew: true });
	if (failed.length) throw new Error("That answer could not be added to the record as it is. Nothing was changed.");
	// The last good copy of what is about to be replaced, in case a write is cut off.
	for (const f of ["concepts.json", "mastery.json", "misconceptions.json"]) {
		const at = join(where.folder, f);
		if (existsSync(at)) copyFileSync(at, `${at}.bak`);
	}
	writeAtomic(join(where.folder, "concepts.json"), JSON.stringify(s.concepts, null, 1));
	writeAtomic(join(where.folder, "mastery.json"), JSON.stringify(s.mastery, null, 1));
	writeAtomic(join(where.folder, "misconceptions.json"), JSON.stringify(s.registry, null, 1));
	const day = r.at.slice(0, 10);
	const dir = join(where.folder, "Sessions");
	mkdirSync(dir, { recursive: true });
	const label = r.verdict === "correct" ? "Correct" : r.verdict === "partial" ? "Partially correct" : "Incorrect";
	// Made inert like the plugin's session notes: this file may be opened in Obsidian, a
	// Markdown preview or GitHub, and every line of it came from an agent.
	const safe = (t: string) => safeMarkdown(t);
	const lines = [`## ${safe(r.note)}`, "", safe(r.question), "", "> [!quote] Your answer", ...safe(r.answer).split("\n").map((l) => `> ${l}`), "", `**${label}.** ${safe(r.feedback ?? "")}`.trim(), ""];
	if (r.verdict !== "correct" && r.modelAnswer) lines.push(`**Expected answer:** ${safe(r.modelAnswer)}`, "");
	const file = join(dir, `${day}.md`);
	if (!existsSync(file)) writeFileSync(file, `# Grill ${day}\n\nTested by ${safe(r.via)}.\n\n`);
	appendFileSync(file, lines.join("\n") + "\n");
}

/** The same reads and writes as plain commands, for an agent with a shell and no MCP
 * set up (the grill-test skill uses these). Prints JSON; exits 1 on a bad call. */
const COMMANDS = ["overview", "digest", "weak-spots", "know", "questions", "record"];

function runCommand(cmd: string, rest: string[]): number {
	const where = locate();
	const s = cmd === "record" ? load(where) : inView(where, load(where));
	const out = (v: unknown) => console.log(JSON.stringify(v, null, 1));
	const topic = rest.filter((a) => !a.startsWith("--") && !isFlagValue(a, rest)).join(" ").trim() || undefined;
	const empty = !Object.keys(s.concepts).length && !Object.keys(s.mastery).length;
	if (cmd === "record") {
		let raw: Record<string, unknown>;
		try {
			// From the argument, or else from stdin: a heredoc keeps quotes and apostrophes
			// in an answer from breaking the shell command.
			const arg = rest.find((a) => a.trim().startsWith("{"));
			raw = JSON.parse(arg ?? (process.stdin.isTTY ? "" : readFileSync(0, "utf8")));
		} catch {
			console.error('record takes the answer as JSON, as an argument or on stdin: {"note":..., "question":..., "answer":..., "verdict":"correct|partial|incorrect", ...}');
			return 1;
		}
		// The answer's own fields only: when it was given, and its id, are set here.
		const { id: _i, at: _a, v: _v, session: _s, via: _w, ...given } = raw;
		const r = parseResult({ ...given, v: RESULT_VERSION, id: randomUUID(), at: new Date().toISOString(), session: process.env.GRILL_SESSION ?? `cli-${new Date().toISOString().slice(0, 10)}`, via: "Agent", ...(typeof raw.misconception === "object" && raw.misconception ? { misconception: { ...(raw.misconception as object), tag: toTag(String((raw.misconception as { tag?: unknown }).tag ?? "")) } } : {}) });
		if (!r) {
			console.error("That answer could not be recorded: it needs note, question, answer and verdict.");
			return 1;
		}
		if (where.vault) {
			const why = notInVault(s, r);
			if (why) {
				console.error(why);
				return 1;
			}
			writeAtomic(join(where.folder, INBOX_DIR, `${r.at.replace(/[:.]/g, "-")}-${r.id.slice(0, 8)}.json`), JSON.stringify(r, null, 1));
		} else recordInRepo(where, r);
		out({ recorded: true, where: where.folder });
		return 0;
	}
	if (empty) {
		out({ empty: true, where: where.folder });
		return 0;
	}
	if (cmd === "overview") out(overview(s));
	else if (cmd === "digest") console.log(learnerBrief({ state: s, ...(topic ? { focus: { note: topic, near: [] } } : {}) }) || "Nothing has been tested yet.");
	else if (cmd === "weak-spots") out(weakSpots(s, topic, 15));
	else if (cmd === "know") {
		if (!topic) {
			console.error("know takes a topic.");
			return 1;
		}
		out(whatTheyKnow(s, topic, 25));
	} else out({ questions: questionsToAsk(s, s.bank, topic, 5) });
	return 0;
}

/** True for the value after --vault or --dir, which is not part of a topic. */
function isFlagValue(a: string, all: string[]): boolean {
	const i = all.indexOf(a);
	return i > 0 && (all[i - 1] === "--vault" || all[i - 1] === "--dir");
}

const cmd = process.argv[2];
if (process.argv.includes("--version")) {
	console.log(typeof GRILL_MCP_VERSION === "string" ? GRILL_MCP_VERSION : "0.0.0");
} else if (cmd && COMMANDS.includes(cmd)) {
	try {
		process.exitCode = runCommand(cmd, process.argv.slice(3));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
} else if (!process.env.GRILL_MCP_NO_MAIN) {
	const where = locate();
	await buildServer(where, process.argv.includes("--chat")).connect(new StdioServerTransport());
	console.error(`grill-mcp: ${where.vault ? "vault" : "repo"} record at ${where.folder}`);
}
