import "./obsidian-stub";
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { acpAsk, acpLine, AcpWire, modelsOf, pickOption, runAcpTurn } from "../src/acp";
import { buildFor, fileInTar, isGrillInstall, opencodeConfig, opencodePlaces } from "../src/opencode";
import type { AgentEvent, PermissionAnswer, PermissionAsk } from "../src/agent";

type Msg = Record<string, any>;

const SESSION = {
	sessionId: "ses_1",
	configOptions: [
		{ id: "model", category: "model", type: "select", currentValue: "opencode/free", options: [{ value: "opencode/free", name: "opencode/Free" }, { value: "ollama/qwen3:8b", name: "ollama/qwen3:8b" }] },
		{ id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
	],
};

/** A stand-in for an ACP agent: answers requests, and plays `script` once a prompt arrives. */
function agent(
	script: (s: { update(u: Msg): void; ask(method: string, params: Msg): Promise<Msg> }) => Promise<void> | void,
	opts: { caps?: Msg; stopReason?: string; resumeFails?: boolean } = {},
) {
	const got: Msg[] = [];
	let toClient: (line: string) => void = () => undefined;
	let closed: (why: string) => void = () => undefined;
	const waiting = new Map<number, (m: Msg) => void>();
	let ids = 1000;
	const say = (m: Msg): void => toClient(JSON.stringify({ jsonrpc: "2.0", ...m }));
	const update = (u: Msg): void => say({ method: "session/update", params: { sessionId: "ses_1", update: u } });
	const ask = (method: string, params: Msg): Promise<Msg> =>
		new Promise((yes) => {
			const id = ids++;
			waiting.set(id, yes);
			say({ id, method, params });
		});
	const wire: AcpWire = {
		send: (line) => {
			const m = JSON.parse(line) as Msg;
			got.push(m);
			queueMicrotask(() => {
				if (m.method === undefined && waiting.has(m.id)) return waiting.get(m.id)!(m);
				if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: 1, agentCapabilities: opts.caps ?? { loadSession: true, sessionCapabilities: { resume: {} } } } });
				else if (m.method === "session/new") say({ id: m.id, result: SESSION });
				else if (m.method === "session/resume" || m.method === "session/load") {
					if (opts.resumeFails) say({ id: m.id, error: { code: -32000, message: "no such session" } });
					else {
						// A load plays the old conversation back first; none of it is the reply.
						if (m.method === "session/load") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD REPLY" } });
						say({ id: m.id, result: { configOptions: SESSION.configOptions } });
					}
				} else if (m.method === "session/set_config_option") say({ id: m.id, result: {} });
				else if (m.method === "session/prompt") {
					void Promise.resolve(script({ update, ask })).then(() => say({ id: m.id, result: { stopReason: opts.stopReason ?? "end_turn" } }));
				}
			});
		},
		onLine: (f) => (toClient = f),
		onClose: (f) => (closed = f),
		close: () => undefined,
	};
	return { wire, got, gone: (why: string) => closed(why) };
}

const base = (over: Partial<Parameters<typeof runAcpTurn>[0]> = {}) => {
	const events: AgentEvent[] = [];
	const asks: PermissionAsk[] = [];
	return {
		events,
		asks,
		run: {
			name: "opencode",
			prompt: "Summarise the note",
			cwd: "/vault",
			level: "safe" as const,
			onEvent: (e: AgentEvent) => events.push(e),
			ask: async (r: PermissionAsk): Promise<PermissionAnswer> => {
				asks.push(r);
				return "once";
			},
			...over,
		},
	};
};

test("a turn streams the reply, lists what it did and counts finished work", async () => {
	const a = agent(({ update }) => {
		update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
		update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", kind: "read", status: "pending", locations: [], rawInput: {} });
		update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", kind: "read", locations: [{ path: "/vault/Ch 11/Solow.md" }], rawInput: { path: "/vault/Ch 11/Solow.md" } });
		update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Capital " } });
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "accumulates." } });
	});
	const { run, events } = base({ brief: "Open note: Solow.md" });
	const r = await runAcpTurn(run, a.wire);
	assert.equal(r.text, "Capital accumulates.");
	assert.equal(r.sessionId, "ses_1");
	assert.deepEqual(r.tools, ["Read"]);
	const lines = events.filter((e) => e.kind === "activity").map((e) => (e as { line: string }).line);
	assert.deepEqual(lines, ["Read Solow.md"], "said once, when the file is known");
	const prompt = a.got.find((m) => m.method === "session/prompt")!;
	assert.match(prompt.params.prompt[0].text, /^<context>\nOpen note: Solow.md\n<\/context>\n\nSummarise the note$/);
});

