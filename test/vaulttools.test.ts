import "./obsidian-stub";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveNote, runTool, runToolChat, toolAsk, VaultPort } from "../src/vaulttools";
import { readPiece, streamText, StreamCall, toolStreamCall, ToolMsg } from "../src/stream";
import type { AgentEvent, PermissionAnswer } from "../src/agent";

function vault(files: Record<string, string>): VaultPort & { files: Record<string, string> } {
	return {
		files,
		notes: () => Object.keys(files).filter((p) => p.endsWith(".md") && !p.startsWith("Grill/")),
		read: async (p) => files[p] ?? null,
		write: async (p, c) => void (files[p] = c),
		create: async (p, c) => void (files[p] = c),
		exists: (p) => p in files,
		locked: (p) => p.startsWith("Grill/"),
	};
}
const call = (name: string, input: Record<string, unknown>, id = "c1") => ({ id, name, input });
const notes = () =>
	vault({
		"Macro/IS.md": "# IS\nThe ZZ curve has a slope greater than 1.\nThe multiplier is 1/(1-c).",
		"Macro/Multiplier.md": "The multiplier amplifies a change in demand.",
		"Micro/Multiplier.md": "Another note with the same name.",
		"Grill/concepts.json": "{}",
		"Grill/Sessions/a.md": "session",
	});

test("a note is found by its path, or by its name when only one note has it", () => {
	const v = notes();
	assert.deepEqual(resolveNote(v, "Macro/IS.md"), { path: "Macro/IS.md" });
	assert.deepEqual(resolveNote(v, "is"), { path: "Macro/IS.md" });
	assert.deepEqual(resolveNote(v, "[[IS]]"), { path: "Macro/IS.md" });
	assert.match((resolveNote(v, "Multiplier") as { error: string }).error, /More than one/);
	assert.match((resolveNote(v, "Nope") as { error: string }).error, /no note/);
	assert.match((resolveNote(v, "Grill/Sessions/a.md") as { error: string }).error, /no note/, "Grill's own files are not offered");
});

