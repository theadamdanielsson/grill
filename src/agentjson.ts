/**
 * Tests on an agent program: writing and marking questions through Claude Code, Codex
 * or opencode when no model is set up, so a student with only one of those can be
 * tested as well as chat.
 *
 * Each call is one turn that may not touch anything: Claude Code gets no tools at all
 * and returns the schema's JSON itself; Codex and opencode run in their read-only mode,
 * every permission they ask for is declined, and they work in an empty folder of
 * Grill's own in the user's home (not the shared temporary folder) rather than in the vault. What comes back is read as JSON the same way a
 * model's reply is.
 */
import type { Options, SDKMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { acceptPaneSignals, pathWith } from "./agent";
import { runAcp } from "./acp";
import { runCodex } from "./codex";
import { opencodeProgram } from "./opencode";

export type AgentEngine = "claudecode" | "codex" | "opencode";

export interface AgentJSONRun {
	engine: AgentEngine;
	program: string;
	/** The model to use, by the program's own id; "" leaves it to the program. */
	model: string;
	system: string;
	user: string;
	schema: Record<string, unknown>;
	/** Aborted when Grill stops waiting: the program is stopped with it. */
	signal?: AbortSignal;
}

type Need = (name: string) => unknown;
const need = (): Need | null => (window as unknown as { require?: Need }).require ?? null;

/** An empty folder of Grill's own to work in, made when first needed, readable by this
 * user only. */
function workFolder(): string {
	const req = need();
	if (!req) throw new Error("This engine can only be run on desktop.");
	const os = req("os") as { homedir(): string };
	const fs = req("fs") as { mkdirSync(p: string, o: { recursive: boolean; mode: number }): void };
	const path = req("path") as { join(...p: string[]): string };
	const dir = path.join(os.homedir(), ".grill", "work");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** The request as one message, with the shape the answer must take. */
export function jsonPrompt(system: string, user: string, schema: Record<string, unknown>): string {
	return `${system}\n\n${user}\n\nDo not use any tools and do not look at any files: everything needed is above. Answer with a single JSON object and nothing else, no code fence, matching this JSON Schema:\n${JSON.stringify(schema)}`;
}

/** A JSON object out of a reply, fenced or not. */
export function readJSON(text: string): unknown {
	const t = text.trim();
	try {
		return JSON.parse(t) as unknown;
	} catch {
		const m = t.match(/\{[\s\S]*\}/);
		if (m) return JSON.parse(m[0]) as unknown;
		throw new Error("Model returned unparseable output");
	}
}

/** Start Claude Code without handing Node the pane's abort signal (see agent.ts). */
function startProgram(o: SpawnOptions): SpawnedProcess {
	const req = need();
	if (!req) throw new Error("Claude Code can only be run on desktop.");
	const cp = req("child_process") as { spawn(cmd: string, args: string[], opts: Record<string, unknown>): { kill(sig?: string): boolean; stdin: unknown; stdout: unknown } };
	const shim = /\.(cmd|bat)$/i.test(o.command);
	const child = cp.spawn(shim ? `"${o.command}"` : o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, ...(shim ? { shell: true } : {}) });
	if (o.signal.aborted) child.kill("SIGTERM");
	else o.signal.addEventListener("abort", () => void child.kill("SIGTERM"), { once: true });
	return child as unknown as SpawnedProcess;
}

async function claudeJSON(run: AgentJSONRun, cwd: string): Promise<unknown> {
	const req = need();
	if (!req) throw new Error("Claude Code can only be run on desktop.");
	acceptPaneSignals(req("events") as Parameters<typeof acceptPaneSignals>[0]);
	const proc = req("process") as { platform: string; env: Record<string, string | undefined> };
	const home = (req("os") as { homedir(): string }).homedir();
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const stop = new AbortController();
	if (run.signal?.aborted) stop.abort();
	else run.signal?.addEventListener("abort", () => stop.abort(), { once: true });
	const options: Options = {
		abortController: stop,
		cwd,
		pathToClaudeCodeExecutable: run.program,
		env: { ...(proc.env as Record<string, string>), PATH: pathWith(proc.env.PATH ?? "", run.program, home, proc.platform) },
		spawnClaudeCodeProcess: startProgram,
		// Nothing to use and nothing to read: Grill's instructions only, the answer in the schema.
		tools: [],
		systemPrompt: run.system,
		settingSources: [],
		outputFormat: { type: "json_schema", schema: run.schema },
		persistSession: false,
		...(run.model ? { model: run.model } : {}),
	};
	let structured: unknown = undefined;
	let text = "";
	let failed = "";
	try {
		for await (const m of query({ prompt: run.user, options }) as AsyncIterable<SDKMessage>) {
			if (m.type !== "result") continue;
			const r = m as { subtype: string; result?: string; structured_output?: unknown; errors?: string[] };
			if (r.subtype === "success") {
				structured = r.structured_output;
				text = r.result ?? "";
			} else failed = r.errors?.join(" ") || r.subtype;
		}
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		if (/log ?in|auth|credential|401/i.test(why)) throw new Error("Claude Code is not signed in. Open a terminal, run claude, and sign in there.");
		throw new Error(`Claude Code stopped: ${why.slice(0, 200)}`);
	}
	if (structured !== undefined && structured !== null) return structured;
	if (text) return readJSON(text);
	throw new Error(failed ? `Claude Code stopped: ${failed.slice(0, 200)}` : "Empty model response");
}

/** One JSON answer from the program. Throws with a sentence fit to show. */
export async function agentJSON(run: AgentJSONRun): Promise<unknown> {
	const cwd = workFolder();
	if (run.engine === "claudecode") return claudeJSON(run, cwd);
	const prompt = jsonPrompt(run.system, run.user, run.schema);
	const quiet = { onEvent: () => undefined, ask: async () => "deny" as const, signal: run.signal };
	const result =
		run.engine === "codex"
			? await runCodex({ program: run.program, prompt, cwd, level: "plan", ...quiet })
			: await runAcp({ ...opencodeProgram(run.program, "plan"), name: "opencode", prompt, cwd, level: "plan", model: run.model, ...quiet });
	return readJSON(result.text);
}
