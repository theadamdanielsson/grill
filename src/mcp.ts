/**
 * MCP servers for Chat on Grill Cloud and on a key of one's own, through the official
 * MCP client. (Claude Code, Codex and opencode connect to their own.)
 *
 * Servers are written as Claude Code writes them in `.mcp.json`: a `command` with `args`
 * and `env` for a program on this computer (desktop only), or a `url` with `headers` for
 * one on the web. Their tools are offered to the model next to the vault's; what they
 * do is run here, in the plugin, and a tool that may change something asks first.
 */
import { requestUrl } from "obsidian";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** The MCP client, loaded the first time a server is used: most people never set one up,
 * and loaded at startup it would run before the schema library it shares with the rest of
 * Grill is ready. */
const sdk = async () => {
	const [client, http, sse, types, oauth] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
		import("@modelcontextprotocol/sdk/client/sse.js"),
		import("@modelcontextprotocol/sdk/types.js"),
		import("@modelcontextprotocol/sdk/client/auth.js"),
	]);
	return {
		Client: client.Client,
		StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
		SSEClientTransport: sse.SSEClientTransport,
		JSONRPCMessageSchema: types.JSONRPCMessageSchema,
		auth: oauth.auth,
		UnauthorizedError: oauth.UnauthorizedError,
	};
};
import { pathWith } from "./agent";
import type { ToolCall, ToolSpec } from "./stream";

