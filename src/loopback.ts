/**
 * Grill's own tools for a program that can only reach them over MCP (opencode): an
 * MCP endpoint on this computer, inside the plugin. The tools run here, on what the
 * pane holds, so they can do what an outside server can't (offer a test as a button).
 *
 * Ported from Claudian's LoopbackSessionToolServer and session tool dispatcher
 * (github.com/YishenTu/claudian, MIT, src/core/session-tools/). As there: it listens
 * on 127.0.0.1 only, from the first route on; any request with an Origin (a web page)
 * is refused; Host must name this port; bodies must be JSON and small; each route is an
 * unguessable id carried in a header, revoked when its turn ends. MCP Streamable HTTP
 * with JSON responses only; no SDK, no zod.
 */

import type { ToolSpec } from "./stream";

export const ROUTE_HEADER = "X-Grill-Route";

const HOST = "127.0.0.1";
const PATH = "/mcp";
const MAX_BODY = 1024 * 1024;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export type ToolCallResult = { content: string; failed?: boolean };
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

export interface Route {
	url: string;
	headers: Record<string, string>;
	/** Revokes the route. Calls still running are answered as revoked. Safe twice. */
	dispose(): void;
}

type Loose = Record<string, unknown>;
type Id = string | number;
type Reply = { jsonrpc: "2.0"; id: Id | null; result?: unknown; error?: { code: number; message: string } };

