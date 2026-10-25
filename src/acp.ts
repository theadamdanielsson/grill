/**
 * Any agent that speaks the Agent Client Protocol (agentclientprotocol.com) as the
 * engine behind Chat. opencode is the one Grill can install; the same code runs any
 * other program that offers an `acp` command.
 *
 * As with Claude Code and Codex, the program runs as it is, signed in however it was
 * signed in, with the vault as its working folder. Grill starts it, speaks the
 * protocol over its pipes (JSON-RPC, one message a line) and draws what comes back on
 * the same activity list and permission card as the other engines. When it must ask
 * is the program's own configuration; Grill sets it from the level (see opencode.ts).
 */
import { RECORD_TOOL_RE, recordToolLine } from "./recordtools";
import { AgentEvent, AgentLevel, AgentResult, PermissionAnswer, PermissionAsk } from "./agent";
import { diffLines } from "./codex";
import { HANDSHAKE_MS, IDLE_MS, idleWatch, NOT_STARTED, openLineWire, quietError, type LineWire, SIGNED_OUT } from "./wire";

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const leaf = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A line each way, however they are carried: the program's pipes, or a stand-in. */
export type AcpWire = LineWire;

/** A model the agent offers, as it names it. */
export interface AcpModel {
	id: string;
	name: string;
}

