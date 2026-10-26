/**
 * Codex as the engine behind Chat.
 *
 * Like the Claude Code engine (agent.ts), this runs a program that is already on the
 * user's machine, signed in however they signed it in, with the vault as its working
 * folder. Grill starts `codex app-server` as it is and talks to it over its own
 * protocol (JSON-RPC, one message a line); it never reads, stores or forwards a login.
 *
 * What Codex may do, and when it must ask, is Codex's own machinery: a sandbox and an
 * approval policy. Grill's three levels choose among Codex's own settings and draw
 * what comes back on the same activity list and permission card as the other engines.
 *
 * The protocol and the way to launch it follow Claudian (github.com/YishenTu/claudian, MIT).
 */
import type { ToolSpec } from "./stream";
import type { ToolRunner } from "./loopback";
import { isRecordTool, recordToolLine } from "./recordtools";
import { AgentEvent, AgentLevel, AgentResult, PermissionAnswer, PermissionAsk } from "./agent";
import { findInstalled, HANDSHAKE_MS, IDLE_MS, idleWatch, need, NOT_STARTED, openLineWire, quietError, rpcPeer, type LineWire, SIGNED_OUT } from "./wire";

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const leaf = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Codex's own settings for each of Grill's levels. Safe: it may read, and asks before
 * anything else. Plan: it may read, and nothing is asked because nothing may change.
 * Auto: it may change files in the vault, and asks before reaching outside it. */
export function codexPolicy(level: AgentLevel): { approvalPolicy: string; sandbox: string } {
	if (level === "plan") return { approvalPolicy: "never", sandbox: "read-only" };
	if (level === "auto") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
	return { approvalPolicy: "on-request", sandbox: "read-only" };
}

/** A line each way, however they are carried: the program's pipes, or a stand-in. */
export type CodexWire = LineWire;

export interface CodexRun {
	prompt: string;
	/** The vault: where it reads and writes. */
	cwd: string;
	level: AgentLevel;
	/** The conversation to go on with, from an earlier turn's result. */
	resume?: string;
	/** Said ahead of the first message: where it is, who for, what Grill has on record. */
	brief?: string;
	signal?: AbortSignal;
	onEvent: (e: AgentEvent) => void;
	ask: (req: PermissionAsk) => Promise<PermissionAnswer>;
	/** Grill's own tools, given to a new conversation as Codex's dynamic tools and run
	 * here when it calls them. A conversation keeps the tools it started with. */
	tools?: { specs: ToolSpec[]; call: ToolRunner };
	/** The model to answer with, by Codex's own name for it; empty for Codex's default. */
	model?: string;
	/** Pictures sent with the first message, as data a model reads. */
	images?: { mediaType: string; dataBase64: string }[];
	/** JSON Schema the final answer must match (turn/start's outputSchema). */
	outputSchema?: Record<string, unknown>;
}

/** The namespace Grill's dynamic tools are listed under. */
export const CODEX_TOOL_NAMESPACE = "grill";

/** The name Claude Code gives the same kind of work, so one summary line serves all. */
function likeClaudeCode(itemType: string): string {
	// Grill's own tools only read the record, so they count as reading.
	return itemType === "commandExecution" ? "Bash" : itemType === "fileChange" ? "Edit" : itemType === "webSearch" ? "WebSearch" : itemType === "dynamicToolCall" ? "Read" : "Other";
}

interface Change {
	path: string;
	diff: string;
}

function changesOf(item: Loose): Change[] {
	return (Array.isArray(item.changes) ? item.changes : []).map((c) => ({ path: str(obj(c)?.path), diff: str(obj(c)?.diff) }));
}

