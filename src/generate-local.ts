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

import { FormatMode, Question } from "./llm";
import { QDifficulty } from "./mastery";
import { safeSlice } from "./text";

/** The kind of structural element a concept was pulled from. */
export type ConceptKind = "heading" | "term" | "definition" | "formula" | "card" | "note" | "authored";

/** A deterministically-identified unit of knowledge within a note. Concept ids
 * are stable across sessions (no model inference), so both the scheduler and
 * either question path (AI or no-key) key off the same set. */
export interface Concept {
	id: string;
	note: string;
	label: string;
	kind: ConceptKind;
	/** Hash of the concept's source text; a change re-opens its recall. */
	sourceHash: string;
	/** Material the AI needs to write a fresh question about this concept. */
	context: string;
	/** The deterministic question for no-key mode. Absent for the note fallback. */
	local?: { question: string; answer: string; hint?: string; type?: "write" | "mc" | "blank"; choices?: string[] };
	/** True for a user-authored `> [!grill]` question: asked verbatim, never rewritten
	 * by the model, and graded against `rubric`/its answer (or the note) rather than a
	 * model-written rubric. */
	authored?: boolean;
	/** The grading rubric the user wrote alongside an authored question, if any. */
	rubric?: string;
}

interface LocalItem {
	question: string;
	/** Revealed for self-grading: the source line, term, or formula. */
	answer: string;
	/** Optional hint carried from an Anki/SR cloze (::hint / ;;hint). */
	hint?: string;
	/** Grading rubric the user wrote alongside an authored callout question. */
	rubric?: string;
	/** What produced this item, for concept identity. */
	kind: ConceptKind;
	/** The structural anchor (heading text, term, front...) — the concept label. */
	label: string;
	/** Answer format, mirroring Question's — set only when mixed formats are on. */
	type?: "write" | "mc" | "blank";
	choices?: string[];
	/** Colon-form definitions only: the raw definition text with no "**term:**"
	 * prefix, kept so the mix-formats pass can use it as an MC distractor/choice
	 * without leaking the term name. Never copied onto the final Question. */
	defText?: string;
}

const BLANK = "\\_\\_\\_\\_\\_"; // renders as literal underscores, not emphasis
/** The interactive blank marker (plain, unescaped) used only when `type: "blank"` —
 * the session view swaps this for a real inline input, so it must match what the
 * AI-generated path also emits, not `BLANK` above (which is just markdown display text). */
const BLANK_MARKER = "____";

const GENERIC_HEADINGS = new Set([
	"overview", "notes", "summary", "introduction", "intro", "contents",
	"references", "links", "todo", "index", "misc", "other", "see also",
	"conclusion", "conclusions", "recap", "key takeaways", "takeaways",
]);

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "is", "are",
	"was", "were", "it", "this", "that", "these", "those", "for", "with", "as",
	"by", "at", "be", "from",
]);

/** Strongly definitional verbs — kept deliberately narrow to avoid turning every
 * "X is high" sentence into a bogus definition. "is/are called|known as" and the
 * category copula "is a/an" are real notes' most common definitional phrasing
 * ("Periods of negative growth are called Recessions") and are still guarded by the
 * same length gate on the definition side, so "X is high" (one content word) still
 * fails to qualify. */
const DEFINITION_VERB =
	/\s+(?:refers to|means|is defined as|are defined as|denotes|stands for|is (?:also )?(?:called|known as)|are (?:also )?(?:called|known as)|is an?)\s+/i;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Replace `[[target]]`/`[[target|alias]]` with plain display text, so a detector
 * that expects prose (a definition's term, a heading label) doesn't choke on — or
 * capture — raw wikilink syntax. */
function dewiki(s: string): string {
	return s.replace(WIKILINK_RE, (_, target: string, alias?: string) => alias ?? target);
}

/** Clean a label pulled from note structure (a heading, a formula's section) of
 * wikilink syntax and trailing punctuation, so it reads as plain text in a question. */
function cleanLabel(s: string): string {
	return dewiki(s).replace(/[:#*_]+$/, "").trim();
}

/** Words contributed by wikilink targets/aliases within raw (pre-dewiki) markup. */
function linkWordCount(raw: string): number {
	let n = 0;
	WIKILINK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIKILINK_RE.exec(raw))) n += wordCount(m[2] ?? m[1]);
	return n;
}

/** True when a span of raw markup is dominated by wikilinks rather than the note's
 * own prose — the "- [[A]]\n- [[B]]\n- [[C]]" shape of a hub/MOC note's link list, or
 * a "See also [[X]], [[Y]]" cross-reference line. A concept built from link-dominated
 * text just asks which note is linked where, not anything the student actually knows,
 * so callers use this to bail out before treating such text as content. */
function isLinkDominated(raw: string): boolean {
	const total = wordCount(dewiki(raw));
	if (total === 0) return false;
	return linkWordCount(raw) / total >= 0.5;
}

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

type MarkKind = "anki" | "highlight" | "curly" | "bold" | "wikilink";

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
		"|\\*\\*([^*]+?)\\*\\*" + // 8=text
		"|\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]", // 9=target 10=alias
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
		} else if (m[8] !== undefined) {
			text = m[8]; group = `u${uid++}`; kind = "bold";
		} else {
			text = m[10] !== undefined ? m[10] : m[9]; group = `u${uid++}`; kind = "wikilink";
		}
		const start = display.length;
		display += text;
		marks.push({ start, end: display.length, text: text.trim(), hint: hint?.trim(), group, kind });
	}
	display += line.slice(last);
	return { display, marks };
}

