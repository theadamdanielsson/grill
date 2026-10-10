/**
 * Learn: what a conversation about a note is given to read. Pure text handling, no
 * model and no vault access, so what is sent can be tested.
 */
import { safeSlice } from "./text";

export interface LearnNote {
	name: string;
	text: string;
}

/** Most of the budget goes to the note being asked about; each note it links to gets
 * a share, since a question about one note often turns on what the next one defines. */
export const LEARN_CAPS = { note: 12000, linked: 1500, maxLinked: 4 };

/** A note's text as a prompt should see it: without the frontmatter block. */
export function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** The note, and the notes it links to, cut to size. Linked notes that are empty once
 * stripped are left out, and no more than `maxLinked` are sent, in the order given. */
export function learnContext(main: LearnNote, linked: LearnNote[], caps = LEARN_CAPS): { noteText: string; linkedText: string } {
	const noteText = safeSlice(stripFrontmatter(main.text), caps.note);
	const parts: string[] = [];
	for (const n of linked) {
		if (parts.length >= caps.maxLinked) break;
		if (n.name === main.name) continue;
		const text = safeSlice(stripFrontmatter(n.text), caps.linked);
		if (text) parts.push(`'${n.name}':\n${text}`);
	}
	return { noteText, linkedText: parts.join("\n\n") };
}

/** How a saved session reads in a list: the notes it covered, the first by name and
 * the rest as a count. `headings` are the session note's own second-level headings,
 * one per question, which name the note each question came from. */
export function sessionTitle(headings: string[]): string {
	const notes = [...new Set(headings.map((h) => h.trim()).filter((h) => h && h !== "Redo"))];
	if (!notes.length) return "";
	return notes.length === 1 ? notes[0] : `${notes[0]} +${notes.length - 1}`;
}

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

const RESULTS: Record<string, PastAnswer["result"]> = {
	Correct: "correct",
	"Partially correct": "partial",
	Incorrect: "incorrect",
	Skipped: "skipped",
};

/** Read the questions and answers back out of a session note. It reads exactly what
 * the store writes (a heading per question naming its note, the question, the answer
 * as a quote, the verdict in bold, the expected answer), and nothing after "Redo". */
export function parseSessionNote(text: string): PastAnswer[] {
	const out: PastAnswer[] = [];
	let cur: PastAnswer | null = null;
	let part: "question" | "answer" | "asked" | "after" = "question";
	for (const line of text.split(/\r?\n/)) {
		const head = /^## (.+)$/.exec(line);
		if (head) {
			if (cur) out.push(cur);
			const name = head[1].trim().replace(/^\[\[(.+?)\]\]$/, "$1");
			if (name === "Redo") {
				cur = null;
				break;
			}
			cur = { note: name, question: "", answer: "", result: "skipped", feedback: "", expected: "" };
			part = "question";
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("> [!quote] Your answer")) {
			part = "answer";
			continue;
		}
		if (line.startsWith("> [!question] You asked")) {
			(cur.asked ??= []).push("");
			part = "asked";
			continue;
		}
		const verdict = /^\*\*(Correct|Partially correct|Incorrect|Skipped)\.\*\*\s*(.*)$/.exec(line);
		if (verdict) {
			cur.result = RESULTS[verdict[1]];
			cur.feedback = verdict[2].trim();
			part = "after";
			continue;
		}
		const expected = /^\*\*Expected answer:\*\*\s*(.*)$/.exec(line);
		if (expected) {
			cur.expected = expected[1].trim();
			continue;
		}
		if (part === "question" && line.trim()) cur.question += (cur.question ? "\n" : "") + line;
		else if (part === "answer") {
			if (line.startsWith(">")) cur.answer += (cur.answer ? "\n" : "") + line.replace(/^> ?/, "");
			else if (line.trim()) part = "after";
		} else if (part === "asked" && cur.asked) {
			const at = cur.asked.length - 1;
			if (line.startsWith(">")) cur.asked[at] += (cur.asked[at] ? " " : "") + line.replace(/^> ?/, "").trim();
			else part = "after";
		}
	}
	if (cur) out.push(cur);
	return out.filter((a) => a.question);
}

export interface LearnRecordInput {
	concepts: Array<{ label: string; correct: number; partial: number; incorrect: number; lastMissed: boolean }>;
	misconceptions: Array<{ label: string; count: number; status: string }>;
	/** Newest first. */
	answers: PastAnswer[];
	/** What the student has asked about this note before, in Learn or under a question,
	 * newest first. */
	asked?: string[];
}

/** What Grill has on record about one note, in words a model can answer from: how each
 * concept has gone, the confusions the grader has named, and the most recent answers
 * as they were given. Empty when the note has never been tested. Cut to `cap`. */
