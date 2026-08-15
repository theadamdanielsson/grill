/** Read-aloud for the current question, via the browser's built-in speech synthesis
 * (Web Speech API) — no API key, no network call. Obsidian's desktop shell and mobile
 * webviews both expose `window.speechSynthesis`; where they don't, `ttsAvailable()` lets
 * callers skip rendering the button entirely rather than show a control that silently
 * does nothing.
 */

import { franc } from "franc-min";

function synth(): SpeechSynthesis | null {
	return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function ttsAvailable(): boolean {
	return synth() !== null;
}

/** franc-min (github.com/wooorm/franc) returns an ISO 639-3 code via trigram-frequency
 * statistics — trained on real corpora, not a hand-picked stopword list, so it doesn't
 * carry the false-positive/false-negative risk of one (a short list either misses real
 * sentences that avoid its exact words, or collides with common English words like
 * "con"/"mit"/"men" that happen to also be foreign function words). `SpeechSynthesisVoice.lang`
 * is BCP-47 (ISO 639-1, e.g. "it"), so franc's 639-3 result needs mapping down to that —
 * limited to the ~45 639-3 codes franc-min actually returns that have a distinct 639-1
 * form (the rest are minority languages with no dedicated code, and, in practice, no
 * installed system voice to match against anyway). */
const ISO_639_3_TO_1: Record<string, string> = {
	arb: "ar",
	azj: "az",
	bel: "be",
	bos: "bs",
	bul: "bg",
	ces: "cs",
	ckb: "ku",
	deu: "de",
	eng: "en",
	fra: "fr",
	hau: "ha",
	hin: "hi",
	hrv: "hr",
	hun: "hu",
	ibo: "ig",
	ind: "id",
	ita: "it",
	jav: "jv",
	kaz: "kk",
	kin: "rw",
	lin: "ln",
	mar: "mr",
	nld: "nl",
	npi: "ne",
	nya: "ny",
	pbu: "ps",
	pes: "fa",
	pol: "pl",
	por: "pt",
	ron: "ro",
	run: "rn",
	rus: "ru",
	som: "so",
	spa: "es",
	srp: "sr",
	sun: "su",
	swe: "sv",
	swh: "sw",
	tgl: "tl",
	tur: "tr",
	ukr: "uk",
	urd: "ur",
	uzn: "uz",
	vie: "vi",
	yor: "yo",
	zlm: "ms",
	zul: "zu",
};

/** franc needs a real sample to work with (its own default minimum is 10 characters;
 * below that, or with no confident match, it returns "und" — undetermined), so a bare
 * word or a number correctly yields null here rather than a guess. */
function detectLang(text: string): string | null {
	const code = franc(text, { minLength: 10 });
	return ISO_639_3_TO_1[code] ?? null;
}

/** Higher first: a "Premium"/"Enhanced"/"Neural"/"Natural" name is how macOS, Windows,
 * and Chrome's own OS-provided lists all flag a higher-quality voice over the compact
 * default every language ships with — there's no structured "quality" field on
 * SpeechSynthesisVoice, so the name is the only signal available. Absent that signal,
 * the OS/browser's own default is the best guess of "sensible" available — NOT "any
 * non-default voice": macOS in particular ships a pile of novelty system voices
 * (Zarvox, Trinoids, Bad News, Bubbles, Whisper, ...) that are all technically
 * non-default, and outscoring the real default with those was picking whichever one
 * happened to sort first. `localService` (on-device, no network round-trip) is a minor
 * tiebreaker only. */
function qualityScore(v: SpeechSynthesisVoice): number {
	let score = 0;
	if (/premium/i.test(v.name)) score += 3;
	else if (/enhanced|neural|natural/i.test(v.name)) score += 2;
	if (v.default) score += 1;
	if (v.localService) score += 1;
	return score;
}

/** All installed voices, best-quality first. Empty on a cold start until the browser
 * finishes loading its voice list — see `onVoicesChanged`. */
export function listVoices(): SpeechSynthesisVoice[] {
	return (synth()?.getVoices() ?? []).slice().sort((a, b) => qualityScore(b) - qualityScore(a));
}

/** Distinct languages among installed voices, for a settings dropdown — each with a
 * human-readable label ("Italian") derived from its own locale code, not hardcoded, so
 * it reads correctly for whatever voices happen to be installed. */
export function listLanguages(): { code: string; label: string }[] {
	const seen = new Map<string, string>();
	for (const v of listVoices()) {
		const code = v.lang.split(/[-_]/)[0].toLowerCase();
		if (!seen.has(code)) seen.set(code, v.lang);
	}
	let names: Intl.DisplayNames | null = null;
	try {
		names = new Intl.DisplayNames(["en"], { type: "language" });
	} catch {
		names = null;
	}
	return [...seen.entries()]
		.map(([code, lang]) => ({ code, label: names?.of(code) ?? lang }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** Installed voices for one language, best-quality first — for a settings dropdown
 * once a language is chosen. */
export function listVoicesForLang(langCode: string): SpeechSynthesisVoice[] {
	return listVoices().filter((v) => v.lang.toLowerCase().startsWith(langCode));
}

/** Fires once the browser's async voice list is actually populated (it's often empty
 * on the very first call). Callers needing a populated list before a first render — the
 * settings tab — should call this and re-render on fire; `speak` itself doesn't need it
 * since by the time a user is in a session the list has long since loaded. */
export function onVoicesChanged(cb: () => void): () => void {
	const s = synth();
	if (!s) return () => undefined;
	s.addEventListener("voiceschanged", cb);
	return () => s.removeEventListener("voiceschanged", cb);
}

export interface VoicePref {
	/** "" = auto-detect from the question text. An explicit code (e.g. "it") pins the
	 * language regardless of detection. */
	lang: string;
	/** "" = auto-pick the best-quality installed voice for the language. A specific
	 * voiceURI pins the exact voice, overriding `lang` entirely. */
	voiceURI: string;
}

export const AUTO_VOICE_PREF: VoicePref = { lang: "", voiceURI: "" };

/** Break `text` into runs of one apparent language each, so a question that embeds a
 * foreign phrase inside an instruction — "Translate: 'Vado al supermercato'", the
 * exact shape of a language-drill question — gets each part read in its own matching
 * voice instead of one language guess for the whole sentence. Splits on quoted spans
 * (almost always the embedded phrase in this kind of drill) and sentence boundaries,
 * merging adjacent runs that resolve to the same language so short or punctuation-only
 * fragments don't cause a voice flicker. A fragment with no detectable signal of its
 * own (a number, a bare word) inherits the question's overall language rather than
 * forcing a switch. */
function splitByLanguage(text: string): { text: string; lang: string | null }[] {
	const overall = detectLang(text);
	// No lookbehind (unsupported on iOS < 16.4, and Grill ships on mobile): split on the
	// sentence-ending punctuation itself rather than the zero-width point after it, which
	// peels it off into its own piece, then fold each punctuation-only piece back onto the
	// end of the previous one — same effective split as `(?<=[.!?])\s+` without the syntax.
	const rawParts = text
		.split(/("[^"]*"|'[^']*'|[.!?]\s+)/)
		.map((p) => p.trim())
		.filter(Boolean);
	const parts: string[] = [];
	for (const p of rawParts) {
		if (/^[.!?]+$/.test(p) && parts.length) parts[parts.length - 1] += p;
		else parts.push(p);
	}
	const runs: { text: string; lang: string | null }[] = [];
	for (const part of parts) {
		const lang = detectLang(part) ?? overall;
		const last = runs[runs.length - 1];
		if (last && last.lang === lang) last.text += " " + part;
		else runs.push({ text: part, lang });
	}
	return runs.length ? runs : [{ text, lang: overall }];
}

/** Speak `text`, cancelling anything already in flight — a re-click, or a fresh
 * question replacing an unfinished one, should replace the previous utterance, never
 * queue behind it. Resolves a voice per `pref` (see VoicePref): a pinned voiceURI is
 * used for the whole text verbatim (nothing left to detect); a pinned language is used
 * for every run (a deliberate override, not per-run detection); otherwise each run gets
 * its own detected language and best-quality matching voice, falling back to the system
 * default voice untouched wherever no match is installed. speechSynthesis plays queued
 * utterances back-to-back on its own, so multiple `speak()` calls here play in order
 * without needing to chain on `onend`. */
export function speak(text: string, pref: VoicePref = AUTO_VOICE_PREF): void {
	const s = synth();
	const clean = text.trim();
	if (!s || !clean) return;
	s.cancel();
	const runs = pref.voiceURI ? [{ text: clean, lang: null }] : splitByLanguage(clean);
	for (const run of runs) {
		const u = new SpeechSynthesisUtterance(run.text);
		let voice: SpeechSynthesisVoice | undefined;
		if (pref.voiceURI) {
			voice = listVoices().find((v) => v.voiceURI === pref.voiceURI);
		} else {
			const lang = pref.lang || run.lang || undefined;
			voice = lang ? listVoicesForLang(lang)[0] : undefined;
		}
		if (voice) {
			u.voice = voice;
			u.lang = voice.lang;
		}
		s.speak(u);
	}
}

export function stopSpeaking(): void {
	synth()?.cancel();
}

/** Strip the subset of markdown Grill's question text actually uses down to plain
 * speakable prose. Not a full markdown parser — good enough for TTS, not for display. */
export function toSpeechText(markdown: string): string {
	return markdown
		.replace(/`([^`]*)`/g, "$1") // inline code
		.replace(/!\[\[[^\]]*\]\]/g, "") // embeds (images, etc.) — nothing to read
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2") // aliased wikilink -> alias
		.replace(/\[\[([^\]]*)\]\]/g, "$1") // wikilink -> target
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
		.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
		.replace(/_{3,}/g, "blank") // fill-in-the-blank marker
		.replace(/\s+/g, " ")
		.trim();
}
