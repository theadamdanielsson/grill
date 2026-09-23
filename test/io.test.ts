import { test } from "node:test";
import assert from "node:assert/strict";
import { net, notices } from "obsidian";
import { testModel } from "../src/llm";
import { GrillStore } from "../src/store";

// ---------------------------------------------------------------- model calls

const anthropic = { provider: "anthropic" as const, apiKey: "k", model: "claude-sonnet-5" };

test("a truncated response is retried once with double the token budget", async () => {
	const budgets: number[] = [];
	net.handler = async (req) => {
		const body = JSON.parse(req.body ?? "{}");
		budgets.push(body.max_tokens);
		const json =
			budgets.length === 1
				? { stop_reason: "max_tokens", content: [{ type: "text", text: '{"o' }] }
				: { stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }] };
		return { status: 200, json, text: JSON.stringify(json) };
	};
	assert.equal(await testModel(anthropic), null);
	assert.deepEqual(budgets, [600, 1200]);
});

test("a response still truncated after the retry says so plainly", async () => {
	net.handler = async () => {
		const json = { stop_reason: "max_tokens", content: [] };
		return { status: 200, json, text: "{}" };
	};
	assert.match((await testModel(anthropic)) ?? "", /ran out of room/);
});

test("Sonnet 5 requests carry an effort level; Haiku 4.5 requests don't", async () => {
	const seen: Array<Record<string, unknown>> = [];
	net.handler = async (req) => {
		seen.push(JSON.parse(req.body ?? "{}").output_config);
		const json = { stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }] };
		return { status: 200, json, text: "" };
	};
	await testModel(anthropic);
	await testModel({ ...anthropic, model: "claude-haiku-4-5" });
	assert.equal(seen[0].effort, "medium");
	assert.equal(seen[1].effort, undefined);
});

test("OpenAI-style finish_reason length counts as truncation", async () => {
	let calls = 0;
	net.handler = async () => {
		calls++;
		const json =
			calls === 1
				? { choices: [{ message: { content: '{"o' }, finish_reason: "length" }] }
				: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };
		return { status: 200, json, text: "" };
	};
	assert.equal(await testModel({ provider: "deepseek", apiKey: "k", model: "deepseek-flash" }), null);
	assert.equal(calls, 2);
});

// ---------------------------------------------------------------- store

/** In-memory vault adapter. `rename` refuses an existing destination, like Obsidian's. */
function fakeAdapter() {
	const files = new Map<string, string>();
	const fail = { read: new Set<string>(), write: new Set<string>() };
	const adapter = {
		files,
		fail,
		async exists(p: string) {
			return files.has(p);
		},
		async read(p: string) {
			if (fail.read.has(p)) throw new Error("locked");
			const v = files.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
		async write(p: string, d: string) {
			if (fail.write.has(p)) throw new Error("disk full");
			files.set(p, d);
		},
		async rename(a: string, b: string) {
			if (files.has(b)) throw new Error("Destination file already exists!");
			files.set(b, files.get(a)!);
			files.delete(a);
		},
		async remove(p: string) {
			files.delete(p);
		},
	};
	return adapter;
}

function storeWith(adapter: ReturnType<typeof fakeAdapter>) {
	const app = { vault: { adapter, createFolder: async () => undefined } };
	return new GrillStore(app as never, () => "Grill");
}

test("saves replace an existing file and leave no .tmp behind", async () => {
	const a = fakeAdapter();
	const store = storeWith(a);
	await store.saveConcepts({ x: 1 } as never);
	await store.saveConcepts({ x: 2 } as never);
	assert.deepEqual(JSON.parse(a.files.get("Grill/concepts.json")!), { x: 2 });
	assert.equal(a.files.has("Grill/concepts.json.tmp"), false);
});

test("an unreadable store is never overwritten with empty data", async () => {
	const a = fakeAdapter();
	a.files.set("Grill/mastery.json", JSON.stringify({ Krebs: { correct: 40 } }));
	a.fail.read.add("Grill/mastery.json");
	const store = storeWith(a);
	notices.length = 0;
	assert.deepEqual(await store.loadMastery(), {});
	await assert.rejects(store.saveMastery({} as never), /won't save over it/);
	assert.deepEqual(JSON.parse(a.files.get("Grill/mastery.json")!), { Krebs: { correct: 40 } });
	assert.ok(notices.some((n) => /won't save over it/.test(n)));
});

test("a save that can't be written anywhere throws, so the caller stays dirty", async () => {
	const a = fakeAdapter();
	a.fail.write.add("Grill/concepts.json");
	a.fail.write.add("Grill/concepts.json.tmp");
	await assert.rejects(storeWith(a).saveConcepts({} as never), /disk full/);
});

test("a cache that can't be written never throws", async () => {
	const a = fakeAdapter();
	a.fail.write.add("Grill/pdf-cache.json");
	a.fail.write.add("Grill/pdf-cache.json.tmp");
	await storeWith(a).savePdfCache({});
});
