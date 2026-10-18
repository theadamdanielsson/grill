import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkills, readSkill, runSkillTool, skillRules, type SkillSource } from "../src/skills";
import { McpHub, parseServers, resultText, toolName } from "../src/mcp";
import { runToolChat, type ExtraTools } from "../src/vaulttools";

/** Skills kept in memory, by path. */
function memory(files: Record<string, string>): SkillSource {
	return {
		dirs: async (root) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${root}/`)).map((p) => `${root}/${p.slice(root.length + 1).split("/")[0]}`))],
		read: async (path) => files[path] ?? null,
		files: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
	};
}

test("a skill's name and description are read from its properties, folded or not", () => {
	assert.deepEqual(readSkill('---\nname: pdf\ndescription: "Fill PDF forms."\n---\nBody'), { name: "pdf", description: "Fill PDF forms.", body: "Body" });
	assert.equal(readSkill("---\nname: x\ndescription: >\n  Two\n  lines\n---\n")?.description, "Two lines");
	assert.equal(readSkill("no properties"), null);
	assert.equal(readSkill("---\nname: x\n---\n"), null);
});

test("skills are found, listed to the model, and loaded with their files", async () => {
	const src = memory({
		"s/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs.\n---\nUse forms.md for forms.",
		"s/pdf/forms.md": "How to fill a form.",
		"s/broken/SKILL.md": "nothing",
	});
	const skills = await findSkills([{ source: src, root: "s" }]);
	assert.deepEqual(skills.map((k) => k.name), ["pdf"]);
	assert.match(skillRules(skills), /- pdf: Work with PDFs\./);
	const loaded = await runSkillTool(skills, { id: "1", name: "use_skill", input: { name: "pdf" } });
	assert.match(loaded.content, /Use forms\.md/);
	assert.match(loaded.content, /Other files in this skill: forms\.md/);
	assert.equal((await runSkillTool(skills, { id: "2", name: "use_skill", input: { name: "pdf", file: "forms.md" } })).content, "How to fill a form.");
	assert.equal((await runSkillTool(skills, { id: "3", name: "use_skill", input: { name: "pdf", file: "../x" } })).failed, true);
	assert.equal((await runSkillTool(skills, { id: "4", name: "use_skill", input: { name: "nope" } })).failed, true);
});

test("MCP servers are read as .mcp.json writes them, or by name alone", () => {
	assert.deepEqual(parseServers('{"mcpServers":{"a":{"url":"https://x"}}}'), { servers: { a: { url: "https://x" } } });
	assert.deepEqual(parseServers('{"b":{"command":"npx","args":["y"]}}'), { servers: { b: { command: "npx", args: ["y"] } } });
	assert.deepEqual(parseServers(""), { servers: {} });
	assert.ok("error" in parseServers("{"));
	assert.ok("error" in parseServers('{"c":{}}'));
});

test("an MCP tool's name here fits every provider and stays unique", () => {
	const taken = new Set<string>();
	assert.equal(toolName("git hub", "create.issue", taken), "mcp__git_hub__create_issue");
	assert.equal(toolName("git hub", "create.issue", taken), "mcp__git_hub__create_issue_2");
	assert.ok(toolName("s", "x".repeat(100), taken).length <= 64);
});

test("what an MCP tool returns is read as text", () => {
	assert.equal(resultText([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }]), "a\n\n[image image/png not shown]");
});

test("a tool from outside the vault asks first at the Safe level, and not when it only reads", async () => {
	const ran: string[] = [];
	const asked: string[] = [];
	const extra: ExtraTools = {
		specs: [],
		rules: "",
		owns: (n) => n.startsWith("mcp__"),
		changes: (n) => n !== "mcp__s__read",
		label: (c) => c.name,
		run: async (c) => (ran.push(c.name), { content: "ok" }),
	};
	let step = 0;
	await runToolChat({
		step: async () =>
			step++ === 0
				? { text: "", calls: [{ id: "1", name: "mcp__s__read", input: {} }, { id: "2", name: "mcp__s__send", input: { to: "x" } }], truncated: false }
				: { text: "Done", calls: [], truncated: false },
		port: { notes: () => [], read: async () => null, write: async () => {}, create: async () => {}, exists: () => false } as never,
		level: "safe",
		onEvent: () => {},
		ask: async (a) => (asked.push(a.title), "deny"),
		extra,
	});
	assert.deepEqual(asked, ["mcp__s__send"]);
	assert.deepEqual(ran, ["mcp__s__read"]);
});

const server = join(process.cwd(), "mcp/dist/grill-mcp.js");
test("a server on this computer is started, its tools listed and one called", { skip: !existsSync(server) }, async () => {
	const w = globalThis as unknown as { window?: unknown };
	const had = w.window;
	w.window = { require: createRequire(import.meta.url), setTimeout, clearTimeout };
	const vault = mkdtempSync(join(tmpdir(), "grill-mcp-test-"));
	mkdirSync(join(vault, "Grill"), { recursive: true });
	writeFileSync(join(vault, "Note.md"), "# Note\n");
	const hub = new McpHub();
	try {
		await hub.ready(JSON.stringify({ mcpServers: { grill: { command: process.execPath, args: [server, "--vault", vault] } } }));
		const st = hub.status();
		assert.equal(st[0].error, undefined, st[0].error);
		const names = hub.specs().map((s) => s.name);
		assert.ok(names.includes("mcp__grill__grill_overview"), names.join(", "));
		const r = await hub.run({ id: "1", name: "mcp__grill__grill_overview", input: {} });
		assert.equal(r.failed, undefined, r.content);
		assert.ok(r.content.length > 0);
	} finally {
		await hub.close();
		w.window = had;
	}
});

test("a server that wants a sign-in is marked for one, signed in to through the browser, and then used", async () => {
	const http = await import("node:http");
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
	let base = "";
	const json = (res: any, status: number, body: unknown, headers: object = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	};
	const read = (req: any): Promise<string> => new Promise((ok) => {
		let b = "";
		req.on("data", (d: Buffer) => (b += d));
		req.on("end", () => ok(b));
	});
	const server = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? "/", base);
		if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
		if (u.pathname.startsWith("/.well-known/oauth-authorization-server") || u.pathname.startsWith("/.well-known/openid-configuration"))
			return json(res, 200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		if (u.pathname === "/register") return json(res, 201, { ...JSON.parse(await read(req)), client_id: "grill-test" });
		if (u.pathname === "/authorize") {
			const back = new URL(u.searchParams.get("redirect_uri")!);
			back.searchParams.set("code", "good");
			const state = u.searchParams.get("state");
			if (state) back.searchParams.set("state", state);
			res.writeHead(302, { location: back.toString() });
			return res.end();
		}
		if (u.pathname === "/token") {
			const form = new URLSearchParams(await read(req));
			return form.get("code") === "good" ? json(res, 200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 }) : json(res, 400, { error: "invalid_grant" });
		}
		if (u.pathname === "/mcp") {
			if (req.headers.authorization !== "Bearer tok")
				return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
			const mcp = new McpServer({ name: "demo", version: "1" });
			mcp.registerTool("hello", { description: "Says hello." }, async () => ({ content: [{ type: "text", text: "hello from demo" }] }));
			const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await mcp.connect(t);
			const body = req.method === "POST" ? JSON.parse(await read(req)) : undefined;
			return t.handleRequest(req, res, body);
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	const w = globalThis as unknown as { window?: unknown };
	const had = w.window;
	w.window = { require: createRequire(import.meta.url), setTimeout, clearTimeout };
	// Obsidian's own request, as it behaves: sent once, read whole.
	const { net } = (await import("obsidian")) as any;
	const offline = net.handler;
	net.handler = async (req: any) => {
		const r = await fetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body });
		const buf = await r.arrayBuffer();
		const text = new TextDecoder().decode(buf);
		const headers: Record<string, string> = {};
		r.headers.forEach((v, k) => (headers[k] = v));
		return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), arrayBuffer: buf, headers };
	};
	const kept = new Map<string, any>();
	const hub = new McpHub({ load: (u) => kept.get(u) ?? null, save: (u, v) => (v ? kept.set(u, v) : kept.delete(u)) });
	try {
		await hub.ready(JSON.stringify({ mcpServers: { demo: { url: `${base}/mcp`, type: "http" } } }));
		assert.equal(hub.status()[0].signIn, true, JSON.stringify(hub.status()));
		// The "browser": follow the sign-in page's redirect back to Grill.
		const failed = await hub.signIn("demo", (url) => {
			void fetch(url, { redirect: "manual" }).then((r) => fetch(r.headers.get("location")!));
		});
		assert.equal(failed, null);
		assert.equal(hub.status()[0].tools, 1, JSON.stringify(hub.status()));
		const r = await hub.run({ id: "1", name: "mcp__demo__hello", input: {} });
		assert.equal(r.content, "hello from demo");
		// Kept: a new start connects with the stored sign-in, no browser.
		const again = new McpHub({ load: (u) => kept.get(u) ?? null, save: (u, v) => (v ? kept.set(u, v) : kept.delete(u)) });
		await again.ready(JSON.stringify({ mcpServers: { demo: { url: `${base}/mcp`, type: "http" } } }));
		assert.equal(again.status()[0].tools, 1);
		await again.close();
	} finally {
		await hub.close();
		server.close();
		w.window = had;
		net.handler = offline;
	}
});

test("notes are cut at their headings and long sections at their paragraphs", async () => {
	const { passages } = await import("../src/semantic");
	const p = passages("---\na: 1\n---\nIntro line\n# Money\nMoney is a medium of exchange.\n## Inflation\n" + "Prices rise. ".repeat(200));
	assert.equal(p[0].heading, "");
	assert.equal(p[1].heading, "Money");
	assert.ok(p.filter((x) => x.heading === "Inflation").length >= 2);
	assert.ok(p.every((x) => x.text.length <= 1800));
});

test("the search index embeds only what changed and finds by meaning", async () => {
	const { updateIndex, search, packVec, unpackVec } = await import("../src/semantic");
	assert.deepEqual(Array.from(unpackVec(packVec([0.5, -1, 2]))), [0.5, -1, 2]);
	// A stand-in model: one dimension per topic word.
	const topics = ["money", "inflation", "growth"];
	let embedded = 0;
	const embed = async (texts: string[]) => {
		embedded += texts.length;
		return texts.map((t) => {
			const v = topics.map((w) => (t.toLowerCase().includes(w) ? 1 : 0));
			const n = Math.hypot(...v) || 1;
			return v.map((x) => x / n);
		});
	};
	const index = { model: "m", notes: {} as Record<string, any> };
	const notes = [
		{ path: "a.md", text: "# Money\nMoney and inflation." },
		{ path: "b.md", text: "# Growth\nLong-run growth." },
	];
	assert.equal(await updateIndex(index, notes, embed), true);
	const first = embedded;
	await updateIndex(index, notes, embed);
	assert.equal(embedded, first, "unchanged notes are not embedded again");
	const hits = search(index, [0, 0, 1]);
	assert.equal(hits[0].path, "b.md");
	await updateIndex(index, [notes[0]], embed);
	assert.deepEqual(Object.keys(index.notes), ["a.md"], "a removed note leaves the index");
	assert.equal(await updateIndex(index, [{ path: "c.md", text: "x" }], async () => null), false);
});

test("a web page is read as its words", async () => {
	const { pageText } = await import("../src/web");
	const t = pageText("<html><head><title>x</title><style>p{}</style></head><body><h2>Prices</h2><p>CPI &amp; PPI&#39;s rise</p><script>evil()</script><ul><li>One</li></ul></body></html>");
	assert.equal(t, "## Prices\nCPI & PPI's rise\n\n- One");
});


test("only tool inputs every provider takes are offered, and addresses on this computer or network are never read", async () => {
	const { acceptedShape } = await import("../src/mcp");
	assert.equal(acceptedShape({ type: "object", properties: {} }), true);
	assert.equal(acceptedShape({ anyOf: [{ type: "object" }] }), false);
	assert.equal(acceptedShape({ type: "string" }), false);
	const { privateHost } = await import("../src/web");
	for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.20.0.1", "169.254.1.1", "[::1]", "printer.local", "::ffff:7f00:1", "[::ffff:192.168.0.1]"]) assert.equal(privateHost(h), true, h);
	for (const h of ["example.com", "8.8.8.8", "172.32.0.1"]) assert.equal(privateHost(h), false, h);
});

test("a tool that reaches beyond the device is asked about every time", async () => {
	const offered: string[] = [];
	const extra: ExtraTools = {
		specs: [],
		rules: "",
		owns: () => true,
		changes: () => true,
		reachesOut: (n) => n === "fetch_url",
		label: (c) => c.name,
		run: async () => ({ content: "ok" }),
	};
	let step = 0;
	await runToolChat({
		step: async () =>
			step++ === 0
				? { text: "", calls: [{ id: "1", name: "fetch_url", input: { url: "https://x" } }, { id: "2", name: "mcp__s__make", input: {} }], truncated: false }
				: { text: "Done", calls: [], truncated: false },
		port: { notes: () => [], read: async () => null, write: async () => {}, create: async () => {}, exists: () => false } as never,
		level: "safe",
		onEvent: () => {},
		ask: async (a) => (offered.push(a.always), "once"),
		extra,
	});
	assert.deepEqual(offered, ["", "Always allow this tool in this chat"]);
});