test("a permission request shows the patch and answers with the option picked", async () => {
	let answer: Msg = {};
	const a = agent(async ({ update, ask }) => {
		update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "write", kind: "edit", status: "pending", locations: [], rawInput: {} });
		answer = await ask("session/request_permission", {
			sessionId: "ses_1",
			toolCall: {
				toolCallId: "t2",
				title: "summary.md",
				kind: "edit",
				locations: [{ path: "/vault/summary.md" }],
				rawInput: { files: [{ file: "summary.md", patch: "--- summary.md\n+++ summary.md\n@@ -0,0 +1 @@\n+The Taylor principle." }] },
			},
			options: [
				{ optionId: "once", kind: "allow_once", name: "Allow" },
				{ optionId: "always", kind: "allow_always", name: "Always" },
				{ optionId: "no", kind: "reject_once", name: "Reject" },
			],
		});
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Written." } });
	});
	const { run, asks } = base();
	await runAcpTurn(run, a.wire);
	assert.equal(asks.length, 1);
	assert.equal(asks[0].tool, "Edit");
	assert.equal(asks[0].title, "Edit summary.md");
	assert.deepEqual(asks[0].added, ["The Taylor principle."]);
	assert.deepEqual(answer.result, { outcome: { outcome: "selected", optionId: "once" } });
});

test("the protocol's own diff content shows on the card too", () => {
	const ask = acpAsk({ kind: "edit", title: "Edit", locations: [{ path: "/v/a.md" }], content: [{ type: "diff", path: "/v/a.md", oldText: "old line", newText: "new line" }] });
	assert.deepEqual(ask.removed, ["old line"]);
	assert.deepEqual(ask.added, ["new line"]);
	const run = acpAsk({ kind: "execute", title: "ls", rawInput: { command: "ls -la" } });
	assert.equal(run.title, "Run a command");
	assert.equal(run.detail, "ls -la");
});

test("a declined change ends the turn as an answer, not as Stop", async () => {
	const a = agent(async ({ ask }) => {
		await ask("session/request_permission", {
			sessionId: "ses_1",
			toolCall: { toolCallId: "t3", title: "a.md", kind: "edit", locations: [{ path: "/vault/a.md" }], rawInput: {} },
			options: [
				{ optionId: "y", kind: "allow_once" },
				{ optionId: "n", kind: "reject_once" },
			],
		});
	}, { stopReason: "cancelled" });
	const { run } = base({ ask: async () => "deny" });
	const r = await runAcpTurn(run, a.wire);
	assert.equal(r.text, "Declined, so nothing was changed.");
	assert.deepEqual(r.tools, []);
});

test("answers map onto the options the agent offered", () => {
	const opts = [
		{ optionId: "a", kind: "allow_once" },
		{ optionId: "b", kind: "allow_always" },
		{ optionId: "c", kind: "reject_once" },
	];
	assert.equal(pickOption(opts, "once"), "a");
	assert.equal(pickOption(opts, "always"), "b");
	assert.equal(pickOption(opts, "deny"), "c");
	assert.equal(pickOption([{ optionId: "x", kind: "allow_once" }], "always"), "x");
	assert.equal(pickOption([{ optionId: "x", kind: "allow_once" }], "deny"), null);
});

test("Plan puts the session in the agent's own plan mode; a picked model is set", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A plan." } }));
	const { run } = base({ level: "plan", model: "ollama/qwen3:8b" });
	await runAcpTurn(run, a.wire);
	const set = a.got.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
	assert.deepEqual(set, [
		{ sessionId: "ses_1", configId: "model", value: "ollama/qwen3:8b" },
		{ sessionId: "ses_1", configId: "mode", value: "plan" },
	]);
});

