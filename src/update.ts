/**
 * Whether a newer Grill is out. Obsidian doesn't install plugin updates by itself, so
 * most people stay on the version they first installed. Once a day Grill asks GitHub
 * for its latest release, sending nothing but the request itself, and the home screen
 * says so in one line when there is a newer one.
 */
import { requestUrl } from "obsidian";

export const LATEST_RELEASE = "https://api.github.com/repos/theadamdanielsson/grill/releases/latest";
/** Where Update goes: Grill's page in Obsidian's community plugins, with its Update button. */
export const PLUGIN_PAGE = "obsidian://show-plugin?id=grill";
/** How long an answer is trusted before GitHub is asked again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Whether version `a` is newer than `b`, both as x.y.z. Anything else is never newer. */
export function isNewer(a: string, b: string): boolean {
	const parse = (v: string): number[] | null => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
}

/** The latest release's version, or null when GitHub can't be reached or says
 * something unexpected. */
export async function latestVersion(): Promise<string | null> {
	try {
		const r = await requestUrl({ url: LATEST_RELEASE, headers: { Accept: "application/vnd.github+json" }, throw: false });
		if (r.status !== 200) return null;
		const tag: unknown = (r.json as { tag_name?: unknown } | null)?.tag_name;
		if (typeof tag !== "string") return null;
		const v = tag.replace(/^v/, "");
		return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
	} catch {
		return null;
	}
}