export interface AcpRun {
	/** The program's name, for what is said when something goes wrong. */
	name: string;
	prompt: string;
	/** The vault: where it reads and writes. */
	cwd: string;
	level: AgentLevel;
	/** The conversation to go on with, from an earlier turn's result. */
	resume?: string;
	/** Said ahead of the first message: where it is, who for, what Grill has on record. */
	brief?: string;
	/** The model to use, by the agent's own id. Empty: the agent's own choice. */
	model?: string;
	/** MCP servers to give the session, as the protocol describes them. */
	mcpServers?: Array<
		| { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
		| { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
	>;
	signal?: AbortSignal;
	onEvent: (e: AgentEvent) => void;
	ask: (req: PermissionAsk) => Promise<PermissionAnswer>;
	/** Told the models the agent offers, and which one it is on, each time a session opens. */
	onModels?: (models: AcpModel[], current: string) => void;
}

/** The name Claude Code gives the same kind of work, so one summary line serves all. */
export function acpTool(kind: string): string {
	switch (kind) {
		case "read":
			return "Read";
		case "edit":
		case "delete":
		case "move":
			return "Edit";
		case "search":
			return "Grep";
		case "execute":
			return "Bash";
		case "fetch":
			return "WebFetch";
		default:
			return "Other";
	}
}

/** One line for something the agent did or is about to do. */
export function acpLine(call: Loose): string {
	const kind = str(call.kind);
	const input = obj(call.rawInput) ?? {};
	const where = list(call.locations).map((l) => leaf(str(obj(l)?.path))).filter(Boolean);
	const file = where[0] || leaf(str(input.path) || str(input.filePath) || str(input.file_path));
	const title = str(call.title);
	// Grill's own record, over MCP: named the way Chat names it everywhere else. opencode 2
	// calls MCP tools from a short program it runs, so the name may be in that instead.
	const record = RECORD_TOOL_RE.exec(`${title} ${str(input.code)}`);
	if (record) return recordToolLine(record[0], input);
	switch (kind) {
		case "read":
			return file ? `Read ${file}` : title ? `Read ${clip(title, 60)}` : "Read a file";
		case "edit":
			return where.length > 1 ? `Edit ${where.slice(0, 3).join(", ")}` : file ? `Edit ${file}` : "Edit a file";
		case "delete":
			return file ? `Delete ${file}` : "Delete a file";
		case "move":
			return file ? `Move ${file}` : "Move a file";
		case "search": {
			const pattern = str(input.pattern) || str(input.query);
			return pattern ? `Search for "${clip(pattern, 60)}"` : title ? clip(title, 80) : "Search the vault";
		}
		case "execute": {
			const command = str(input.command) || title;
			return command ? `Run ${clip(command.split("\n")[0], 80)}` : "Run a command";
		}
		case "fetch": {
			const url = str(input.url) || str(input.query) || title;
			return url ? `Fetch ${clip(url, 80)}` : "Look on the web";
		}
		default:
			return title ? clip(title[0].toUpperCase() + title.slice(1), 80) : "Use a tool";
	}
}

/** What the permission card shows for one request: the change, when there is one, as
 * the lines that go and the lines that come. Agents carry a change either as the
 * protocol's diff content or, like opencode, as a patch in what the tool was given. */
export function acpAsk(call: Loose): PermissionAsk {
	const kind = str(call.kind);
	const input = obj(call.rawInput) ?? {};
	const tool = acpTool(kind);
	const removed: string[] = [];
	const added: string[] = [];
	for (const c of list(call.content)) {
		const d = obj(c);
		if (d?.type !== "diff") continue;
		const was = str(d.oldText);
		const now = str(d.newText);
		const cut = diffLines([...(was ? was.split("\n").map((l) => `-${l}`) : []), ...now.split("\n").map((l) => `+${l}`)].join("\n"));
		removed.push(...cut.removed);
		added.push(...cut.added);
	}
	for (const f of list(input.files)) {
		const cut = diffLines(str(obj(f)?.patch));
		removed.push(...cut.removed);
		added.push(...cut.added);
	}
	if (!removed.length && !added.length && str(input.patch)) {
		const cut = diffLines(str(input.patch));
		removed.push(...cut.removed);
		added.push(...cut.added);
	}
	if (tool === "Edit") {
		return { tool, title: acpLine(call), removed, added, detail: "", always: "Always allow edits in this chat" };
	}
	if (tool === "Bash") {
		return { tool, title: "Run a command", removed, added, detail: str(input.command) || str(call.title), always: "Always allow this command in this chat" };
	}
	const query = str(input.query);
	const title = tool === "Other" && query && !str(input.url) ? `Search the web for "${clip(query, 60)}"` : acpLine(call);
	return { tool: query && tool === "Other" ? "WebSearch" : tool, title, removed, added, detail: str(input.url) || query || "", always: "Always allow in this chat" };
}

/** The option the agent offered that matches the answer given on the card. */
export function pickOption(options: unknown[], answer: PermissionAnswer): string | null {
	const of = (kind: string): string | null => {
		const o = options.map(obj).find((x) => x && x.kind === kind);
		return o ? str(o.optionId) : null;
	};
	if (answer === "once") return of("allow_once") ?? of("allow_always");
	if (answer === "always") return of("allow_always") ?? of("allow_once");
	return of("reject_once") ?? of("reject_always");
}

/** The models in what a session said about itself: the protocol's config options, or
 * the older `models` field. */
export function modelsOf(session: Loose): { models: AcpModel[]; current: string } {
	const option = list(session.configOptions)
		.map(obj)
		.find((o) => o && (o.category === "model" || o.id === "model"));
	if (option) {
		const models = list(option.options)
			.map(obj)
			.filter((o): o is Loose => !!o && !!str(o.value))
			.map((o) => ({ id: str(o.value), name: str(o.name) || str(o.value) }));
		return { models, current: str(option.currentValue) };
	}
	const old = obj(session.models);
	const models = list(old?.availableModels)
		.map(obj)
		.filter((o): o is Loose => !!o && !!str(o.modelId))
		.map((o) => ({ id: str(o.modelId), name: str(o.name) || str(o.modelId) }));
	return { models, current: str(old?.currentModelId) };
}

/** A session's mode option, when it has one with a "read and propose only" value: that
 * value, the one to go back to otherwise, and the one it is on. */
export function modeOption(session: Loose): { configId: string; plan: string; other: string; current: string } | null {
	const option = list(session.configOptions)
		.map(obj)
		.find((o) => o && (o.category === "mode" || o.id === "mode"));
	if (!option) return null;
	const values = list(option.options).map((o) => str(obj(o)?.value)).filter(Boolean);
	const plan = values.find((v) => /^plan$/i.test(v));
	const other = values.find((v) => /^build$/i.test(v)) ?? values.find((v) => v !== plan);
	return plan && other ? { configId: str(option.id), plan, other, current: str(option.currentValue) } : null;
}

/** Run one turn over a wire that is already open. Throws with a sentence fit to show. */
export async function runAcpTurn(run: AcpRun, wire: AcpWire): Promise<AgentResult> {
	const began = Date.now();
	let nextId = 1;
	const waiting = new Map<number, { yes(v: unknown): void; no(e: Error): void }>();
	const tools: string[] = [];
	const counted = new Set<string>();
	/** Calls that read Grill's record, so the summary says they read it. */
	const recordReads = new Set<string>();
	/** What each tool call has said about itself so far, by its id. */
	const calls = new Map<string, Loose>();
	let text = "";
	let lastKind = "";
	let sessionId = "";
	/** Until the turn is sent, updates are the old conversation being played back. */
	let live = false;
	let stopped = false;
	/** Whether a change was declined on the card: some agents (opencode) end the turn there. */
	let declined = false;
	/** Whether Plan turned a change or a command away, which it does without asking. */
	let planned = false;
	// A program that stops answering is given up on, not waited for with the pane locked.
	const watch = idleWatch(HANDSHAKE_MS, (ms) => {
		const e = quietError(run.name, ms);
		for (const p of waiting.values()) p.no(e);
		waiting.clear();
	});

	const request = <T>(method: string, params: unknown): Promise<T> =>
		new Promise<T>((yes, no) => {
			const id = nextId++;
			waiting.set(id, { yes: yes as (v: unknown) => void, no });
			wire.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	const answer = (id: unknown, result: unknown): void => wire.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	const refuse = (id: unknown, message: string): void => wire.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));

	const asked = async (id: unknown, method: string, params: Loose): Promise<void> => {
		if (method === "session/request_permission") {
			if (stopped) return answer(id, { outcome: { outcome: "cancelled" } });
			const call = { ...(calls.get(str(obj(params.toolCall)?.toolCallId)) ?? {}), ...(obj(params.toolCall) ?? {}) };
			// Plan changes nothing and runs nothing, whatever the agent's own rules let through.
			if (run.level === "plan" && ["edit", "delete", "move", "execute"].includes(str(call.kind))) {
				planned = declined = true;
				const optionId = pickOption(list(params.options), "deny");
				return answer(id, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
			}
			const a = await run.ask(acpAsk(call));
			if (a === "deny") declined = true;
			if (stopped) return answer(id, { outcome: { outcome: "cancelled" } });
			const optionId = pickOption(list(params.options), a);
			return answer(id, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
		}
		// Grill does not offer files or a terminal of its own: the agent uses its own.
		refuse(id, `Grill does not handle ${method}.`);
	};

	const told = (params: Loose): void => {
		const u = obj(params.update);
		if (!u || !live) return;
		// Work handed to a helper inside the agent is the agent's business: its reply is
		// what the agent makes of it, not the helper's own words.
		if (obj(u._meta)?.["opencode/child-session"] || obj(params._meta)?.["opencode/child-session"]) return;
		const what = str(u.sessionUpdate);
		if (what === "agent_message_chunk") {
			const c = obj(u.content);
			if (c?.type !== "text") return;
			// Text after a tool call is a new paragraph, not the end of the last sentence.
			if (lastKind === "tool" && text && !text.endsWith("\n")) text += "\n\n";
			text += str(c.text);
			lastKind = "text";
			run.onEvent({ kind: "text", soFar: text });
		} else if (what === "tool_call" || what === "tool_call_update") {
			const id = str(u.toolCallId);
			const before = calls.get(id);
			const call = { ...(before ?? {}), ...u };
			calls.set(id, call);
			lastKind = "tool";
			// Said once, when there is enough to say what it is: opencode opens a call
			// with nothing in it and names the file in the next update.
			const said = before?.said === true;
			const input = obj(call.rawInput) ?? {};
			const ready =
				call.status === "completed" ||
				call.status === "failed" ||
				(call.kind === "execute" ? !!str(input.command) : list(call.locations).length > 0 || Object.keys(input).length > 0);
			if (!said && ready) {
				call.said = true;
				// Reading Grill's record counts as reading, in the summary under the reply.
				if (RECORD_TOOL_RE.test(`${str(call.title)} ${str(obj(call.rawInput)?.code)}`)) recordReads.add(id);
				run.onEvent({ kind: "activity", tool: recordReads.has(id) ? "Read" : acpTool(str(call.kind)), line: acpLine(call) });
			}
			// Counted once it has been done, and only if it was: a declined change is not work.
			if (call.status === "completed" && !counted.has(id)) {
				counted.add(id);
				tools.push(recordReads.has(id) ? "Read" : acpTool(str(call.kind)));
			}
		}
	};

	wire.onLine((line) => {
		watch.heard();
		let m: Loose | null = null;
		try {
			m = obj(JSON.parse(line));
		} catch {
			return; // not a message: a stray line of log
		}
		if (!m) return;
		if (typeof m.method === "string") {
			const params = obj(m.params) ?? {};
			if (m.id !== undefined && m.id !== null) void watch.hold(asked(m.id, m.method, params)).catch(() => refuse(m?.id, "That request could not be answered."));
			else if (m.method === "session/update") told(params);
			return;
		}
		const pending = typeof m.id === "number" ? waiting.get(m.id) : undefined;
		if (!pending) return;
		waiting.delete(m.id as number);
		const err = obj(m.error);
		if (err) pending.no(new Error(str(err.message) || `${run.name} refused the request.`));
		else pending.yes(m.result);
	});
	wire.onClose((why) => {
		const e = new Error(
			why === NOT_STARTED
				? `${run.name} could not be started. Check where it is installed, in settings.`
				: SIGNED_OUT.test(why)
					? `${run.name} is not signed in to that model. Pick another model, or sign in from Grill's settings.`
					: `${run.name} stopped${why ? `: ${clip(why.trim(), 200)}` : "."}`,
		);
		for (const p of waiting.values()) p.no(e);
		waiting.clear();
	});

	const stop = (): void => {
		stopped = true;
		if (sessionId) wire.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }));
		const e = new DOMException("Stopped.", "AbortError");
		for (const p of waiting.values()) p.no(e);
		waiting.clear();
	};
	run.signal?.addEventListener("abort", stop, { once: true });
	try {
		const init = await request<Loose>("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "grill", version: "1.0.0" },
		});
		const caps = obj(init?.agentCapabilities) ?? {};
		const sessionCaps = obj(caps.sessionCapabilities) ?? {};
		let session: Loose | null = null;
		if (run.resume) {
			// Picked up without the old conversation played back where the protocol allows
			// it; played back (and not shown) where it only allows loading.
			const how = sessionCaps.resume ? "session/resume" : caps.loadSession ? "session/load" : "";
			if (how) {
				try {
					session = (await request<Loose>(how, { sessionId: run.resume, cwd: run.cwd, mcpServers: run.mcpServers ?? [] })) ?? {};
					sessionId = run.resume;
				} catch (e) {
					if ((e as Error).name === "AbortError") throw e;
					session = null; // gone: a new conversation, with the brief again
				}
			}
		}
		const fresh = !session;
		if (!session) {
			session = (await request<Loose>("session/new", { cwd: run.cwd, mcpServers: run.mcpServers ?? [] })) ?? {};
			sessionId = str(session.sessionId);
		}
		if (!sessionId) throw new Error(`${run.name} did not open a conversation.`);
		const { models, current } = modelsOf(session);
		if (models.length) run.onModels?.(models, current);
		if (run.model && run.model !== current && models.some((m) => m.id === run.model)) {
			await request("session/set_config_option", { sessionId, configId: "model", value: run.model });
		}
		// Set either way: a conversation picked up again keeps the mode it was left in.
		const mode = modeOption(session);
		const wanted = mode && (run.level === "plan" ? mode.plan : mode.other);
		if (mode && wanted && (wanted !== mode.current || !fresh)) await request("session/set_config_option", { sessionId, configId: mode.configId, value: wanted });
		if (run.signal?.aborted) throw new DOMException("Stopped.", "AbortError");
		const first = fresh && run.brief ? `<context>\n${run.brief}\n</context>\n\n${run.prompt}` : run.prompt;
		live = true;
		watch.limit(IDLE_MS);
		const done = await request<Loose>("session/prompt", { sessionId, prompt: [{ type: "text", text: first }] });
		if (stopped || (str(done?.stopReason) === "cancelled" && !declined)) throw new DOMException("Stopped.", "AbortError");
		if (str(done?.stopReason) === "refusal") throw new Error(`${run.name} declined to answer that.`);
	} finally {
		watch.stop();
		run.signal?.removeEventListener("abort", stop);
	}
	// A turn the agent ended on a declined change has said what it was about to do, or
	// nothing: either way nothing was changed, which is the answer.
	const changed = tools.includes("Edit") || tools.includes("Bash");
	const reply =
		text.trim() ||
		(planned
			? "Plan changes nothing. Switch to Safe to let it make the change, with your permission."
			: declined
				? changed
					? "Stopped at the change you declined. What was allowed before it was done."
					: "Declined, so nothing was changed."
				: "");
	if (!reply) throw new Error(`${run.name} finished without saying anything.`);
	return { text: reply, sessionId, tools, seconds: (Date.now() - began) / 1000 };
}



