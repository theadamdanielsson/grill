/**
 * Claude Code as the engine behind Chat.
 *
 * This runs the Claude Code that is already installed on the user's machine, signed in
 * however they signed it in, with the vault as its working folder. Grill starts the
 * program as it is and talks to it through Anthropic's Agent SDK; it never reads,
 * stores or forwards a login, and it does not change the program.
 *
 * The permission levels, what is shown while it works and when it must ask are Claude
 * Code's own: Grill passes the level on and draws what comes back. The SDK is loaded
 * only when this engine is used, and only on desktop, where there is a program to run.
 *
 * The approach follows Claudian (github.com/YishenTu/claudian, MIT).
 */
import type { CanUseTool, Options, PermissionMode, PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Claude Code's permission levels, by the names its own interface gives them. */
export type AgentLevel = "safe" | "plan" | "auto";

export const AGENT_LEVELS: Array<{ id: AgentLevel; name: string; says: string }> = [
	{ id: "safe", name: "Safe", says: "Asks before it changes a note or runs a command." },
	{ id: "plan", name: "Plan", says: "Reads and proposes. Changes nothing." },
	{ id: "auto", name: "Auto", says: "Edits notes without asking. Still asks before running a command." },
];

export function levelMode(level: AgentLevel): PermissionMode {
	return level === "plan" ? "plan" : level === "auto" ? "acceptEdits" : "default";
}

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const leaf = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What kind of work a tool call is, for counting it in the folded line. */
export type ActivityKind = "read" | "search" | "edit" | "run" | "web" | "other";

export function activityKind(tool: string): ActivityKind {
	if (tool === "Read" || tool === "NotebookRead") return "read";
	if (tool === "Glob" || tool === "Grep" || tool === "LS") return "search";
	if (tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "NotebookEdit") return "edit";
	if (tool === "Bash" || tool === "BashOutput" || tool === "KillShell") return "run";
	if (tool === "WebSearch" || tool === "WebFetch") return "web";
	return "other";
}

/** One line for one thing Claude Code did, as its own interface would say it. */
export function activityLine(tool: string, input: Input): string {
	const file = leaf(text(input.file_path) || text(input.notebook_path) || text(input.path));
	switch (tool) {
		case "Read":
		case "NotebookRead":
			return file ? `Read ${file}` : "Read a file";
		case "Write":
			return file ? `Write ${file}` : "Write a file";
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return file ? `Edit ${file}` : "Edit a file";
		case "Glob":
			return `Search for files ${clip(text(input.pattern), 60)}`.trim();
		case "Grep":
			return `Search for "${clip(text(input.pattern), 60)}"`;
		case "LS":
			return file ? `List ${file}` : "List a folder";
		case "Bash":
			return `Run ${clip(text(input.command).split("\n")[0], 80)}`.trim();
		case "WebSearch":
			return `Search the web for "${clip(text(input.query), 60)}"`;
		case "WebFetch":
			return `Fetch ${clip(text(input.url), 80)}`.trim();
		case "Task":
		case "Agent":
			return `Hand off: ${clip(text(input.description), 60)}`;
		case "TodoWrite":
			return "Update its to-do list";
		default:
			return tool.startsWith("mcp__") ? `Use ${tool.split("__").slice(1).join(" ")}` : `Use ${tool}`;
	}
}

const times = (n: number, one: string, many: string): string => (n === 1 ? one : many.replace("#", String(n)));

/** Everything it did, in one line: what the folded row says when the reply is done. */
export function activitySummary(tools: string[], seconds: number): string {
	const count: Record<ActivityKind, number> = { read: 0, search: 0, edit: 0, run: 0, web: 0, other: 0 };
	for (const t of tools) count[activityKind(t)]++;
	const parts: string[] = [];
	if (count.read) parts.push(times(count.read, "read 1 file", "read # files"));
	if (count.search) parts.push(times(count.search, "searched the vault once", "searched the vault # times"));
	if (count.edit) parts.push(times(count.edit, "edited 1 file", "made # edits"));
	if (count.run) parts.push(times(count.run, "ran 1 command", "ran # commands"));
	if (count.web) parts.push(times(count.web, "looked on the web once", "looked on the web # times"));
	if (count.other) parts.push(times(count.other, "used 1 other tool", "used # other tools"));
	if (seconds >= 1) parts.push(`worked for ${Math.round(seconds)}s`);
	const line = parts.join(", ");
	return line ? line[0].toUpperCase() + line.slice(1) : "";
}

/** What a permission card shows: what is asked, and for a change to a note, the lines
 * that go and the lines that come. */
export interface PermissionAsk {
	tool: string;
	title: string;
	removed: string[];
	added: string[];
	/** A command, an address: what there is to read before deciding, when it isn't a change. */
	detail: string;
	/** The words on the middle button: what "always" would cover. */
	always: string;
}

const lines = (s: string, most = 12): string[] => {
	const all = s.split("\n").filter((l) => l.trim());
	return all.length > most ? [...all.slice(0, most), `… ${all.length - most} more lines`] : all;
};

export function permissionAsk(tool: string, input: Input, title?: string): PermissionAsk {
	const ask: PermissionAsk = { tool, title: title || activityLine(tool, input), removed: [], added: [], detail: "", always: "Always allow in this chat" };
	if (tool === "Edit") {
		ask.removed = lines(text(input.old_string));
		ask.added = lines(text(input.new_string));
		ask.always = "Always allow edits in this chat";
	} else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
		for (const e of input.edits as Input[]) {
			ask.removed.push(...lines(text(e.old_string), 6));
			ask.added.push(...lines(text(e.new_string), 6));
		}
		ask.always = "Always allow edits in this chat";
	} else if (tool === "Write") {
		ask.added = lines(text(input.content));
		ask.always = "Always allow edits in this chat";
	} else if (tool === "Bash") {
		ask.detail = text(input.command);
	} else if (tool === "WebFetch") {
		ask.detail = text(input.url);
	} else if (tool === "WebSearch") {
		ask.detail = text(input.query);
	}
	return ask;
}