test("a model the agent does not offer is not asked for", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }));
	const { run } = base({ model: "gone/model" });
	await runAcpTurn(run, a.wire);
	assert.equal(a.got.filter((m) => m.method === "session/set_config_option").length, 0);
});

test("a later turn resumes the conversation and does not repeat the brief", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Again." } }));
	const { run } = base({ resume: "ses_1", brief: "Open note: x" });
	const r = await runAcpTurn(run, a.wire);
	assert.equal(r.text, "Again.");
	assert.ok(a.got.some((m) => m.method === "session/resume"));
	assert.ok(!a.got.some((m) => m.method === "session/new"));
	assert.equal(a.got.find((m) => m.method === "session/prompt")!.params.prompt[0].text, "Summarise the note");
});

test("loading plays the old conversation back, and none of it ends up in the reply", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New." } }), { caps: { loadSession: true } });
	const { run } = base({ resume: "ses_1" });
	const r = await runAcpTurn(run, a.wire);
	assert.ok(a.got.some((m) => m.method === "session/load"));
	assert.equal(r.text, "New.");
});

test("a conversation that is gone starts again, with the brief", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh." } }), { resumeFails: true });
	const { run } = base({ resume: "ses_old", brief: "B" });
	const r = await runAcpTurn(run, a.wire);
	assert.equal(r.text, "Fresh.");
	assert.ok(a.got.some((m) => m.method === "session/new"));
	assert.match(a.got.find((m) => m.method === "session/prompt")!.params.prompt[0].text, /<context>\nB\n/);
});

test("the models it offers are passed on", async () => {
	let seen: string[] = [];
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }));
	const { run } = base({ onModels: (m, current) => (seen = [...m.map((x) => x.id), current]) });
	await runAcpTurn(run, a.wire);
	assert.deepEqual(seen, ["opencode/free", "ollama/qwen3:8b", "opencode/free"]);
	assert.deepEqual(modelsOf({ models: { availableModels: [{ modelId: "m1", name: "M1" }], currentModelId: "m1" } }), { models: [{ id: "m1", name: "M1" }], current: "m1" });
});

test("stopping cancels the session and ends the turn as stopped", async () => {
	const ctl = new AbortController();
	const a = agent(async ({ update }) => {
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Half" } });
		ctl.abort();
		await new Promise((r) => setTimeout(r, 5));
	}, { stopReason: "cancelled" });
	const { run } = base({ signal: ctl.signal });
	await assert.rejects(runAcpTurn(run, a.wire), (e: Error) => e.name === "AbortError");
	assert.ok(a.got.some((m) => m.method === "session/cancel" && m.params.sessionId === "ses_1"));
});

test("the program going away ends the turn with a sentence", async () => {
	const a = agent(() => new Promise(() => undefined));
	const { run } = base();
	const p = runAcpTurn(run, a.wire);
	await new Promise((r) => setTimeout(r, 5));
	a.gone("Error: 401 unauthorized");
	await assert.rejects(p, /not signed in/);
});

test("requests Grill does not handle are refused, not left hanging", async () => {
	let reply: Msg = {};
	const a = agent(async ({ update, ask }) => {
		reply = await ask("fs/read_text_file", { path: "/x" });
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
	});
	await runAcpTurn(base().run, a.wire);
	assert.ok(reply.error);
});

test("activity lines read like the other engines'", () => {
	assert.equal(acpLine({ kind: "read", locations: [{ path: "/v/a/b.md" }] }), "Read b.md");
	assert.equal(acpLine({ kind: "execute", rawInput: { command: "ls\nmore" } }), "Run ls");
	assert.equal(acpLine({ kind: "search", rawInput: { pattern: "Taylor" } }), 'Search for "Taylor"');
	assert.equal(acpLine({ kind: "other", title: "todowrite" }), "Todowrite");
});