/** Shared blank-building logic for a set of same-line marks: group by `group`
 * (grouped marks are blanked together on one card), quality-filter auto-detected
 * groups, then produce one LocalItem per surviving group. */
function buildClozeCards(display: string, marks: Mark[], auto: boolean, mixFormats: boolean): LocalItem[] {
	const groups = new Map<string, Mark[]>();
	for (const mk of marks) {
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
		const marker = mixFormats ? BLANK_MARKER : BLANK;
		let q = display;
		for (const g of [...group].sort((a, b) => b.start - a.start)) {
			q = q.slice(0, g.start) + marker + q.slice(g.end);
		}
		// Need enough surrounding context for the blank to be answerable.
		if (wordCount(q.split(marker).join(" ")) < 3) continue;
		out.push({
			question: mixFormats ? q.trim() : `Fill in the blank: ${q.trim()}`,
			// Interactive blank: the missing text alone (matches the AI path's modelAnswer
			// shape). Free-text fallback: the fuller reveal, unchanged from before.
			answer: mixFormats ? termText : `**${termText}** — ${display.trim()}`,
			hint: group.find((g) => g.hint)?.hint,
			kind: auto ? "term" : "card",
			label: termText,
			...(mixFormats ? { type: "blank" as const } : {}),
		});
	}
	return out;
}

/** Cloze cards from EXPLICIT user markup only (Anki cloze, SR highlight) — always
 * trusted, never quality-filtered, since the user deliberately marked these. */
function explicitClozeCards(line: string, mixFormats: boolean): LocalItem[] {
	const { display, marks } = parseInline(line);
	const explicit = marks.filter((k) => k.kind === "anki" || k.kind === "highlight" || k.kind === "curly");
	if (!explicit.length) return [];
	return buildClozeCards(display, explicit, false, mixFormats);
}

/** Cloze cards auto-detected from bold text or `[[wikilinks]]` — the two signals a
 * note author gives "this is a term worth knowing" without spelling out a card.
 * Quality-filtered (`goodTerm`), and only tried when the line has no explicit markup
 * and no better structural match (a colon/verb definition wins over an auto blank —
 * see `itemsForNote`), so a well-formed "**Term**: definition" line gets the clean
 * definitionCard treatment instead of an awkward blank-with-trailing-colon. */
function autoClozeCards(line: string, mixFormats: boolean): LocalItem[] {
	const { display, marks } = parseInline(line);
	if (marks.some((k) => k.kind === "anki" || k.kind === "highlight" || k.kind === "curly")) return []; // explicit wins
	const auto = marks.filter((k) => k.kind === "bold" || k.kind === "wikilink");
	if (!auto.length) return [];
	// A line where wikilinks dominate the word count reads as a reference/hub list
	// ("- [[A]]", "See also [[X]], [[Y]]"), not a claim worth testing recall of —
	// blanking one link's title just asks which note is linked, not anything known.
	if (marks.some((k) => k.kind === "wikilink") && isLinkDominated(line)) return [];
	return buildClozeCards(display, auto, true, mixFormats);
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
	const cards: LocalItem[] = [{ question: front, answer: back, kind: "card", label: front }];
	if (rev) cards.push({ question: back, answer: front, kind: "card", label: back });
	return cards;
}

