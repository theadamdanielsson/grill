/** The session note's format: what the plugin and grill-mcp write for each answer, and
 * how it is read back. Kept in one place because the two writers and the readers have to
 * agree on every marker. The frontmatter, the debrief, the explanations and the redo
 * block are the store's own and stay there. No Obsidian here: grill-mcp bundles it. */

import { safeDiagram, safeMarkdown } from "./safemd";
import type { SessionDebrief } from "./debrief";
import type { Verdict } from "./mastery";
import type { Question } from "./question";

/** The lines that mark each part of an answer. A marker only counts after an empty line. */
export const MARK = {
	answer: "> [!quote] Your answer",
	asked: "> [!question] You asked",
	tutor: "> [!note] Grill",
	expected: "**Expected answer:**",
	debrief: "> [!summary] Debrief",
	redo: "Redo",
	redoFence: "```grill-redo",
} as const;

/** One past answer, as a session note records it. */
export interface PastAnswer {
	note: string;
	question: string;
	/** Empty when nothing was answered: the question was skipped or asked about. */
	answer: string;
	result: "correct" | "partial" | "incorrect" | "skipped";
	feedback: string;
	expected: string;
	/** What the student asked under this question afterwards, in order. */
	asked?: string[];
	/** The session's date, YYYY-MM-DD, when the caller knows it. */
	when?: string;
}

export const VERDICT_LABELS: Record<PastAnswer["result"], string> = {
	correct: "Correct",
	partial: "Partially correct",
	incorrect: "Incorrect",
	skipped: "Skipped",
};

const RESULTS = Object.fromEntries(Object.entries(VERDICT_LABELS).map(([k, v]) => [v, k])) as Record<string, PastAnswer["result"]>;

/** A note name that can sit inside a [[link]]. One with ] or | (from an agent or a file
 * made outside Obsidian) is written as plain text instead. */
export function linkable(name: string): boolean {
	return /^[^[\]|#^\n\r]+$/.test(name);
}

/** One answer as it is written. */
export interface AnswerEntry {
	node: string;
	question: string;
	answer: string;
	verdict: "correct" | "partial" | "incorrect";
	gaveUp: boolean;
	feedback: string;
	modelAnswer: string;
}

/** The lines for one answer: the note's heading, the question, the answer quoted, the
 * verdict and, when it wasn't right, the expected answer. Model and agent text is made
 * inert (see safemd.ts). */
export function renderAnswer(e: AnswerEntry, link: boolean): string[] {
	const label = VERDICT_LABELS[e.gaveUp ? "skipped" : e.verdict];
	const lines = [link && linkable(e.node) ? `## [[${e.node}]]` : `## ${safeMarkdown(e.node)}`, "", safeMarkdown(e.question), ""];
	if (!e.gaveUp && e.answer) lines.push(MARK.answer, ...safeMarkdown(e.answer).split("\n").map((l) => `> ${l}`), "");
	lines.push(`**${label}.** ${safeMarkdown(e.feedback)}`, "");
	if (e.verdict !== "correct" && e.modelAnswer) lines.push(`${MARK.expected} ${safeMarkdown(e.modelAnswer)}`, "");
	return lines;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A session's date and time as its file is named: `2026-10-25 14.05`. */
export function stampOf(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/** Reads a session note's file name: the date, the hour and the minute. */
export const STAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})/;

/** Read the questions and answers back out of a session note. It reads exactly what
 * renderAnswer writes: a heading per question naming its note, the question, the answer
 * as a quote, the verdict in bold, the expected answer. What a question or an answer
 * happens to contain must not be mistaken for that structure, since what comes out is
 * told to a model as the student's history:
 * - a line starting "## " inside a code block is code, not the next question;
 * - a callout marker or a verdict only counts after an empty line, which is where the
 *   store puts them, and where quoted text never is;
 * - "Redo" ends the note only when the redo block follows it, so a note that is itself
 *   called Redo is read like any other. */
export function parseSessionNote(text: string): PastAnswer[] {
	const lines = text.split(/\r?\n/);
	const out: PastAnswer[] = [];
	let cur: PastAnswer | null = null;
	let part: "question" | "answer" | "asked" | "feedback" | "expected" | "after" = "question";
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const afterBlank = i === 0 || lines[i - 1].trim() === "";
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		else if (!fenced) {
			const head = /^## (.+)$/.exec(line);
			if (head) {
				const name = head[1].trim().replace(/^\[\[(.+?)\]\]$/, "$1");
				const next = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
				if (name === MARK.redo && next.startsWith(MARK.redoFence)) break;
				if (cur) out.push(cur);
				cur = { note: name, question: "", answer: "", result: "skipped", feedback: "", expected: "" };
				part = "question";
				continue;
			}
		}
		if (!cur) continue;
		if (!fenced && afterBlank) {
			if (line.startsWith(MARK.answer)) {
				part = "answer";
				continue;
			}
			if (line.startsWith(MARK.asked)) {
				(cur.asked ??= []).push("");
				part = "asked";
				continue;
			}
			const verdict = /^\*\*(Correct|Partially correct|Incorrect|Skipped)\.\*\*\s*(.*)$/.exec(line);
			if (verdict) {
				cur.result = RESULTS[verdict[1]];
				cur.feedback = verdict[2].trim();
				part = "feedback";
				continue;
			}
			if (line.startsWith(MARK.expected)) {
				cur.expected = line.slice(MARK.expected.length).trim();
				part = "expected";
				continue;
			}
		}
		if (part === "question") {
			if (line.trim() || fenced) cur.question += (cur.question ? "\n" : "") + line;
		} else if (part === "answer") {
			if (line.startsWith(">")) cur.answer += (cur.answer ? "\n" : "") + line.replace(/^> ?/, "");
			else if (line.trim()) part = "after";
		} else if (part === "asked" && cur.asked) {
			const at = cur.asked.length - 1;
			if (line.startsWith(">")) cur.asked[at] += (cur.asked[at] ? " " : "") + line.replace(/^> ?/, "").trim();
			else part = "after";
		} else if (part === "feedback" || part === "expected") {
			// Either can run over several lines; an empty line ends it.
			if (!line.trim()) part = "after";
			else cur[part] += (cur[part] ? " " : "") + line.trim();
		}
	}
	if (cur) out.push(cur);
	return out.filter((a) => a.question);
}