/** How to start a program as an ACP agent. */
export interface AcpProgram {
	program: string;
	args: string[];
	/** Added to its environment: how the level is passed on, for opencode. */
	env?: Record<string, string>;
}

/** Start the program on its own pipes. Each turn has its own process, which picks the
 * conversation up again by its id; nothing is left running between messages. */
export function openAcp(p: AcpProgram, cwd: string, name = "The program"): AcpWire {
	return openLineWire(p, cwd, name);
}

/** One turn with an ACP program. */
export async function runAcp(run: AcpRun & AcpProgram): Promise<AgentResult> {
	const wire = openAcp(run, run.cwd, run.name);
	try {
		return await runAcpTurn(run, wire);
	} finally {
		wire.close();
	}
}

/** The models an ACP program offers, without sending anything to a model: a session is
 * opened, read and closed. */
export async function acpModels(p: AcpProgram, cwd: string): Promise<{ models: AcpModel[]; current: string }> {
	const wire = openAcp(p, cwd);
	let nextId = 1;
	const waiting = new Map<number, (m: Loose) => void>();
	wire.onLine((line) => {
		let m: Loose | null = null;
		try {
			m = obj(JSON.parse(line));
		} catch {
			return;
		}
		if (m && typeof m.id === "number" && typeof m.method !== "string") waiting.get(m.id)?.(m);
	});
	const request = (method: string, params: unknown): Promise<Loose> =>
		new Promise((yes, no) => {
			const id = nextId++;
			waiting.set(id, (m) => (obj(m.error) ? no(new Error(str(obj(m.error)?.message))) : yes(obj(m.result) ?? {})));
			wire.onClose((why) => no(new Error(why || "The program stopped.")));
			wire.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	try {
		await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
		return modelsOf(await request("session/new", { cwd, mcpServers: [] }));
	} finally {
		wire.close();
	}
}
