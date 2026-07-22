/** Deterministic question generation from a note's own structure, with no model.
 *
 * A text model isn't needed to make a passable recall prompt: a note already carries
 * the signal in its bold terms, highlights, headings, definitions and formulas. This
 * pulls those out and turns them into cloze and recall questions so Grill can quiz you
 * with no API key at all. Quality tracks how well-structured the note is, so this is
 * picky about what it blanks: definitions and formulas make good questions, filler
 * sentences do not.
 */

import { Question } from "./llm";

interface LocalItem {
	/** The prompt shown to the user. */
	question: string;
	/** What's revealed for self-grading: the source line, term, or formula. */
	answer: string;
}

const BLANK = "\\_\\_\\_\\_\\_"; // renders as literal underscores, not emphasis

/** Headings too generic to make a useful recall prompt. */
const GENERIC_HEADINGS = new Set([
	"overview",
	"notes",
	"summary",
	"introduction",
	"intro",
	"contents",
	"references",
	"links",
	"todo",
	"index",
	"misc",
	"other",
]);

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"of",
	"to",
	"in",
	"on",
	"is",
	"are",
	"was",
	"it",
	"this",
	"that",
	"these",
	"those",
	"for",
	"with",
	"as",
	"by",
]);

function stripFrontmatter(text: string): string {
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		if (end !== -1) return text.slice(end + 4);
	}
	return text;
}

function wordCount(s: string): number {
	return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Is a blanked term worth asking about? Not a stopword, not a bare number, not too long. */
function goodTerm(term: string): boolean {
	const t = term.trim();
	if (t.length < 3 || t.length > 45) return false;
	if (wordCount(t) > 5) return false;
	if (/^[\d\s.,%$-]+$/.test(t)) return false; // pure numbers/punctuation
	if (STOPWORDS.has(t.toLowerCase())) return false;
	return true;
}

/** Blank the first emphasised (**bold** or ==highlight==) term in a prose line. */
function clozeFromEmphasis(line: string): LocalItem | null {
	if (wordCount(line) < 6) return null;
	const m = /\*\*(.+?)\*\*|==(.+?)==/.exec(line);
	if (!m) return null;
	const term = (m[1] ?? m[2] ?? "").trim();
	if (!goodTerm(term)) return null;
	const plain = line.replace(/[*=]/g, "").trim();
	// Blank only the first occurrence, so the rest of the sentence stays as context.
	const blanked = plain.replace(term, BLANK);
	if (blanked === plain) return null; // term not found after unescaping
	return { question: `Fill in the blank: ${blanked}`, answer: `**${term}** — ${plain}` };
}

/** "Term: definition" or "Term - definition" lines become a define-this prompt. */
function defineFromLine(line: string): LocalItem | null {
	const m = /^\s*[-*]?\s*\*{0,2}([A-Z][^:*\n]{1,45}?)\*{0,2}\s*[:–—-]\s+(.{15,})$/.exec(line);
	if (!m) return null;
	const term = m[1].trim();
	const def = m[2].trim();
	if (/https?$/i.test(term) || term.includes("http")) return null;
	if (!goodTerm(term) || wordCount(def) < 3) return null;
	return { question: `Define **${term}**.`, answer: `**${term}:** ${def}` };
}

/** A line carrying LaTeX becomes a recall-the-formula prompt, headed by its context. */
function formulaFromLine(line: string, heading: string): LocalItem | null {
	if (!/\$.+\$/.test(line) && !line.includes("$$")) return null;
	const math = line.trim();
	if (math.replace(/\$/g, "").trim().length < 3) return null;
	const context = heading || "this note";
	return { question: `Recall the formula from **${context}**.`, answer: math };
}

/** A heading with a body becomes a free-recall prompt. */
function recallFromHeading(heading: string, body: string): LocalItem | null {
	const h = heading.trim();
	if (!h || GENERIC_HEADINGS.has(h.toLowerCase()) || wordCount(h) > 8) return null;
	const trimmed = body.trim();
	if (trimmed.length < 25) return null;
	const answer = trimmed.length > 500 ? trimmed.slice(0, 500).trim() + "…" : trimmed;
	return { question: `Recall what you know about **${h}**.`, answer };
}

/** Extract up to `cap` distinct question items from one note's text. */
function itemsForNote(text: string, cap: number): LocalItem[] {
	const body = stripFrontmatter(text);
	const lines = body.split("\n");
	const items: LocalItem[] = [];
	const seen = new Set<string>();
	const push = (it: LocalItem | null) => {
		if (!it) return;
		const key = it.question.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		items.push(it);
	};

	let heading = "";
	let sectionBody: string[] = [];
	const flushHeading = () => {
		if (heading) push(recallFromHeading(heading, sectionBody.join("\n")));
	};

	for (const raw of lines) {
		const line = raw.trim();
		const hm = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
		if (hm) {
			flushHeading();
			heading = hm[2];
			sectionBody = [];
			continue;
		}
		if (line) sectionBody.push(line);
		if (!line || /^[-*>|]/.test(line) === false) {
			// prose line: try cloze / definition
			push(defineFromLine(line));
			push(clozeFromEmphasis(line));
		} else {
			// list/callout line can still hold a definition or emphasis
			push(defineFromLine(line.replace(/^[-*>\s]+/, "")));
			push(clozeFromEmphasis(line));
		}
		push(formulaFromLine(line, heading));
	}
	flushHeading();
	return items.slice(0, cap);
}

const ITEM_CAP_PER_NOTE = 6;

/** Build up to `count` questions from the given notes with no model call. Questions are
 * spread across notes round-robin, so a session samples breadth before depth. */
export function generateLocalQuestions(notes: { name: string; text: string }[], count: number): Question[] {
	const perNote = notes.map((n) => ({ name: n.name, items: itemsForNote(n.text, ITEM_CAP_PER_NOTE) }));
	const out: Question[] = [];
	let progressed = true;
	for (let round = 0; progressed && out.length < count; round++) {
		progressed = false;
		for (const n of perNote) {
			if (out.length >= count) break;
			const it = n.items[round];
			if (!it) continue;
			progressed = true;
			out.push({
				node: n.name,
				question: it.question,
				difficulty: "medium",
				modelAnswer: it.answer,
				acceptableAnswers: [],
				commonErrors: [],
				hints: { tier1: "", tier2: "", tier3: "" },
			});
		}
	}
	return out;
}