export interface SessionEntry {
	node: string;
	question: string;
	answer: string;
	verdict: Verdict;
	gaveUp: boolean;
	feedback: string;
	modelAnswer: string;
	/** Follow-ups asked under this question and the tutor's replies, in order. */
	discussion?: Array<{ role: "student" | "tutor"; text: string; diagram?: string; imagePath?: string }>;
	/** What "Explain this" wrote, when it was asked for: kept so it is in the session
	 * note, not paid for and then lost. */
	explanation?: { whatWentWrong: string; keyConcept: string; example: string; diagram: string; relevantImagePath?: string };
}

export interface SessionMeta {
	provider: string;
	model: string;
	startedAt: Date;
	/** True when this session came from "Review N due now" / the due-queue status bar,
	 * not a regular study session, so the note can say so instead of reading identically. */
	dueOnly?: boolean;
}

/** A conversation's turns, as Learn notes and session notes write them: each quoted under
 * who said it, with any diagram after. Made inert (see safemd.ts). */
export function renderTurns(turns: Array<{ role: "student" | "tutor"; text: string; diagram?: string; imagePath?: string }>): string[] {
	const lines: string[] = [];
	for (const turn of turns) {
		const quoted = safeMarkdown(turn.text).split("\n").map((l) => `> ${l}`);
		lines.push(turn.role === "student" ? MARK.asked : MARK.tutor, ...quoted);
		if (turn.imagePath) lines.push(">", `> ![[${turn.imagePath}]]`);
		lines.push("");
		const drawn = safeDiagram(turn.diagram ?? "");
		if (drawn) lines.push("```mermaid", drawn, "```", "");
	}
	return lines;
}

/** A session's note, whole: its properties, the debrief, every answer with what was
 * explained and discussed under it, and the questions again for Redo. */