export interface McpServer {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

export interface McpStatus {
	name: string;
	tools: number;
	error?: string;
	/** The server wants the user to sign in before it can be used. */
	signIn?: boolean;
}

const CONNECT_MS = 30_000;
const CALL_MS = 120_000;
const RESULT_CHARS = 60_000;
/** What Grill Cloud takes for one tool; a longer one is cut, a bigger shape left out. */
const DESCRIBED = 1000;
const SHAPE_CHARS = 10_000;
const MOST_TOOLS = 100;
const TOOLS_CHARS = 250_000;

/** The servers in what was pasted: a `.mcp.json` (`{"mcpServers": {...}}`) or just the
 * servers by name. */
export function parseServers(json: string): { servers: Record<string, McpServer> } | { error: string } {
	if (!json.trim()) return { servers: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { error: "This isn't valid JSON." };
	}
	const all = (raw as { mcpServers?: unknown })?.mcpServers ?? raw;
	if (!all || typeof all !== "object" || Array.isArray(all)) return { error: 'Expected {"mcpServers": {"name": {...}}}.' };
	const servers: Record<string, McpServer> = {};
	for (const [name, s] of Object.entries(all as Record<string, unknown>)) {
		const v = s as McpServer;
		if (!v || typeof v !== "object" || (typeof v.command !== "string" && typeof v.url !== "string")) return { error: `"${name}" needs a command or a url.` };
		servers[name] = v;
	}
	return { servers };
}

/** The name a server's tool goes by here: unique, and in the characters every provider
 * takes. */
/** Whether a tool's input can be offered to every provider: an object, not a choice of
 * shapes at its top, which Anthropic refuses for the whole request. */
export function acceptedShape(shape: unknown): boolean {
	const s = shape as Record<string, unknown> | null;
	return !!s && typeof s === "object" && s.type === "object" && !("anyOf" in s) && !("oneOf" in s) && !("allOf" in s);
}

export function toolName(server: string, tool: string, taken: Set<string>): string {
	const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
	let name = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
	for (let n = 2; taken.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
	taken.add(name);
	return name;
}

/** The text of what a tool came to. */
export function resultText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
	const parts = content.map((c: { type?: string; text?: string; resource?: { text?: string; uri?: string }; mimeType?: string }) => {
		if (c?.type === "text") return c.text ?? "";
		if (c?.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
		if (c?.type === "image" || c?.type === "audio") return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""} not shown]`;
		if (c?.type === "resource_link") return `[link ${(c as { uri?: string }).uri ?? ""}]`;
		return JSON.stringify(c);
	});
	const text = parts.join("\n\n");
	return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n\n[Cut short: ${text.length - RESULT_CHARS} more characters.]` : text;
}

type Need = (m: string) => unknown;
const need = (): Need | null => (window as unknown as { require?: Need }).require ?? null;

/** Requests to MCP servers and their sign-in pages. Everything is sent once, through
 * Obsidian's own request, which no server's browser rules can refuse; it is read whole,
 * which is how an answer comes anyway. Only a stream a server holds open for messages
 * of its own needs `fetch`: where that is refused, it is said not to be there, since
 * what Chat needs comes as answers. */
const looseFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
	const method = init?.method ?? "GET";
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
	if (method === "GET" && /text\/event-stream/.test(headers.accept ?? "")) {
		try {
			return await fetch(url, init);
		} catch (e) {
			if (init?.signal?.aborted) throw e;
			return new Response(null, { status: 405 });
		}
	}
	const form = init?.body instanceof URLSearchParams;
	if (form && !headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";
	const body = typeof init?.body === "string" ? init.body : form ? String(init?.body) : undefined;
	const r = await requestUrl({ url: String(url), method, headers, body, throw: false });
	const empty = [204, 205, 304].includes(r.status);
	return new Response(empty ? null : r.arrayBuffer, { status: r.status, headers: r.headers });
};

/** A program on this computer, spoken to over its input and output, a message a line. */
class ProgramTransport implements Transport {
	onmessage?: (m: JSONRPCMessage) => void;
	onerror?: (e: Error) => void;
	onclose?: () => void;
	/** The end of what it wrote to its error output: said when it fails to start. */
	said = "";
	private child: {
		stdin: { write(s: string): void; end(): void };
		stdout: { on(e: "data", f: (d: unknown) => void): void; setEncoding(e: string): void };
		stderr: { on(e: "data", f: (d: unknown) => void): void; setEncoding(e: string): void };
		pid?: number;
		on(e: string, f: (x?: unknown) => void): void;
		once(e: string, f: (x?: unknown) => void): void;
		kill(): void;
	} | null = null;
	private buf = "";
	private win = false;

	constructor(
		private s: McpServer,
		private parse: (v: unknown) => JSONRPCMessage,
	) {}

	async start(): Promise<void> {
		const req = need();
		if (!req) throw new Error("A server that runs on this computer works on desktop only.");
		const cp = req("child_process") as { spawn(c: string, a: string[], o: object): NonNullable<ProgramTransport["child"]> };
		const os = req("os") as { homedir(): string };
		const proc = req("process") as { platform: string; env: Record<string, string | undefined> };
		const command = this.s.command ?? "";
		const env = { ...proc.env, ...(this.s.env ?? {}), PATH: pathWith(proc.env.PATH ?? "", command, os.homedir(), proc.platform) };
		// On Windows `npx` and the like are .cmd files, run through the shell, which needs
		// each argument quoted.
		const win = proc.platform === "win32";
		const quote = (a: string): string => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
		const child = cp.spawn(win ? quote(command) : command, (this.s.args ?? []).map((a) => (win ? quote(a) : a)), { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: win });
		this.child = child;
		this.win = win;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		await new Promise<void>((ok, fail) => {
			child.once("spawn", () => ok());
			child.once("error", (e) => fail(e as Error));
		});
		child.on("error", (e) => this.onerror?.(e as Error));
		child.on("close", () => this.onclose?.());
		child.stderr.on("data", (d) => (this.said = (this.said + String(d)).slice(-1000)));
		child.stdout.on("data", (d) => {
			this.buf += String(d);
			for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				if (!line) continue;
				try {
					this.onmessage?.(this.parse(JSON.parse(line)));
				} catch (e) {
					this.onerror?.(e as Error);
				}
			}
		});
	}

	async send(m: JSONRPCMessage): Promise<void> {
		this.child?.stdin.write(`${JSON.stringify(m)}\n`);
	}

	async close(): Promise<void> {
		const child = this.child;
		this.child = null;
		try {
			child?.stdin.end();
			// On Windows the shell is what was started: the server under it is ended with it.
			if (this.win && child?.pid) (need()?.("child_process") as { exec(c: string): void } | undefined)?.exec(`taskkill /pid ${child.pid} /T /F`);
			else child?.kill();
		} catch {
			// Gone already.
		}
	}
}

/** What a sign-in left behind for one server: Grill's registration with it, the tokens,
 * and, part way through, the PKCE verifier. */
export interface SignedIn {
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	verifier?: string;
	/** The address the registration was made for. */
	redirect?: string;
}

/** Where sign-ins are kept, by server address. */
export interface SignInStore {
	load(url: string): SignedIn | null;
	save(url: string, s: SignedIn | null): void;
}

/** Thrown in place of opening a browser when Chat, not the user, is connecting. */
class NeedsSignIn extends Error {
	constructor() {
		super("Needs sign-in.");
	}
}

/** The SDK's view of a server's sign-in. Only a sign-in the user started may open the
 * browser; otherwise a server that wants one is marked for it. */
class Provider implements OAuthClientProvider {
	/** Sent with the sign-in and checked when the browser comes back: only the sign-in
	 * Grill started is finished. */
	readonly nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