export type PermissionAnswer = "once" | "always" | "deny";

export type AgentEvent =
	/** The reply so far, each time more of it is written. */
	| { kind: "text"; soFar: string }
	/** Something it did or is about to do. */
	| { kind: "activity"; tool: string; line: string };

export interface AgentRun {
	prompt: string;
	/** The vault: where it reads and writes. */
	cwd: string;
	/** The installed Claude Code. */
	program: string;
	level: AgentLevel;
	/** The conversation to go on with, from an earlier turn's result. */
	resume?: string;
	/** Added to Claude Code's own instructions: who it is working for here, and what
	 * Grill has on record. */
	append?: string;
	model?: string;
	signal?: AbortSignal;
	onEvent(e: AgentEvent): void;
	ask(req: PermissionAsk): Promise<PermissionAnswer>;
}

export interface AgentResult {
	text: string;
	sessionId: string;
	tools: string[];
	seconds: number;
}

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === "object" ? (v as Loose) : null);

/** Follows the messages of one turn and keeps what the reply is so far. Separate from
 * the running of the program so that it can be checked without one. */
export class TurnReader {
	text = "";
	tools: string[] = [];
	sessionId = "";
	failed = "";
	result: string | null = null;
	constructor(private onEvent: (e: AgentEvent) => void) {}

	take(m: SDKMessage | Loose): void {
		const msg = m as Loose;
		if (typeof msg.session_id === "string" && msg.session_id) this.sessionId = msg.session_id;
		// What a helper it handed work to says is its own business, not the reply.
		if (msg.parent_tool_use_id) return;
		if (msg.type === "stream_event") {
			const e = obj(msg.event);
			const delta = obj(e?.delta);
			if (e?.type === "content_block_start" && obj(e.content_block)?.type === "text" && this.text && !this.text.endsWith("\n")) {
				// A new stretch of prose after it went off to do something.
				this.text += "\n\n";
			}
			if (e?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
				this.text += delta.text;
				this.onEvent({ kind: "text", soFar: this.text });
			}
		} else if (msg.type === "assistant") {
			const content = obj(msg.message)?.content;
			if (!Array.isArray(content)) return;
			for (const block of content) {
				const b = obj(block);
				if (b?.type === "tool_use" && typeof b.name === "string") {
					this.tools.push(b.name);
					this.onEvent({ kind: "activity", tool: b.name, line: activityLine(b.name, obj(b.input) ?? {}) });
				}
			}
		} else if (msg.type === "result") {
			if (msg.subtype === "success" && !msg.is_error) this.result = typeof msg.result === "string" ? msg.result : "";
			else this.failed = msg.subtype === "error_max_turns" ? "It stopped after too many steps. Ask it to go on." : typeof msg.result === "string" && msg.result ? msg.result : "Claude Code stopped with an error.";
		}
	}

