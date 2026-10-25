/** What a question, a grade and an explanation are, and the checks a written question
 * must pass before it reaches the student. */

import type { Verdict } from "./mastery";
import { safeDiagram } from "./safemd";
import { contentWords } from "./text";

export interface Question {
	node: string;
	question: string;
	difficulty: "easy" | "medium" | "hard";
	modelAnswer: string;
	acceptableAnswers: string[];
	commonErrors: { pattern: string; misconception: string }[];
	hints: { tier1: string; tier2: string; tier3: string };
	/** Canonical misconception tag this question deliberately re-probes, or "".
	 * Answering it correctly resolves that misconception. */
	targetsMisconception?: string;
	/** The concept this question tests, assigned by construction (not inferred).
	 * Drives concept-level scheduling. */
	conceptId?: string;
	/** In a connections session, the linked note this question bridges to. Shown
	 * to the student so the connection is legible; empty in a standard session. */
	connectTo?: string;
	/** Set when this question was inserted by reactive prerequisite routing: the
	 * note the student just missed, whose foundation this question shores up. Shown
	 * so the detour is legible ("you missed X, so let's check Y it builds on"). */
	routedFrom?: string;
	/** Set when this question was inserted by misconception contagion: the note the
	 * student just showed a specific confusion on, whose linked neighbor this question
	 * re-probes for the same confusion. Shown so the detour is legible ("you showed
	 * the same mistake on X, checking if it applies here too"). AI mode only. */
	contagionFrom?: string;
	/** A missing-link bridge question: `connectTo` names a note NOT yet linked to
	 * `node`, and answering tests the latent relationship. Drives the "Link these
	 * notes" affordance and keeps the question out of concept/FSRS scheduling. */
	missingLink?: boolean;
	/** A user-authored question (from a `> [!grill]` callout): asked verbatim, never
	 * rewritten by the model, and graded against `rubric`/`modelAnswer` when present
	 * else the source note. */
	authored?: boolean;
	/** Optional grading rubric the user wrote alongside an authored question. */
	rubric?: string;
	/** Answer format. "write" (the default, free-response) is assumed when unset.
	 * "mc" renders `choices` as clickable options and grades instantly by exact match
	 * against `modelAnswer`. "blank" renders `question`'s blank marker(s) (`____`, one
	 * to three per question) as inline input(s), graded like "write" against
	 * `modelAnswer`/`acceptableAnswers`. "tf" renders a fixed True/False pair and grades
	 * instantly against `modelAnswer` ("True"/"False"). "multi" renders `choices` as
	 * togglable options where 2+ are correct (`correctChoices`), graded instantly by set
	 * comparison. "match" renders `pairs` as two columns to connect, graded instantly by
	 * per-pair comparison. "occlusion" shows `occlusionImage` with `occlusionRegions`
	 * redacted; the student names what's hidden, graded like "write" (free text, LLM-graded)
	 * against `modelAnswer`. "draw" is answered by drawing the diagram from memory in
	 * Excalidraw (see draw.ts); the drawing is graded as an image against `modelAnswer`. */
	type?: "write" | "mc" | "blank" | "tf" | "multi" | "match" | "occlusion" | "draw";
	/** For `type: "mc"`: the options shown, one of which must equal `modelAnswer`
	 * exactly (case-insensitive compare at grade time). Unused for "tf" (always
	 * rendered as a fixed True/False pair) and for "multi" (see `choices` below). */
	choices?: string[];
	/** For `type: "multi"`: the full option set is `choices`; this is the subset (2 or
	 * more) whose exact text marks them correct. Everything else in `choices` is a
	 * distractor. */
	correctChoices?: string[];
	/** For `type: "match"`: the correct left/right pairs. Rendered as a fixed-order left
	 * column and a shuffled right-column pool the student connects them to. */
	pairs?: { left: string; right: string }[];
	/** For `type: "occlusion"`: the vault path of the note-embedded image, resolved to a
	 * displayable URL at render time via `app.vault.getResourcePath` (same pattern
	 * `renderRelevantImage` already uses) — never re-sent as base64 except at generation
	 * time, when it's decoded locally for OCR (see `ocr.ts`'s `detectOcclusionRegions`). */
	occlusionImage?: string;
	/** For `type: "occlusion"`: one or more redacted regions, normalized (0-1, top-left
	 * origin) so they survive the image being resized/re-rendered at any resolution.
	 * `modelAnswer` is the joined labels (`" / "`-separated, same convention "blank"
	 * uses for its multi-blank answers) so grading/display code that already reads
	 * `modelAnswer` generically needs no occlusion-specific branch. */
	occlusionRegions?: { x: number; y: number; w: number; h: number; label: string }[];
	/** For `type: "draw"`: vault path of the Excalidraw file the student draws in. */
	drawing?: string;
}