/** "Term: definition" or "Term refers to definition" → a define-this prompt. Matches
 * against a de-wikilinked copy of the line so a term like "[[Recession]]: a period of
 * ..." (the term itself wikilinked, common in Obsidian notes) still qualifies, and so
 * neither the label nor the revealed answer carry raw `[[...]]` syntax. */
function definitionCard(line: string): LocalItem | null {
	const clean = dewiki(line);
	const colon = /^\s*[-*]?\s*([A-Z][^:*\n]{1,50}?)\s*:\s+(.{15,})$/.exec(clean);
	if (colon && !line.includes("http")) {
		const term = colon[1].trim();
		const def = colon[2].trim();
		if (goodTerm(term) && wordCount(def) >= 3) {
			return {
				question: `Define **${term}**.`,
				answer: `**${term}:** ${def}`,
				kind: "definition",
				label: term,
				defText: def, // raw, term-free — usable as an MC distractor/choice
			};
		}
	}
	const verb = DEFINITION_VERB.exec(clean);
	if (verb) {
		const term = clean.slice(0, verb.index).replace(/^(?:the|an?)\s+/i, "").trim();
		const def = clean.slice(verb.index + verb[0].length).trim();
		if (goodTerm(term) && wordCount(def) >= 3) {
			return { question: `Define **${term}**.`, answer: clean.trim(), kind: "definition", label: term };
		}
	}
	return null;
}

const MATH_RE = /\$\$[^$]+\$\$|\$[^$]+\$/;

/** LaTeX becomes a cloze if the line has prose around it, else a recall prompt. */
function formulaCard(line: string, context: string, mixFormats: boolean): LocalItem | null {
	const mm = MATH_RE.exec(line);
	if (!mm) return null;
	const math = mm[0];
	if (math.replace(/\$/g, "").trim().length < 3) return null;
	const surrounding = line.replace(MATH_RE, " ").trim();
	const label = context ? cleanLabel(context) : "this note";
	if (wordCount(surrounding) >= 3) {
		const marker = mixFormats ? BLANK_MARKER : BLANK;
		const q = line.slice(0, mm.index) + marker + line.slice(mm.index + math.length);
		return {
			question: mixFormats ? q.trim() : `Fill in the blank: ${q.trim()}`,
			answer: math,
			kind: "formula",
			label,
			...(mixFormats ? { type: "blank" as const } : {}),
		};
	}
	return { question: `Recall the formula from **${label}**.`, answer: math, kind: "formula", label };
}

function headingCard(heading: string, body: string): LocalItem | null {
	const h = cleanLabel(heading);
	if (!h || GENERIC_HEADINGS.has(h.toLowerCase()) || wordCount(h) > 8) return null;
	// A section that's mostly a list of links to other notes (a hub/MOC section) has no
	// content of its own to recall — the notes it points to are where the knowledge is.
	if (isLinkDominated(body)) return null;
	const trimmed = dewiki(body).trim();
	if (trimmed.length < 25) return null;
	const answer = trimmed.length > 500 ? safeSlice(trimmed, 500).trim() + "…" : trimmed;
	return { question: `Recall what you know about **${h}**.`, answer, kind: "heading", label: h };
}

// ------------------------------------------------------ user-authored callout

const CALLOUT_START = /^>\s*\[!grill\][+-]?\s?(.*)$/i;

/** Parse a `> [!grill]` callout the user wrote as their own question. The title (and
 * any following plain `>` lines before a field) is the question; `> A:`/`> answer:` is
 * the model answer; `> rubric:` is the grading rubric. Returns the item and the index
 * of the last consumed line, or null if there's no question text. Example:
 *
 *   > [!grill] Why does IFRS 16 move operating leases on-balance-sheet?
 *   > A: They become a right-of-use asset and a lease liability.
 *   > rubric: mentions right-of-use asset, lease liability, on-balance-sheet
 */
