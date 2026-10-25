/** What the agent programs share: finding and starting them through Node, which only the
 * desktop app has, the PATH they need, the line protocol Codex's app-server and opencode
 * (ACP) are spoken to over, and the watchdog on it. */

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export type Need = (name: string) => unknown;
/** Node's require, which Obsidian gives the desktop app; null on a phone. */
export const need = (): Need | null => (window as unknown as { require?: Need }).require ?? null;

type Env = Record<string, string | undefined>;

/** A program as it is installed: the path set in settings if it is there, else the first
 * usual place that has one. Null on a phone, or when it isn't installed. */
export function findInstalled(setPath: string, places: (home: string, platform: string, env: Env) => string[]): string | null {
	try {
		const req = need();
		if (!req) return null;
		const fs = req("fs") as { existsSync(p: string): boolean };
		const os = req("os") as { homedir(): string };
		const proc = req("process") as { platform: string; env: Env };
		const wanted = setPath.trim();
		if (wanted) return fs.existsSync(wanted) ? wanted : null;
		return places(os.homedir(), proc.platform, proc.env).find((p) => fs.existsSync(p)) ?? null;
	} catch {
		return null;
	}
}

/** Folders a program started from the dock can't see but a terminal can: where Claude
 * Code, and the Node it may need, usually are. */
