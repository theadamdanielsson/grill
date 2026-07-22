/** Deterministic question generation from a note's own structure, with no model.
 *
 * Two jobs, in priority order:
 *
 *  1. Respect cards the user already hand-authored in the conventions of the big
 *     spaced-repetition tools, so an existing deck inside a note just works:
 *       - Obsidian Spaced Repetition cloze  ==answer==  (and ==1;;answer;;hint==)
 *       - Anki cloze  {{c1::answer::hint}}  (same number grouped, different = separate)
 *       - Obsidian SR Q&A separators  a::b  a:::b (reversed)  and multi-line ? / ??
 *
 *  2. Where the note has no explicit cards, generate them from its structure — a
 *     thing none of those tools do, since they're all manual: bold terms become
 *     cloze, headings become recall prompts, "Term: definition" lines and LaTeX
 *     become their own questions.
 *
 * Quality tracks how well-structured the note is, so this is picky about what it
 * blanks: it skips stopwords, bare numbers, code, tables and generic headings.
 */

import { Question } from "./llm";

interface LocalItem {
	question: string;
	/** Revealed for self-grading: the source line, term, or formula. */
	answer: string;
	/** Optional hint carried from an Anki/SR cloze (::hint / ;;hint). */
	hint?: string;
}

const BLANK = "\\_\\_\\_\\_\\_"; // renders as literal underscores, not emphasis

const GENERIC_HEADINGS = new Set([
	"overview", "notes", "summary", "introduction", "intro", "contents",
	"references", "links", "todo", "index", "misc", "other", "see also",
]);

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "is", "are",
	"was", "were", "it", "this", "that", "these", "those", "for", "with", "as",
	"by", "at", "be", "from",
]);

/** Strongly definitional verbs — kept deliberately narrow to avoid turning every
 * "X is high" sentence into a bogus definition. */
const DEFINITION_VERB = /\s+(?:refers to|means|is defined as|are defined as|denotes|stands for)\s+/i;

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

/** Is an auto-blanked term worth asking about? (Explicit user clozes bypass this.) */
function goodTerm(term: string): boolean {
	const t = term.trim();
	if (t.length < 3 || t.length > 60) return false;
	if (wordCount(t) > 6) return false;
	if (/^[\d\s.,%$+×·-]+$/.test(t)) return false; // pure numbers / operators
	if (STOPWORDS.has(t.toLowerCase())) return false;
	return true;
}

// --------------------------------------------------------------- inline parsing

type MarkKind = "anki" | "highlight" | "curly" | "bold";

interface Mark {
	start: number; // position in the display string
	end: number;
	text: string;
	hint?: string;
	group: string; // marks sharing a group are blanked on the same card
	kind: MarkKind;
}

// Order matters: Anki `{{c1::..}}` before the generic curly `{{..}}`.
const INLINE_RE = new RegExp(
	"\\{\\{c(\\d+)::([^}]+?)(?:::([^}]+?))?\\}\\}" + // 1=cN 2=text 3=hint
		"|==(?:(\\d+);;)?([^=]+?)(?:;;([^=]+?))?==" + // 4=seq 5=text 6=hint
		"|\\{\\{([^}]+?)\\}\\}" + // 7=text
		"|\\*\\*([^*]+?)\\*\\*", // 8=text
	"g",
);

/** Split a line into a plain display string plus the marks found in it. Every
 * marker's delimiters are removed so the display reads naturally; each mark
 * records where its text sits in that display so it can be blanked precisely. */
function parseInline(line: string): { display: string; marks: Mark[] } {
	let display = "";
	let last = 0;
	let uid = 0;
	const marks: Mark[] = [];
	INLINE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = INLINE_RE.exec(line))) {
		display += line.slice(last, m.index);
		last = m.index + m[0].length;
		let text: string, hint: string | undefined, group: string, kind: MarkKind;
		if (m[1] !== undefined) {
			text = m[2]; hint = m[3]; group = `a${m[1]}`; kind = "anki";
		} else if (m[5] !== undefined) {
			text = m[5]; hint = m[6]; group = m[4] ? `h${m[4]}` : `u${uid++}`; kind = "highlight";
		} else if (m[7] !== undefined) {
			text = m[7]; group = `u${uid++}`; kind = "curly";
		} else {
			text = m[8]; group = `u${uid++}`; kind = "bold";
		}
		const start = display.length;
		display += text;
		marks.push({ start, end: display.length, text: text.trim(), hint: hint?.trim(), group, kind });
	}
	display += line.slice(last);
	return { display, marks };
}

/** Cloze cards from one line. Explicit user markers (==, {{ }}) win; otherwise
 * bold is used as an auto signal. One card per group; other marks stay visible. */
function clozeCards(line: string): LocalItem[] {
	const { display, marks } = parseInline(line);
	if (!marks.length) return [];
	const explicit = marks.filter((k) => k.kind !== "bold");
	const cloze = explicit.length ? explicit : marks; // bold-only lines use bold
	const auto = explicit.length === 0; // bold-derived cards get the quality filter

	const groups = new Map<string, Mark[]>();
	for (const mk of cloze) {
		const g = groups.get(mk.group);
		if (g) g.push(mk);
		else groups.set(mk.group, [mk]);
	}

	const out: LocalItem[] = [];
	for (const group of groups.values()) {
		const termText = group.map((g) => g.text).join(" / ");
		if (auto && !goodTerm(termText)) continue;
		if (!termText) continue;
		// Blank this group's spans right-to-left so earlier indices stay valid.
		let q = display;
		for (const g of [...group].sort((a, b) => b.start - a.start)) {
			q = q.slice(0, g.start) + BLANK + q.slice(g.end);
		}
		// Need enough surrounding context for the blank to be answerable.
		if (wordCount(q.split(BLANK).join(" ")) < 3) continue;
		out.push({
			question: `Fill in the blank: ${q.trim()}`,
			answer: `**${termText}** — ${display.trim()}`,
			hint: group.find((g) => g.hint)?.hint,
		});
	}
	return out;
}

