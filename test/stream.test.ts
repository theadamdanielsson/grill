import test from "node:test";
import assert from "node:assert/strict";
import { readPiece, streamCall, streamText, StreamCall, StreamUnavailable, takeLines, withoutThinking } from "../src/stream";
import { replyInProgress } from "../src/llm";
import { cloud } from "../src/cloud";

const call = (kind: StreamCall["kind"]): StreamCall => ({ kind, url: "https://example.test/x", headers: {}, body: {} });

/** A server that answers with these chunks, cut exactly where given. */
function answering(chunks: string[], type = "text/event-stream", status = 200): typeof fetch {
	return (async () => {
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of chunks) c.enqueue(enc.encode(chunk));
				c.close();
			},
		});
		return new Response(body, { status, headers: { "content-type": type } });
	}) as unknown as typeof fetch;
}

const run = (fetchImpl: typeof fetch, heard: string[] = []) => ({ onText: (t: string) => void heard.push(t), idleMs: 5000, fetch: fetchImpl });

test("lines are taken whole, and the unfinished one is kept for the next read", () => {
	const a = takeLines('event: x\ndata: {"a":1}\n\ndata: {"b"', "chat");
	assert.deepEqual(a.payloads, ['{"a":1}']);
	assert.equal(a.pending, 'data: {"b"');
	const b = takeLines(`${a.pending}:2}\r\ndata: [DONE]\n`, "chat");
	assert.deepEqual(b.payloads, ['{"b":2}']);
	assert.deepEqual(takeLines('{"x":1}\n\n{"y":2}\n', "ollama").payloads, ['{"x":1}', '{"y":2}']);
});

test("each provider's stream is read in its own shape", () => {
	assert.equal(readPiece("anthropic", { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }).text, "hi");
	assert.equal(readPiece("anthropic", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } }).text, undefined);
	assert.equal(readPiece("anthropic", { type: "message_delta", delta: { stop_reason: "max_tokens" } }).truncated, true);
	assert.match(readPiece("anthropic", { type: "error", error: { message: "Overloaded" } }).error ?? "", /Overloaded/);
	assert.equal(readPiece("chat", { choices: [{ delta: { content: "yo" } }] }).text, "yo");
	assert.equal(readPiece("chat", { choices: [{ delta: {}, finish_reason: "length" }] }).truncated, true);
	assert.equal(readPiece("gemini", { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] }).text, "ab");
	assert.equal(readPiece("ollama", { message: { content: "ok" } }).text, "ok");
	assert.deepEqual(readPiece("chat", { grill: { credits: 12, cost: 0.4 } }), { credits: 12, cost: 0.4 });
	assert.deepEqual(readPiece("chat", "nonsense"), {});
});

test("a reply is handed over as it grows, however the chunks are cut", async () => {
	const heard: string[] = [];
	const sse =
		'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The mul"}}\n\n' +
		'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tiplier"}}\n\n' +
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
	// Cut in the middle of a line and in the middle of a multi-byte character's worth of text.
	const chunks = [sse.slice(0, 37), sse.slice(37, 120), sse.slice(120)];
	const got = await streamText(call("anthropic"), run(answering(chunks), heard));
	assert.deepEqual(got, { text: "The multiplier", truncated: false, calls: [] });
	assert.deepEqual(heard, ["The mul", "The multiplier"]);
});

test("a stream that can't be opened says so before anything is written", async () => {
	const refused = (async () => {
		throw new TypeError("Failed to fetch");
	}) as unknown as typeof fetch;
	await assert.rejects(streamText(call("chat"), run(refused)), StreamUnavailable);
	await assert.rejects(streamText(call("chat"), run(answering(['{"error":{"message":"no"}}'], "application/json", 401))), StreamUnavailable);
	await assert.rejects(streamText(call("chat"), run(answering(["data: [DONE]\n\n"]))), StreamUnavailable);
});

test("a server that answers whole is used as it is, not asked again", async () => {
	const heard: string[] = [];
	const whole = JSON.stringify({ choices: [{ message: { content: "All of it." }, finish_reason: "stop" }] });
	const got = await streamText(call("chat"), run(answering([whole], "application/json"), heard));
	assert.equal(got.text, "All of it.");
	assert.deepEqual(heard, ["All of it."]);
});

test("a failure after the reply began is an error, not a reason to ask again", async () => {
	const heard: string[] = [];
	const chunks = ['data: {"choices":[{"delta":{"content":"Half"}}]}\n\n', 'data: {"error":{"message":"Out of credits."}}\n\n'];
	await assert.rejects(streamText(call("chat"), run(answering(chunks), heard)), (e: Error) => !(e instanceof StreamUnavailable) && /Out of credits/.test(e.message));
	assert.deepEqual(heard, ["Half"]);
});