export function pathWith(current: string, program: string, home: string, platform: string): string {
	const sep = platform === "win32" ? ";" : ":";
	const slash = platform === "win32" ? "\\" : "/";
	const dir = program.slice(0, Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")));
	const usual = platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.volta/bin`, `${home}/.bun/bin`, "/usr/bin", "/bin"];
	const seen = new Set<string>();
	return [dir, ...current.split(sep), ...usual, `${home}${slash}.claude${slash}local`]
		.filter((p) => p && !seen.has(p) && seen.add(p))
		.join(sep);
}

/** A Windows .cmd or .bat is run through a shell, which reads the command as written: a
 * path with a space in it (a Windows user name) has to be quoted. */
const shimmed = (program: string): boolean => /\.(cmd|bat)$/i.test(program);

/** Start Claude Code the way its SDK would, but without handing Node the pane's abort
 * signal, which it refuses: stopping is done by hand. After Claudian's custom spawn. */
export function startSdkProgram(o: SpawnOptions, name: string): SpawnedProcess {
	const req = need();
	if (!req) throw new Error(`${name} can only be run on desktop.`);
	const cp = req("child_process") as { spawn(cmd: string, args: string[], opts: Record<string, unknown>): { kill(sig?: string): boolean; stdin: unknown; stdout: unknown } };
	const shim = shimmed(o.command);
	const child = cp.spawn(shim ? `"${o.command}"` : o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, ...(shim ? { shell: true } : {}) });
	const kill = (): void => void child.kill("SIGTERM");
	if (o.signal.aborted) kill();
	else o.signal.addEventListener("abort", kill, { once: true });
	if (!child.stdin || !child.stdout) throw new Error(`${name} could not be started.`);
	return child as unknown as SpawnedProcess;
}

/** A program spoken to a line at a time over its own pipes. */
export interface LineWire {
	send(line: string): void;
	onLine(take: (line: string) => void): void;
	/** Called once if the other end goes away, with what it last said on its error stream
	 * (or NOT_STARTED when it never started). */
	onClose(gone: (why: string) => void): void;
	close(): void;
}

/** What a program says when it isn't signed in, in any of the ways they say it. */
export const SIGNED_OUT = /log ?in|auth|credential|401|unauthorized/i;

/** What onClose is told when the program could not be started at all. */
export const NOT_STARTED = "not started";

interface Child {
	stdin: { write(s: string): void; end(): void } | null;
	stdout: { on(e: "data", f: (d: unknown) => void): void; setEncoding?(enc: string): void } | null;
	stderr: { on(e: "data", f: (d: unknown) => void): void } | null;
	on(e: "exit" | "error", f: (...a: unknown[]) => void): void;
	kill(sig?: string): boolean;
}

/** Start a program on its own pipes. Each turn has its own process, which picks the
 * conversation up again by its id; nothing is left running between messages. */
export function openLineWire(p: { program: string; args: string[]; env?: Record<string, string> }, cwd: string, name: string): LineWire {
	const req = need();
	if (!req) throw new Error(`${name} can only be run on desktop.`);
	const proc = req("process") as { platform: string; env: Env };
	const home = (req("os") as { homedir(): string }).homedir();
	const cp = req("child_process") as { spawn(cmd: string, args: string[], opts: Record<string, unknown>): Child };
	const shim = shimmed(p.program);
	let child: Child;
	try {
		child = cp.spawn(shim ? `"${p.program}"` : p.program, p.args, {
			cwd,
			env: { ...proc.env, ...(p.env ?? {}), PATH: pathWith(proc.env.PATH ?? "", p.program, home, proc.platform) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			...(shim ? { shell: true } : {}),
		});
	} catch {
		throw new Error(`${name} could not be started. Check where it is installed, in settings.`);
	}
	if (!child.stdin || !child.stdout) throw new Error(`${name} could not be started.`);
	let said = "";
	let pending = "";
	let closed = false;
	let take: (line: string) => void = () => undefined;
	let gone: (why: string) => void = () => undefined;
	// Writing to a program that has just gone away is not an error worth more than the
	// one its exit already reports.
	(child.stdin as unknown as { on?(e: "error", f: () => void): void }).on?.("error", () => undefined);
	child.stdout.setEncoding?.("utf8");
	child.stdout.on("data", (d) => {
		pending += String(d);
		let at: number;
		while ((at = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, at).trim();
			pending = pending.slice(at + 1);
			if (line) take(line);
		}
	});
	child.stderr?.on("data", (d) => {
		said = (said + String(d)).slice(-600);
	});
	const ended = (why: string): void => {
		if (closed) return;
		closed = true;
		gone(why);
	};
	child.on("exit", () => ended(said));
	child.on("error", () => ended(NOT_STARTED));
	return {
		send: (line) => {
			if (!closed) child.stdin?.write(`${line}\n`);
		},
		onLine: (f) => (take = f),
		onClose: (f) => (gone = f),
		close: () => {
			closed = true;
			try {
				child.stdin?.end();
			} catch {
				/* already gone */
			}
			child.kill("SIGTERM");
		},
	};
}

/** How long a program may take to answer the opening requests, before any turn. */
export const HANDSHAKE_MS = 60_000;
/** How long a turn may go without a word from the program. Long: a test run or a build
 * can be quiet for minutes. Not a limit on the whole turn. */
export const IDLE_MS = 10 * 60_000;

/** Fails a run that has heard nothing from its program for too long. Every line from it
 * keeps the run alive, and so does a question the student is still answering (`hold` it
 * while they do). */
export function idleWatch(limit: number, fail: (quietMs: number) => void): { heard(): void; hold<T>(p: Promise<T>): Promise<T>; limit(ms: number): void; stop(): void } {
	let ms = limit;
	let held = 0;
	let timer: number | null = null;
	const arm = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = held ? null : window.setTimeout(() => fail(ms), ms);
	};
	arm();
	return {
		heard: arm,
		async hold<T>(p: Promise<T>): Promise<T> {
			held++;
			arm();
			try {
				return await p;
			} finally {
				held--;
				arm();
			}
		},
		limit(next: number): void {
			ms = next;
			arm();
		},
		stop(): void {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
			held = 1;
		},
	};
}

/** The sentence for a program that went quiet. */
export function quietError(name: string, quietMs: number): Error {
	const minutes = Math.round(quietMs / 60_000);
	return new Error(`${name} said nothing for ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(quietMs / 1000)} seconds`}, so Grill stopped waiting.`);
}
