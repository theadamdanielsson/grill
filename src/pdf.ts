/** Extract text from PDFs a note embeds, so a `![[worksheet.pdf]]` isn't invisible
 * to Grill the way it is to a plain text reader — the PDF's real content becomes
 * part of the note's text, feeding the same structural parser and AI prompt as
 * anything typed directly into the note. A bonus feature: any failure (a corrupt
 * or password-protected PDF, an unresolvable embed) is swallowed per-file so it
 * never breaks a session — the note just falls back to whatever text it already had.
 *
 * Reads via Obsidian's own `loadPdfJs()` (docs.obsidian.md/Reference/TypeScript+API/
 * loadPdfJs) — the same pdf.js instance its native PDF viewer uses, lazy-loaded and
 * fully worker/cmap/font-configured by Obsidian itself. No bundled pdfjs-dist copy,
 * no worker to inline: this plugin never ships pdf.js at all. Precedent: PDF++
 * (github.com/RyotaUshio/obsidian-pdf-plus) reads Obsidian's copy the same way. */

import { App, loadPdfJs, TFile } from "obsidian";

/** Obsidian types `loadPdfJs()` as `Promise<any>` (it just re-exports pdf.js's own
 * lazily-loaded module verbatim). This is the minimal slice of pdf.js's real API
 * this file touches, declared once so the `any` is contained to a single cast at
 * the loadPdfJs() call site instead of leaking untyped through every line below. */
interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
}
interface PdfTextContent {
	items: PdfTextItem[];
}
interface PdfPageProxy {
	getTextContent(): Promise<PdfTextContent>;
}
interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
}
interface PdfJsLib {
	getDocument(params: { data: Uint8Array; cMapPacked: boolean; cMapUrl: string; standardFontDataUrl: string }): {
		promise: Promise<PdfDocumentProxy>;
	};
}

/** Ceiling on pages read per PDF — a safety valve against someone embedding an
 * entire textbook, not a token-budget cap (that's NOTE_CHAR_CAP in view.ts, applied
 * uniformly to a note's combined text after this runs). Parsing is local/CPU-only,
 * so this is generous. */
const MAX_PAGES_PER_PDF = 40;
/** A note embedding more than a couple of PDFs is rare and each one is a real
 * parse cost; bound it defensively. */
const MAX_PDFS_PER_NOTE = 2;

/** One PDF's extracted text, memoized against the exact file state it was read
 * from. `mtime`/`size` (not a content hash) are the cheap, already-available
 * TFile.stat fields Obsidian keeps current without us reading the file —
 * good enough to detect "this file changed since we last parsed it" without
 * hashing multi-MB PDFs on every session start just to find out nothing moved. */
export interface PdfCacheEntry {
	mtime: number;
	size: number;
	text: string;
	/** Extraction pipeline version the text was produced by. An entry from an older
	 * pipeline (or with no version at all) is a miss, so a change to extraction —
	 * like stripPdfBoilerplate — reaches PDFs that were already cached. */
	v?: number;
}

/** Bump whenever extractPdfText's output changes for the same bytes. */
const PDF_EXTRACT_VERSION = 2;

/** Exam-paper administration, not course content: time limits, what's allowed in the
 * room, misconduct rules, how to fill in the answer sheet. Each pattern is one signal.
 * STRONG signals only appear on an exam's front page; the rest also turn up in normal
 * course material ("phones", "minutes"), so they only count alongside a strong one. */
