/** The agent programs Chat can run on instead of a model: Claude Code, Codex and
 * opencode. What differs between them, short of a chat turn's own wiring, is here, so
 * the screens and the plugin ask the engine instead of naming each one. */

import { findProgram } from "./agent";
import { claudeJSON, codexJSON, opencodeJSON, type AgentJSONRun } from "./agentjson";
import { findCodex } from "./codex";
import { findOpencode } from "./opencode";

export type EngineId = "claudecode" | "codex" | "opencode";

/** The settings the engines read. */
export interface EngineSettings {
	claudePath: string;
	claudeModel: string;
	codexPath: string;
	codexModel: string;
	opencodePath: string;
	opencodeModel: string;
}

export interface Engine {
	id: EngineId;
	name: string;
	/** Where it is installed, preferring the place set in settings; null when it isn't. */
	find(s: EngineSettings): string | null;
	/** The setting that holds its model, by the program's own id ("" leaves it to it). */
	modelSetting: "claudeModel" | "codexModel" | "opencodeModel";
	/** Whether pictures sent with a request reach it. */
	readsImages: boolean;
	/** One JSON answer, standing in for a model call. */
	json(run: AgentJSONRun): Promise<unknown>;
}

export const ENGINES: Record<EngineId, Engine> = {
	claudecode: { id: "claudecode", name: "Claude Code", find: (s) => findProgram(s.claudePath), modelSetting: "claudeModel", readsImages: true, json: (run) => claudeJSON(run) },
	codex: { id: "codex", name: "Codex", find: (s) => findCodex(s.codexPath), modelSetting: "codexModel", readsImages: true, json: codexJSON },
	opencode: { id: "opencode", name: "opencode", find: (s) => findOpencode(s.opencodePath), modelSetting: "opencodeModel", readsImages: false, json: opencodeJSON },
};

/** In the order they are offered and looked for. */
export const ENGINE_IDS: EngineId[] = ["claudecode", "codex", "opencode"];

/** The engine a `chatEngine` setting names, or null for "model". */
export function engineFor(chatEngine: string): Engine | null {
	return (ENGINES as Record<string, Engine>)[chatEngine] ?? null;
}
