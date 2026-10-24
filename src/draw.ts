/**
 * Draw from memory: the student answers by drawing in the Excalidraw plugin, and the
 * drawing is graded as an image (see gradeAnswer's DRAWING_RULES in llm.ts).
 *
 * Grill does not bundle Excalidraw. It drives the Excalidraw plugin through
 * ExcalidrawAutomate, the API that plugin publishes on `window` for other plugins and
 * scripts. Only a few long-standing methods are used, typed here rather than taken from
 * its npm package, whose types lag the plugin. The drawing stays in the vault as an
 * ordinary Excalidraw file.
 */
import { App, normalizePath, TFile, WorkspaceLeaf } from "obsidian";
import { toBase64, type ImageInput } from "./images";

interface DrawElement {
	type: string;
	isDeleted?: boolean;
	text?: string;
}

/** The part of ExcalidrawAutomate this file uses. */
interface ExcalidrawAutomate {
	getAPI(view?: unknown): ExcalidrawAutomate;
	reset(): void;
	destroy(): void;
	create(params: { filename?: string; foldername?: string; onNewPane?: boolean }): Promise<string>;
	setView(view: unknown): unknown;
	getViewElements(): readonly DrawElement[];
	copyViewElementsToEAforEditing(elements: readonly DrawElement[]): void;
	createPNG(
		templatePath?: string,
		scale?: number,
		exportSettings?: { withBackground: boolean; withTheme: boolean; isMask: boolean },
		loader?: undefined,
		theme?: string,
	): Promise<Blob>;
}

const EXCALIDRAW_VIEW = "excalidraw";
export const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

function automate(): ExcalidrawAutomate | null {
	const ea = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomate }).ExcalidrawAutomate;
	return ea && typeof ea.getAPI === "function" ? ea : null;
}

/** True when the Excalidraw plugin is installed and on. */
export function canDraw(): boolean {
	return automate() !== null;
}

/** A new, empty drawing in `<Grill folder>/Drawings`, opened in a tab beside the notes.
 * Returns its vault path. */
export async function newDrawing(grillFolder: string, note: string): Promise<string> {
	const root = automate();
	if (!root) throw new Error("The Excalidraw plugin is not on.");
	const ea = root.getAPI();
	try {
		ea.reset();
		const stamp = window.moment().format("YYYY-MM-DD HH.mm");
		const name = `${note} ${stamp}`.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim();
		return await ea.create({ foldername: normalizePath(`${grillFolder}/Drawings`), filename: name, onNewPane: true });
	} finally {
		ea.destroy();
	}
}

function drawingLeaf(app: App, path: string): WorkspaceLeaf | null {
	return app.workspace.getLeavesOfType(EXCALIDRAW_VIEW).find((l) => (l.view as { file?: TFile }).file?.path === path) ?? null;
}

/** Bring the drawing's tab forward, opening it again if it was closed. */
export async function showDrawing(app: App, path: string): Promise<void> {
	const leaf = drawingLeaf(app, path);
	if (leaf) {
		await app.workspace.revealLeaf(leaf);
		return;
	}
	const file = app.vault.getFileByPath(path);
	if (file) await app.workspace.getLeaf("split").openFile(file);
}

/** The drawing as a PNG, plus the text written in it, or null when nothing is drawn.
 * Read from the open tab when there is one, so strokes not yet saved still count. */
export async function captureDrawing(app: App, path: string): Promise<{ image: ImageInput; labels: string } | null> {
	const root = automate();
	if (!root) throw new Error("The Excalidraw plugin is not on.");
	const leaf = drawingLeaf(app, path);
	const ea = root.getAPI(leaf?.view);
	try {
		let elements: readonly DrawElement[] = [];
		if (leaf) {
			ea.setView(leaf.view);
			elements = ea.getViewElements().filter((e) => !e.isDeleted);
			if (!elements.length) return null;
			ea.copyViewElementsToEAforEditing(elements);
		}
		// Always light with a white background: the grader reads ink on paper.
		const settings = { withBackground: true, withTheme: true, isMask: false };
		const blob = leaf ? await ea.createPNG(undefined, 1.5, settings, undefined, "light") : await ea.createPNG(path, 1.5, settings, undefined, "light");
		if (!leaf && blob.size === 0) return null;
		const labels = elements
			.filter((e) => e.type === "text" && e.text?.trim())
			.map((e) => (e.text as string).trim())
			.join("\n");
		return { image: { mediaType: "image/png", dataBase64: toBase64(await blob.arrayBuffer()), path }, labels };
	} finally {
		ea.destroy();
	}
}
