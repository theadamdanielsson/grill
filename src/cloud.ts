/** Grill Cloud: the hosted way to run Grill, for people who don't want to get an API
 * key. The plugin makes up a key on this device; the server knows an account only by
 * that key's hash, with a prepaid credit balance against it. No sign-up, no email.
 *
 * Notes studied this way are sent through Grill's server to the model, which they are
 * not in any other mode, so it is never on unless the user picks it.
 *
 * With `cloud.url` empty (a build without the hosted service) the provider isn't offered
 * anywhere and none of this runs.
 */

import { requestUrl } from "obsidian";

export interface CloudPack {
	credits: number;
	price: string;
	url: string;
	/** What's better about this pack, said on its button. */
	note?: string;
}

/** A typical session, in credits. Never shown: what a session costs depends on how
 * long the notes are, so no count of sessions is ever promised. It only decides when a
 * balance counts as low, until this vault has sessions of its own to go by. */
export const TYPICAL_SESSION = 12;

/** A balance in words. */
export function creditsInWords(credits: number): string {
	if (credits <= 0) return "No credits left";
	return `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"} left`;
}

/** What sessions cost, said from what this vault's own sessions have cost (credits
 * per session, oldest first), or what it depends on when there are none yet: no
 * figure, because sessions vary too much for one. A receipt, not a promise. */
export function usageInWords(history: number[]): string {
	if (!history.length) return "How many credits a session uses depends on how long your notes are and how much you ask for explanations or the natural voice.";
	const last = history[history.length - 1];
	return `Your last session used ${last} ${last === 1 ? "credit" : "credits"}.`;
}

/** The balance below which another session may not fit: what this vault's sessions
 * have cost at most lately, or a typical one. */
export function lowBalance(history: number[]): number {
	return history.length ? Math.max(...history) : TYPICAL_SESSION;
}

/** What a pack's button says. */
export function packLabel(pack: CloudPack): string {
	return `${pack.credits.toLocaleString("en-US")} credits for ${pack.price} + tax${pack.note ? ` (${pack.note})` : ""}`;
}

export const cloud = {
	/** The server's plugin route, e.g. https://grill.example.com/cloud */
	url: "https://grill.onbridger.com/cloud",
	/** The credit packs on sale, smallest first, each with its Stripe payment link
	 * (https://buy.stripe.com/...). A pack with no link isn't offered. */
	packs: [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/dRmeVdcYwh1fazHfaW0ZW02" },
		{ credits: 1100, price: "$9.99", url: "https://buy.stripe.com/bJefZh1fOcKZcHP0g20ZW00", note: "10% extra" },
	] as CloudPack[],
	/** Where the privacy policy and the terms live. */
	privacyUrl: "https://grill.onbridger.com/privacy",
	termsUrl: "https://grill.onbridger.com/terms",
	/** Called with the balance whenever the server mentions it. */
	onCredits: null as ((credits: number) => void) | null,
	/** Called with what a reply cost, in credits (fractions included). */
	onCost: null as ((credits: number) => void) | null,
};

/** Why pick it, in one line under its name: nothing to get, nothing to fill in. */
export const CLOUD_LEAD = "No API key. No sign-up. One click and you're studying.";

/** The three things to know before starting, said wherever Grill Cloud is offered. */
export const CLOUD_FACTS = [
	"AI writes your questions and grades your answers.",
	"Free credits to start, while each day's last. Then credit packs from $3.99 + tax.",
	"Your notes go through Grill's server to Claude. Grill's server doesn't store them.",
];

/** The whole of it, shown before anything is sent to anyone who asks what is. */
export const CLOUD_PITCH =
	"The notes in a session, the images in them, your answers and your custom instructions go through Grill's server to Anthropic's Claude, which writes the questions and grades. " +
	"So do short excerpts of notes it checks for missing links, and a summary of what you keep getting wrong, which it uses to adapt. " +
	"Grill's server doesn't store them. Anthropic keeps them for up to 30 days to watch for abuse and doesn't train on them. " +
	"Text you have read aloud goes through Grill's server to OpenAI, which makes the voice, unless you switch to your device's voice in settings. " +
	"Don't study notes this way that you wouldn't send to an online service. For ages 18 and over.";

