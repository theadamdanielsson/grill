/** The scan at the start of a session: each reference document and each picked note is
 * read, its concepts extracted, its text cut to what fits a prompt, and its pictures
 * collected. Returns what it found; it keeps no state of its own. */

import { type App, Platform, type TFile } from "obsidian";
import { type Concept, type ConceptExtractionCacheMap, extractConceptsCached } from "./generate-local";
import { collectNoteImages, hasEmbeddedImage, type ImageInput } from "./images";
import { extractPdfTextCached, noteStudyText, type PdfCacheMap } from "./pdf";
import { mapWithConcurrency } from "./text";

/** How many reference documents / notes are scanned at once (see mapWithConcurrency
 * in text.ts). These reads/parses are independent of each other, so serializing them
 * one at a time paid N round-trips of latency for nothing; this just bounds how many are
 * in flight so a huge reference library doesn't open hundreds of files simultaneously. */
export const SCAN_CONCURRENCY = 8;

export interface ScanInput {
	/** The notes picked for the session, by basename. */
	names: string[];
	byName: ReadonlyMap<string, TFile>;
	/** The reference documents uploaded in Instructions.md. */
	refDocs: TFile[];
	pdfCache: PdfCacheMap;
	conceptCache: ConceptExtractionCacheMap;
	formatMode: Parameters<typeof extractConceptsCached>[2];
	/** The prompt context for a text too long to send whole. */
	selectContext(text: string, concepts: Concept[]): Promise<string>;
	/** Text longer than this is cut down by `selectContext`. */
	charCap: number;
	/** The model reads images. */
	vision: boolean;
	/** Image occlusion is on, and can run here. */
	occlusion: boolean;
	imagesPerNote: number;
}

export interface ScanResult {
	/** Each note's and document's concepts, reference documents first. */
	conceptsByNote: Map<string, Concept[]>;
	noteText: Record<string, string>;
	noteImages: Record<string, ImageInput[]>;
	/** Notes with image embeds that couldn't be sent. */
	notesWithUnsentImages: Set<string>;
	/** Notes with images, when image occlusion is off. */
	occlusionMissed: Set<string>;
}

export async function scanNotes(app: App, o: ScanInput): Promise<ScanResult> {
	const conceptsByNote = new Map<string, Concept[]>();
	const noteText: Record<string, string> = {};
	const noteImages: Record<string, ImageInput[]> = {};
	const notesWithUnsentImages = new Set<string>();
	const occlusionMissed = new Set<string>();
	// Reference documents (Instructions.md's upload area), BEFORE the notes loop
	// below — order matters here, not just correctness: pickConcepts' fresh-content
	// reserve interleaves untested concepts round-robin by note in FIRST-APPEARANCE
	// order (see interleaveByNote in concepts.ts), and that reserve is typically only
	// ~30% of a session. In an established vault with dozens of never-tested notes,
	// inserting these after the loop meant they were always last into that interleave
	// and the reserve was spent entirely on other notes before ever reaching them —
	// extraction worked, but a reference document could never actually win a slot.
	// Going first here means they're first into the round-robin instead. Each document
	// goes through the exact same extractConcepts() a note's text does, not a side-
	// channel — this is what actually makes "Grill asks questions from the real
	// worksheet" true, rather than just true-looking. Keyed by the file's full name
	// WITH extension (e.g. "DA worksheets.pdf"), which can never collide with a real
	// note's basename (a markdown note's basename never ends in .pdf) and, as a bonus,
	// is exactly what openNote()/openLinkText needs to open the actual PDF when the
	// student taps through from a question to its source. Always included regardless
	// of session scope — a course's reference library isn't folder-bound the way a
	// note is, so there's no "which folder is this relevant to" scoping decision to
	// make here (see the doc comment on MAX_REFERENCE_DOCS in store.ts for why the
	// library can be large rather than a curated handful).
	// Both loops below are parallelized (mapWithConcurrency, text.ts) rather than a
	// sequential for...await: each iteration only touches its own key in
	// conceptsByNote/noteText/noteImages, so there's no shared state to race on
	// except pdfCache — and the worst case there is two notes that embed the exact
	// same not-yet-cached PDF both missing the cache at once and parsing it twice,
	// a one-time, self-correcting cost on first sight of that file, not a
	// correctness bug (see pdf.ts's extractPdfTextCached: last write wins, and both
	// writes are the same value).
	const refDocScanStart = Date.now();
	await mapWithConcurrency(o.refDocs, SCAN_CONCURRENCY, async (file) => {
		const text = await extractPdfTextCached(app, file, o.pdfCache);
		if (!text) return;
		const docConcepts = extractConceptsCached(file.name, text, o.formatMode, o.conceptCache);
		conceptsByNote.set(file.name, docConcepts);
		noteText[file.name] =
			text.length > o.charCap ? await o.selectContext(text, docConcepts) : text;
	});
	console.debug(
		`Grill: scanned ${o.refDocs.length} reference doc(s) in ${Date.now() - refDocScanStart}ms`,
	);
	const notesScanStart = Date.now();
	await mapWithConcurrency(o.names, SCAN_CONCURRENCY, async (n) => {
		const file = o.byName.get(n);
		if (!file) return;
		// A note that only embeds a PDF (`![[worksheet.pdf]]`) has real content, just
		// none of it in the note's own markdown text — pull the PDF's text in as if
		// it were typed there, so it's not invisible to both the structural parser and
		// the AI prompt below (see pdf.ts; a no-op for notes with no PDF embeds).
		const text = await noteStudyText(app, file, o.pdfCache);
		// Extract concepts from the FULL note; only the prompt context is truncated.
		const noteConcepts = extractConceptsCached(n, text, o.formatMode, o.conceptCache);
		conceptsByNote.set(n, noteConcepts);
		// Rank by relevance to this note's own concepts (see selectPromptContext
		// and selectRelevantText's doc comments) instead of a flat character
		// cutoff, so a long note or a big PDF import keeps the sections that
		// actually contain quizzable material rather than whatever happens to
		// fall in the first `charCap` characters. Falls back to the old flat
		// truncation when there's nothing to rank against or rank with — never
		// worse than today, sometimes much better.
		noteText[n] = text.length > o.charCap ? await o.selectContext(text, noteConcepts) : text;
		// Independent of `vision` and of whether a model is involved at all —
		// occlusion is local OCR. Recorded, not acted on: see renderOffers.
		if (!o.occlusion && !Platform.isMobile && hasEmbeddedImage(app, file)) occlusionMissed.add(n);
		if (o.vision) {
			const imgs = await collectNoteImages(app, file, o.imagesPerNote);
			if (imgs.length) noteImages[n] = imgs;
		} else if (app.metadataCache.getFileCache(file)?.embeds?.length) {
			notesWithUnsentImages.add(n);
			// Local OCR occlusion needs the same decoded images the vision path uses,
			// even when nothing's being sent to a model at all.
			if (o.occlusion) {
				const imgs = await collectNoteImages(app, file, o.imagesPerNote);
				if (imgs.length) noteImages[n] = imgs;
			}
		}
	});
	console.debug(`Grill: scanned ${o.names.length} note(s) in ${Date.now() - notesScanStart}ms`);
	return { conceptsByNote, noteText, noteImages, notesWithUnsentImages, occlusionMissed };
}