export function renderSessionNote(entries: SessionEntry[], meta: SessionMeta, link: boolean, debrief?: SessionDebrief, redoQuestions: Question[] = []): string {
	const d = meta.startedAt;
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = stampOf(d);
	const right = entries.filter((e) => e.verdict === "correct").length;

	// `correct` and `total` are numbers so a Bases view can sort and filter on them
	// (`score` is text, kept for the heatmap and older notes). `notes` lists the
	// tested notes, so a view can filter sessions by note: as links, or as plain
	// names when sessions aren't linked to notes.
	const tested = [...new Set(entries.map((e) => e.node))].filter(linkable);
	const lines: string[] = [
		"---",
		`date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		`score: ${right}/${entries.length}`,
		`correct: ${right}`,
		`total: ${entries.length}`,
		...(tested.length ? ["notes:", ...tested.map((n) => `  - ${JSON.stringify(link ? `[[${n}]]` : n)}`)] : []),
		`type: ${meta.dueOnly ? "due review" : "study session"}`,
		`provider: ${meta.provider}`,
		`model: ${meta.model}`,
		"---",
		"",
		`# Grill ${meta.dueOnly ? "due review" : "session"} ${stamp}`,
		"",
	];

	// Everything a model wrote is made inert before it is written here: this note is
	// rendered by Obsidian on every opening, long after the session. See safemd.ts.
	/** Model text, safe, with its later lines kept inside the quote it is written in. */
	const quote = (text: string): string => safeMarkdown(text).split("\n").join("\n> ");

	if (debrief) {
		lines.push(MARK.debrief, `> ${quote(debrief.headline)}`);
		if (debrief.pattern) lines.push(">", `> **Recurring pattern:** ${quote(debrief.pattern)}`);
		if (debrief.gaps.length) {
			lines.push(">", "> **To review:**");
			for (const g of debrief.gaps) {
				const noteRef = link ? `[[${g.note}]]` : g.note;
				lines.push(`> - **${quote(g.concept)}** (${noteRef}): ${quote(g.why)}`);
			}
		}
		if (debrief.nextFocus.length) {
			const focus = debrief.nextFocus.map((n) => (link ? `[[${n}]]` : n)).join(", ");
			lines.push(">", `> **Study next:** ${focus}`);
		}
		lines.push("");
	}
	for (const e of entries) {
		lines.push(...renderAnswer(e, link));
		// What was asked afterwards, and what the tutor said: often the part worth rereading.
		const x = e.explanation;
		if (x) {
			lines.push("> [!info] Explanation");
			for (const [label, text] of [["What went wrong", x.whatWentWrong], ["Key concept", x.keyConcept], ["Example", x.example]] as const) {
				if (text) lines.push(`> **${label}.** ${quote(text)}`, ">");
			}
			if (x.relevantImagePath) lines.push(`> ![[${x.relevantImagePath}]]`, ">");
			if (lines[lines.length - 1] === ">") lines.pop();
			lines.push("");
			const drawn = safeDiagram(x.diagram ?? "");
			if (drawn) lines.push("```mermaid", drawn, "```", "");
		}
		lines.push(...renderTurns(e.discussion ?? []));
	}

	// Embed the asked questions (full grading rubric intact) so "Redo this quiz" can
	// re-serve them with no model call. Rendered as a button by the grill-redo code
	// block processor; bridge/missing-link questions are one-offs, so they're excluded.
	const redo = redoQuestions
		.filter((q) => !q.missingLink)
		.map((q) => ({
			node: q.node,
			conceptId: q.conceptId,
			question: q.question,
			difficulty: q.difficulty,
			modelAnswer: q.modelAnswer,
			acceptableAnswers: q.acceptableAnswers,
			commonErrors: q.commonErrors,
			hints: q.hints,
			...(q.authored ? { authored: true, rubric: q.rubric } : {}),
			...(q.targetsMisconception ? { targetsMisconception: q.targetsMisconception } : {}),
			...(q.type && q.type !== "write"
				? { type: q.type, choices: q.choices, correctChoices: q.correctChoices, pairs: q.pairs }
				: {}),
		}));
	if (redo.length) {
		lines.push(`## ${MARK.redo}`, "", MARK.redoFence, JSON.stringify({ v: 1, questions: redo }), "```", "");
	}
	return lines.join("\n");
}