export function cloudEnabled(): boolean {
	return cloud.url !== "";
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh key: 256 random bits. It is the only credential, so it's kept wherever
 * API keys are kept. */
export function newCloudKey(): string {
	return "grill_" + toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function isCloudKey(key: string): boolean {
	return /^grill_[0-9a-f]{64}$/.test(key);
}

/** The account id the server files this key under: its SHA-256. This, never the key,
 * is what goes in a checkout link. */
export async function cloudAccount(key: string): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))));
}

/** Link to buy one pack for this key's account. */
export async function cloudCheckoutUrl(key: string, packUrl: string): Promise<string> {
	const joiner = packUrl.includes("?") ? "&" : "?";
	return `${packUrl}${joiner}client_reference_id=${await cloudAccount(key)}`;
}

/** What the server said, or that it couldn't be reached at all. The two are different
 * things to tell a user: "check your connection" is only true of the second. */
export type CloudReply<T> = { ok: true; data: T } | { ok: false; offline: boolean; status: number; message: string };

async function ask<T>(key: string, method: string, path: string): Promise<CloudReply<T>> {
	try {
		const r = await Promise.race([
			requestUrl({
				url: `${cloud.url.replace(/\/$/, "")}${path}`,
				method,
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: method === "POST" ? "{}" : undefined,
				throw: false,
			}),
			new Promise<never>((_, no) => window.setTimeout(() => no(new Error("timeout")), 20_000)),
		]);
		let json: unknown = null;
		try {
			json = r.json;
		} catch {
			json = null;
		}
		if (r.status === 200 && json && typeof json === "object") return { ok: true, data: json as T };
		const said = (json as { error?: { message?: unknown } } | null)?.error?.message;
		return { ok: false, offline: false, status: r.status, message: typeof said === "string" ? said : `Grill Cloud answered with an error (${r.status}).` };
	} catch {
		return { ok: false, offline: true, status: 0, message: "Couldn't reach Grill Cloud. Check your connection and try again." };
	}
}

export interface CloudBalance {
	credits: number;
	/** Whether the server has an account for this key at all. */
	account: boolean;
	/** How many purchases have been credited to it. A purchase arriving is this number
	 * going up, which nothing else changes. */
	purchases: number;
	/** Whether credits can be bought right now. */
	sales: boolean;
	/** Whether a natural read-aloud voice can be asked for. */
	speech?: boolean;
}

/** The balance. Asks nothing of the server but to look. */
export function cloudBalance(key: string): Promise<CloudReply<CloudBalance>> {
	return ask<CloudBalance>(key, "GET", "/balance");
}

/** Open the account for a key, with the free starter if one is available. Only the
 * Start free button calls this. */
export function cloudStart(key: string): Promise<CloudReply<{ credits: number; granted: boolean; starters: boolean }>> {
	return ask(key, "POST", "/start");
}

/** Erase this key's account on the server. */
export function cloudDelete(key: string): Promise<CloudReply<{ deleted: boolean }>> {
	return ask(key, "DELETE", "/account");
}

/** Read text aloud in a natural voice: the audio (MP3), or why not. The text goes
 * through Grill's server to the speech provider; neither keeps it. */
export async function cloudSpeech(key: string, text: string): Promise<CloudReply<ArrayBuffer>> {
	try {
		const r = await Promise.race([
			requestUrl({
				url: `${cloud.url.replace(/\/$/, "")}/speech`,
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify({ text }),
				throw: false,
			}),
			new Promise<never>((_, no) => window.setTimeout(() => no(new Error("timeout")), 45_000)),
		]);
		heardFromCloud(r.headers);
		if (r.status === 200 && r.arrayBuffer && r.arrayBuffer.byteLength > 0) return { ok: true, data: r.arrayBuffer };
		let said: unknown;
		try {
			said = (r.json as { error?: { message?: unknown } } | null)?.error?.message;
		} catch {
			said = undefined;
		}
		return { ok: false, offline: false, status: r.status, message: typeof said === "string" ? said : `Grill Cloud answered with an error (${r.status}).` };
	} catch {
		return { ok: false, offline: true, status: 0, message: "Couldn't reach Grill Cloud. Check your connection and try again." };
	}
}

/** Every model reply carries the balance it left; pick it up, so the number shown
 * never needs its own request. */
export function heardFromCloud(headers: Record<string, string> | undefined): void {
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() === "x-grill-credits" && /^\d+$/.test(value)) cloud.onCredits?.(Number(value));
		if (name.toLowerCase() === "x-grill-cost" && /^\d+(\.\d+)?$/.test(value)) cloud.onCost?.(Number(value));
	}
}
