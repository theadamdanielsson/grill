/** The record grill-mcp keeps for coding agents outside any vault (~/.grill/record), and
 * the conversations Claude Code and Codex keep on this computer: the files the plugin
 * reads with Node's fs, on desktop only. Callers pass Obsidian's `require`. */

import type { ConceptMap } from "./concepts";
import type { MisconceptionRegistry } from "./debrief";
import type { AskSource } from "./imported";
import type { MasteryMap } from "./mastery";
import { HOME_RECORD_SEGMENTS, RECORD_FILES } from "./recordpaths";

export type NodeRequire = (m: string) => unknown;

const homeOf = (req: NodeRequire): string => (req("os") as { homedir(): string }).homedir();
const recordDir = (req: NodeRequire): string => [homeOf(req), ...HOME_RECORD_SEGMENTS].join("/");

/** The concepts in the agent record. Throws when there is no record or it can't be read. */
export function readAgentConcepts(req: NodeRequire): ConceptMap {
	const fs = req("fs") as { readFileSync(p: string, e: string): string };
	return JSON.parse(fs.readFileSync(`${recordDir(req)}/${RECORD_FILES.concepts}`, "utf8")) as ConceptMap;
}

/** Takes one project out of the agent record: its concepts, their schedule, and its share
 * of each misconception. The session notes stay, as history. Written the way grill-mcp
 * writes these files: a temp file, renamed. */
export function forgetAgentProject(req: NodeRequire, project: string): void {
	const fs = req("fs") as {
		existsSync(p: string): boolean;
		readFileSync(p: string, e: string): string;
		writeFileSync(p: string, d: string): void;
		renameSync(a: string, b: string): void;
	};
	const dir = recordDir(req);
	const inProject = (note: unknown): boolean => typeof note === "string" && (note === project || note.startsWith(`${project}/`));
	const edit = <T>(name: string, change: (data: T) => void): void => {
		const path = `${dir}/${name}`;
		if (!fs.existsSync(path)) return;
		const data = JSON.parse(fs.readFileSync(path, "utf8")) as T;
		change(data);
		fs.writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 1));
		fs.renameSync(`${path}.tmp`, path);
	};
	edit<ConceptMap>(RECORD_FILES.concepts, (d) => {
		for (const [id, c] of Object.entries(d)) if (inProject(c?.note)) delete d[id];
	});
	edit<MasteryMap>(RECORD_FILES.mastery, (d) => {
		for (const k of Object.keys(d)) if (inProject(k)) delete d[k];
	});
	edit<MisconceptionRegistry>(RECORD_FILES.registry, (d) => {
		for (const [tag, m] of Object.entries(d)) {
			m.notes = (m.notes ?? []).filter((n) => !inProject(n));
			if (!m.notes.length) delete d[tag];
		}
	});
}

/** How many conversations Claude Code and Codex keep on this computer. */
export function countAgentChats(req: NodeRequire): { claudeCode: number; codex: number } {
	const fs = req("fs") as { existsSync(p: string): boolean; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } };
	const home = homeOf(req);
	const count = (dir: string, deep: boolean): number => {
		if (!fs.existsSync(dir)) return 0;
		let n = 0;
		for (const f of fs.readdirSync(dir)) {
			const p = `${dir}/${f}`;
			if (f.endsWith(".jsonl")) n++;
			else if (deep && fs.statSync(p).isDirectory()) n += count(p, true);
		}
		return n;
	};
	const projects = `${home}/.claude/projects`;
	const claudeCode = fs.existsSync(projects) ? fs.readdirSync(projects).reduce((n, d) => n + count(`${projects}/${d}`, false), 0) : 0;
	return { claudeCode, codex: count(`${home}/.codex/sessions`, true) + count(`${home}/.codex/archived_sessions`, true) };
}

/** The text of every Claude Code and Codex conversation on this computer, or of one of
 * the two. A file that can't be read comes back empty. */
export async function readAgentChats(req: NodeRequire, only?: "claude-code" | "codex"): Promise<Array<{ source: AskSource; text: string }>> {
	type Entry = { name: string; isDirectory(): boolean };
	const fs = (req("fs") as { promises: { readdir(p: string, o: { withFileTypes: true }): Promise<Entry[]>; readFile(p: string, e: string): Promise<string> } }).promises;
	const home = homeOf(req);
	const files = async (dir: string, deep: boolean): Promise<string[]> => {
		try {
			const out: string[] = [];
			for (const e of await fs.readdir(dir, { withFileTypes: true })) {
				const p = `${dir}/${e.name}`;
				if (e.name.endsWith(".jsonl")) out.push(p);
				else if (deep && e.isDirectory()) out.push(...(await files(p, true)));
			}
			return out;
		} catch {
			return [];
		}
	};
	const out: Array<{ source: AskSource; text: string }> = [];
	if (only !== "codex") {
		const dirs = await fs.readdir(`${home}/.claude/projects`, { withFileTypes: true }).catch(() => [] as Entry[]);
		for (const dir of dirs.filter((e) => e.isDirectory())) {
			for (const f of await files(`${home}/.claude/projects/${dir.name}`, false)) {
				out.push({ source: "claude-code", text: await fs.readFile(f, "utf8").catch(() => "") });
			}
		}
	}
	if (only !== "claude-code") {
		for (const f of [...(await files(`${home}/.codex/sessions`, true)), ...(await files(`${home}/.codex/archived_sessions`, true))]) {
			out.push({ source: "codex", text: await fs.readFile(f, "utf8").catch(() => "") });
		}
	}
	return out;
}