test("reading, searching and listing say what is there", async () => {
	const v = notes();
	assert.match((await runTool(v, call("read_note", { path: "IS" }))).content, /^Macro\/IS\.md\n\n# IS/);
	const found = await runTool(v, call("search_notes", { query: "MULTIPLIER" }));
	assert.match(found.content, /^3 notes match/);
	assert.match(found.content, /Macro\/IS\.md: The multiplier is 1\/\(1-c\)\./);
	assert.match((await runTool(v, call("search_notes", { query: "zebra" }))).content, /Nothing in the vault/);
	assert.equal((await runTool(v, call("list_notes", { folder: "Micro" }))).content, "Micro/Multiplier.md");
	assert.equal((await runTool(v, call("list_notes", { folder: "Nowhere" }))).failed, true);
});

test("an edit replaces text that is there once, and says why when it can't", async () => {
	const v = notes();
	const ok = await runTool(v, call("edit_note", { path: "Macro/IS.md", old_text: "slope greater than 1", new_text: "slope below 1" }));
	assert.equal(ok.failed, undefined);
	assert.match(v.files["Macro/IS.md"], /slope below 1\./);
	assert.match((await runTool(v, call("edit_note", { path: "Macro/IS.md", old_text: "not there", new_text: "x" }))).content, /not found/);
	assert.match((await runTool(v, call("edit_note", { path: "Macro/IS.md", old_text: "1", new_text: "2" }))).content, /appears \d+ times/);
	// A replacement is put in as written, dollar signs and all.
	await runTool(v, call("edit_note", { path: "Macro/IS.md", old_text: "# IS", new_text: "# IS $& $1" }));
	assert.match(v.files["Macro/IS.md"], /^# IS \$& \$1/);
	assert.equal((await runTool(v, call("edit_note", { path: "Grill/Sessions/a.md", old_text: "session", new_text: "x" }))).failed, true);
	assert.equal(v.files["Grill/Sessions/a.md"], "session");
});

test("a new note is made where nothing is, and nowhere it shouldn't be", async () => {
	const v = notes();
	assert.equal((await runTool(v, call("create_note", { path: "Macro/Summary", content: "hi" }))).content, "Created Macro/Summary.md.");
	assert.equal(v.files["Macro/Summary.md"], "hi");
	assert.match((await runTool(v, call("create_note", { path: "Macro/IS.md", content: "x" }))).content, /already/);
	assert.equal((await runTool(v, call("create_note", { path: "../outside.md", content: "x" }))).failed, true);
	assert.equal((await runTool(v, call("create_note", { path: "Grill/x.md", content: "x" }))).failed, true);
	assert.equal((await runTool(v, call("nonsense", {}))).failed, true);
	assert.equal((await runTool(v, call("read_note", { __unreadable: "{" }))).failed, true);
});

/** A model that answers with these steps in turn. */
const scripted = (replies: Array<{ text: string; calls?: ReturnType<typeof call>[] }>, seen: ToolMsg[][] = []) => ({
	seen,
	step: async (steps: ToolMsg[], onText: (t: string) => void) => {
		seen.push(JSON.parse(JSON.stringify(steps)));
		const r = replies.shift() ?? { text: "" };
		if (r.text) onText(r.text);
		return { text: r.text, truncated: false, calls: r.calls ?? [] };
	},
});

test("a turn reads, asks before changing, changes, and answers", async () => {
	const v = notes();
	const events: AgentEvent[] = [];
	const asked: string[] = [];
	const model = scripted([
		{ text: "Let me look.", calls: [call("read_note", { path: "IS" })] },
		{ text: "", calls: [call("edit_note", { path: "Macro/IS.md", old_text: "greater than 1", new_text: "below 1" }, "c2")] },
		{ text: "Fixed the slope in IS." },
	]);
	const done = await runToolChat({
		...model,
		port: v,
		level: "safe",
		onEvent: (e) => events.push(e),
		ask: async (req) => (asked.push(req.title), "once" as PermissionAnswer),
	});
	assert.equal(done.text, "Let me look.\n\nFixed the slope in IS.");
	assert.deepEqual(done.tools, ["Read", "Edit"]);
	assert.deepEqual(asked, ["Edit IS.md"]);
	assert.match(v.files["Macro/IS.md"], /slope below 1/);
	assert.deepEqual(events.filter((e) => e.kind === "activity").map((e) => (e as { line: string }).line), ["Read IS", "Edit IS.md"]);
	assert.equal((events.at(-1) as { soFar: string }).soFar, "Let me look.\n\nFixed the slope in IS.");
	// The model was handed what its request came to, under the id it asked with.
	const last = model.seen[2].at(-1) as Extract<ToolMsg, { role: "tool" }>;
	assert.deepEqual(last.results, [{ id: "c2", content: "Changed Macro/IS.md." }]);
});

test("a declined change and Plan level change nothing, and the model is told", async () => {
	for (const [level, answer, said] of [["safe", "deny", /declined/], ["plan", "once", /Plan level/]] as const) {
		const v = notes();
		const before = v.files["Macro/IS.md"];
		const model = scripted([{ text: "", calls: [call("edit_note", { path: "Macro/IS.md", old_text: "greater than 1", new_text: "below 1" })] }, { text: "Left as it was." }]);
		let asks = 0;
		const done = await runToolChat({ ...model, port: v, level, onEvent: () => undefined, ask: async () => (asks++, answer) });
		assert.equal(v.files["Macro/IS.md"], before);
		assert.deepEqual(done.tools, []);
		assert.equal(asks, level === "plan" ? 0 : 1);
		const told = model.seen[1].at(-1) as Extract<ToolMsg, { role: "tool" }>;
		assert.equal(told.results[0].failed, true);
		assert.match(told.results[0].content, said);
	}
});

test("Always allow is asked once for the chat's turn; Auto never asks; a turn has an end", async () => {
	const edit = (n: number) => call("create_note", { path: `New ${n}.md`, content: "x" }, `c${n}`);
	const v = notes();
	let asks = 0;
	await runToolChat({ ...scripted([{ text: "", calls: [edit(1), edit(2)] }, { text: "", calls: [edit(3)] }, { text: "ok" }]), port: v, level: "safe", onEvent: () => undefined, ask: async () => (asks++, "always") });
	assert.equal(asks, 1);
	assert.ok("New 3.md" in v.files);
	asks = 0;
	await runToolChat({ ...scripted([{ text: "", calls: [edit(4)] }, { text: "ok" }]), port: v, level: "auto", onEvent: () => undefined, ask: async () => (asks++, "deny") });
	assert.equal(asks, 0);
	assert.ok("New 4.md" in v.files);
	const forever = { step: async () => ({ text: "", truncated: false, calls: [call("list_notes", {})] }) };
	const done = await runToolChat({ ...forever, port: v, level: "safe", onEvent: () => undefined, ask: async () => "deny", maxSteps: 3 });
	assert.match(done.text, /as far as one message goes/);
});

test("the permission card for an edit shows what goes and what comes", () => {
	const ask = toolAsk(call("edit_note", { path: "Macro/IS.md", old_text: "old line", new_text: "new line" }));
	assert.deepEqual([ask.title, ask.removed, ask.added], ["Edit IS.md", ["old line"], ["new line"]]);
	assert.equal(toolAsk(call("create_note", { path: "A/New.md", content: "one\ntwo" })).title, "Create New.md");
});

// ---- the requests and the streams that carry tool calls

const answering = (chunks: string[], type = "text/event-stream"): typeof fetch =>
	(async () => {
		const enc = new TextEncoder();
		return new Response(new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(enc.encode(x))), c.close()) }), { status: 200, headers: { "content-type": type } });
	}) as unknown as typeof fetch;
const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const sc = (kind: StreamCall["kind"]): StreamCall => ({ kind, url: "https://x.test", headers: {}, body: {} });