function parseGrillCallout(lines: string[], start: number): { item: LocalItem; next: number } | null {
	const m = CALLOUT_START.exec(lines[start].trim());
	if (!m) return null;
	const qLines: string[] = [];
	const title = m[1].trim();
	if (title) qLines.push(title);
	let answer = "";
	let rubric = "";
	// Which field a plain continuation line belongs to — the field most recently
	// introduced by an "A:"/"answer:"/"rubric:" line, not just "was any field seen
	// yet": a rubric that wraps onto a second line needs its continuation routed to
	// `rubric`, not merged into (or, if `answer` is still empty, silently dropped
	// from) `answer`.
	let lastField: "answer" | "rubric" | null = null;
	let i = start + 1;
	for (; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t.startsWith(">")) break;
		const content = t.replace(/^>\s?/, "").trim();
		const am = /^(?:a|answer)\s*:\s*(.*)$/i.exec(content);
		const rm = /^rubric\s*:\s*(.*)$/i.exec(content);
		if (am) {
			answer = am[1].trim();
			lastField = "answer";
			continue;
		}
		if (rm) {
			rubric = rm[1].trim();
			lastField = "rubric";
			continue;
		}
		if (!content) continue;
		if (!lastField) qLines.push(content);
		else if (lastField === "answer") answer = `${answer} ${content}`.trim();
		else rubric = `${rubric} ${content}`.trim();
	}
	const question = qLines.join(" ").trim();
	if (!question) return null;
	return {
		item: { question, answer, rubric: rubric || undefined, kind: "authored", label: question },
		next: i - 1,
	};
}

// ------------------------------------------------------------ per-note walk

// This is the ceiling on how many concepts a note can EVER have, in either local or AI
// mode (extractConcepts feeds both) — not a per-session pacing limit, which is handled
// separately by questionsPerSession/maxNotesPerSession/due rotation. Content past this
// cap is permanently invisible to the scheduler, no matter how many sessions run, since
// the walk below stops scanning once it's collected this many items (first N in
// document order). Was 12, which silently truncated any content-dense note (a
// vocabulary list, a long glossary) to only ever quiz its first ~12 terms forever; then
// 80, which turned out to be the same failure mode one size up — a real hand-authored
// drill sheet (a `[!grill]` callout worksheet covering every tense of a topic) can
// exceed 80 on its own. Raised again, well past realistic note sizes, so pacing, not
// this cap, is what limits a session.
const ITEM_CAP_PER_NOTE = 200;

function itemsForNote(text: string, cap: number, mode: FormatMode): LocalItem[] {
	const mixFormats = mode !== "write";
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

		// User-authored question: `> [!grill] ...` callout, possibly multi-line.
		if (CALLOUT_START.test(line)) {
			const res = parseGrillCallout(lines, i);
			if (res) { push(res.item); block = []; i = res.next; continue; }
		}

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
				push({ question: front, answer: back, kind: "card", label: front });
				if (line === "??") push({ question: back, answer: front, kind: "card", label: back });
			}
			block = [];
			i = j - 1;
			continue;
		}

		sectionBody.push(line);
		block.push(line);

		// Priority: explicit user markup, then Q&A separators, then a structural
		// definition (colon or verb form) — a well-formed "**Term**: definition" line
		// should read as a clean "Define Term" prompt, not an auto-blank-with-a-
		// trailing-colon just because the term happened to be bolded too — and only
		// then the bold/wikilink auto-cloze fallback for lines with no cleaner match.
		const explicit = explicitClozeCards(line, mixFormats);
		if (explicit.length) {
			for (const c of explicit) push(c);
			continue;
		}
		const qa = qaCards(line);
		if (qa.length) {
			for (const c of qa) push(c);
			continue;
		}
		const def = definitionCard(line);
		if (def) {
			push(def);
		} else {
			const auto = autoClozeCards(line, mixFormats);
			if (auto.length) {
				for (const c of auto) push(c);
				continue;
			}
		}
		push(formulaCard(line, heading, mixFormats));
	}
	flushHeading();
	return applyMcMix(items.slice(0, cap), mode);
}

/** Convert some colon-form definitions into multiple-choice: the correct definition
 * plus 3 distractor definitions sampled from OTHER terms in the same note. Only
 * definitions carry `defText` (the term-free definition text), so only those are
 * eligible; needs at least 3 other candidates to build a real choice set.
 *
 * "mixed" converts roughly one in three eligible definitions, so free-text variety
 * remains too — MC there is one format among several, not the point of the mode.
 * "mc" ("Multiple choice only") converts every eligible definition: the setting's own
 * description promises MC as the default with a structured fallback (still true here —
 * everything else already comes out "blank"-typed, not "write", via `mixFormats` above)
 * only for concepts that genuinely can't be posed as MC, not a one-in-three sampling. */