// ------------------------------------------------------------ line heuristics

/** Single-line Q&A: `front::back` (one card) or `front:::back` (both directions). */
function qaCards(line: string): LocalItem[] {
	const rev = line.includes(":::");
	const sep = rev ? ":::" : line.includes("::") ? "::" : null;
	if (!sep) return [];
	const i = line.indexOf(sep);
	const front = line.slice(0, i).trim();
	const back = line.slice(i + sep.length).trim();
	if (!front || back.length < 2 || wordCount(front) > 25) return [];
	const cards: LocalItem[] = [{ question: front, answer: back }];
	if (rev) cards.push({ question: back, answer: front });
	return cards;
}

/** "Term: definition" or "Term refers to definition" → a define-this prompt. */
function definitionCard(line: string): LocalItem | null {
	const colon = /^\s*[-*]?\s*([A-Z][^:*\n]{1,50}?)\s*:\s+(.{15,})$/.exec(line);
	if (colon && !line.includes("http")) {
		const term = colon[1].trim();
		if (goodTerm(term) && wordCount(colon[2]) >= 3) {
			return { question: `Define **${term}**.`, answer: `**${term}:** ${colon[2].trim()}` };
		}
	}
	const verb = DEFINITION_VERB.exec(line);
	if (verb) {
		const term = line.slice(0, verb.index).replace(/^(?:the|an?)\s+/i, "").trim();
		const def = line.slice(verb.index + verb[0].length).trim();
		if (goodTerm(term) && wordCount(def) >= 3) {
			return { question: `Define **${term}**.`, answer: line.trim() };
		}
	}
	return null;
}

const MATH_RE = /\$\$[^$]+\$\$|\$[^$]+\$/;

/** LaTeX becomes a cloze if the line has prose around it, else a recall prompt. */
function formulaCard(line: string, context: string): LocalItem | null {
	const mm = MATH_RE.exec(line);
	if (!mm) return null;
	const math = mm[0];
	if (math.replace(/\$/g, "").trim().length < 3) return null;
	const surrounding = line.replace(MATH_RE, " ").trim();
	if (wordCount(surrounding) >= 3) {
		const q = line.slice(0, mm.index) + BLANK + line.slice(mm.index + math.length);
		return { question: `Fill in the blank: ${q.trim()}`, answer: math };
	}
	const label = context || "this note";
	return { question: `Recall the formula from **${label}**.`, answer: math };
}

function headingCard(heading: string, body: string): LocalItem | null {
	const h = heading.trim();
	if (!h || GENERIC_HEADINGS.has(h.toLowerCase()) || wordCount(h) > 8) return null;
	const trimmed = body.trim();
	if (trimmed.length < 25) return null;
	const answer = trimmed.length > 500 ? trimmed.slice(0, 500).trim() + "…" : trimmed;
	return { question: `Recall what you know about **${h}**.`, answer };
}

// ------------------------------------------------------------ per-note walk

const ITEM_CAP_PER_NOTE = 12;

function itemsForNote(text: string, cap: number): LocalItem[] {
	const body = stripFrontmatter(text).replace(/<!--[\s\S]*?-->/g, "");
	const lines = body.split("\n");
	const items: LocalItem[] = [];
	const seen = new Set<string>();
	const push = (it: LocalItem | null) => {
		if (!it) return;
		const key = it.question.toLowerCase().trim();
		if (!key || seen.has(key)) return;
		seen.add(key);
		items.push(it);
	};

	let heading = "";
	let sectionBody: string[] = [];
	let block: string[] = []; // contiguous non-empty run, for multi-line ? cards
	let inCode = false;
	const flushHeading = () => {
		if (heading) push(headingCard(heading, sectionBody.join("\n")));
	};

	for (let i = 0; i < lines.length && items.length < cap; i++) {
		const line = lines[i].trim();

		if (/^(```|~~~)/.test(line)) { inCode = !inCode; continue; }
		if (inCode) continue;

		const hm = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
		if (hm) { flushHeading(); heading = hm[2]; sectionBody = []; block = []; continue; }

		if (!line) { block = []; continue; }
		// Skip table rows and pure image embeds.
		if (/^\|/.test(line) || /^!\[/.test(line) || /^!\[\[/.test(line)) continue;

		// Multi-line ? / ?? card: the block above is the front, the lines below
		// (until blank/heading) are the answer.
		if (line === "?" || line === "??") {
			const front = block.join(" ").trim();
			const ans: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const b = lines[j].trim();
				if (!b || /^#{1,6}\s/.test(b) || b === "?" || b === "??") break;
				ans.push(b);
			}
			const back = ans.join("\n").trim();
			if (front && back) {
				push({ question: front, answer: back });
				if (line === "??") push({ question: back, answer: front });
			}
			block = [];
			i = j - 1;
			continue;
		}

		sectionBody.push(line);
		block.push(line);

		const cloze = clozeCards(line);
		if (cloze.length) {
			for (const c of cloze) push(c);
			continue;
		}
		const qa = qaCards(line);
		if (qa.length) {
			for (const c of qa) push(c);
			continue;
		}
		push(definitionCard(line));
		push(formulaCard(line, heading));
	}
	flushHeading();
	return items.slice(0, cap);
}

/** Build up to `count` questions from the given notes with no model call. Questions
 * are spread across notes round-robin, so a session samples breadth before depth. */
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
				hints: { tier1: it.hint ?? "", tier2: "", tier3: "" },
			});
		}
	}
	return out;
}
