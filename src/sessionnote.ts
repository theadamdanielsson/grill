/** The session note's format: what the plugin and grill-mcp write for each answer, and
 * how it is read back. Kept in one place because the two writers and the readers have to
 * agree on every marker. The frontmatter, the debrief, the explanations and the redo
 * block are the store's own and stay there. No Obsidian here: grill-mcp bundles it. */

import { safeMarkdown } from "./safemd";

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