const STRONG_SIGNALS: RegExp[] = [
	// A time allowance for the paper itself: "Time allowed: 2 hours", "the time limit
	// is: 25 minutes". Seconds never count (a programming problem's "time limit").
	/\btime (allowed|limit)\b(\s+(is|of))?\s*:?\s*\d+\s*(minutes|mins|hours|hrs)\b|\byou (will )?have \d+\s*(minutes|mins|hours) to (complete|answer|finish)\b/i,
	/\binstructions (to|for) (candidates|students)\b/i,
	/\b(airplane|aeroplane|flight) mode\b/i,
	/\bdo not (turn|open) (over |this |the )?(page|paper|booklet)\b/i,
	/\b(answer all( the)? questions|attempt all questions)\b/i,
];
const WEAK_SIGNALS: RegExp[] = [
	/\b(calculators?|laptops?|mobile phones?|phones?|smart ?watch(es)?|electronic devices?|wi-?fi)\b/i,
	/\b(not )?(allowed|permitted) to (use|bring|have)\b|\bclosed[- ]book\b|\bopen[- ]book\b/i,
	/\b(misconduct|disciplinary|cheating|academic (integrity|dishonesty)|fail the exam)\b/i,
	/\bcross(ed)? (it )?out\b|\bchange your mind\b|\bmarked as (an )?(erroneous|incorrect|wrong)\b/i,
	/\b(fill in|transfer) (the |your )?(correct )?answers?\b|\banswer (sheet|box|grid)\b/i,
	/\bwrite your (full )?(name|student (number|id))\b/i,
	/\b(exam|test|paper) contains\b|\beach question (carries|is worth)\b|\b\d+ points\b.*\b(distributed|exercises|questions)\b/i,
];

/** Where the actual questions start: "Question 1", "Problem 2", "Exercise 1.3", "Task 1". */
const CONTENT_START = /^\s*(question|problem|exercise|task)\s*\d+/im;

/** Drop an exam paper's administrative front matter (time limit, laptop rules, how to
 * correct an answer) so it isn't quizzed as study material. Conservative by design:
 * only page 1, only the part before a "Question 1"-style marker, only when that part
 * carries a strong exam signal plus at least two other distinct signals — and even
 * then it drops only the SENTENCES carrying a signal, so a case study or data table
 * printed before the questions stays. Pure, so it's tested directly. */