/** One line for something Codex did or is about to do. */
export function codexLine(item: Loose): string | null {
	switch (item.type) {
		case "commandExecution":
			return `Run ${clip(str(item.command).split("\n")[0], 80)}`.trim();
		case "fileChange": {
			const files = changesOf(item).map((c) => leaf(c.path)).filter(Boolean);
			return files.length ? `Edit ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}` : "Edit a file";
		}
		case "webSearch":
			return `Search the web for "${clip(str(item.query), 60)}"`;
		case "mcpToolCall":
			return `Use ${str(item.server)} ${str(item.tool)}`.trim();
		case "dynamicToolCall": {
			const tool = str(item.tool);
			return isRecordTool(tool) ? recordToolLine(tool, obj(item.arguments) ?? {}) : `Use ${tool}`;
		}
		default:
			return null;
	}
}

/** The lines a patch takes out and puts in, for the permission card. */
export function diffLines(diff: string, most = 12): { removed: string[]; added: string[] } {
	const removed: string[] = [];
	const added: string[] = [];
	for (const line of diff.split("\n")) {
		if (/^(\+\+\+|---|@@|diff |index )/.test(line)) continue;
		if (line.startsWith("-") && line.slice(1).trim()) removed.push(line.slice(1));
		else if (line.startsWith("+") && line.slice(1).trim()) added.push(line.slice(1));
	}
	const cut = (all: string[]): string[] => (all.length > most ? [...all.slice(0, most), `… ${all.length - most} more lines`] : all);
	return { removed: cut(removed), added: cut(added) };
}

const NOT_STARTED_SAID = "Codex could not be started. Check where it is installed, in settings.";
const DECISION: Record<PermissionAnswer, string> = { once: "accept", always: "acceptForSession", deny: "decline" };