/** Mirrors the `questionFormats` setting. The single choke point every question-serving
 * path (fresh AI generation, fresh local generation, and cache reuse) runs a candidate
 * through before it's allowed to reach the student — see `formatSatisfies`. */
export type FormatMode = "write" | "mixed" | "mc";

/** Whether a question's format satisfies the `questionFormats` setting. "mixed" accepts
 * anything. "write" requires a plain free-response question (no `type`, or `type:
 * "write"`). "mc" ("Multiple choice only") means what its name says: literal `type:
 * "mc"`, not merely "not write" — a fill-in-the-blank or true/false question is still
 * a format the student didn't ask for. (An earlier version of this function accepted
 * any structured type here, on the theory that some concepts "genuinely can't be posed
 * as a single-answer choice" — in practice that just meant a setting literally called
 * "Multiple choice only" silently served blank/tf/match questions instead, which reads
 * as the setting not working, not as a reasonable fallback.) */
export function formatSatisfies(type: Question["type"] | undefined, mode: FormatMode): boolean {
	const t = type ?? "write";
	if (mode === "mixed") return true;
	if (mode === "mc") return t === "mc";
	return t === "write";
}


export interface Grade {
	verdict: Verdict;
	feedback: string;
	misconceptionTag: string;
	/** Set only when grading was told the message might not be an answer (see
	 * `gradeAnswer`'s `mayAsk`), and it wasn't: the student asked for help instead.
	 * The verdict then means nothing and must not reach the record. */
	asked?: boolean;
}

/** Structured "Explain this" output — distinct short fields, not one prose blob, so the
 * feedback screen can render each as its own labeled block instead of a wall of text. */
export interface Explanation {
	/** "" when the answer was already fully correct — nothing to correct. */
	whatWentWrong: string;
	/** The underlying concept/rule/fact — named generically since not every question
	 * has a "rule" (e.g. plain factual recall or vocabulary). */
	keyConcept: string;
	/** "" when no natural worked example applies — same convention as debriefSchema's `pattern`. */
	example: string;
	/** Raw Mermaid body (no ```mermaid fence — the caller adds that), "" when no
	 * diagram genuinely helps. Deliberately constrained (see EXPLAIN_RULES): LLM-
	 * generated Mermaid is a well-documented source of render failures, so this is
	 * scoped to the shapes most likely to actually parse, not "draw whatever helps". */
	diagram: string;
	/** Vault path of the one note-embedded image (of the ones sent as vision input) the
	 * model judged actually relevant to THIS question, "" for the common case of none.
	 * Picked by the model rather than "first images in the note" — a note can embed
	 * many unrelated images across its length, and document order has no relation to
	 * which one this particular question is about. */
	relevantImagePath: string;
}

/** Belt-and-suspenders: strip em/en dashes from model output regardless of prompt compliance. */
/** A diagram body fit to be put inside a ```mermaid fence, in the view and in the
 * session note. Models often wrap it in a fence of their own despite being told not
 * to; written into a note as it came, that closes the note's fence early and turns
 * everything after it into a code block. So a wrapping fence is taken off, and a
 * diagram that still has a fence inside it is dropped. */
