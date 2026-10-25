import "./obsidian-stub";
import test from "node:test";
import assert from "node:assert/strict";
import { codexLine, codexPlaces, codexPolicy, CodexWire, diffLines, runCodexTurn } from "../src/codex";
import type { AgentEvent, PermissionAnswer, PermissionAsk } from "../src/agent";

type Msg = Record<string, any>;

/** A stand-in for `codex app-server`: answers requests, and plays `script` once a turn starts. */
function server(script: (s: { say(method: string, params: Msg): void; ask(method: string, params: Msg): Promise<Msg> }) => Promise<void> | void) {
	const got: Msg[] = [];
	let toClient: (line: string) => void = () => undefined;
	let closed: (why: string) => void = () => undefined;
	const waiting = new Map<number, (m: Msg) => void>();
	let ids = 1000;
	const say = (method: string, params: Msg): void => toClient(JSON.stringify({ jsonrpc: "2.0", method, params }));
	const ask = (method: string, params: Msg): Promise<Msg> =>
		new Promise((yes) => {
			const id = ids++;
			waiting.set(id, yes);
			toClient(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	const wire: CodexWire = {
		send: (line) => {
			const m = JSON.parse(line) as Msg;
			got.push(m);
			queueMicrotask(() => {
				if (m.method === undefined && waiting.has(m.id)) return waiting.get(m.id)!(m);
				if (m.method === "initialize") toClient(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { userAgent: "codex" } }));
				else if (m.method === "thread/start") toClient(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th_new" } } }));
				else if (m.method === "thread/resume") toClient(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { thread: { id: m.params.threadId } } }));
				else if (m.method === "turn/start") {
					toClient(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "tu_1" } } }));
					void Promise.resolve(script({ say, ask })).catch(() => undefined);
				}
			});
		},
		onLine: (f) => (toClient = f),
		onClose: (f) => (closed = f),
		close: () => undefined,
	};
	return { wire, got, die: (why: string) => closed(why) };
}
const base = (over: Partial<Parameters<typeof runCodexTurn>[0]> = {}) => ({
	prompt: "fix the slope",
	cwd: "/vault",
	level: "safe" as const,
	onEvent: (_e: AgentEvent) => undefined,
	ask: async (_r: PermissionAsk): Promise<PermissionAnswer> => "once",
	...over,
});
const finish = (s: { say(method: string, params: Msg): void }, status = "completed", error: unknown = null) => s.say("turn/completed", { threadId: "th_new", turn: { id: "tu_1", status, error, items: [] } });

test("Grill's levels are Codex's own sandbox and approval settings", () => {
	assert.deepEqual(codexPolicy("safe"), { approvalPolicy: "on-request", sandbox: "read-only" });
	assert.deepEqual(codexPolicy("plan"), { approvalPolicy: "never", sandbox: "read-only" });
	assert.deepEqual(codexPolicy("auto"), { approvalPolicy: "on-request", sandbox: "workspace-write" });
});

