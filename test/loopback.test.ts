import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { LoopbackToolServer, ROUTE_HEADER, mcpHandle } from "../src/loopback";

const tools = [{ name: "grill_overview", description: "d", input: { type: "object", properties: {} } }];
const run = async (name: string) => ({ content: `ran ${name}` });

function post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
	const u = new URL(url);
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (res) => {
			let b = "";
			res.on("data", (d) => (b += d));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

test("speaks enough MCP for a client to list and call Grill's tools", async () => {
	const init = await mcpHandle("grill", tools, run, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.equal((init?.result as any).protocolVersion, "2025-06-18");
	assert.equal(await mcpHandle("grill", tools, run, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
	const list = await mcpHandle("grill", tools, run, { jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.deepEqual((list?.result as any).tools.map((t: any) => t.name), ["grill_overview"]);
	const call = await mcpHandle("grill", tools, run, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "grill_overview", arguments: {} } });
	assert.deepEqual(call?.result, { content: [{ type: "text", text: "ran grill_overview" }], isError: false });
	const unknown = await mcpHandle("grill", tools, run, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_note" } });
	assert.equal(unknown?.error?.code, -32602);
});

test("over HTTP: only this computer, only with the route's id, never from a web page", async () => {
	const server = new LoopbackToolServer(createRequire(import.meta.url));
	try {
		const route = await server.open(tools, run);
		const u = new URL(route.url);
		assert.equal(u.hostname, "127.0.0.1");
		const ok = { "Content-Type": "application/json", ...route.headers };
		const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grill_overview", arguments: {} } });
		const good = await post(route.url, call, ok);
		assert.equal(good.status, 200);
		assert.match(good.body, /ran grill_overview/);
		assert.equal((await post(route.url, call, { ...ok, Origin: "https://evil.example" })).status, 403, "a web page");
		assert.equal((await post(route.url, call, { ...ok, Host: "evil.example" })).status, 403, "DNS rebinding");
		assert.equal((await post(route.url, call, { "Content-Type": "application/json" })).status, 404, "no route id");
		assert.equal((await post(route.url, call, { ...ok, [ROUTE_HEADER]: "guess" })).status, 404, "a guessed id");
		assert.equal((await post(route.url, call, { ...route.headers, "Content-Type": "text/plain" })).status, 415);
		// Refused before the whole body is in: a 413, or the connection cut under the upload.
		const big = await post(route.url, "x".repeat(1024 * 1024 + 10), ok).catch((e: NodeJS.ErrnoException) => ({ status: e.code === "EPIPE" || e.code === "ECONNRESET" ? 413 : 0, body: "" }));
		assert.equal(big.status, 413);
		assert.equal((await post(route.url, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), ok)).status, 202);
		route.dispose();
		assert.equal((await post(route.url, call, ok)).status, 404, "a turn that has ended");
	} finally {
		await server.close();
	}
});