function applyMcMix(items: LocalItem[], mode: FormatMode): LocalItem[] {
	if (mode === "write") return items;
	const pool = items.filter((it) => it.kind === "definition" && it.defText);
	if (pool.length < 4) return items;
	let n = 0;
	return items.map((it) => {
		if (it.kind !== "definition" || !it.defText) return it;
		n += 1;
		if (mode === "mixed" && n % 3 !== 1) return it;
		const distractors = pool
			.filter((p) => p !== it)
			.map((p) => p.defText as string)
			.sort(() => Math.random() - 0.5)
			.slice(0, 3);
		if (distractors.length < 3) return it;
		const choices = [it.defText, ...distractors].sort(() => Math.random() - 0.5);
		return {
			...it,
			question: `Which of these is the definition of **${it.label}**?`,
			answer: it.defText,
			type: "mc" as const,
			choices,
		};
	});
}

// ------------------------------------------------------------ concept extraction

/** Stable, url-ish slug for a concept id. */
function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";
}

/** Cheap deterministic hash (djb2) → base36. Used to notice a concept's source changed. */
function hashStr(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

const MIN_CONCEPTS_BEFORE_FALLBACK = 2;

/** Deterministically decompose a note into concepts. Same set feeds both the
 * scheduler and either question path, so concept ids never depend on the model. */
export function extractConcepts(note: string, text: string, mode: FormatMode = "write"): Concept[] {
	const items = itemsForNote(text, ITEM_CAP_PER_NOTE, mode);
	const concepts: Concept[] = [];
	const usedIds = new Set<string>();
	const labelById = new Map<string, string>();
	for (const it of items) {
		// Same note+kind+label is treated as the same concept (first wins), so ids
		// are position-independent and stable across edits — a later dedup can't
		// reassign one concept's history to another.
		const base = `${note}::${it.kind}:${slug(it.label)}`;
		// slug() is lossy (strips all punctuation, truncates past 48 chars), so two
		// genuinely DIFFERENT labels can land on the same base id — without this check
		// the second one was silently dropped and never became schedulable. Only
		// disambiguate when the collision is real (a different label claiming an
		// already-used id); the common case — the same label re-extracted — still
		// resolves to the original, unsuffixed id, so no existing concept gets renamed.
		const id = usedIds.has(base) && labelById.get(base) !== it.label ? `${base}-${hashStr(it.label).slice(0, 6)}` : base;
		if (usedIds.has(id) && labelById.get(id) === it.label) continue;
		usedIds.add(id);
		labelById.set(id, it.label);
		concepts.push({
			id,
			note,
			label: it.label,
			kind: it.kind,
			// Authored questions re-open on any edit to the question, answer, or rubric.
			sourceHash: hashStr(
				it.kind === "authored" ? `${it.question} ${it.answer} ${it.rubric ?? ""}` : it.answer,
			),
			context: it.answer,
			local: { question: it.question, answer: it.answer, hint: it.hint, type: it.type, choices: it.choices },
			...(it.kind === "authored" ? { authored: true, rubric: it.rubric } : {}),
		});
	}
	// A sparse or prose-heavy note still gets schedulable concepts the AI can range
	// over. It has no `local` question (nothing deterministic to show). Chunked, not
	// one giant concept: a note this size in practice is usually a PDF embed's
	// extracted text (see pdf.ts) run to many thousands of characters — a single
	// concept capped at the first slice meant only the first ~page ever got quizzed,
	// no matter how long the note actually was.
	const FALLBACK_CHUNK_SIZE = 2000;
	// A well-structured worksheet/exam (exactly what a PDF import tends to be) numbers
	// its own items — "Question 7", "Problem 3", "Exercise 2" — which is a far better
	// place to cut than an arbitrary character count: each chunk becomes exactly one
	// exercise instead of a slice that might cut one in half or straddle two.
	const QUESTION_BOUNDARY = /^(?:question|problem|exercise|q)\.?\s*\d+\b/i;
	if (concepts.length < MIN_CONCEPTS_BEFORE_FALLBACK) {
		const body = stripFrontmatter(text).replace(/<!--[\s\S]*?-->/g, "").trim();
		// A note that's mostly links (a hub/MOC with no real prose of its own) genuinely
		// has nothing to quiz — the knowledge lives in the notes it points to, so it
		// shouldn't fall back to testing its own link list as if that were content.
		if (body.length >= 40 && !isLinkDominated(body)) {
			const lines = body.split("\n");
			const boundaries: { label: string; startLine: number }[] = [];
			for (let i = 0; i < lines.length; i++) {
				const t = lines[i].trim();
				if (QUESTION_BOUNDARY.test(t)) boundaries.push({ label: safeSlice(cleanLabel(t), 80), startLine: i });
			}
			// Only trust it with at least two real boundaries — a single stray match
			// (a formula that happens to start "Q1 =", say) isn't real document structure,
			// and falling back to fixed-size chunking below is exactly as good for that.
			let rawChunks: { label: string; text: string }[];
			if (boundaries.length >= 2) {
				rawChunks = boundaries.map((b, i) => ({
					label: b.label,
					text: lines.slice(b.startLine, boundaries[i + 1]?.startLine ?? lines.length).join("\n").trim(),
				}));
			} else {
				// No detectable structure (plain prose, or a PDF that doesn't number its
				// items) — the previous behavior: even-sized slices, chunked by codepoint
				// so a slice boundary can't land mid-character (PDF-extracted worksheets
				// are often full of astral math symbols like 𝑌, 𝑃, 𝐺).
				const bodyChars = Array.from(body);
				rawChunks = [];
				for (let start = 0, i = 0; start < bodyChars.length; start += FALLBACK_CHUNK_SIZE, i++) {
					const slice = bodyChars.slice(start, start + FALLBACK_CHUNK_SIZE).join("");
					// Label content, not the file name. This label is sent to the model as
					// "the concept" to test (see ConceptTarget in llm.ts) — the note name is
					// already given separately, so using it again here as the "concept" told
					// the model the topic WAS the file/organizational title, and it dutifully
					// wrote questions about that ("what's covered under 05. Career 2?")
					// instead of the actual material. Use the first real line of prose in
					// THIS chunk instead, capped so a page with no line breaks at all can't
					// hand back a paragraph as a "label"; fall back to the note name (plus a
					// part number past the first chunk, so chunks stay distinguishable).
					const firstLine = cleanLabel(
						slice.split("\n").find((l) => {
							const lt = l.trim();
							// Same embed/table exclusion itemsForNote's main walk already applies —
							// without it, a chunk starting right at a note's own `![[embed]]` line
							// (the whole reason this note fell back to whole-note chunking at
							// all) would pick that raw markup as its label.
							return wordCount(cleanLabel(lt)) >= 3 && !/^(\||!\[)/.test(lt);
						}) ?? "",
					);
					const label = safeSlice(firstLine, 80) || (i === 0 ? note : `${note} (part ${i + 1})`);
					rawChunks.push({ label, text: slice });
				}
			}
			for (let chunk = 0; chunk < rawChunks.length && concepts.length < ITEM_CAP_PER_NOTE; chunk++) {
				const { label, text: slice } = rawChunks[chunk];
				const id = `${note}::note:whole:${chunk}`;
				if (usedIds.has(id) || !slice) continue;
				usedIds.add(id);
				concepts.push({
					id,
					note,
					label,
					kind: "note",
					sourceHash: hashStr(slice),
					context: slice,
				});
			}
		}
	}
	return concepts;
}

/** The no-key question for a concept (its deterministic card), tagged with the
 * concept id. Null for the note fallback, which has no fixed question. `difficulty`
 * defaults to "medium" for callers with no scheduling context to seed it from, but
 * every real caller passes the concept's actual target difficulty (see view.ts's
 * `conceptTargetDifficulty`) — without this, a no-key/authored question could never
 * reach "hard" and therefore never earn an Easy FSRS rating, unlike an AI-generated
 * question on the same concept. */
export function localQuestionForConcept(c: Concept, difficulty: QDifficulty = "medium"): Question | null {
	if (!c.local) return null;
	return {
		node: c.note,
		conceptId: c.id,
		question: c.local.question,
		difficulty,
		modelAnswer: c.local.answer,
		acceptableAnswers: [],
		commonErrors: [],
		hints: { tier1: c.local.hint ?? "", tier2: "", tier3: "" },
		...(c.authored ? { authored: true, rubric: c.rubric } : {}),
		...(c.local.type ? { type: c.local.type, choices: c.local.choices } : {}),
	};
}

/** Render no-key questions for already-selected concepts, in order, up to count.
 * `difficultyOf`, when given, seeds each question's difficulty from the concept's own
 * scheduling state instead of the flat "medium" default — see `localQuestionForConcept`. */
export function localQuestions(
	concepts: Concept[],
	count: number,
	difficultyOf?: (c: Concept) => QDifficulty,
): Question[] {
	const out: Question[] = [];
	for (const c of concepts) {
		if (out.length >= count) break;
		const q = localQuestionForConcept(c, difficultyOf?.(c));
		if (q) out.push(q);
	}
	return out;
}
