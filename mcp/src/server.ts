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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
} from "../../src/record";
import type { QuestionBank } from "../../src/store";

declare const GRILL_MCP_VERSION: string;

interface Where {
	/** The folder holding concepts.json and the rest. */
	folder: string;
	/** True in an Obsidian vault: the plugin owns the record files there. */
	vault: boolean;
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
	const cwd = process.cwd();
	if (existsSync(join(cwd, ".obsidian"))) return { folder: join(cwd, grillFolderName(cwd)), vault: true };
	return { folder: join(cwd, ".grill"), vault: false };
}

function readJSON<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Written next to its target under a dot name (which Obsidian doesn't index), then
 * moved into place, so nobody ever reads half a file. */
function writeAtomic(path: string, data: string): void {
	const dir = path.slice(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${randomUUID()}.tmp`);
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

function load(where: Where): RecordState & { bank: QuestionBank } {
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
1. To help them: before explaining something, call grill_what_they_know or grill_weak_spots on the topic and pitch the explanation at their level. Name the specific confusion if the record shows one.
2. To test them, when they ask to be tested or grilled: get questions from grill_questions. Ask ONE at a time and wait for the answer. Never show the expected answer before they answer. Grade strictly against the expected answer and acceptable answers: "correct", "partial" or "incorrect". Then tell them the verdict and what was missing, and call grill_record_answer for that answer before asking the next question. If there are no stored questions, write your own from their notes and record those too.

Recorded answers update their schedule in Grill, the same as answers given inside Grill.`;

export function buildServer(where: Where): McpServer {
	const session = randomUUID();
	const server = new McpServer({ name: "grill", version: typeof GRILL_MCP_VERSION === "string" ? GRILL_MCP_VERSION : "0.0.0" }, { instructions: INSTRUCTIONS });
	const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
	const empty = () =>
		json({
			empty: true,
			message: where.vault
				? `No Grill record in ${where.folder} yet. The person has not been tested in Grill in this vault.`
				: `No record in ${where.folder} yet. Answers recorded with grill_record_answer start one.`,
		});
	const hasRecord = (s: RecordState) => Object.keys(s.concepts).length + Object.keys(s.mastery).length > 0;

	server.registerTool(
		"grill_overview",
		{
			title: "Overview of what they know",
			description: "A summary of the person's record: how many concepts are tested, known and struggling, how many are due now or fading this week, their weakest notes, and their active misconceptions.",
			inputSchema: {},
		},
		async () => {
			const s = load(where);
			return hasRecord(s) ? json(overview(s)) : empty();
		},
	);

	server.registerTool(
		"grill_weak_spots",
		{
			title: "Weak spots",
			description: "Concepts the person got wrong last time, is struggling with, or is likely to have forgotten, weakest first, with their active misconceptions. Optionally limited to a topic (matched on note names and concept labels).",
			inputSchema: {
				topic: z.string().optional().describe("A topic, note name or concept. Leave out for the whole record."),
				limit: z.number().int().min(1).max(50).optional(),
			},
		},
		async ({ topic, limit }) => {
			const s = load(where);
			return hasRecord(s) ? json(weakSpots(s, topic, limit ?? 15)) : empty();
		},
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
		async ({ topic, limit }) => {
			const s = load(where);
			return hasRecord(s) ? json(whatTheyKnow(s, topic, limit ?? 25)) : empty();
		},
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
		async ({ topic, limit }) => {
			const s = load(where);
			if (!hasRecord(s)) return empty();
			const qs = questionsToAsk(s, s.bank, topic, limit ?? 5);
			if (!qs.length) return json({ questions: [], message: "No stored questions match. Write your own from their notes, ask them one at a time, and record each answer." });
			return json({ questions: qs });
		},
	);

	server.registerTool(
		"grill_record_answer",
		{
			title: "Record an answer",
			description: "Record one graded answer so it counts in the person's Grill record and schedule. Call once per question, right after grading it. Use the conceptId and note from grill_questions or grill_weak_spots when you have them.",
			inputSchema: {
				note: z.string().min(1).describe("The note (or, in a code repo, the file or topic) the question was about."),
				conceptId: z.string().optional().describe("The concept id from another grill tool, when the question came from one."),
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
					.describe("Only when the answer showed a specific, nameable confusion."),
			},
		},
		async (a) => {
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
				const s = load(where);
				const known = (r.conceptId && s.concepts[r.conceptId]) || s.mastery[r.note] || Object.values(s.concepts).some((c) => c.note === r.note);
				if (!known) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: `"${r.note}" is not a note in the Grill record. Use a note name or conceptId returned by another grill tool.` }],
					};
				}
				writeAtomic(join(where.folder, INBOX_DIR, `${r.at.replace(/[:.]/g, "-")}-${r.id.slice(0, 8)}.json`), JSON.stringify(r, null, 1));
				return json({ recorded: true, note: "Grill folds this into the record the next time it is open and not mid-session." });
			}
			recordInRepo(where, r);
			return json({ recorded: true });
		},
	);

	return server;
}

/** Outside a vault there is no plugin, so the answer goes straight into the record,
 * and into a day's log the person can read. */
function recordInRepo(where: Where, r: AgentResult): void {
	const s = load(where);
	applyResults(s, [r], { allowNew: true });
	writeAtomic(join(where.folder, "concepts.json"), JSON.stringify(s.concepts, null, 1));
	writeAtomic(join(where.folder, "mastery.json"), JSON.stringify(s.mastery, null, 1));
	writeAtomic(join(where.folder, "misconceptions.json"), JSON.stringify(s.registry, null, 1));
	const day = r.at.slice(0, 10);
	const dir = join(where.folder, "Sessions");
	mkdirSync(dir, { recursive: true });
	const label = r.verdict === "correct" ? "Correct" : r.verdict === "partial" ? "Partially correct" : "Incorrect";
	const lines = [`## ${r.note}`, "", r.question, "", "> [!quote] Your answer", ...r.answer.split("\n").map((l) => `> ${l}`), "", `**${label}.** ${r.feedback ?? ""}`.trim(), ""];
	if (r.verdict !== "correct" && r.modelAnswer) lines.push(`**Expected answer:** ${r.modelAnswer}`, "");
	const file = join(dir, `${day}.md`);
	if (!existsSync(file)) writeFileSync(file, `# Grill ${day}\n\nTested by ${r.via}.\n\n`);
	appendFileSync(file, lines.join("\n") + "\n");
}

if (process.argv.includes("--version")) {
	console.log(typeof GRILL_MCP_VERSION === "string" ? GRILL_MCP_VERSION : "0.0.0");
} else if (!process.env.GRILL_MCP_NO_MAIN) {
	const where = locate();
	await buildServer(where).connect(new StdioServerTransport());
	console.error(`grill-mcp: ${where.vault ? "vault" : "repo"} record at ${where.folder}`);
}