/** Run one turn over a wire that is already open. Throws with a sentence fit to show. */
export async function runCodexTurn(run: CodexRun, wire: CodexWire): Promise<AgentResult> {
	const began = Date.now();
	const tools: string[] = [];
	/** File changes Codex has announced, by item, so an approval request can show them. */
	const announced = new Map<string, Change[]>();
	let text = "";
	let lastMessage = "";
	let threadId = run.resume ?? "";
	let turnId = "";
	let finished: ((v: void) => void) | null = null;
	let failed: ((e: Error) => void) | null = null;
	const done = new Promise<void>((yes, no) => {
		finished = yes;
		failed = no;
	});
	// Nothing waits on `done` until the turn has started; a failure before then is
	// reported by the request that was in flight.
	done.catch(() => undefined);
	// A program that stops answering (waiting on its own terminal for a first-run
	// question, say) is given up on, not waited for with the pane locked.
	const watch = idleWatch(HANDSHAKE_MS, (ms) => {
		const e = quietError("Codex", ms);
		peer.failAll(e);
		failed?.(e);
	});

	const asked = async (id: unknown, method: string, params: Loose): Promise<void> => {
		if (method === "item/commandExecution/requestApproval") {
			const command = str(params.command);
			const a = await run.ask({ tool: "Bash", title: "Run a command", removed: [], added: [], detail: command || str(params.reason), always: "Always allow this in this chat" });
			return peer.answer(id, { decision: DECISION[a] });
		}
		if (method === "item/fileChange/requestApproval") {
			const changes = announced.get(str(params.itemId)) ?? [];
			const lines = changes.map((c) => diffLines(c.diff));
			const files = changes.map((c) => leaf(c.path)).filter(Boolean);
			const a = await run.ask({
				tool: "Edit",
				title: files.length ? `Edit ${files.slice(0, 3).join(", ")}` : "Edit a file",
				removed: lines.flatMap((l) => l.removed),
				added: lines.flatMap((l) => l.added),
				detail: lines.some((l) => l.removed.length || l.added.length) ? "" : str(params.reason),
				always: "Always allow edits in this chat",
			});
			return peer.answer(id, { decision: DECISION[a] });
		}
		// One of Grill's own tools: run here, answered in Codex's dynamic tool shape.
		if (method === "item/tool/call" && run.tools && (params.namespace ?? CODEX_TOOL_NAMESPACE) === CODEX_TOOL_NAMESPACE) {
			const tool = str(params.tool);
			if (run.tools.specs.some((t) => t.name === tool)) {
				let r: { content: string; failed?: boolean };
				try {
					r = await run.tools.call(tool, obj(params.arguments) ?? {});
				} catch (e) {
					r = { content: e instanceof Error ? e.message : String(e), failed: true };
				}
				return peer.answer(id, { success: !r.failed, contentItems: [{ type: "inputText", text: r.content }] });
			}
		}
		// Anything else it might ask of its host (more permissions, a question, a tool
		// Grill doesn't offer) is not something this chat can answer.
		peer.refuse(id, `Grill does not handle ${method}.`);
	};

	const told = (method: string, params: Loose): void => {
		const item = obj(params.item);
		if (method === "item/agentMessage/delta") {
			text += str(params.delta);
			run.onEvent({ kind: "text", soFar: text });
		} else if (method === "item/started" && item) {
			if (item.type === "agentMessage" && text && !text.endsWith("\n")) text += "\n\n";
			if (item.type === "fileChange") announced.set(str(item.id), changesOf(item));
			const line = codexLine(item);
			if (line) run.onEvent({ kind: "activity", tool: likeClaudeCode(str(item.type)), line });
		} else if (method === "item/completed" && item) {
			if (item.type === "agentMessage") lastMessage = str(item.text) || lastMessage;
			if (item.type === "fileChange") announced.set(str(item.id), changesOf(item));
			// Counted once it has been done, and only if it was: a declined change is not work.
			const ok = item.status === undefined || item.status === "completed" || item.status === "success";
			if (ok && codexLine(item)) tools.push(likeClaudeCode(str(item.type)));
		} else if (method === "turn/started") {
			turnId = str(obj(params.turn)?.id) || turnId;
		} else if (method === "turn/completed") {
			const turn = obj(params.turn);
			if (turn?.status === "failed") failed?.(new Error(str(obj(turn.error)?.message) || "Codex stopped with an error."));
			else finished?.();
		} else if (method === "error" && params.willRetry !== true) {
			const why = str(obj(params.error)?.message);
			if (why) failed?.(new Error(why));
		}
	};

	const peer = rpcPeer(wire, {
		refused: "Codex refused the request.",
		heard: () => watch.heard(),
		onRequest: (id, method, params) => void watch.hold(asked(id, method, params)).catch(() => peer.refuse(id, "That request could not be answered.")),
		onNotice: (method, params) => told(method, params),
	});
	wire.onClose((why) => {
		const e = new Error(why === NOT_STARTED ? NOT_STARTED_SAID : SIGNED_OUT.test(why) ? "Codex is not signed in. Open a terminal, run codex, and sign in there." : `Codex stopped${why ? `: ${clip(why.trim(), 200)}` : "."}`);
		peer.failAll(e);
		failed?.(e);
	});

	const stop = (): void => {
		if (threadId) void peer.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
		const e = new DOMException("Stopped.", "AbortError");
		// A request it has not answered yet is not waited on either.
		peer.failAll(e);
		failed?.(e);
	};
	run.signal?.addEventListener("abort", stop, { once: true });
	try {
		await peer.request("initialize", { clientInfo: { name: "grill", version: "1.0.0" }, capabilities: { experimentalApi: true } });
		peer.notify("initialized");
		const policy = codexPolicy(run.level);
		const config = { cwd: run.cwd, approvalPolicy: policy.approvalPolicy, approvalsReviewer: "user", sandbox: policy.sandbox, ...(run.model ? { model: run.model } : {}) };
		const tools = run.tools ? { dynamicTools: run.tools.specs.map((t) => ({ namespace: CODEX_TOOL_NAMESPACE, name: t.name, description: t.description, inputSchema: t.input })) } : {};
		const opened = await peer.request<Loose>(threadId ? "thread/resume" : "thread/start", threadId ? { threadId, ...config } : { ...config, ...tools });
		threadId = str(obj(opened?.thread)?.id) || threadId;
		if (run.signal?.aborted) throw new DOMException("Stopped.", "AbortError");
		const first = !run.resume && run.brief ? `<context>\n${run.brief}\n</context>\n\n${run.prompt}` : run.prompt;
		const pictures = (run.images ?? []).map((im) => ({ type: "image", url: `data:${im.mediaType};base64,${im.dataBase64}` }));
		const started = await peer.request<Loose>("turn/start", { threadId, input: [...pictures, { type: "text", text: first }], ...(run.outputSchema ? { outputSchema: run.outputSchema } : {}), approvalPolicy: policy.approvalPolicy, approvalsReviewer: "user", ...(run.model ? { model: run.model } : {}) });
		turnId = str(obj(started?.turn)?.id) || turnId;
		watch.limit(IDLE_MS);
		await done;
	} finally {
		watch.stop();
		run.signal?.removeEventListener("abort", stop);
	}
	const reply = text.trim() || lastMessage.trim();
	if (!reply) throw new Error("Codex finished without saying anything.");
	return { text: reply, sessionId: threadId, tools, seconds: (Date.now() - began) / 1000 };
}