	constructor(
		private url: string,
		private store: SignInStore,
		private redirect: string | undefined,
		private open?: (url: URL) => void,
	) {}

	private get kept(): SignedIn {
		return this.store.load(this.url) ?? {};
	}

	private put(change: Partial<SignedIn>): void {
		this.store.save(this.url, { ...this.kept, ...change });
	}

	get redirectUrl(): string {
		return this.redirect ?? this.kept.redirect ?? "http://127.0.0.1/callback";
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Grill",
			client_uri: "https://grill.onbridger.com",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const st = this.kept;
		// Registered for another address (a sign-in on another port): register again.
		if (this.redirect && st.redirect !== this.redirect) return undefined;
		return st.client;
	}

	saveClientInformation(client: OAuthClientInformationMixed): void {
		this.put({ client, redirect: this.redirectUrl });
	}

	tokens(): OAuthTokens | undefined {
		return this.kept.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.put({ tokens });
	}

	state(): string {
		return this.nonce;
	}

	redirectToAuthorization(url: URL): void {
		if (!this.open) throw new NeedsSignIn();
		// Only a web page: a server's sign-in address must not open anything else.
		const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server's sign-in page is not a web address.");
		this.open(url);
	}

	saveCodeVerifier(verifier: string): void {
		this.put({ verifier });
	}

	codeVerifier(): string {
		return this.kept.verifier ?? "";
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all") this.store.save(this.url, null);
		else if (scope === "client") this.put({ client: undefined, redirect: undefined });
		else if (scope === "tokens") this.put({ tokens: undefined });
		else if (scope === "verifier") this.put({ verifier: undefined });
	}
}

/** Where the browser comes back to after a sign-in, and the code it brings. On desktop a
 * one-time address on this computer, as Claude Code uses; on a phone, Obsidian's own
 * link, which the plugin hands to `McpHub.returned`. */
interface Return {
	redirect: string;
	code: Promise<URLSearchParams>;
	close(): void;
}

const PAGE = "<!doctype html><meta charset=utf-8><title>Grill</title><body style=\"font:16px system-ui;padding:3em\">Signed in. You can close this tab and go back to Obsidian.</body>";

async function desktopReturn(accept: (p: URLSearchParams) => boolean): Promise<Return | null> {
	const req = need();
	if (!req) return null;
	const http = req("http") as {
		createServer(h: (q: { url?: string }, r: { writeHead(n: number, h: object): void; end(s: string): void }) => void): {
			listen(port: number, host: string, f: () => void): void;
			address(): { port: number };
			close(): void;
			once(e: string, f: (e: Error) => void): void;
		};
	};
	let got: (p: URLSearchParams) => void = () => {};
	const code = new Promise<URLSearchParams>((ok) => (got = ok));
	const server = http.createServer((q, r) => {
		const u = new URL(q.url ?? "/", "http://127.0.0.1");
		if (u.pathname !== "/callback") {
			r.writeHead(404, {});
			r.end("");
			return;
		}
		if (!accept(u.searchParams)) {
			r.writeHead(400, {});
			r.end("");
			return;
		}
		r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		r.end(PAGE);
		got(u.searchParams);
	});
	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", ok);
	});
	return { redirect: `http://127.0.0.1:${server.address().port}/callback`, code, close: () => server.close() };
}

/** The link Obsidian opens Grill with after a sign-in on a phone. */
export const RETURN_ACTION = "grill-mcp-auth";

interface Linked {
	name: string;
	client: Client | null;
	tools: Array<{ spec: ToolSpec; real: string; readOnly: boolean }>;
	error?: string;
	signIn?: boolean;
}

const inTime = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
	let timer = 0;
	const late = new Promise<T>((_, fail) => (timer = window.setTimeout(() => fail(new Error(`${what} took too long.`)), ms)));
	return Promise.race([work, late]).finally(() => window.clearTimeout(timer));
};

/** The servers in use, connected once and kept until what is set changes. */
export class McpHub {
	private set = "";
	private linked: Linked[] = [];
	private linking: Promise<void> | null = null;
	/** A sign-in waiting for the browser to come back to Obsidian's link. */
	private waiting: ((p: URLSearchParams) => void) | null = null;