export function learnRecord(r: LearnRecordInput, cap = 6000): string {
	const tested = r.concepts.filter((c) => c.correct + c.partial + c.incorrect > 0);
	const asked = (r.asked ?? []).filter(Boolean);
	if (!tested.length && !r.answers.length && !r.misconceptions.length && !asked.length) return "";
	const lines: string[] = [];
	if (tested.length) {
		const sum = (k: "correct" | "partial" | "incorrect"): number => tested.reduce((n, c) => n + c[k], 0);
		lines.push(`Answers so far on this note: ${sum("correct")} right, ${sum("partial")} partly right, ${sum("incorrect")} wrong or skipped.`);
		lines.push("By concept (right / partly / wrong):");
		for (const c of tested) lines.push(`- ${c.label}: ${c.correct} / ${c.partial} / ${c.incorrect}${c.lastMissed ? ", last answer missed" : ""}`);
	}
	const active = r.misconceptions.filter((m) => m.status !== "dismissed");
	if (active.length) {
		lines.push("Confusions the grader has named here:");
		for (const m of active) lines.push(`- ${m.label} (seen ${m.count} time${m.count === 1 ? "" : "s"}, ${m.status === "resolved" ? "since resolved" : "still open"})`);
	}
	if (r.answers.length) {
		lines.push("Recent answers, newest first:");
		r.answers.forEach((a, i) => {
			const said = a.answer ? `Answered: ${a.answer.replace(/\s+/g, " ")}` : "Gave no answer (skipped it or asked for help)";
			lines.push(`${i + 1}.${a.when ? ` [${a.when}]` : ""} Asked: ${a.question.replace(/\s+/g, " ")}`);
			lines.push(`   ${said}`);
			lines.push(`   Marked: ${a.result}.${a.result !== "correct" && a.expected ? ` Expected: ${a.expected.replace(/\s+/g, " ")}` : ""}`);
			// Why it was marked down, in the grader's words, where there was an answer to mark.
			if (a.answer && a.result !== "correct" && a.feedback) lines.push(`   Feedback given: ${a.feedback.replace(/\s+/g, " ")}`);
		});
	}
	if (asked.length) {
		lines.push("What they have asked about this note before, newest first:");
		for (const q of asked) lines.push(`- ${q.replace(/\s+/g, " ")}`);
	}
	return safeSlice(lines.join("\n"), cap);
}

/** The questions asked in a saved Learn conversation: each "You asked" block, in order. */
export function parseLearnNote(text: string): string[] {
	const out: string[] = [];
	let open = false;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("> [!question] You asked")) {
			out.push("");
			open = true;
		} else if (open && line.startsWith(">")) {
			out[out.length - 1] += (out[out.length - 1] ? " " : "") + line.replace(/^> ?/, "").trim();
		} else open = false;
	}
	return out.filter(Boolean);
}

const STOP = new Set(
	"a an and are as at be but by can did do does for from had has have how i if in into is it its me my not of on or so than that the their them then there these they this to was we were what when where which who why will with would you your about tell explain more".split(" "),
);

/** The words of a question or a note that say what it is about. */
export function contentTerms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

/** The notes a question is most likely about, best first: plain term matching, no
 * model. A term counts for more the fewer notes use it, and for more again when it is
 * in a note's name. `prefer` (the open note) wins a near tie, so a question asked
 * while reading something is taken to be about it unless another note fits clearly
 * better. Notes that share no term with the question are left out. */
export function rankNotes(question: string, notes: LearnNote[], k = 5, prefer = ""): LearnNote[] {
	const terms = [...new Set(contentTerms(question))];
	if (!terms.length || !notes.length) return [];
	const bags = notes.map((n) => {
		const words = contentTerms(stripFrontmatter(n.text));
		const tf = new Map<string, number>();
		for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
		return { n, tf, len: words.length, name: new Set(contentTerms(n.name)) };
	});
	const avgLen = bags.reduce((sum, b) => sum + b.len, 0) / bags.length || 1;
	const scored = bags.map((b) => {
		let score = 0;
		for (const t of terms) {
			const df = bags.reduce((c, x) => c + (x.tf.has(t) || x.name.has(t) ? 1 : 0), 0);
			if (!df) continue;
			const idf = Math.log(1 + notes.length / df);
			// A term's count levels off, and counts for less in a long note, so a long
			// sheet that mentions everything doesn't outrank the note that is about it.
			const tf = b.tf.get(t) ?? 0;
			if (tf) score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * b.len) / avgLen));
			if (b.name.has(t)) score += 3 * idf;
		}
		if (score > 0 && b.n.name === prefer) score *= 1.25;
		return { n: b.n, score };
	});
	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
		.map((s) => s.n);
}
