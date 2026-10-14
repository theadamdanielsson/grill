/**
 * opencode (github.com/anomalyco/opencode, MIT) as an engine for Chat, through the
 * Agent Client Protocol (acp.ts).
 *
 * opencode runs on whatever model it is given: its own free models with no sign-in,
 * Ollama on this computer, or an account signed in with `opencode auth login`. Grill
 * can install it: one pinned build, fetched from npm, where opencode publishes it, and
 * checked against the checksum written here before it is unpacked. It goes into a
 * folder of Grill's own outside the vault, so it is not synced.
 *
 * What it may do, and when it must ask, is opencode's own configuration. Grill passes
 * the level as configuration on top of the user's own (OPENCODE_CONFIG_CONTENT), so
 * the level wins for those rules and everything else is theirs.
 */
import { requestUrl } from "obsidian";
import type { AgentLevel } from "./agent";
import type { AcpProgram } from "./acp";

/** The build Grill installs and has been tried with. */
export const OPENCODE_VERSION = "2.0.22";

/** npm's checksum for each build, as published for this version. */
const BUILDS: Record<string, { integrity: string; mb: number }> = {
	"darwin-arm64": { integrity: "sha512-NNg1VCCTWSfLlNKpRb4RA6IE7H67ZBLBYmfIWjP3CxR9NPtdROQFCL8lpPf+Tz2Qje4Bb27sQOLWanYyNT/9dQ==", mb: 78 },
	"darwin-x64": { integrity: "sha512-R/o6HCCHdcDlmXSqveuYBBTB3mrGjMvG4H2AO3PpUJ2X1VEaHhei0BQ0nckGjJh6JXe7J/zJZqpxuBsVJbHfOw==", mb: 82 },
	"linux-x64": { integrity: "sha512-DlV1qgEDDnVqpTWMPqv7tCHCcXodzZBFaMcxjsiYdY6E5gHH2Q68JfasVksyQ1nu6m1887WQKGhOsepE+oKyYw==", mb: 85 },
	"linux-arm64": { integrity: "sha512-t/yuu9Dqd/M44dFH95bphu7ikO6FATMQuVk/91QBnCMzsP8zVrXU7zAxD1wVLpYYUDqIonEmi80XETlFqx7chw==", mb: 84 },
	"windows-x64": { integrity: "sha512-n7eg3FwlHtRSZY5SV00XYh5c/TV7V0GIDqgygv9c5UEzPfbBfdk6d9mvGbZqn/Po/gmOPFyxU6SjmjWdGDF3ag==", mb: 86 },
	"windows-arm64": { integrity: "sha512-eVGgsYQmMPpb6Be28yFjgQiMXSojxypQ949xHbKH0Gg7rhv4hMxeBkOik4gb0jW/NqEZhRBQwHPKuMEGOhBgSw==", mb: 82 },
};

/** The name npm gives this computer's build, or null when there isn't one. */
export function buildFor(platform: string, arch: string): string | null {
	const os = platform === "win32" ? "windows" : platform;
	const key = `${os}-${arch}`;
	return key in BUILDS ? key : null;
}

/** How big the download is, in MB, for saying so before it starts. */
export function downloadSize(platform: string, arch: string): number | null {
	const b = buildFor(platform, arch);
	return b ? BUILDS[b].mb : null;
}

/** opencode's permission rules for each of Grill's levels. Safe: asks before changing
 * a note, running a command or going on the web. Plan: the same, and the session is put
 * in opencode's own read-only mode. Auto: edits without asking, still asks before a
 * command or the web. Its own updater is off: Grill keeps the build it has tried. */
export function opencodeConfig(level: AgentLevel): string {
	const edit = level === "auto" ? "allow" : "ask";
	return JSON.stringify({ autoupdate: false, permission: { edit, bash: "ask", webfetch: "ask", external_directory: "ask" } });
}

/** How to start opencode as an agent for a level. */
export function opencodeProgram(program: string, level: AgentLevel): AcpProgram {
	return { program, args: ["acp"], env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(level) } };
}

type Need = (name: string) => unknown;
const need = (): Need | null => (window as unknown as { require?: Need }).require ?? null;

/** Where Grill keeps the build it installs. */
export function installDir(home: string, platform: string): string {
	const slash = platform === "win32" ? "\\" : "/";
	return [home, ".grill", "opencode", OPENCODE_VERSION].join(slash);
}

const exe = (platform: string): string => (platform === "win32" ? "opencode.exe" : "opencode");

/** Where opencode usually is, most likely first: Grill's own install, then the
 * installer's and package managers' places. */
export function opencodePlaces(home: string, platform: string, env: Record<string, string | undefined>): string[] {
	const own = `${installDir(home, platform)}${platform === "win32" ? "\\" : "/"}${exe(platform)}`;
	if (platform === "win32") {
		const app = env.APPDATA ?? `${home}\\AppData\\Roaming`;
		return [own, `${home}\\.opencode\\bin\\opencode.exe`, `${app}\\npm\\opencode.cmd`];
	}
	return [
		own,
		`${home}/.opencode/bin/opencode`,
		"/opt/homebrew/bin/opencode",
		"/usr/local/bin/opencode",
		`${home}/.local/bin/opencode`,
		`${home}/.npm-global/bin/opencode`,
		`${home}/.bun/bin/opencode`,
		"/usr/bin/opencode",
	];
}