	/** The reply: what was heard as it was written, or failing that, what the result says. */
	reply(): string {
		return this.text.trim() || (this.result ?? "").trim();
	}
}

/** Run one turn. Throws with a sentence fit to show when it can't be run or fails. */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const stop = new AbortController();
	const left = (): void => stop.abort();
	run.signal?.addEventListener("abort", left);
	const began = Date.now();
	const reader = new TurnReader(run.onEvent);
	let said = "";
	const canUseTool: CanUseTool = async (tool, input, o) => {
		const answer = await run.ask(permissionAsk(tool, input, (o as { title?: string }).title));
		if (answer === "deny") return { behavior: "deny", message: "The user declined this." };
		const updated: PermissionUpdate[] | undefined = answer === "always" ? o.suggestions : undefined;
		return { behavior: "allow", updatedInput: input, ...(updated?.length ? { updatedPermissions: updated } : {}) };
	};
	const options: Options = {
		cwd: run.cwd,
		pathToClaudeCodeExecutable: run.program,
		permissionMode: levelMode(run.level),
		includePartialMessages: true,
		abortController: stop,
		canUseTool,
		systemPrompt: run.append ? { type: "preset", preset: "claude_code", append: run.append } : { type: "preset", preset: "claude_code" },
		// The user's own settings and the vault's, as when they run it in a terminal there.
		settingSources: ["user", "project", "local"],
		stderr: (data) => {
			said = (said + data).slice(-600);
		},
		...(run.resume ? { resume: run.resume } : {}),
		...(run.model ? { model: run.model } : {}),
	};
	try {
		for await (const m of query({ prompt: run.prompt, options })) reader.take(m);
	} catch (e) {
		if (run.signal?.aborted) throw e;
		const why = e instanceof Error ? e.message : String(e);
		if (/ENOENT|not found|spawn/i.test(why)) throw new Error("Claude Code could not be started. Check where it is installed, in settings.");
		if (/log ?in|auth|credential|401/i.test(`${why} ${said}`)) throw new Error("Claude Code is not signed in. Open a terminal, run claude, and sign in there.");
		throw new Error(`Claude Code stopped: ${clip(why, 200)}`);
	} finally {
		run.signal?.removeEventListener("abort", left);
	}
	if (reader.failed) throw new Error(reader.failed);
	const reply = reader.reply();
	if (!reply) throw new Error("Claude Code finished without saying anything.");
	return { text: reply, sessionId: reader.sessionId, tools: reader.tools, seconds: (Date.now() - began) / 1000 };
}

/** Where Claude Code is usually installed, most likely first. Obsidian started from the
 * dock does not have the terminal's PATH, so the places are named outright. */
export function programPlaces(home: string, platform: string, env: Record<string, string | undefined>): string[] {
	if (platform === "win32") {
		const app = env.APPDATA ?? `${home}\\AppData\\Roaming`;
		const local = env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
		return [`${home}\\.local\\bin\\claude.exe`, `${home}\\.claude\\local\\claude.exe`, `${local}\\Programs\\claude\\claude.exe`, `${app}\\npm\\claude.cmd`];
	}
	return [
		`${home}/.local/bin/claude`,
		`${home}/.claude/local/claude`,
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		`${home}/.npm-global/bin/claude`,
		`${home}/.volta/bin/claude`,
		`${home}/.bun/bin/claude`,
		"/usr/bin/claude",
	];
}

/** The installed Claude Code: the path set in settings if it is there, else the first
 * usual place that has one. Null on a phone, or when it isn't installed. */
export function findProgram(setPath: string): string | null {
	try {
		const need = (window as unknown as { require?: (name: string) => unknown }).require;
		if (!need) return null;
		const fs = need("fs") as { existsSync(p: string): boolean };
		const os = need("os") as { homedir(): string };
		const proc = need("process") as { platform: string; env: Record<string, string | undefined> };
		const wanted = setPath.trim();
		if (wanted) return fs.existsSync(wanted) ? wanted : null;
		return programPlaces(os.homedir(), proc.platform, proc.env).find((p) => fs.existsSync(p)) ?? null;
	} catch {
		return null;
	}
}