test("opencode: builds, places, levels", () => {
	assert.equal(buildFor("darwin", "arm64"), "darwin-arm64");
	assert.equal(buildFor("win32", "x64"), "windows-x64");
	assert.equal(buildFor("freebsd", "x64"), null);
	assert.equal(opencodePlaces("/Users/a", "darwin", {})[0], "/Users/a/.grill/opencode/2.0.22/opencode");
	assert.ok(isGrillInstall("/Users/a/.grill/opencode/2.0.22/opencode"));
	assert.ok(!isGrillInstall("/opt/homebrew/bin/opencode"));
	assert.equal(JSON.parse(opencodeConfig("safe")).permission.edit, "ask");
	assert.equal(JSON.parse(opencodeConfig("auto")).permission.edit, "allow");
	assert.equal(JSON.parse(opencodeConfig("auto")).permission.bash, "ask");
	assert.equal(JSON.parse(opencodeConfig("plan")).autoupdate, false);
});

/** A tar archive of the files given, as npm writes them. */
function tar(files: Record<string, string>): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const [name, body] of Object.entries(files)) {
		const h = new Uint8Array(512);
		h.set(new TextEncoder().encode(name), 0);
		h.set(new TextEncoder().encode(body.length.toString(8).padStart(11, "0")), 124);
		h[156] = 48;
		blocks.push(h);
		const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
		data.set(new TextEncoder().encode(body));
		blocks.push(data);
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}

test("the program is found in npm's archive", () => {
	const archive = tar({ "package/package.json": "{}", "package/bin/opencode": "#!binary".repeat(100) });
	const got = fileInTar(archive, ["package/bin/opencode"]);
	assert.equal(new TextDecoder().decode(got!), "#!binary".repeat(100));
	assert.equal(fileInTar(archive, ["package/bin/opencode.exe"]), null);
	assert.ok(gzipSync(archive).length > 0);
});

// ---- tests on an agent program ------------------------------------------------

import { jsonPrompt, readJSON } from "../src/agentjson";
import { gradeAnswer } from "../src/llm";

test("an agent's reply is read as JSON, fenced or not", () => {
	assert.deepEqual(readJSON('{"a":1}'), { a: 1 });
	assert.deepEqual(readJSON('Here:\n```json\n{"a":2}\n```'), { a: 2 });
	assert.throws(() => readJSON("no json"), /unparseable/);
	const p = jsonPrompt("SYS", "USER", { type: "object" });
	assert.match(p, /^SYS\n\nUSER\n\n/);
	assert.match(p, /Do not use any tools/);
	assert.match(p, /\{"type":"object"\}$/);
});

test("with an agent standing in for a model, grading goes to it whole and its JSON is used", async () => {
	const seen: Array<{ system: string; user: string; schema: Record<string, unknown> }> = [];
	const cfg = {
		provider: "custom" as const,
		apiKey: "",
		model: "opencode",
		agent: async (system: string, user: string, schema: Record<string, unknown>) => {
			seen.push({ system, user, schema });
			return { verdict: "correct", score: 1, feedback: "Right: more than one-for-one.", misconception: null, missing: [] };
		},
	};
	const q: any = {
		node: "Taylor principle",
		question: "What does the Taylor principle say?",
		difficulty: "easy",
		modelAnswer: "The nominal rate rises more than one-for-one with inflation.",
		acceptableAnswers: [],
		commonErrors: [],
		hints: { tier1: "", tier2: "", tier3: "" },
	};
	const g = await gradeAnswer(cfg, q, "The Taylor principle: nominal rate > one-for-one.", "Rates rise more than inflation");
	assert.equal(seen.length, 1);
	assert.match(seen[0].user, /Rates rise more than inflation/);
	assert.equal(g.verdict, "correct");
});

import { learnTitle } from "../src/store";