export function stripPdfBoilerplate(pages: string[]): string[] {
	if (!pages.length) return pages;
	const page = pages[0];
	const m = CONTENT_START.exec(page);
	const head = m ? page.slice(0, m.index) : page;
	const tail = m ? page.slice(m.index) : "";
	// Units: each line on its own (titles, table rows), except that a lowercase line
	// continuing an unfinished sentence joins the one before it (a wrapped rule stays
	// whole); then each unit is split at sentence ends.
	const units: string[] = [];
	for (const line of head.split("\n")) {
		const prev = units[units.length - 1];
		if (prev !== undefined && !/[.!?:]\s*$/.test(prev) && /^\s*[a-z(]/.test(line)) units[units.length - 1] = `${prev}\n${line}`;
		else units.push(line);
	}
	const sentences = units.flatMap((u) => u.split(/(?<=[.!?])[ \t]+/));
	const kinds = new Set<string>();
	let strong = false;
	const flagged = sentences.map((sentence) => {
		let hit = false;
		STRONG_SIGNALS.forEach((re, k) => {
			if (re.test(sentence)) {
				kinds.add(`s${k}`);
				strong = hit = true;
			}
		});
		WEAK_SIGNALS.forEach((re, k) => {
			if (re.test(sentence)) {
				kinds.add(`w${k}`);
				hit = true;
			}
		});
		return hit;
	});
	if (!strong || kinds.size < 3) return pages;
	const kept = sentences
		.filter((_, i) => !flagged[i])
		.join("\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
	const first = [kept, tail].filter((x) => x.trim()).join("\n");
	return first ? [first, ...pages.slice(1)] : pages.slice(1);
}

/** Keyed by vault path. Persisted by the caller (see GrillStore.loadPdfCache /
 * savePdfCache) — this module only reads and mutates the map handed to it. */
export type PdfCacheMap = Record<string, PdfCacheEntry>;

async function extractPdfText(bytes: ArrayBuffer, label: string): Promise<string> {
	try {
		const pdfjsLib = (await loadPdfJs()) as PdfJsLib;
		const doc = await pdfjsLib.getDocument({
			data: new Uint8Array(bytes),
			cMapPacked: true,
			cMapUrl: "/lib/pdfjs/cmaps/",
			standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
		}).promise;
		const pages: string[] = [];
		const pageCount = Math.min(doc.numPages, MAX_PAGES_PER_PDF);
		for (let i = 1; i <= pageCount; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			// hasEOL is pdf.js's own line-break signal from the PDF's layout — joining on
			// it recovers real paragraph/line structure (so downstream chunking can find
			// a sane per-chunk label) instead of flattening a whole page into one line.
			const text = content.items
				.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
				.join("")
				.trim();
			if (text) pages.push(text);
		}
		const content = stripPdfBoilerplate(pages);
		// An HTML comment, not a plain line: extractConcepts already strips comments
		// before parsing (same convention itemsForNote uses), so this attribution stays
		// readable in the raw text but can never get picked up as a chunk's label the
		// way a plain leading line would.
		return content.length ? `<!-- From the PDF "${label}" -->\n\n${content.join("\n\n")}` : "";
	} catch (e) {
		console.error(`Grill: couldn't extract text from PDF "${label}"`, e);
		return ""; // corrupt, encrypted, or unparseable; the note falls back to its own text
	}
}

/** Cache-aware single-PDF extraction: reuses `cache[dest.path]` verbatim when
 * the file's mtime/size haven't moved since it was last parsed, so a worksheet
 * embedded in ten different notes (or the same note opened every session) only
 * ever costs one real pdf.js parse until the file actually changes. Mutates
 * `cache` in place on a miss; the caller owns persisting it (see
 * GrillStore.loadPdfCache/savePdfCache) so a batch of lookups across one
 * session-start scan writes to disk once, not once per file. */
export async function extractPdfTextCached(app: App, dest: TFile, cache: PdfCacheMap): Promise<string> {
	const hit = cache[dest.path];
	if (hit && hit.v === PDF_EXTRACT_VERSION && hit.mtime === dest.stat.mtime && hit.size === dest.stat.size)
		return hit.text;
	const bytes = await app.vault.readBinary(dest);
	const text = await extractPdfText(bytes, dest.basename);
	cache[dest.path] = { mtime: dest.stat.mtime, size: dest.stat.size, text, v: PDF_EXTRACT_VERSION };
	return text;
}

/** Does this note embed a PDF at all? Metadata-only — resolves link destinations but
 * never opens or parses a file, so it's cheap enough to run over many notes on a render.
 * Mirrors `hasEmbeddedImage` in images.ts: it answers "is there material here Grill could
 * work with", which is a different and much cheaper question than "what is that material",
 * and is what the home screen needs to decide whether a note is quizzable at all. */
export function hasEmbeddedPdf(app: App, file: TFile): boolean {
	for (const e of app.metadataCache.getFileCache(file)?.embeds ?? []) {
		const dest = app.metadataCache.getFirstLinkpathDest(e.link, file.path);
		if (dest && dest.extension.toLowerCase() === "pdf") return true;
	}
	return false;
}

/** Text extracted from the PDFs a note embeds, concatenated, or "" if it embeds
 * none (or none could be read). Meant to be appended to the note's own markdown
 * text before that combined text goes through extraction/truncation, so PDF
 * content is genuinely just more text to Grill, not a separate special case. */
export async function collectNotePdfText(app: App, file: TFile, cache: PdfCacheMap): Promise<string> {
	const embeds = app.metadataCache.getFileCache(file)?.embeds ?? [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const e of embeds) {
		// Bound on distinct PDFs ATTEMPTED, not merely ones that parsed successfully —
		// `seen` grows the moment we commit to trying one, before we know if it'll fail
		// (corrupt/encrypted/scanned-image-only), so a run of failures can't make the
		// cap a no-op and blow through the parse-cost budget it exists to bound.
		if (seen.size >= MAX_PDFS_PER_NOTE) break;
		const dest = app.metadataCache.getFirstLinkpathDest(e.link, file.path);
		if (!dest || dest.extension.toLowerCase() !== "pdf" || seen.has(dest.path)) continue;
		seen.add(dest.path);
		try {
			const text = await extractPdfTextCached(app, dest, cache);
			if (text) out.push(text);
		} catch (e) {
			console.error(`Grill: couldn't read PDF attachment "${dest.basename}"`, e);
		}
	}
	return out.join("\n\n");
}

/** A note's full study text: its own markdown plus the text of any PDFs it embeds.
 * The one definition both a session start and the on-edit concept refresh use, so the
 * two can never disagree about which concepts a note has (they did: the refresh read
 * markdown only and orphaned every PDF-derived concept on each edit). */
export async function noteStudyText(app: App, file: TFile, cache: PdfCacheMap): Promise<string> {
	const raw = await app.vault.cachedRead(file);
	const pdfText = await collectNotePdfText(app, file, cache);
	return pdfText ? `${raw}\n\n${pdfText}` : raw;
}