test("Grill Cloud's closing line reports the balance and the cost", async () => {
	const seen: Array<[number | undefined, number | undefined]> = [];
	const chunks = ['data: {"choices":[{"delta":{"content":"Yes."}}]}\n\n', 'data: {"grill":{"credits":88,"cost":1.5}}\n\ndata: [DONE]\n\n'];
	const got = await streamText(call("chat"), { ...run(answering(chunks)), onCloud: (c, cost) => void seen.push([c, cost]) });
	assert.equal(got.text, "Yes.");
	assert.deepEqual(seen, [[88, 1.5]]);
});

test("leaving the conversation stops the request and is not mistaken for a failed stream", async () => {
	const stop = new AbortController();
	const hanging = ((_url: string, init: RequestInit) =>
		new Promise((_, no) => init.signal?.addEventListener("abort", () => no(new DOMException("Aborted", "AbortError"))))) as unknown as typeof fetch;
	const p = streamText(call("chat"), { ...run(hanging), signal: stop.signal });
	stop.abort();
	await assert.rejects(p, (e: Error) => e.name === "AbortError");
});

test("a local model's thinking is not part of the reply", async () => {
	assert.equal(withoutThinking("<think>hm, let me"), "");
	assert.equal(withoutThinking("<think>hm</think>\nThe answer"), "The answer");
	const heard: string[] = [];
	const chunks = ['{"message":{"content":"<think>hm"}}\n', '{"message":{"content":"</think>Four."}}\n{"done":true,"done_reason":"stop"}\n'];
	const got = await streamText(call("ollama"), run(answering(chunks, "application/x-ndjson"), heard));
	assert.equal(got.text, "Four.");
	assert.deepEqual(heard, ["", "Four."]);
});

test("a diagram's source stays out of a reply until it is whole", () => {
	assert.equal(replyInProgress("Here it is.\n\n```mermaid\nflowchart LR\n  A-->"), "Here it is.");
	assert.equal(replyInProgress("Before\n```mermaid\nA-->B\n```\nAfter"), "Before\n\nAfter");
	assert.equal(replyInProgress("```js\nx\n```"), "```js\nx\n```");
});

test("the request asks for a stream of plain text, with the note marked for the cache", () => {
	const p = { system: "S", cacheable: "NOTE", rest: "ASK", maxTokens: 100 };
	const a = streamCall({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" }, p);
	assert.equal(a?.body.stream, true);
	assert.equal(a?.body.output_config && (a.body.output_config as { format?: unknown }).format, undefined);
	const content = (a?.body.messages as Array<{ content: Array<{ cache_control?: unknown }> }>)[0].content;
	assert.ok(content[0].cache_control);
	assert.equal(content[1].cache_control, undefined);
	// Grill Cloud is asked this way only once its server has said it can answer this way.
	assert.equal(streamCall({ provider: "grillcloud", apiKey: "k", model: "m" }, p), null);
	Object.assign(cloud, { streams: true, url: "https://c.test/cloud/" });
	try {
		assert.equal(streamCall({ provider: "grillcloud", apiKey: "k", model: "m" }, p)?.url, "https://c.test/cloud/chat/completions");
	} finally {
		Object.assign(cloud, { streams: false, url: "" });
	}
});

test("the provider's own web search runs alongside, and its pieces are never taken for a tool Grill must run", async () => {
	const sse = [
		{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search" } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"cpi"}' } },
		{ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [] } },
		{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "CPI rose." } },
		{ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t1", name: "read_note" } },
		{ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"A"}' } },
	]
		.map((e) => `data: ${JSON.stringify(e)}\n\n`)
		.join("");
	const got = await streamText(call("anthropic"), run(answering([sse])));
	assert.equal(got.text, "CPI rose.");
	assert.deepEqual(got.calls.map((c) => c.name), ["read_note"]);
});

test("web search is asked for in each provider's way, and only where asked", async () => {
	const { toolStreamCall } = await import("../src/stream");
	const p = { system: "S", cacheable: "", rest: "ASK", maxTokens: 100 };
	const tool = { name: "read_note", description: "x", input: { type: "object" } };
	const a = toolStreamCall({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" }, p, [], [tool], { webSearch: true })!;
	assert.ok((a.body.tools as Array<{ type?: string }>).some((t) => t.type === "web_search_20250305"));
	const plain = toolStreamCall({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" }, p, [], [tool])!;
	assert.equal((plain.body.tools as unknown[]).length, 1);
	Object.assign(cloud, { streams: true, tools: true, search: true, url: "https://c.test/cloud" });
	let c: StreamCall;
	try {
		c = toolStreamCall({ provider: "grillcloud", apiKey: "k", model: "m" }, p, [], [tool], { webSearch: true })!;
	} finally {
		Object.assign(cloud, { streams: false, tools: false, search: false, url: "" });
	}
	assert.equal(c.body.web_search, true);
	assert.ok(!(c.body.tools as Array<{ type?: string }>).some((t) => t.type === "web_search_20250305"), "Grill Cloud adds the search itself");
});