	constructor(private signIns: SignInStore = { load: () => null, save: () => {} }) {}

	/** Obsidian was opened with the sign-in link: hand its code to the sign-in waiting. */
	returned(params: Record<string, string>): void {
		this.waiting?.(new URLSearchParams(params));
	}

	/** Sign in to a server: open its sign-in page in the browser, wait for the code to come
	 * back, trade it for tokens, and connect again. Resolves to why it failed, or null. */
	async signIn(name: string, open: (url: string) => void): Promise<string | null> {
		const parsed = parseServers(this.set);
		const server = "servers" in parsed ? parsed.servers[name] : undefined;
		if (!server?.url) return "That server has no address to sign in to.";
		const { auth } = await sdk();
		let nonce = "";
		const ours = (p: URLSearchParams): boolean => !!nonce && p.get("state") === nonce;
		let back = await desktopReturn(ours);
		if (!back) {
			let got: (p: URLSearchParams) => void = () => {};
			const code = new Promise<URLSearchParams>((ok) => (got = ok));
			this.waiting = (p) => ours(p) && got(p);
			back = { redirect: `obsidian://${RETURN_ACTION}`, code, close: () => (this.waiting = null) };
		}
		const r = back;
		try {
			const provider = new Provider(server.url, this.signIns, r.redirect, (url) => open(url.toString()));
			nonce = provider.nonce;
			const first = await auth(provider, { serverUrl: server.url, fetchFn: looseFetch });
			if (first === "REDIRECT") {
				const params = await inTime(r.code, 5 * 60_000, "Signing in");
				const code = params.get("code");
				if (!code) return params.get("error_description") ?? params.get("error") ?? "The sign-in was not completed.";
				await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn: looseFetch });
			}
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		} finally {
			r.close();
		}
		const json = this.set;
		this.set = "";
		await this.ready(json);
		const st = this.status().find((x) => x.name === name);
		return st?.error ?? null;
	}

	/** Forget a server's sign-in. */
	signOut(name: string): void {
		const parsed = parseServers(this.set);
		const url = "servers" in parsed ? parsed.servers[name]?.url : undefined;
		if (url) this.signIns.save(url, null);
	}

	/** Connected to the servers in `json`, if not already. Never throws: a server that
	 * can't be reached is listed with why, and its tools aren't offered. */
	ready(json: string): Promise<void> {
		if (json === this.set && this.linking) return this.linking;
		this.set = json;
		const was = this.linked;
		this.linked = [];
		this.linking = (async () => {
			await Promise.all(was.map((l) => l.client?.close().catch(() => undefined)));
			const parsed = parseServers(json);
			if ("error" in parsed) {
				this.linked = [{ name: "MCP servers", client: null, tools: [], error: parsed.error }];
				return;
			}
			const taken = new Set<string>();
			const linked = await Promise.all(Object.entries(parsed.servers).map(([name, s]) => this.link(name, s)));
			// Named in order, so the same servers give the same names every time.
			for (const l of linked) for (const t of l.tools) t.spec.name = toolName(l.name, t.real, taken);
			this.linked = linked;
		})();
		return this.linking;
	}

	private async link(name: string, s: McpServer): Promise<Linked> {
		let client: Client | null = null;
		let program: ProgramTransport | null = null;
		try {
			const { Client, StreamableHTTPClientTransport, SSEClientTransport, JSONRPCMessageSchema, UnauthorizedError } = await sdk();
			client = new Client({ name: "grill", version: "1" }, { capabilities: {} });
			if (s.url) {
				const url = new URL(s.url);
				const requestInit = { headers: s.headers ?? {} };
				// Signs in with what an earlier sign-in kept, refreshing it when it has run out;
				// never opens a browser from here.
				const authProvider = new Provider(s.url, this.signIns, undefined);
				const signIn = (e: unknown): boolean => e instanceof NeedsSignIn || e instanceof UnauthorizedError || (e instanceof Error && /\b401\b|unauthori[sz]ed/i.test(e.message));
				try {
					if (s.type === "sse") throw new Error("sse");
					await inTime(client.connect(new StreamableHTTPClientTransport(url, { requestInit, fetch: looseFetch, authProvider })), CONNECT_MS, "Connecting");
				} catch (e) {
					if (signIn(e)) return { name, client: null, tools: [], error: "Needs sign-in.", signIn: true };
					// An older server speaks the earlier HTTP form.
					if (s.type === "http") throw e;
					client = new Client({ name: "grill", version: "1" }, { capabilities: {} });
					try {
						await inTime(client.connect(new SSEClientTransport(url, { requestInit, fetch: looseFetch, authProvider })), CONNECT_MS, "Connecting");
					} catch (e2) {
						if (signIn(e2)) return { name, client: null, tools: [], error: "Needs sign-in.", signIn: true };
						throw e2;
					}
				}
			} else {
				program = new ProgramTransport(s, (v) => JSONRPCMessageSchema.parse(v));
				await inTime(client.connect(program), CONNECT_MS, "Starting it");
			}
			const tools: Linked["tools"] = [];
			let cursor: string | undefined;
			do {
				const page = await inTime(client.listTools(cursor ? { cursor } : {}), CONNECT_MS, "Listing its tools");
				for (const t of page.tools) {
					if (JSON.stringify(t.inputSchema).length > SHAPE_CHARS || !acceptedShape(t.inputSchema)) continue;
					const d = t.description ?? t.title ?? t.name;
					tools.push({
						real: t.name,
						// Read-only and closed to the outside world: a tool that reads the web can
						// still carry the notes out in what it is asked for.
						readOnly: t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false,
						spec: { name: t.name, description: d.length > DESCRIBED ? `${d.slice(0, DESCRIBED)}…` : d, input: t.inputSchema as Record<string, unknown> },
					});
				}
				cursor = page.nextCursor;
			} while (cursor && tools.length < MOST_TOOLS);
			return { name, client, tools: tools.slice(0, MOST_TOOLS) };
		} catch (e) {
			await client?.close().catch(() => undefined);
			const said = program?.said.trim();
			return { name, client: null, tools: [], error: `${e instanceof Error ? e.message : String(e)}${said ? ` (${said.split("\n").pop()})` : ""}` };
		}
	}

	status(): McpStatus[] {
		return this.linked.map((l) => ({ name: l.name, tools: l.tools.length, ...(l.error ? { error: l.error } : {}), ...(l.signIn ? { signIn: true } : {}) }));
	}

	/** The tools offered, as many as fit what one request may carry (Grill Cloud takes
	 * 400,000 characters of tools, the vault's own included). */
	specs(): ToolSpec[] {
		const out: ToolSpec[] = [];
		let used = 0;
		for (const t of this.linked.flatMap((l) => l.tools.map((x) => x.spec))) {
			const size = JSON.stringify(t).length;
			if (out.length >= MOST_TOOLS || used + size > TOOLS_CHARS) break;
			out.push(t);
			used += size;
		}
		return out;
	}

	/** How many tools did not fit (see `specs`). */
	leftOut(): number {
		return this.linked.reduce((n, l) => n + l.tools.length, 0) - this.specs().length;
	}

	private find(name: string): { l: Linked; t: Linked["tools"][number] } | null {
		for (const l of this.linked) for (const t of l.tools) if (t.spec.name === name) return { l, t };
		return null;
	}

	owns(name: string): boolean {
		return this.find(name) !== null;
	}

	/** Whether a tool may reach beyond this device (the server does not say it is closed). */
	reachesOut(name: string): boolean {
		const f = this.find(name);
		return !!f && !f.t.readOnly;
	}

	/** Whether the server says the tool only reads. */
	readOnly(name: string): boolean {
		return this.find(name)?.t.readOnly === true;
	}

	/** "server: tool", for the line above a reply and the permission card. */
	label(name: string): string {
		const f = this.find(name);
		return f ? `${f.l.name}: ${f.t.real}` : name;
	}

	async run(call: ToolCall, signal?: AbortSignal): Promise<{ content: string; failed?: boolean }> {
		const f = this.find(call.name);
		if (!f?.l.client) return { content: "That tool's server isn't connected.", failed: true };
		try {
			const r = await f.l.client.callTool({ name: f.t.real, arguments: call.input }, undefined, { timeout: CALL_MS, signal });
			const content = resultText(r.content ?? (r as { toolResult?: unknown }).toolResult);
			return r.isError ? { content: content || "The tool failed.", failed: true } : { content: content || "(no output)" };
		} catch (e) {
			return { content: `That didn't work: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}`, failed: true };
		}
	}

	async close(): Promise<void> {
		const was = this.linked;
		this.linked = [];
		this.set = "";
		this.linking = null;
		await Promise.all(was.map((l) => l.client?.close().catch(() => undefined)));
	}
}