/** Where Codex is usually installed, most likely first: the command-line program, then
 * the copies the desktop apps carry. */
export function codexPlaces(home: string, platform: string, env: Record<string, string | undefined>): string[] {
	if (platform === "win32") {
		const app = env.APPDATA ?? `${home}\\AppData\\Roaming`;
		return [`${home}\\.local\\bin\\codex.exe`, `${app}\\npm\\codex.cmd`];
	}
	return [
		`${home}/.local/bin/codex`,
		"/opt/homebrew/bin/codex",
		"/usr/local/bin/codex",
		`${home}/.npm-global/bin/codex`,
		`${home}/.volta/bin/codex`,
		`${home}/.bun/bin/codex`,
		"/Applications/Codex.app/Contents/Resources/codex",
		`${home}/Applications/Codex.app/Contents/Resources/codex`,
		"/Applications/ChatGPT.app/Contents/Resources/codex",
		"/usr/bin/codex",
	];
}

/** The installed Codex: the path set in settings if it is there, else the first usual
 * place that has one. Null on a phone, or when it isn't installed. */
export function findCodex(setPath: string): string | null {
	return findInstalled(setPath, codexPlaces);
}

/** The models the installed Codex offers, as it last fetched them for its own picker
 * (~/.codex/models_cache.json), best first. Empty when there is no such list. */
export function codexModels(): Array<{ id: string; name: string }> {
	try {
		const req = need();
		if (!req) return [];
		const fs = req("fs") as { readFileSync(p: string, e: string): string };
		const home = (req("os") as { homedir(): string }).homedir();
		const data = JSON.parse(fs.readFileSync(`${home}/.codex/models_cache.json`, "utf8")) as { models?: unknown };
		const list = Array.isArray(data.models) ? (data.models as Array<Record<string, unknown>>) : [];
		return list
			.filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
			.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
			.map((m) => ({ id: m.slug as string, name: codexModelName(m.slug as string) }));
	} catch {
		return [];
	}
}

/** "gpt-5.4-mini" reads "GPT-5.4-Mini": Codex's own display names are written either way. */
export function codexModelName(slug: string): string {
	return slug
		.split("-")
		.map((w, i) => (i === 0 && w === "gpt" ? "GPT" : /^[a-z]/.test(w) && i > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join("-");
}

/** Start the program and run one turn with it. Each turn has its own process, which
 * picks the conversation up again by its id; nothing is left running between messages. */
export async function runCodex(run: CodexRun & { program: string }): Promise<AgentResult> {
	const wire = openLineWire({ program: run.program, args: ["app-server", "--listen", "stdio://"] }, run.cwd, "Codex");
	try {
		return await runCodexTurn(run, wire);
	} finally {
		wire.close();
	}
}
