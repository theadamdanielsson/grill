import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeConversation, codexConversation, conversationsFromZip, exportConversations, importedLines, isAsk, matchConversations, mergeImported, plainPrior } from "../src/imported";

/** Past chats with other AI tools: read as whole conversations, so a quiz's answers come
 * along with the question that named the note, and matched to a note only when a message
 * the student typed names it. */

test("isAsk keeps questions and drops code, commands and long prompts", () => {
	assert.equal(isAsk("Explain the deflation spiral"), true);
	assert.equal(isAsk("/clear"), false);
	assert.equal(isAsk("fix src/view.ts so the build passes"), false);
	assert.equal(isAsk("```js\nconst a = 1\n```"), false);
	assert.equal(isAsk("(Open in the editor now: [[Money]].) What do I keep getting wrong?"), false);
	assert.equal(isAsk("word ".repeat(200)), false);
});

test("Claude Code: typed messages and reply text, Grill's brief and tool results left out", () => {
	const c = claudeCodeConversation(
		[
			JSON.stringify({ type: "user", timestamp: "2026-10-11T10:00:00Z", message: { content: [{ type: "text", text: "<context>\nrecord\n</context>\n\nQuiz me on the Taylor rule" }] } }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "What does the rule set?" }, { type: "tool_use", name: "Read" }] } }),
			JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
			JSON.stringify({ type: "user", isMeta: true, message: { content: "Caveat" } }),
			JSON.stringify({ type: "user", message: { content: "The exchange rate?" } }),
			'{"type":"user", cut short',
		].join("\n"),
	);
	assert.deepEqual(c.turns, [
		{ role: "user", text: "Quiz me on the Taylor rule" },
		{ role: "ai", text: "What does the rule set?" },
		{ role: "user", text: "The exchange rate?" },
	]);
	assert.equal(c.at, "2026-10-11T10:00:00Z");
});

test("Codex: user and agent messages", () => {
	const c = codexConversation(
		[
			JSON.stringify({ timestamp: "2026-05-26T22:49:47Z", type: "event_msg", payload: { type: "user_message", message: "what is the natural rate of interest?\n" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "The real rate at which output is at potential." } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } }),
		].join("\n"),
	);
	assert.deepEqual(c.turns.map((t) => t.role), ["user", "ai"]);
});

test("exports: ChatGPT's mapping in time order, and Claude's chat_messages", () => {
	const chatgpt = exportConversations(
		JSON.stringify([
			{
				mapping: {
					b: { message: { author: { role: "assistant" }, create_time: 2, content: { parts: ["It anchors expectations."] } } },
					a: { message: { author: { role: "user" }, create_time: 1, content: { parts: ["How does inflation targeting work?"] } } },
					c: { message: null },
				},
			},
		]),
	);
	assert.deepEqual(chatgpt[0].turns.map((t) => t.role), ["user", "ai"]);
	const claude = exportConversations(JSON.stringify([{ chat_messages: [{ sender: "human", text: "What is the Phillips curve?", created_at: "2026-09-01T00:00:00Z" }, { sender: "assistant", text: "It is..." }] }]));
	assert.equal(claude[0].source, "claude");
	assert.equal(claude[0].turns.length, 2);
	assert.throws(() => exportConversations('{"not":"a list"}'));
});

test("a quiz's answers come with the question that named the note; talk about software matches nothing", () => {
	const notes = [
		{ name: "Taylor rule", text: "The Taylor rule sets the policy rate from inflation and the output gap." },
		{ name: "Phillips curve", text: "The Phillips curve links unemployment and inflation expectations." },
		{ name: "Money", text: "Money supply, demand for money, liquidity." },
	];
	const quiz = {
		source: "chatgpt" as const,
		at: "2026-10-01",
		turns: [
			{ role: "user" as const, text: "Quiz me on the Taylor rule please" },
			{ role: "ai" as const, text: "What two gaps does it respond to?" },
			{ role: "user" as const, text: "Unemployment and the exchange rate" },
			{ role: "ai" as const, text: "Not quite: inflation and output." },
		],
	};
	const other = { source: "codex" as const, at: "2026-10-02", turns: [{ role: "user" as const, text: "How much money will the plugin make this month?" }] };
	const m = matchConversations([quiz, other], notes);
	assert.deepEqual(Object.keys(m), ["Taylor rule"]);
	assert.match(m["Taylor rule"][0].text, /STUDENT: Unemployment and the exchange rate/);
	assert.match(plainPrior(m["Taylor rule"]), /^Asked ChatGPT about it/);
});

test("merging keeps the newest line a note, and the digest names the source", () => {
	const first = mergeImported(null, { codex: 10 }, { "Taylor rule": { text: "Asked for a first explanation.", at: "2026-01-01", source: "codex" } }, new Date("2026-10-21"));
	const again = mergeImported(first, { codex: 5 }, { "Taylor rule": { text: "Quizzed: mixed up the two gaps.", at: "2026-02-01", source: "chatgpt" } }, new Date("2026-10-22"));
	assert.deepEqual(again.read, { codex: 15 });
	assert.deepEqual(importedLines(again), ["- Taylor rule: Quizzed: mixed up the two gaps. (ChatGPT, 2026-02-01)"]);
	assert.deepEqual(importedLines(null), []);
});

test("a data export's zip is read without unzipping it first", async () => {
	const zlib = await import("node:zlib");
	const body = Buffer.from(JSON.stringify([{ chat_messages: [{ sender: "human", text: "What is the IS curve in macroeconomics?" }] }]));
	const packed = zlib.deflateRawSync(body);
	const name = Buffer.from("conversations.json");
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(packed.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(packed.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0, 42);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + packed.length, 16);
	const zip = Buffer.concat([local, name, packed, central, name, end]);
	const text = conversationsFromZip(new Uint8Array(zip), (d) => new Uint8Array(zlib.inflateRawSync(d)));
	assert.ok(text);
	assert.equal(exportConversations(text)[0].turns[0].text, "What is the IS curve in macroeconomics?");
	assert.throws(() => conversationsFromZip(new Uint8Array(Buffer.from("not a zip at all, nothing here")), (d) => d));
});
