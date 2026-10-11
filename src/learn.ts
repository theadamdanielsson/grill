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
 * the store writes: a heading per question naming its note, the question, the answer
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
				if (name === "Redo" && next.startsWith("```grill-redo")) break;
				if (cur) out.push(cur);
				cur = { note: name, question: "", answer: "", result: "skipped", feedback: "", expected: "" };
				part = "question";
				continue;
			}
		}
		if (!cur) continue;
		if (!fenced && afterBlank) {
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
				part = "feedback";
				continue;
			}
			const expected = /^\*\*Expected answer:\*\*\s*(.*)$/.exec(line);
			if (expected) {
				cur.expected = expected[1].trim();
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

/** The questions asked in a saved Learn conversation: each "You asked" block, in order.
 * The marker only counts after an empty line, which is where the store writes it; a
 * reply that happens to quote the same words sits inside a quote, after a quoted line. */
export function parseLearnNote(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let open = false;
	lines.forEach((line, i) => {
		if (line.startsWith("> [!question] You asked") && (i === 0 || lines[i - 1].trim() === "")) {
			out.push("");
			open = true;
		} else if (open && line.startsWith(">")) {
			out[out.length - 1] += (out[out.length - 1] ? " " : "") + line.replace(/^> ?/, "").trim();
		} else open = false;
	});
	return out.filter(Boolean);
}

const STOP = new Set(
	"a an and are as at be but by can did do does for from had has have how i if in into is it its me my no not of on or so than that the their them then there these they this to up us was we were what when where which who why will with would you your about tell explain more".split(" "),
);

/** Scripts written without spaces between words. A run of them is not one word; it is
 * taken two characters at a time, which is how a question and a note come to share
 * terms in Chinese, Japanese or Thai. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** The words of a question or a note that say what it is about. */
export function contentTerms(text: string): string[] {
	const out: string[] = [];
	for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (UNSPACED.test(w)) {
			const chars = [...w];
			if (chars.length === 1) out.push(w);
			for (let k = 0; k + 1 < chars.length; k++) out.push(chars[k] + chars[k + 1]);
		} else if (w.length > 1 && !STOP.has(w)) out.push(w);
	}
	return out;
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
	// In how many notes each term of the question appears: worked out once.
	const inNotes = new Map(terms.map((t) => [t, bags.reduce((c, x) => c + (x.tf.has(t) || x.name.has(t) ? 1 : 0), 0)] as const));
	const scored = bags.map((b) => {
		let score = 0;
		for (const t of terms) {
			const df = inNotes.get(t) ?? 0;
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

/** A note as the vault map lists it. */
export interface VaultNote extends LearnNote {
	folder: string;
	/** How many other notes link to this one. */
	linksIn: number;
	/** How the student is doing on it, in a word or two. */
	status: string;
}

/** Every note in the vault on a line: its name, where it is, how many notes link to
 * it and how the student is doing on it. Small enough to send with every question, and
 * what lets an answer speak about the vault as a whole or point at a note it wasn't
 * given in full. Always in the same order, so it is read from the provider's cache. */
export function vaultMap(notes: VaultNote[], cap = 40_000): string {
	const lines = [...notes]
		.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
		.map((n) => `- ${n.name} [${n.folder || "top level"}; linked from ${n.linksIn}; ${n.status}]`);
	return `MAP OF EVERY NOTE (${notes.length}), as name [folder; how many notes link to it; how the student is doing]:\n${safeSlice(lines.join("\n"), cap)}`;
}

/** The notes themselves, for a question about the vault as a whole: as many in full as
 * fit `budget` characters. When they all fit they go in a fixed order (folder, then
 * name), so the same text is sent every time and a provider's cache can serve it at a
 * fraction of the price after the first question. When they don't, the most linked-to
 * notes go first, since those are the ones the rest lean on. */
export function vaultNotes(notes: VaultNote[], budget: number): { text: string; included: number } {
	const bodies = notes.map((n) => ({ n, text: stripFrontmatter(n.text) })).filter((b) => b.text);
	const total = bodies.reduce((sum, b) => sum + b.text.length + b.n.name.length + 6, 0);
	const fits = total <= budget;
	bodies.sort(fits ? (a, b) => a.n.folder.localeCompare(b.n.folder) || a.n.name.localeCompare(b.n.name) : (a, b) => b.n.linksIn - a.n.linksIn || a.n.name.localeCompare(b.n.name));
	const parts: string[] = [];
	let used = 0;
	for (const b of bodies) {
		const block = `'${b.n.name}':\n${b.text}`;
		if (used + block.length > budget) continue;
		parts.push(block);
		used += block.length + 2;
	}
	return { text: `NOTES IN FULL (${parts.length} of ${notes.length}):\n${parts.join("\n\n")}`, included: parts.length };
}

/** Words that are about a collection of notes, not about what any one of them says. */
const VAULT_WORDS = new Set(
	"note notes vault course subject module everything overall overview whole syllabus topic topics chapter chapters backbone structure summary summarise summarize big picture outline".split(" "),
);

/** Whether a question is about the notes as a whole: "which notes are the backbone of
 * the course?", "give me an overview of everything". Read from its words, in English;
 * a question in another language is taken to be about its topic. */
export function aboutTheVault(question: string): boolean {
	return contentTerms(question).some((w) => VAULT_WORDS.has(w));
}

/** Whether a question names one of the notes it matched: "why does inflation matter?"
 * and a note called Inflation. Words about the vault itself don't count, so "which
 * notes are the backbone of the course?" does not name a note called "Course notes". */
export function namesANote(question: string, matched: string[]): boolean {
	const terms = new Set(contentTerms(question).filter((w) => !VAULT_WORDS.has(w)));
	return matched.some((name) => contentTerms(name).some((w) => terms.has(w)));
}

/** A file name for a reply kept as a note: its first line without Markdown's marks or
 * the characters a file name can't hold, cut at a word. Empty when nothing is left. */
export function replyTitle(firstLine: string): string {
	const plain = firstLine
		.replace(/^#+\s*/, "")
		.replace(/\$[^$]*\$/g, "")
		.replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, "$1")
		.replace(/[*_`#[\]\\/:?"<>|^]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.:;,]+$/, "")
		.trim();
	if (plain.length <= 60) return plain;
	const cut = plain.slice(0, 60);
	return cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 60).trim();
}