export function cleanDiagram(raw: string): string {
	const body = cleanText(raw)
		.trim()
		.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, "")
		.replace(/\r?\n?```[ \t]*$/, "")
		.trim();
	return safeDiagram(body);
}

export function cleanText(t: string): string {
	// Em dashes always go. An en dash only goes when spaced ("this – that"): an unspaced
	// one is a range ("1914–1918", "pp. 3–7") and turning it into ", " changed facts.
	return t.replace(/\s*—\s*/g, ", ").replace(/\s+–\s+/g, ", ");
}

function overlapCount(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n;
}

/** Loose equality for matching an mc `modelAnswer` back to one of its own `choices`:
 * casefold, collapse whitespace, strip trailing punctuation and any straight/curly
 * quote marks. A model asked to reproduce one string in two separate JSON fields
 * "exactly" often doesn't (trailing period, smart quote, a stray space) — normalizing
 * before matching turns that near-miss into a fixable case instead of a dropped
 * question, which otherwise silently shrinks a requested batch of N into fewer. */
export function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/[""'']/g, "'")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?;:,]+$/, "");
}

const YESNO_OPENER = /^(is|are|was|were|does|do|did|can|could|should|would|will|has|have|had)\b/i;

const OPEN_CUE =
	/\b(why|how|explain|describe|what|which|who|whom|whose|when|where|name|list|give|calculate|derive|compare|contrast|define|outline|state|show|prove|justify|verify|demonstrate|argue)\b/i;

const MC_STEM =
	/\b(which of the following|which statement (best|correctly)|select the (correct|best)|all of the following|none of the following)\b/i;

/** Two or more "1)"/"2)"-style markers: a 'multi' question enumerating its own options
 * inline in the question text, duplicating what's already rendered as separate
 * clickable buttons (see FORMAT_MIX_INSTRUCTIONS' 'multi' bullet, which now tells the
 * model not to do this — this is the belt-and-suspenders backstop). */
const NUMBERED_OPTIONS = /\b[1-9]\)\s/g;

/** Deterministic quality gate for one built question against its source excerpt.
 * Returns a short reason to DROP the question, or null if it passes. Model-free and
 * cheap, so it catches slop on weak local models where a single-pass generator is
 * likeliest to produce it — without a second (equally weak) LLM critique call. */
export function questionDefect(q: Question, source: string): string | null {
	const text = q.question.trim();
	if (text.length < 10 || text.length > 1000) return "length";
	if (!q.modelAnswer.trim()) return "empty model answer";
	switch (q.type) {
		case "mc":
			if (!q.choices || q.choices.length < 2) return "mc with too few choices";
			if (!q.choices.includes(q.modelAnswer)) return "mc answer not among choices";
			break;
		case "blank": {
			const blanks = text.match(/_{3,}/g) ?? [];
			if (blanks.length === 0) return "blank question missing a blank marker";
			if (blanks.length > 3) return "blank question has too many blanks";
			// modelAnswer is contracted (see FORMAT_MIX_INSTRUCTIONS) to list each blank's
			// answer in left-to-right order, separated by " / " — if a model drops or
			// merges one, the answer shown to the student afterward no longer lines up
			// one-to-one with the inputs they actually filled in.
			const segments = q.modelAnswer.split(" / ").filter((s) => s.trim());
			if (segments.length !== blanks.length) return "blank count doesn't match modelAnswer segments";
			break;
		}
		case "tf":
			// Rendered as a fixed True/False pair regardless of what the model put in
			// `choices` (normalized post-generation, below), so only the answer matters here.
			if (!/^(true|false)$/i.test(q.modelAnswer.trim())) return "tf answer isn't true/false";
			break;
		case "multi": {
			if (!q.choices || q.choices.length < 3) return "multi with too few choices";
			if (!q.correctChoices || q.correctChoices.length < 2) return "multi needs 2+ correct choices";
			if (!q.correctChoices.every((c) => q.choices!.includes(c))) return "multi correctChoices not among choices";
			if (q.correctChoices.length >= q.choices.length) return "multi with no wrong option";
			if ((text.match(NUMBERED_OPTIONS) ?? []).length >= 2) return "multi restates its options in the question text";
			break;
		}
		case "match": {
			if (!q.pairs || q.pairs.length < 3) return "match with too few pairs";
			const lefts = new Set(q.pairs.map((p) => p.left.trim().toLowerCase()));
			const rights = new Set(q.pairs.map((p) => p.right.trim().toLowerCase()));
			if (lefts.size !== q.pairs.length || rights.size !== q.pairs.length) return "match pairs not unique";
			break;
		}
		default:
			// Grill is free-response by default: an MC-style stem gives the student no
			// options to pick, unless this question is actually typed 'mc' above.
			if (MC_STEM.test(text)) return "multiple-choice stem";
	}
	if (/what does (the|your) notes?\b/i.test(text)) return "asks what the note says";
	if (YESNO_OPENER.test(text) && !OPEN_CUE.test(text) && text.length < 90) return "yes/no question";
	// Answer leakage: a hint that contains the model answer almost verbatim.
	const ans = q.modelAnswer.toLowerCase().trim();
	const ansWords = contentWords(q.modelAnswer);
	for (const tier of [q.hints.tier1, q.hints.tier2, q.hints.tier3]) {
		if (!tier.trim() || ansWords.size < 3) continue;
		if (ans.length >= 12 && tier.toLowerCase().includes(ans)) return "hint reveals the answer";
		if (overlapCount(ansWords, contentWords(tier)) / ansWords.size >= 0.8) return "hint reveals the answer";
	}
	// Grounding: at least two of the question's content words should appear in the
	// concept's source excerpt. Only fires when the source is substantial, and never
	// for a connections bridge (which is deliberately phrased in a LINKED note's
	// vocabulary), so a well-phrased grounded question is never dropped for drift.
	const src = contentWords(source);
	if (src.size >= 20 && !q.connectTo) {
		const qWords = contentWords(`${q.question} ${q.modelAnswer}`);
		if (qWords.size >= 4 && overlapCount(qWords, src) < 2) return "ungrounded in source";
	}
	return null;
}
