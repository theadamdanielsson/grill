/**
 * The web for Chat on Grill Cloud and a key of one's own: `fetch_url` reads a page, on
 * any provider; searching is the provider's own (see stream.ts's `webSearch`).
 */
import { requestUrl } from "obsidian";
import type { ToolCall, ToolSpec } from "./stream";

const PAGE_CHARS = 40_000;

export const FETCH_TOOL: ToolSpec = {
	name: "fetch_url",
	description: "Read a web page by its address (http or https), as plain text. For a page the user names or one a search turned up.",
	input: {
		type: "object",
		properties: { url: { type: "string", description: "The full address, starting with https:// or http://." } },
		required: ["url"],
		additionalProperties: false,
	},
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A page's words: scripts, styles and markup gone, blocks on lines of their own. */
export function pageText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") {
				const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		})
		.replace(/[ \t\f\v\r]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** This computer and the local network: services there (a note server, a router) are
 * not the web, and a page must not be able to send the model to them. Checked on the
 * address as written: a name that resolves to such an address, or a page that redirects
 * to one, is not caught, since Obsidian's request does not say where it went. */
export function privateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::" || h === "::1") return true;
	if (/^(fc|fd|fe80)/.test(h) && h.includes(":")) return true;
	// An IPv4 address written as IPv6 (::ffff:7f00:1 is 127.0.0.1).
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
	if (mapped) {
		const hi = parseInt(mapped[1], 16);
		const lo = parseInt(mapped[2], 16);
		return privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(h)) return privateHost(h.slice(7));
	const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
	if (!ip) return false;
	const [a, b] = [Number(ip[1]), Number(ip[2])];
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export const fetchedUrl = (call: ToolCall): string => (typeof call.input.url === "string" ? call.input.url.trim() : "");

/** Do what `fetch_url` asks. */
export async function fetchPage(url: string): Promise<{ content: string; failed?: boolean }> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { content: "That isn't a web address.", failed: true };
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return { content: "Only http and https addresses can be read.", failed: true };
	if (privateHost(u.hostname)) return { content: "Addresses on this computer or its local network are not read.", failed: true };
	try {
		const r = await requestUrl({ url: u.toString(), method: "GET", headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, throw: false });
		if (r.status >= 400) return { content: `The page answered with status ${r.status}.`, failed: true };
		const type = (r.headers["content-type"] ?? r.headers["Content-Type"] ?? "").toLowerCase();
		if (type && !/text|json|xml|javascript/.test(type)) return { content: `That address is not a page of text (${type}).`, failed: true };
		const text = /html|xml/.test(type) || /^\s*</.test(r.text) ? pageText(r.text) : r.text;
		return { content: `${u.toString()}\n\n${text.length > PAGE_CHARS ? `${text.slice(0, PAGE_CHARS)}\n\n[Cut short: ${text.length - PAGE_CHARS} more characters.]` : text}` };
	} catch (e) {
		return { content: `The page could not be read: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`, failed: true };
	}
}
