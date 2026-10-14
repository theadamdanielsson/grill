/**
 * What Chat is asked when it is started from text selected in a note: the passage,
 * quoted, under one line saying what to do with it. Pure text, so it can be tested.
 */

export type SelectionAsk = "ask" | "explain" | "rewrite" | "note";

/** The things that can be done with a selection, in the order they are offered. */
export const SELECTION_ASKS: Array<{ id: SelectionAsk; command: string; menu: string }> = [
	{ id: "ask", command: "Ask about the selection", menu: "Ask about this" },
	{ id: "explain", command: "Explain the selection", menu: "Explain" },
	{ id: "rewrite", command: "Rewrite the selection", menu: "Rewrite" },
	{ id: "note", command: "Make a note from the selection", menu: "Make a note" },
];

/** As much of a selection as is quoted. The whole note is sent with the message
 * anyway; this only has to say which part is meant. */
export const SELECTION_MAX = 4000;

const LEAD: Record<SelectionAsk, string> = {
	ask: "About this part of the note:",
	explain: "Explain this part of the note:",
	rewrite: "Rewrite this part of the note so it reads more clearly. Keep the meaning, and reply with the rewritten text only:",
	note: "Write a note of its own from this part of the note. Start with a title line, and reply with the note only:",
};

/** The selection as a quote: each line marked, cut at a line where it is too long. */
export function quoteSelection(selected: string): string {
	let text = selected.replace(/\r\n?/g, "\n").trim();
	if (text.length > SELECTION_MAX) {
		const cut = text.slice(0, SELECTION_MAX);
		const line = cut.lastIndexOf("\n");
		text = `${(line > SELECTION_MAX / 2 ? cut.slice(0, line) : cut).trimEnd()}\n[...]`;
	}
	return text
		.split("\n")
		.map((l) => (l ? `> ${l}` : ">"))
		.join("\n");
}

/** The message for one of the asks. "ask" ends open, for the question to be typed
 * under it; the others are sent as they are. Empty when nothing is selected. */
export function selectionMessage(kind: SelectionAsk, selected: string): string {
	if (!selected.trim()) return "";
	const quoted = `${LEAD[kind]}\n\n${quoteSelection(selected)}`;
	return kind === "ask" ? `${quoted}\n\n` : quoted;
}

/** A saved prompt as it is used: the note's text without its properties. */
export function promptText(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(/^---\n[\s\S]*?\n---(\n|$)/, "")
		.trim();
}

/** A saved prompt with the selection in it. `{{selection}}` says where the selected
 * text goes; without it, the selection is quoted under the prompt. */
export function promptMessage(prompt: string, selected: string): string {
	const text = promptText(prompt);
	if (!text) return "";
	const has = !!selected.trim();
	if (/\{\{\s*selection\s*\}\}/i.test(text)) {
		const quoted = has ? `\n\n${quoteSelection(selected)}\n\n` : "";
		return text.replace(/\s*\{\{\s*selection\s*\}\}\s*/gi, () => quoted || " ").trim();
	}
	return has ? `${text}\n\n${quoteSelection(selected)}` : text;
}

/** Prompts that come with Grill, offered above the saved ones: things worth asking of
 * any note, whatever it is for. */
export const STARTER_PROMPTS: Array<{ name: string; text: string }> = [
	{ name: "Summarise", text: "Summarise this note in five bullet points, in plain words." },
	{ name: "Find the gaps", text: "What is missing, unclear or contradictory in this note?" },
	{ name: "Pull out tasks", text: "List every task, decision and open question in this note." },
	{ name: "Explain simply", text: "Explain this note as if I were new to the subject." },
];

/** What a new saved prompt starts as. */
export const NEW_PROMPT = "Summarise this in five bullet points, in plain words.\n";

/** Claude Code's own names for its models; "" leaves the choice to Claude Code. */
export const CLAUDE_MODELS: Array<{ id: string; name: string }> = [
	{ id: "", name: "Default model" },
	{ id: "opus", name: "Opus" },
	{ id: "sonnet", name: "Sonnet" },
	{ id: "haiku", name: "Haiku" },
];
