/**
 * Tools that let the model behind Chat work in the vault: read a note, search and list
 * notes, change a note, make a new one.
 *
 * The model only asks. Everything is done here, in the plugin, through Obsidian, so it
 * works with any provider that can ask for a tool and on a phone as on a desktop. A
 * change to a note goes through the same permission levels and the same card as Claude
 * Code's do (see agent.ts); reading never asks.
 */
import { AgentEvent, AgentLevel, PermissionAnswer, PermissionAsk, permissionAsk } from "./agent";
import type { StreamResult, ToolCall, ToolMsg, ToolSpec } from "./stream";

/** The vault, as far as these tools need it. */
export interface VaultPort {
	/** Paths of every note that may be read, e.g. "Macro/Multiplier.md". */
	notes(): string[];
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	create(path: string, content: string): Promise<void>;
	/** Whether anything, note or not, is already at this path. */
	exists(path: string): boolean;
	/** Grill's own files and whatever the user has excluded: never written to. */
	locked(path: string): boolean;
}

const path = { type: "string", description: 'Path of the note in the vault, e.g. "Macro/Multiplier.md". A note\'s name alone works when only one note has it.' };

export const VAULT_TOOLS: ToolSpec[] = [
	{
		name: "read_note",
		description: "Read one note in full.",
		input: { type: "object", properties: { path }, required: ["path"], additionalProperties: false },
	},
	{
		name: "search_notes",
		description: "Find the notes and lines that contain some words. Case does not matter. Returns matching lines with their note.",
		input: { type: "object", properties: { query: { type: "string", description: "Words or a phrase to look for." } }, required: ["query"], additionalProperties: false },
	},
	{
		name: "list_notes",
		description: "List the notes in the vault, or in one folder of it.",
		input: { type: "object", properties: { folder: { type: "string", description: "A folder to list. Leave out for the whole vault." } }, additionalProperties: false },
	},
	{
		name: "edit_note",
		description:
			"Change part of a note: old_text is replaced by new_text. old_text must be copied exactly from the note and appear in it once; include a neighbouring line if it would otherwise match twice. Read the note first.",
		input: {
			type: "object",
			properties: { path, old_text: { type: "string" }, new_text: { type: "string" } },
			required: ["path", "old_text", "new_text"],
			additionalProperties: false,
		},
	},
	{
		name: "create_note",
		description: "Make a new note. Fails if something is already at that path.",
		input: {
			type: "object",
			properties: { path: { type: "string", description: 'Where to put it, ending in .md, e.g. "Macro/Open economy summary.md".' }, content: { type: "string" } },
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
];

/** Said to the model with the tools: what they are for and how to use them well. */
export const TOOL_RULES =
	"You can work in the student's vault with tools: read_note, search_notes and list_notes to look, edit_note and create_note to change things. " +
	"Look before you answer when the notes you were given don't cover the question. Change a note only when asked to, read it first, and keep each edit as small as the request allows. " +
	"The student may be asked to allow a change; if they decline, don't try it again another way. When you have changed something, say in a sentence what you changed and where.";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const leaf = (p: string): string => p.split("/").pop() ?? p;
const READ_CHARS = 60_000;
const SEARCH_HITS = 40;
const LIST_MOST = 400;

/** The note a path or a bare name means, or why it can't be told. */
export function resolveNote(port: VaultPort, asked: string): { path: string } | { error: string } {
	const want = asked.trim().replace(/^\/+/, "").replace(/^\[\[|\]\]$/g, "");
	if (!want) return { error: "No note was named." };
	const all = port.notes();
	const withExt = /\.md$/i.test(want) ? want : `${want}.md`;
	const exact = all.find((p) => p === withExt) ?? all.find((p) => p.toLowerCase() === withExt.toLowerCase());
	if (exact) return { path: exact };
	const name = leaf(withExt).toLowerCase();
	const byName = all.filter((p) => leaf(p).toLowerCase() === name);
	if (byName.length === 1) return { path: byName[0] };
	if (byName.length > 1) return { error: `More than one note is called that: ${byName.slice(0, 6).join(", ")}. Give the path.` };
	return { error: `There is no note at "${asked}". Use search_notes or list_notes to find it.` };
}

/** Which tools change the vault, and so may need permission. */
export const changes = (name: string): boolean => name === "edit_note" || name === "create_note";

/** The name Claude Code gives the same kind of work, so one summary line serves both. */
export function likeClaudeCode(name: string): string {
	return name === "read_note" ? "Read" : name === "search_notes" ? "Grep" : name === "list_notes" ? "LS" : name === "edit_note" ? "Edit" : name === "create_note" ? "Write" : name;
}

/** One line for what a call does, as it is listed above the reply. */
export function toolLine(call: ToolCall): string {
	const file = leaf(str(call.input.path));
	switch (call.name) {
		case "read_note":
			return `Read ${file || "a note"}`;
		case "search_notes":
			return `Search for "${str(call.input.query).slice(0, 60)}"`;
		case "list_notes":
			return str(call.input.folder) ? `List ${str(call.input.folder)}` : "List the notes";
		case "edit_note":
			return `Edit ${file || "a note"}`;
		case "create_note":
			return `Create ${file || "a note"}`;
		default:
			return `Use ${call.name}`;
	}
}

/** What the permission card shows for a change. */
export function toolAsk(call: ToolCall): PermissionAsk {
	if (call.name === "edit_note") {
		return permissionAsk("Edit", { file_path: str(call.input.path), old_string: str(call.input.old_text), new_string: str(call.input.new_text) }, `Edit ${leaf(str(call.input.path))}`);
	}
	return permissionAsk("Write", { file_path: str(call.input.path), content: str(call.input.content) }, `Create ${leaf(str(call.input.path))}`);
}

export interface ToolOutcome {
	content: string;
	failed?: boolean;
}

const fail = (content: string): ToolOutcome => ({ content, failed: true });

/** Do what one call asks. Never throws: what went wrong is told to the model, which
 * can then try again properly. Permission has been settled before this is called. */
export async function runTool(port: VaultPort, call: ToolCall): Promise<ToolOutcome> {
	if ("__unreadable" in call.input) return fail("The request could not be read. Send it again as valid JSON.");
	try {
		switch (call.name) {
			case "read_note": {
				const at = resolveNote(port, str(call.input.path));
				if ("error" in at) return fail(at.error);
				const text = await port.read(at.path);
				if (text === null) return fail(`"${at.path}" could not be read.`);
				return { content: `${at.path}\n\n${text.length > READ_CHARS ? `${text.slice(0, READ_CHARS)}\n\n[The note goes on: ${text.length - READ_CHARS} more characters not shown.]` : text}` };
			}
			case "search_notes": {
				const query = str(call.input.query).trim().toLowerCase();
				if (!query) return fail("No words were given to look for.");
				const words = query.split(/\s+/).filter(Boolean);
				const hits: string[] = [];
				let notes = 0;
				for (const p of port.notes()) {
					const text = await port.read(p);
					if (text === null) continue;
					const lower = text.toLowerCase();
					const named = words.every((w) => p.toLowerCase().includes(w));
					// The phrase as written first; failing that, a note that has every word.
					const phrase = lower.includes(query);
					if (!phrase && !named && !words.every((w) => lower.includes(w))) continue;
					notes++;
					if (hits.length >= SEARCH_HITS) continue;
					const lines = text.split("\n").filter((l) => {
						const ll = l.toLowerCase();
						return phrase ? ll.includes(query) : words.some((w) => ll.includes(w));
					});
					if (!lines.length) hits.push(`${p}: (the note's name matches)`);
					for (const l of lines.slice(0, 3)) if (hits.length < SEARCH_HITS) hits.push(`${p}: ${l.trim().slice(0, 240)}`);
				}
				if (!notes) return { content: `Nothing in the vault matches "${str(call.input.query)}".` };
				return { content: `${notes} ${notes === 1 ? "note matches" : "notes match"}.\n${hits.join("\n")}` };
			}
			case "list_notes": {
				const folder = str(call.input.folder).trim().replace(/^\/+|\/+$/g, "");
				const all = port.notes().filter((p) => !folder || p.toLowerCase().startsWith(`${folder.toLowerCase()}/`));
				if (!all.length) return fail(folder ? `There are no notes in "${folder}".` : "The vault has no notes.");
				const shown = all.slice(0, LIST_MOST);
				return { content: shown.join("\n") + (all.length > shown.length ? `\n[${all.length - shown.length} more not shown. List a folder to see them.]` : "") };
			}
			case "edit_note": {
				const at = resolveNote(port, str(call.input.path));
				if ("error" in at) return fail(at.error);
				if (port.locked(at.path)) return fail(`"${at.path}" is one of Grill's own files or is excluded, and is not changed from here.`);
				const before = str(call.input.old_text);
				const after = str(call.input.new_text);
				if (!before) return fail("old_text is empty. Copy the text to replace from the note.");
				if (before === after) return fail("old_text and new_text are the same: nothing to change.");
				const text = await port.read(at.path);
				if (text === null) return fail(`"${at.path}" could not be read.`);
				const count = text.split(before).length - 1;
				if (count === 0) return fail("old_text was not found in the note. Read the note and copy the text exactly, line breaks included.");
				if (count > 1) return fail(`old_text appears ${count} times in the note. Include more of the surrounding text so it matches once.`);
				await port.write(at.path, text.replace(before, () => after));
				return { content: `Changed ${at.path}.` };
			}
			case "create_note": {
				const want = str(call.input.path).trim().replace(/^\/+/, "");
				if (!want) return fail("No path was given.");
				const at = /\.md$/i.test(want) ? want : `${want}.md`;
				if (/(^|\/)\.\.?(\/|$)|[\\:*?"<>|]/.test(at)) return fail("That path can't be used. Give a plain path inside the vault.");
				if (port.locked(at)) return fail(`"${at}" is inside Grill's own folder or an excluded one. Put it elsewhere.`);
				if (port.exists(at)) return fail(`Something is already at "${at}". Choose another name, or edit that note.`);
				await port.create(at, str(call.input.content));
				return { content: `Created ${at}.` };
			}
			default:
				return fail(`There is no tool called ${call.name}.`);
		}
	} catch (e) {
		return fail(`That didn't work: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
	}
}

export interface ToolChat {
	/** Ask the model for its next step, given the steps so far. */
	step(steps: ToolMsg[], onText: (soFar: string) => void): Promise<StreamResult>;
	port: VaultPort;
	level: AgentLevel;
	onEvent(e: AgentEvent): void;
	ask(req: PermissionAsk): Promise<PermissionAnswer>;
	signal?: AbortSignal;
	/** How many times the model may be asked in one turn. */
	maxSteps?: number;
}

export interface ToolChatResult {
	text: string;
	/** What was used, by the names Claude Code gives the same work. */
	tools: string[];
	seconds: number;
}

/** One turn of Chat in which the model may use the vault tools: ask, do what it asks
 * for, hand back what came of it, and ask again, until it answers without asking. */
export async function runToolChat(chat: ToolChat): Promise<ToolChatResult> {
	const began = Date.now();
	const steps: ToolMsg[] = [];
	const tools: string[] = [];
	// What it has said in earlier steps of this turn, shown ahead of what it says now.
	let said = "";
	let always = false;
	const most = chat.maxSteps ?? 12;
	for (let n = 0; n < most; n++) {
		const got = await chat.step(steps, (soFar) => chat.onEvent({ kind: "text", soFar: said ? `${said}\n\n${soFar}` : soFar }));
		if (got.text.trim()) said = said ? `${said}\n\n${got.text.trim()}` : got.text.trim();
		if (!got.calls.length) break;
		steps.push({ role: "assistant", text: got.text, calls: got.calls });
		const results: Array<{ id: string; content: string; failed?: boolean }> = [];
		for (const call of got.calls) {
			if (chat.signal?.aborted) throw new DOMException("Stopped.", "AbortError");
			chat.onEvent({ kind: "activity", tool: likeClaudeCode(call.name), line: toolLine(call) });
			let outcome: ToolOutcome;
			if (changes(call.name) && chat.level === "plan") {
				outcome = fail("Plan level: nothing may be changed. Describe the change you would make instead.");
			} else if (changes(call.name) && chat.level === "safe" && !always) {
				const answer = await chat.ask(toolAsk(call));
				if (answer === "always") always = true;
				outcome = answer === "deny" ? fail("The student declined this change.") : await runTool(chat.port, call);
			} else {
				outcome = await runTool(chat.port, call);
			}
			if (!outcome.failed) tools.push(likeClaudeCode(call.name));
			results.push({ id: call.id, content: outcome.content, ...(outcome.failed ? { failed: true } : {}) });
		}
		steps.push({ role: "tool", results });
		if (n === most - 1) said = `${said}${said ? "\n\n" : ""}That is as far as one message goes. Ask me to go on.`;
	}
	return { text: said || "Done.", tools, seconds: (Date.now() - began) / 1000 };
}