test("a turn is opened, read as it is written, and closed with what was done", async () => {
	const events: AgentEvent[] = [];
	const s = server((c) => {
		c.say("item/started", { item: { type: "agentMessage", id: "m1", text: "" } });
		c.say("item/agentMessage/delta", { itemId: "m1", delta: "Looking" });
		c.say("item/agentMessage/delta", { itemId: "m1", delta: " at it." });
		c.say("item/started", { item: { type: "commandExecution", id: "c1", command: "rg slope\n--more", status: "inProgress" } });
		c.say("item/completed", { item: { type: "commandExecution", id: "c1", command: "rg slope", status: "completed" } });
		c.say("item/started", { item: { type: "agentMessage", id: "m2", text: "" } });
		c.say("item/agentMessage/delta", { itemId: "m2", delta: "The slope is below 1." });
		finish(c);
	});
	const done = await runCodexTurn(base({ onEvent: (e) => events.push(e), brief: "The note open: IS.md" }), s.wire);
	assert.equal(done.text, "Looking at it.\n\nThe slope is below 1.");
	assert.equal(done.sessionId, "th_new");
	assert.deepEqual(done.tools, ["Bash"]);
	assert.deepEqual(events.filter((e) => e.kind === "activity"), [{ kind: "activity", tool: "Bash", line: "Run rg slope" }]);
	// What it was sent: a handshake, a thread in the vault at this level, then the message with its brief.
	assert.deepEqual(s.got.map((m) => m.method), ["initialize", "initialized", "thread/start", "turn/start"]);
	assert.deepEqual(s.got[2].params, { cwd: "/vault", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" });
	assert.equal(s.got[3].params.threadId, "th_new");
	assert.match(s.got[3].params.input[0].text, /^<context>\nThe note open: IS\.md\n<\/context>\n\nfix the slope$/);
});

test("the next message goes on with the same conversation, without the brief again", async () => {
	const s = server((c) => {
		c.say("item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } });
		finish(c);
	});
	const done = await runCodexTurn(base({ resume: "th_old", brief: "brief", level: "auto" }), s.wire);
	assert.equal(done.text, "Done.", "a reply that came whole, not in pieces");
	assert.equal(done.sessionId, "th_old");
	assert.equal(s.got[2].method, "thread/resume");
	assert.deepEqual(s.got[2].params, { threadId: "th_old", cwd: "/vault", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
	assert.equal(s.got[3].params.input[0].text, "fix the slope");
});

test("it asks before a command and before a change, and each answer is passed on in Codex's words", async () => {
	const asked: PermissionAsk[] = [];
	const answers: PermissionAnswer[] = ["once", "always", "deny"];
	const decisions: string[] = [];
	const s = server(async (c) => {
		decisions.push((await c.ask("item/commandExecution/requestApproval", { threadId: "th_new", turnId: "tu_1", itemId: "c1", command: "git status", cwd: "/vault" })).result.decision);
		c.say("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path: "/vault/Macro/IS.md", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-slope greater than 1\n+slope below 1\n context" }] } });
		decisions.push((await c.ask("item/fileChange/requestApproval", { threadId: "th_new", turnId: "tu_1", itemId: "f1" })).result.decision);
		c.say("item/completed", { item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/vault/Macro/IS.md", diff: "" }] } });
		decisions.push((await c.ask("item/fileChange/requestApproval", { threadId: "th_new", turnId: "tu_1", itemId: "unknown", reason: "needs to write outside the vault" })).result.decision);
		// Something this chat can't answer is refused, not left hanging.
		assert.ok((await c.ask("item/tool/requestUserInput", { threadId: "th_new" })).error);
		c.say("item/agentMessage/delta", { delta: "Fixed." });
		finish(c);
	});
	const done = await runCodexTurn(base({ ask: async (r) => (asked.push(r), answers.shift()!) }), s.wire);
	assert.deepEqual(decisions, ["accept", "acceptForSession", "decline"]);
	assert.deepEqual([asked[0].title, asked[0].detail], ["Run a command", "git status"]);
	assert.deepEqual([asked[1].title, asked[1].removed, asked[1].added], ["Edit IS.md", ["slope greater than 1"], ["slope below 1"]]);
	assert.equal(asked[2].detail, "needs to write outside the vault");
	assert.deepEqual(done.tools, ["Edit"]);
});

test("a turn that fails, a program that dies and a stop each end the turn with a reason", async () => {
	const failed = server((c) => finish(c, "failed", { message: "You've hit your usage limit." }));
	await assert.rejects(runCodexTurn(base(), failed.wire), /usage limit/);
	const dies = server(() => dies.die("error: not logged in. Run codex login"));
	await assert.rejects(runCodexTurn(base(), dies.wire), /not signed in/);
	const stop = new AbortController();
	const hangs = server(() => stop.abort());
	await assert.rejects(runCodexTurn(base({ signal: stop.signal }), hangs.wire), (e: Error) => e.name === "AbortError");
	assert.equal(hangs.got.at(-1)?.method, "turn/interrupt");
	// Stopped while a request it never answers is still out: the turn ends all the same.
	const early = new AbortController();
	const mute: CodexWire = { send: () => queueMicrotask(() => early.abort()), onLine: () => undefined, onClose: () => undefined, close: () => undefined };
	await assert.rejects(runCodexTurn(base({ signal: early.signal }), mute), (e: Error) => e.name === "AbortError");
	const silent = server((c) => finish(c));
	await assert.rejects(runCodexTurn(base(), silent.wire), /without saying anything/);
});

test("what Codex did is said in a line, and a patch is read as lines out and lines in", () => {
	assert.equal(codexLine({ type: "fileChange", changes: [{ path: "/v/A.md" }, { path: "/v/B.md" }] }), "Edit A.md, B.md");
	assert.equal(codexLine({ type: "webSearch", query: "multiplier" }), 'Search the web for "multiplier"');
	assert.equal(codexLine({ type: "reasoning" }), null);
	assert.deepEqual(diffLines("@@ -1,2 +1,2 @@\n-old\n+new\n+\n same"), { removed: ["old"], added: ["new"] });
	assert.equal(diffLines(Array.from({ length: 20 }, (_, i) => `+l${i}`).join("\n")).added.length, 13);
	assert.ok(codexPlaces("/Users/a", "darwin", {}).includes("/opt/homebrew/bin/codex"));
});

test("Grill's tools go to a new conversation as dynamic tools, and Codex's calls are answered here", async () => {
	const called: Array<[string, Msg]> = [];
	const tools = {
		specs: [{ name: "grill_weak_spots", description: "weak spots", input: { type: "object", properties: { topic: { type: "string" } } } }],
		call: async (name: string, args: Record<string, unknown>) => (called.push([name, args]), { content: "bracket creep, missed last time" }),
	};
	let reply: Msg | undefined;
	let refused: Msg | undefined;
	const lines: string[] = [];
	const s = server(async (x) => {
		reply = await x.ask("item/tool/call", { threadId: "th_new", turnId: "tu_1", callId: "c1", namespace: "grill", tool: "grill_weak_spots", arguments: { topic: "inflation" } });
		refused = await x.ask("item/tool/call", { threadId: "th_new", turnId: "tu_1", callId: "c2", namespace: "other", tool: "grill_weak_spots", arguments: {} });
		const item = { type: "dynamicToolCall", id: "c1", namespace: "grill", tool: "grill_weak_spots", arguments: { topic: "inflation" } };
		x.say("item/started", { threadId: "th_new", turnId: "tu_1", item: { ...item, status: "inProgress" } });
		x.say("item/completed", { threadId: "th_new", turnId: "tu_1", item: { ...item, status: "completed" } });
		x.say("item/completed", { threadId: "th_new", turnId: "tu_1", item: { type: "agentMessage", id: "m1", text: "Start with bracket creep." } });
		finish(x);
	});
	const r = await runCodexTurn(base({ tools, onEvent: (e) => e.kind === "activity" && lines.push(e.line) }), s.wire);
	const start = s.got.find((m) => m.method === "thread/start")!;
	assert.deepEqual(start.params.dynamicTools, [{ namespace: "grill", name: "grill_weak_spots", description: "weak spots", inputSchema: tools.specs[0].input }]);
	assert.deepEqual(called, [["grill_weak_spots", { topic: "inflation" }]]);
	assert.deepEqual(reply!.result, { success: true, contentItems: [{ type: "inputText", text: "bracket creep, missed last time" }] });
	assert.ok(refused!.error, "a tool of another namespace is not Grill's to run");
	assert.ok(lines.includes("Read your weak spots on inflation"));
	assert.equal(r.text, "Start with bracket creep.");
	assert.equal(codexLine({ type: "dynamicToolCall", tool: "grill_overview", arguments: {} }), "Read your record");
});

test("a resumed conversation keeps the tools it started with: none are sent again", async () => {
	const s = server((x) => finish(x));
	await runCodexTurn(base({ resume: "th_old", tools: { specs: [], call: async () => ({ content: "" }) } }), s.wire).catch(() => undefined);
	const resume = s.got.find((m) => m.method === "thread/resume")!;
	assert.equal(resume.params.dynamicTools, undefined);
});

test("pictures go ahead of the text, and the answer's shape is set on the turn", async () => {
	const s = server((c) => {
		c.say("item/completed", { item: { type: "agentMessage", id: "m1", text: "{\"verdict\":\"correct\"}" } });
		finish(c);
	});
	const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };
	await runCodexTurn(base({ images: [{ mediaType: "image/png", dataBase64: "AAAA" }], outputSchema: schema }), s.wire);
	const turn = s.got.find((m) => m.method === "turn/start")!.params;
	assert.deepEqual(turn.input[0], { type: "image", url: "data:image/png;base64,AAAA" });
	assert.equal(turn.input[1].type, "text");
	assert.deepEqual(turn.outputSchema, schema);
});

test("a chat turn sends text only and no shape", async () => {
	const s = server((c) => {
		c.say("item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } });
		finish(c);
	});
	await runCodexTurn(base(), s.wire);
	const turn = s.got.find((m) => m.method === "turn/start")!.params;
	assert.deepEqual(turn.input.map((i: Msg) => i.type), ["text"]);
	assert.equal("outputSchema" in turn, false);
});

test("a Codex that never answers is given up on, with a reason, instead of waited on forever", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const silent: CodexWire = { send: () => undefined, onLine: () => undefined, onClose: () => undefined, close: () => undefined };
	const run = runCodexTurn({ prompt: "hi", cwd: "/v", level: "safe", onEvent: () => undefined, ask: async () => "deny" } as never, silent);
	t.mock.timers.tick(60_000);
	await assert.rejects(run, /Codex said nothing for 1 minute, so Grill stopped waiting/);
});
