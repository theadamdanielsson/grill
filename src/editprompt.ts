/**
 * What the model is asked when a passage is edited in the note itself (see
 * inlineedit.ts), and how its answer is made to fit the place it goes. Pure text, so it
 * can be tested.
 */

/** The longest passage edited in place. A longer one is a job for Chat, which reads
 * and writes the note with its tools. */
export const EDIT_MAX = 12_000;

/** How much of the note around the passage is sent, before it and after it. */
const BEFORE_CHARS = 6000;
const AFTER_CHARS = 2500;

export const EDIT_RULES = `You edit one passage of a note in the user's Obsidian vault, in place. You are given the note around the passage, the passage, and what the user wants done to it.

- Reply with the text that takes the passage's place, and nothing else: no preamble, no explanation, no quotation marks around it, and no code fence unless the passage itself is one.
- Do what was asked and no more. Leave alone what the instruction does not touch: wording, order, links, numbers.
- Write in the language of the passage and in the note's own voice.
- Keep its Markdown as the note writes it: [[links]], headings, lists and their markers, tables, callouts, $...$ and $$...$$ math, footnotes, tags.
- The note around the passage is there to read, not to repeat: never include it in your reply.
- When the passage is empty, write what belongs at that point in the note.
- If the instruction cannot be carried out on this passage, reply with the passage unchanged.`;

export const EDIT_SCHEMA = {
	type: "object",
	properties: { replacement: { type: "string" } },
	required: ["replacement"],
	additionalProperties: false,
} as const;

/** The instruction "Rewrite" sends, with nothing typed. */
export const REWRITE_ASK = "Rewrite this so it reads more clearly. Keep the meaning and the length about the same.";

/** The request for one edit: the note with the place marked, the passage, the
 * instruction, and what was offered before when this is a second try. */
export function editRequest(a: { note: string; text: string; from: number; to: number; ask: string; earlier?: string }): string {
	const before = a.text.slice(Math.max(0, a.from - BEFORE_CHARS), a.from);
	const after = a.text.slice(a.to, a.to + AFTER_CHARS);
	const passage = a.text.slice(a.from, a.to);
	const parts = [
		`NOTE: ${a.note}`,
		`BEFORE THE PASSAGE${a.from > BEFORE_CHARS ? " (the note's start is left out)" : ""}:\n${before || "(the note starts here)"}`,
		`AFTER THE PASSAGE:\n${after || "(the note ends here)"}`,
		passage ? `THE PASSAGE:\n${passage}` : "THE PASSAGE: (empty: the cursor is between the two parts above)",
	];
	if (a.earlier !== undefined) parts.push(`YOUR LAST VERSION, which the user wants changed:\n${a.earlier}`);
	parts.push(`WHAT TO DO:\n${a.ask.trim()}`);
	return parts.join("\n\n");
}

/** How many tokens a reply may run to: room to double a passage, and enough to write
 * a few paragraphs at an empty cursor. */
export function editTokens(passage: string): number {
	return Math.min(8000, Math.max(1500, Math.ceil(passage.length / 2) + 1200));
}

/** The model's answer made to fit where the passage was. A fence it wrapped the answer
 * in is taken off, unless the passage was fenced; the passage's own leading and
 * trailing space is kept, so a line stays a line and a word keeps its space. */
export function fitReplacement(passage: string, reply: string): string {
	let text = reply.replace(/\r\n?/g, "\n");
	const fenced = /^\s*(```|~~~)/.test(passage);
	if (!fenced) {
		const m = /^\s*(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(text);
		if (m) text = m[2];
	}
	if (!passage) return text.trim();
	const lead = /^\s*/.exec(passage)?.[0] ?? "";
	const trail = /\s*$/.exec(passage)?.[0] ?? "";
	// A passage that was only space is replaced by what was written.
	if (lead.length === passage.length) return text.trim();
	return `${lead}${text.trim()}${trail}`;
}