test("a chat is named by what it was about", () => {
	const t = (student: string, tutor: string, note = "agent__teach_me_something@20261014_172657") =>
		learnTitle([{ role: "student", text: student }, { role: "tutor", text: tutor }], note);
	assert.equal(t("teach me something", "## Real Interest Rate (r)\nSources..."), "Real Interest Rate (r)");
	assert.equal(t("why does the **IS curve** slope down?", "Because..."), "Why does the IS curve slope down");
	assert.equal(t("teach me", "No heading here.", "Solow Model"), "Solow Model");
	assert.equal(t("hi", "ok", ""), "hi");
	assert.ok(!/[\\/:*?"<>|#^[\]]/.test(t("a/b: c? [[x]] d", "# What is r*: a/b?")));
});

// ---- after the review ---------------------------------------------------------

import { modeOption } from "../src/acp";
import { levelRules, opencodeProgram } from "../src/opencode";

test("opencode: Grill's rules sit on every built-in agent, and a vault's own config is not read", () => {
	const p = opencodeProgram("/x/opencode", "safe");
	assert.equal(p.env!.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
	const c = JSON.parse(p.env!.OPENCODE_CONFIG_CONTENT);
	assert.equal(c.default_agent, "build");
	for (const a of ["build", "plan", "general", "explore"]) assert.deepEqual(c.agent[a].permission, c.permission, a);
	assert.equal(c.permission.websearch, "ask");
	assert.equal(c.permission.codesearch, "ask");
	assert.equal(levelRules("plan").bash, "ask");
	assert.equal(levelRules("plan").edit, "deny");
	assert.equal(levelRules("auto").edit, "allow");
	assert.equal(levelRules("auto").bash, "ask");
});

test("a helper's own words stay out of the reply", async () => {
	const a = agent(({ update }) => {
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HELPER REPORT" }, _meta: { "opencode/child-session": "ses_child" } });
		update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "read", status: "completed", locations: [{ path: "/v/x.md" }], _meta: { "opencode/child-session": "ses_child" } });
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
	});
	const { run, events } = base();
	const r = await runAcpTurn(run, a.wire);
	assert.equal(r.text, "Done.");
	assert.deepEqual(r.tools, []);
	assert.equal(events.filter((e) => e.kind === "activity").length, 0);
});

test("a conversation left in Plan goes back to building at another level", async () => {
	const a = agent(({ update }) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }));
	const { run } = base({ resume: "ses_1", level: "safe" });
	await runAcpTurn(run, a.wire);
	const set = a.got.filter((m) => m.method === "session/set_config_option").map((m) => m.params);
	assert.deepEqual(set, [{ sessionId: "ses_1", configId: "mode", value: "build" }]);
	assert.deepEqual(modeOption(SESSION), { configId: "mode", plan: "plan", other: "build", current: "build" });
});

test("declining after changes went through says so", async () => {
	const a = agent(async ({ update, ask }) => {
		update({ sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", status: "completed", locations: [{ path: "/v/a.md" }] });
		await ask("session/request_permission", { sessionId: "ses_1", toolCall: { toolCallId: "e2", kind: "edit", locations: [{ path: "/v/b.md" }] }, options: [{ optionId: "n", kind: "reject_once" }] });
	}, { stopReason: "cancelled" });
	const { run } = base({ ask: async () => "deny" });
	const r = await runAcpTurn(run, a.wire);
	assert.match(r.text, /^Stopped at the change you declined/);
});

test("Plan turns a change or command away itself, with no card", async () => {
	let reply: Msg = {};
	const a = agent(async ({ ask }) => {
		reply = await ask("session/request_permission", {
			sessionId: "ses_1",
			toolCall: { toolCallId: "x", kind: "execute", rawInput: { command: "touch ran.txt" } },
			options: [
				{ optionId: "y", kind: "allow_once" },
				{ optionId: "n", kind: "reject_once" },
			],
		});
	}, { stopReason: "cancelled" });
	const { run, asks } = base({ level: "plan" });
	const r = await runAcpTurn(run, a.wire);
	assert.equal(asks.length, 0);
	assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "n" } });
	assert.match(r.text, /^Plan changes nothing/);
});

test("a call to Grill's record reads as reading the record, also from opencode's code", async () => {
	const { acpLine } = await import("../src/acp");
	assert.equal(acpLine({ kind: "other", title: "execute", rawInput: { code: 'await tools["grill"]["grill_weak_spots"]({topic: "inflation"})' } }), "Read your weak spots");
	assert.equal(acpLine({ kind: "other", title: "grill_overview", rawInput: {} }), "Read your record");
});