const loose = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (id: Id | null, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

/** One JSON-RPC message to the MCP server named `name`: the reply, or nothing for a
 * notification. Separate from the HTTP side so it can be checked without a socket. */
export async function mcpHandle(name: string, tools: ToolSpec[], run: ToolRunner, message: unknown): Promise<Reply | undefined> {
	if (!loose(message) || message.jsonrpc !== "2.0") return fail(null, INVALID_REQUEST, "Invalid JSON-RPC message");
	const { id, method } = message;
	if (typeof method !== "string") {
		// A response to a request of ours: this server sends none.
		if ("result" in message || "error" in message) return undefined;
		return fail(null, INVALID_REQUEST, "Invalid JSON-RPC message");
	}
	if (id === undefined) return undefined; // notifications: initialized, cancelled
	if (typeof id !== "string" && typeof id !== "number") return fail(null, INVALID_REQUEST, "Invalid JSON-RPC request id");
	const params = loose(message.params) ? message.params : {};
	switch (method) {
		case "initialize": {
			const asked = params.protocolVersion;
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name, version: "1.0.0" },
				},
			};
		}
		case "ping":
			return { jsonrpc: "2.0", id, result: {} };
		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) } };
		case "tools/call": {
			const tool = params.name;
			if (typeof tool !== "string" || !tools.some((t) => t.name === tool)) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(tool)}`);
			let r: ToolCallResult;
			try {
				r = await run(tool, loose(params.arguments) ? params.arguments : {});
			} catch (e) {
				r = { content: e instanceof Error ? e.message : String(e), failed: true };
			}
			return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.content }], isError: !!r.failed } };
		}
		default:
			return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
	}
}

interface Req {
	headers: Record<string, string | string[] | undefined>;
	method?: string;
	url?: string;
	complete?: boolean;
	on(e: "data", f: (c: Uint8Array) => void): void;
	on(e: "end" | "close", f: () => void): void;
	on(e: "error", f: (err: Error) => void): void;
	removeAllListeners(e: string): void;
}
interface Res {
	headersSent: boolean;
	writableEnded: boolean;
	destroyed: boolean;
	setHeader(k: string, v: string): void;
	writeHead(status: number, headers?: Record<string, string | number>): void;
	end(body?: string): void;
	destroy(): void;
	on(e: "close", f: () => void): void;
}
interface HttpServer {
	listen(port: number, host: string, cb: () => void): void;
	address(): { port: number } | string | null;
	once(e: "error", f: (err: Error) => void): void;
	off(e: "error", f: (err: Error) => void): void;
	on(e: "error", f: (err: Error) => void): void;
	close(cb?: () => void): void;
	closeAllConnections?(): void;
}

interface RouteRecord {
	tools: ToolSpec[];
	run: ToolRunner;
	revoked: boolean;
}

export class LoopbackToolServer {
	private routes = new Map<string, RouteRecord>();
	private server: HttpServer | null = null;
	private listening: Promise<number> | null = null;
	private hosts = new Set<string>();
	private closed = false;

	constructor(private need: (m: string) => unknown) {}

	/** A route serving these tools, until disposed. Starts listening on first use. */
	async open(tools: ToolSpec[], run: ToolRunner): Promise<Route> {
		const port = await this.listen();
		if (this.closed) throw new Error("Grill's tool endpoint is closed.");
		const crypto = this.need("crypto") as { randomBytes(n: number): { toString(enc: string): string } };
		const id = crypto.randomBytes(32).toString("base64url");
		const record: RouteRecord = {
			tools,
			revoked: false,
			// A call that arrives after its turn has ended is answered, not run.
			run: async (n, a) => (record.revoked ? { content: "This chat turn has ended.", failed: true } : run(n, a)),
		};
		this.routes.set(id, record);
		return {
			url: `http://${HOST}:${port}${PATH}`,
			headers: { [ROUTE_HEADER]: id },
			dispose: () => {
				if (this.routes.get(id) !== record) return;
				record.revoked = true;
				this.routes.delete(id);
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const r of this.routes.values()) r.revoked = true;
		this.routes.clear();
		await this.listening?.catch(() => undefined);
		const server = this.server;
		this.server = null;
		if (!server) return;
		await new Promise<void>((done) => {
			server.close(() => done());
			server.closeAllConnections?.();
		});
	}

	private listen(): Promise<number> {
		if (this.closed) return Promise.reject(new Error("Grill's tool endpoint is closed."));
		this.listening ??= new Promise<number>((resolve, reject) => {
			const http = this.need("http") as { createServer(o: Loose, h: (req: Req, res: Res) => void): HttpServer };
			const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => void this.handle(req, res));
			this.server = server;
			server.once("error", reject);
			server.listen(0, HOST, () => {
				server.off("error", reject);
				// An error after listening must not take Obsidian down; the request fails alone.
				server.on("error", () => undefined);
				const at = server.address();
				const port = typeof at === "object" && at ? at.port : 0;
				this.hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
				resolve(port);
			});
		}).catch((e: unknown) => {
			this.listening = null;
			this.server = null;
			throw e;
		});
		return this.listening;
	}

	private async handle(req: Req, res: Res): Promise<void> {
		const header = (k: string): string => {
			const v = req.headers[k];
			return typeof v === "string" ? v : "";
		};
		if (!this.hosts.has(header("host").toLowerCase())) return send(res, 403, { error: "Forbidden host." });
		if (req.headers.origin !== undefined) return send(res, 403, { error: "Browser requests are not allowed." });
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			return send(res, 405, { error: "Method not allowed." });
		}
		const route = this.routes.get(header(ROUTE_HEADER.toLowerCase()));
		if (!route || req.url?.split("?")[0] !== PATH) return send(res, 404, { error: "Unknown route." });
		if (header("content-type").split(";")[0].trim().toLowerCase() !== "application/json") return send(res, 415, { error: "Expected application/json." });
		if (Number(header("content-length")) > MAX_BODY) return tooLarge(res);
		let body: string;
		try {
			body = await readBody(req);
		} catch (e) {
			if (e instanceof TooLarge) return tooLarge(res);
			if (!res.headersSent) res.destroy();
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			return send(res, 400, fail(null, -32700, "Parse error"));
		}
		const reply = await mcpHandle("grill", route.tools, route.run, message);
		if (res.destroyed || res.writableEnded) return;
		if (reply) send(res, 200, reply);
		else send(res, 202);
	}
}

class TooLarge extends Error {}

function readBody(req: Req): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				req.removeAllListeners("data");
				reject(new TooLarge());
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const all = new Uint8Array(size);
			let at = 0;
			for (const c of chunks) {
				all.set(c, at);
				at += c.length;
			}
			resolve(new TextDecoder().decode(all));
		});
		req.on("error", reject);
		req.on("close", () => {
			if (!req.complete) reject(new Error("Request aborted."));
		});
	});
}

function tooLarge(res: Res): void {
	res.setHeader("Connection", "close");
	send(res, 413, { error: "Request body too large." });
}

function send(res: Res, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status);
		res.end();
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": new TextEncoder().encode(payload).length });
	res.end(payload);
}