test("tool calls are read out of Anthropic's stream and out of an OpenAI-style one", async () => {
	const a = sse([
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } },
		{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_note", input: {} } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"Mac' } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ro/IS.md"}' } },
		{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "list_notes", input: {} } },
		{ type: "message_delta", delta: { stop_reason: "tool_use" } },
	]);
	const got = await streamText(sc("anthropic"), { onText: () => undefined, idleMs: 5000, fetch: answering([a.slice(0, 150), a.slice(150)]) });
	assert.equal(got.text, "Looking.");
	assert.deepEqual(got.calls, [
		{ id: "toolu_1", name: "read_note", input: { path: "Macro/IS.md" } },
		{ id: "toolu_2", name: "list_notes", input: {} },
	]);
	const o = sse([
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "search_notes", arguments: "" } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"slope"}' } }] } }] },
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
	]);
	// A step that only asks for a tool, with no words, is still an answer.
	const only = await streamText(sc("chat"), { onText: () => undefined, idleMs: 5000, fetch: answering([o]) });
	assert.deepEqual(only, { text: "", truncated: false, calls: [{ id: "call_9", name: "search_notes", input: { query: "slope" } }] });
	// Answered whole instead of streamed.
	const whole = readPiece("chat", { choices: [{ message: { content: null, tool_calls: [{ id: "c", function: { name: "list_notes", arguments: "{}" } }] } }] });
	assert.deepEqual(whole.callParts, [{ index: 0, id: "c", name: "list_notes", args: "{}" }]);
	// Arguments that aren't JSON don't lose the turn: the tool is told they were unreadable.
	const bad = await streamText(sc("chat"), { onText: () => undefined, idleMs: 5000, fetch: answering([sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "read_note", arguments: "{oops" } }] } }] }])]) });
	assert.ok("__unreadable" in bad.calls[0].input);
});

test("the steps of a turn are sent in each provider's own shape", () => {
	const p = { system: "S", cacheable: "NOTE", rest: "ASK", maxTokens: 100 };
	const tools = [{ name: "read_note", description: "Read.", input: { type: "object" } }];
	const steps: ToolMsg[] = [
		{ role: "assistant", text: "Looking.", calls: [{ id: "t1", name: "read_note", input: { path: "A.md" } }] },
		{ role: "tool", results: [{ id: "t1", content: "A.md\n\nhello" }, { id: "t2", content: "no", failed: true }] },
	];
	const a = toolStreamCall({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" }, p, steps, tools)!;
	assert.deepEqual(a.body.tools, [{ name: "read_note", description: "Read.", input_schema: { type: "object" } }]);
	const am = a.body.messages as any[];
	assert.equal(am.length, 3);
	assert.deepEqual(am[1].content[1], { type: "tool_use", id: "t1", name: "read_note", input: { path: "A.md" } });
	assert.deepEqual(am[2].content[1], { type: "tool_result", tool_use_id: "t2", content: "no", is_error: true });
	const c = toolStreamCall({ provider: "openai", apiKey: "k", model: "gpt-5" }, p, steps, tools)!;
	const cm = c.body.messages as any[];
	assert.deepEqual(cm[2].tool_calls, [{ id: "t1", type: "function", function: { name: "read_note", arguments: '{"path":"A.md"}' } }]);
	assert.deepEqual(cm.slice(3), [{ role: "tool", tool_call_id: "t1", content: "A.md\n\nhello" }, { role: "tool", tool_call_id: "t2", content: "no" }]);
	assert.equal(toolStreamCall({ provider: "gemini", apiKey: "k", model: "g" }, p, steps, tools), null);
	assert.equal(toolStreamCall({ provider: "grillcloud", apiKey: "k", model: "m" }, p, steps, tools), null, "not until its server says it can");
});

test("a note can be rewritten whole, but not emptied, and not one of Grill's own", async () => {
	const v = notes();
	assert.equal((await runTool(v, call("write_note", { path: "IS", content: "# IS\nAll new." }))).content, "Rewrote Macro/IS.md.");
	assert.equal(v.files["Macro/IS.md"], "# IS\nAll new.");
	assert.equal((await runTool(v, call("write_note", { path: "IS", content: "  " }))).failed, true);
	assert.equal((await runTool(v, call("write_note", { path: "IS", content: "# IS\nAll new." }))).failed, true);
	assert.equal((await runTool(v, call("write_note", { path: "Nope", content: "x" }))).failed, true);
	assert.equal(toolAsk(call("write_note", { path: "Macro/IS.md", content: "a\nb" })).title, "Rewrite IS.md");
	// It needs permission like any change.
	let asks = 0;
	await runToolChat({ ...scripted([{ text: "", calls: [call("write_note", { path: "IS", content: "x" })] }, { text: "ok" }]), port: v, level: "safe", onEvent: () => undefined, ask: async () => (asks++, "deny") });
	assert.equal(asks, 1);
	assert.equal(v.files["Macro/IS.md"], "# IS\nAll new.");
});
