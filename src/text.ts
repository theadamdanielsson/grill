/** Surrogate-pair-safe string truncation.
 *
 * Every prompt-bound text field in this codebase gets hard-capped somewhere (a
 * note's context, a label, referenced-instructions text) — plain `String.slice`
 * truncates by UTF-16 code unit, which can split an astral character (anything
 * outside the Basic Multilingual Plane, e.g. the italic math variables PDF-extracted
 * worksheets are full of: 𝑌, 𝑃, 𝐺) into a lone surrogate. That's a valid JS string
 * but invalid once encoded to UTF-8 for an outgoing request body, and providers
 * reject the resulting bytes with an opaque "failed to parse JSON" error that gives
 * no hint the actual cause was a truncation boundary landing mid-character.
 *
 * The standard fix: `Array.from` (or the string iterator it uses) decomposes a
 * string by Unicode codepoint, not UTF-16 code unit, so it always keeps a surrogate
 * pair together as one element — unlike slice/substring/charAt.
 */

/** Truncate `s` to at most `max` Unicode characters (codepoints). `s.length` (a
 * code-unit count) is always >= the codepoint count, so it's a safe, cheap
 * pre-check that skips the decomposition for the common case of a string that
 * plainly doesn't need truncating. */
export function safeSlice(s: string, max: number): string {
	if (s.length <= max) return s;
	const chars = Array.from(s);
	return chars.length <= max ? s : chars.slice(0, max).join("");
}

/** Cheap deterministic hash (djb2) → base36. Used to notice a concept's source (or,
 * for embeddings.json, a note's own text) changed since it was last processed. */
export function hashStr(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}
