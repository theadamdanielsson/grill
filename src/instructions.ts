/** The Instructions note (<folder>/Instructions.md): its template, and reading the
 * student's persona and preferences out of it. No vault access: the store passes in how
 * to read a linked note. */

import { DEFAULT_PERSONA } from "./persona";
import { safeSlice } from "./text";

/** Each section's length, at most. */
const INSTRUCTIONS_CAP = 2000;

/** Total characters of referenced-note text that [[wikilinks]] in persona/
 * preferences may inline, shared across the whole file, so a linked style
 * guide can't inflate every session's prompt without bound. */
export const INSTRUCTIONS_CONTEXT_CAP = 4000;

export const INSTRUCTIONS_TEMPLATE = [
	"## Persona",
	"<!-- This is who Grill is and how it talks to you. Rewrite the line below to change",
	"     Grill's character: a strict examiner, a gentle Socratic guide, a blunt drill",
	"     sergeant, whatever suits you. This changes only Grill's voice. How questions are",
	"     built and how your answers are scored is fixed by the engine, so your grades stay",
	"     consistent no matter what you write here. Leave it blank to use the default. -->",
	"",
	DEFAULT_PERSONA,
	"",
	"## Preferences",
	"<!-- Plain sentences telling Grill how you want to be quizzed and graded: question",
	"     style, difficulty, strictness. Leave blank for the defaults.",
	"",
	"     This is NOT where to pick question FORMAT (multiple-choice, fill-in-the-blank,",
	"     true/false, write-in, etc.). That is a hard setting the model can't reliably",
	"     override from prose, so it has its own control: Settings -> Question formats.",
	"",
	"     Examples you might write:",
	'       "Prefer short numeric problems over definitions."',
	'       "Ask me to explain concepts in my own words."',
	'       "Be strict on exact terminology."',
	'       "Accept bullet-point answers, do not mark me down for phrasing."',
	"",
	"     You can point at another note with [[links]] and Grill reads it in, so a",
	"     longer style guide or marking rubric can live in its own note. Referenced",
	"     notes are capped, and everything here rides along in every session, so keep",
	"     it short; long text costs more tokens every session. -->",
	"",
	"",
	"## Reference documents",
	"<!-- Drop worksheets, past exams, or official solutions below and Grill reads",
	"     their real text into every session: the same idea as attaching a file in",
	"     an AI chat, not a description of the document, the document itself. PDFs",
	"     are text-extracted (first 40 pages, cached so re-opening a session doesn't",
	"     re-parse them); other file types are stored but not read yet. 30 MB per",
	"     file, 300 documents max. This is a course library, not a single",
	"     message's attachments, so attach every worksheet you have. Each session",
	"     splits a shared text budget evenly across whatever's attached, so a",
	"     bigger library means less depth per document, not documents silently",
	"     dropped. -->",
	"",
	"```grill-documents",
	'{"v":1,"files":[]}',
	"```",
	"",
].join("\n");

/** The user's persona override and question/grading preferences, parsed from the two
 * "## Persona" / "## Preferences" sections, with how-to comments stripped and each section
 * length-capped. An empty persona means "use the engine default". Files written before this
 * format (no headings) are read as all-preferences, preserving old behavior. */
export function splitInstructions(raw: string): { persona: string; preferences: string } {
	const cap = INSTRUCTIONS_CAP;
	const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim();
	const lower = raw.toLowerCase();
	const pIdx = lower.indexOf("## persona");
	const fIdx = lower.indexOf("## preferences");
	// A third heading sits after Preferences (the reference documents): without
	// accounting for it, Preferences' "run to end of file" slice would swallow that
	// heading and its raw JSON fence as prose. (Attached documents' content flows into
	// the same concept-extraction pipeline a note's text does, not this channel.)
	const rIdx = lower.indexOf("## reference documents");
	const nextBoundary = (start: number): number => {
		const after = [pIdx, fIdx, rIdx].filter((i) => i > start);
		return after.length ? Math.min(...after) : raw.length;
	};
	let persona = "";
	let preferences = "";
	// Legacy file with no section headings: treat the whole thing as preferences, but
	// still stop at the reference-documents fence if one exists (the upload area's "add"
	// flow can append that section to any file), so its JSON never reaches the prompt.
	if (pIdx === -1 && fIdx === -1) {
		preferences = safeSlice(strip(raw.slice(0, rIdx === -1 ? raw.length : rIdx)), cap);
	} else {
		if (pIdx !== -1) persona = safeSlice(strip(raw.slice(pIdx + "## persona".length, nextBoundary(pIdx))), cap);
		if (fIdx !== -1) preferences = safeSlice(strip(raw.slice(fIdx + "## preferences".length, nextBoundary(fIdx))), cap);
	}
	return { persona, preferences };
}

/** Append the body of any [[wikilinks]] a section references (one level only, no
 * recursion), under a labelled block. `readNote` gives a link's Markdown, or null for one
 * not to read. Shares `budget` across the whole file and truncates, so referenced notes
 * can never blow up the prompt. */
export async function inlineLinks(text: string, readNote: (linkpath: string) => Promise<string | null>, budget: { left: number }): Promise<string> {
	if (!text || budget.left <= 0) return text;
	const seen = new Set<string>();
	const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
	let out = text;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (budget.left <= 0) break;
		const linkpath = m[1].trim();
		if (!linkpath || seen.has(linkpath.toLowerCase())) continue;
		seen.add(linkpath.toLowerCase());
		let body = await readNote(linkpath);
		if (body === null) continue;
		body = body
			.replace(/^---\n[\s\S]*?\n---\n/, "")
			.replace(/<!--[\s\S]*?-->/g, "")
			.trim();
		if (!body) continue;
		const slice = safeSlice(body, budget.left);
		budget.left -= slice.length;
		out += `\n\nReferenced note "${linkpath}":\n${slice}${slice.length < body.length ? "\n[truncated]" : ""}`;
	}
	return out;
}