/** The installed opencode: the path set in settings if it is there, else the first
 * usual place that has one. Null on a phone, or when it isn't installed. */
export function findOpencode(setPath: string): string | null {
	try {
		const req = need();
		if (!req) return null;
		const fs = req("fs") as { existsSync(p: string): boolean };
		const os = req("os") as { homedir(): string };
		const proc = req("process") as { platform: string; env: Record<string, string | undefined> };
		const wanted = setPath.trim();
		if (wanted) return fs.existsSync(wanted) ? wanted : null;
		return opencodePlaces(os.homedir(), proc.platform, proc.env).find((p) => fs.existsSync(p)) ?? null;
	} catch {
		return null;
	}
}

/** Whether this computer can have opencode installed by Grill. */
export function canInstall(): boolean {
	try {
		const req = need();
		if (!req) return false;
		const proc = req("process") as { platform: string; arch: string };
		return buildFor(proc.platform, proc.arch) !== null;
	} catch {
		return false;
	}
}

/** The one file a tar archive holds under `name`, or null. Enough of the format for
 * npm's packages: plain files, and the long-name records npm does not use for these. */
export function fileInTar(tar: Uint8Array, names: string[]): Uint8Array | null {
	const ascii = (from: number, len: number): string => {
		let s = "";
		for (let i = from; i < from + len && tar[i] !== 0; i++) s += String.fromCharCode(tar[i]);
		return s;
	};
	let at = 0;
	while (at + 512 <= tar.length) {
		const name = ascii(at, 100);
		if (!name) break;
		const prefix = ascii(at + 345, 155);
		const full = prefix ? `${prefix}/${name}` : name;
		const size = parseInt(ascii(at + 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(tar[at + 156] || 48);
		const body = at + 512;
		if ((type === "0" || type === "\0") && names.includes(full)) return tar.subarray(body, body + size);
		at = body + Math.ceil(size / 512) * 512;
	}
	return null;
}

/** Download, check and unpack the pinned build. Returns where the program now is.
 * Throws with a sentence fit to show. */
export async function installOpencode(): Promise<string> {
	const req = need();
	if (!req) throw new Error("opencode can only be installed on desktop.");
	const proc = req("process") as { platform: string; arch: string };
	const os = req("os") as { homedir(): string };
	const fs = req("fs") as {
		mkdirSync(p: string, o: { recursive: boolean }): void;
		writeFileSync(p: string, d: Uint8Array, o?: { mode: number }): void;
		renameSync(a: string, b: string): void;
		chmodSync(p: string, mode: number): void;
	};
	const crypto = req("crypto") as { createHash(alg: string): { update(d: Uint8Array): { digest(enc: string): string } } };
	const zlib = req("zlib") as { gunzipSync(d: Uint8Array): Uint8Array };
	const build = buildFor(proc.platform, proc.arch);
	if (!build) throw new Error("There is no opencode build for this computer.");
	const name = `cli-${build}`;
	const url = `https://registry.npmjs.org/@opencode/${name}/-/${name}-${OPENCODE_VERSION}.tgz`;
	let data: Uint8Array;
	try {
		const resp = await requestUrl({ url, method: "GET", throw: false });
		if (resp.status !== 200) throw new Error(String(resp.status));
		data = new Uint8Array(resp.arrayBuffer);
	} catch {
		throw new Error("opencode could not be downloaded. Check the connection and try again.");
	}
	const sum = `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`;
	if (sum !== BUILDS[build].integrity) throw new Error("The download did not match opencode's published checksum, so it was not installed.");
	const file = fileInTar(zlib.gunzipSync(data), [`package/bin/${exe(proc.platform)}`]);
	if (!file) throw new Error("The opencode download did not contain the program.");
	const dir = installDir(os.homedir(), proc.platform);
	const target = `${dir}${proc.platform === "win32" ? "\\" : "/"}${exe(proc.platform)}`;
	fs.mkdirSync(dir, { recursive: true });
	// Written beside it and moved into place, so a half-written program is never found.
	fs.writeFileSync(`${target}.part`, file, { mode: 0o755 });
	fs.renameSync(`${target}.part`, target);
	if (proc.platform !== "win32") fs.chmodSync(target, 0o755);
	return target;
}

/** Remove Grill's install. Only Grill's own folder is touched. */
export function uninstallOpencode(): void {
	const req = need();
	if (!req) return;
	const proc = req("process") as { platform: string };
	const os = req("os") as { homedir(): string };
	const fs = req("fs") as { rmSync(p: string, o: { recursive: boolean; force: boolean }): void };
	fs.rmSync(installDir(os.homedir(), proc.platform), { recursive: true, force: true });
}

/** Whether `program` is the copy Grill installed (and so Grill may remove it). */
export function isGrillInstall(program: string): boolean {
	return /[\\/]\.grill[\\/]opencode[\\/]/.test(program);
}
