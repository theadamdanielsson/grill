/** Grill's own icon: the pixel flame from the README and the site, in one colour so it
 * sits with Obsidian's other icons and follows the theme. Drawn on Obsidian's 100x100
 * icon grid; the open band between the outer flame and the core is the yellow of the
 * coloured flame. */
import { addIcon } from "obsidian";

export const GRILL_ICON = "grill-flame";

export function registerGrillIcon(): void {
	addIcon(GRILL_ICON, '<g fill="currentColor" stroke="none" shape-rendering="crispEdges"><rect x="46.5" y="1" width="7" height="7"/><rect x="39.5" y="8" width="21" height="7"/><rect x="39.5" y="15" width="21" height="7"/><rect x="32.5" y="22" width="35" height="7"/><rect x="25.5" y="29" width="21" height="7"/><rect x="53.5" y="29" width="21" height="7"/><rect x="25.5" y="36" width="14" height="7"/><rect x="60.5" y="36" width="14" height="7"/><rect x="18.5" y="43" width="21" height="7"/><rect x="46.5" y="43" width="7" height="7"/><rect x="60.5" y="43" width="21" height="7"/><rect x="18.5" y="50" width="14" height="7"/><rect x="39.5" y="50" width="21" height="7"/><rect x="67.5" y="50" width="14" height="7"/><rect x="11.5" y="57" width="21" height="7"/><rect x="39.5" y="57" width="21" height="7"/><rect x="67.5" y="57" width="21" height="7"/><rect x="11.5" y="64" width="14" height="7"/><rect x="32.5" y="64" width="35" height="7"/><rect x="74.5" y="64" width="14" height="7"/><rect x="11.5" y="71" width="14" height="7"/><rect x="39.5" y="71" width="21" height="7"/><rect x="74.5" y="71" width="14" height="7"/><rect x="11.5" y="78" width="21" height="7"/><rect x="46.5" y="78" width="7" height="7"/><rect x="67.5" y="78" width="21" height="7"/><rect x="18.5" y="85" width="21" height="7"/><rect x="60.5" y="85" width="21" height="7"/><rect x="25.5" y="92" width="49" height="7"/></g>');
}

/** Grill's own flame silhouette for the verdict badge (7x10, crisp pixel blocks — the
 * same shape-rendering technique used in the plugin's hero art) instead of a generic
 * Lucide circle-check/circle-x, which every other app also uses. One shape for every
 * verdict; only the badge's own text color (.grill-v-correct/partial/incorrect/skipped)
 * differentiates it, via currentColor, so a Style Settings retint still works. */
const FLAME_ICON_CELLS: [number, number][] = [
	[3, 0],
	[3, 1],
	[4, 1],
	[2, 2],
	[3, 2],
	[4, 2],
	[2, 3],
	[3, 3],
	[4, 3],
	[5, 3],
	[1, 4],
	[2, 4],
	[3, 4],
	[4, 4],
	[5, 4],
	[1, 5],
	[2, 5],
	[3, 5],
	[4, 5],
	[5, 5],
	[1, 6],
	[2, 6],
	[3, 6],
	[4, 6],
	[5, 6],
	[6, 6],
	[1, 7],
	[2, 7],
	[3, 7],
	[4, 7],
	[5, 7],
	[2, 8],
	[3, 8],
	[4, 8],
	[5, 8],
	[2, 9],
	[3, 9],
	[4, 9],
];
/** Builds the flame icon as real SVG DOM nodes, not an innerHTML string — Obsidian's
 * plugin review flags raw innerHTML assignment as unsafe even for fully static,
 * hardcoded content like this, so every cell is its own createSvg'd <rect> (Obsidian's
 * own namespace-aware DOM helper, not document.createElementNS). */
export function renderFlameIcon(container: HTMLElement): void {
	const svg = container.createSvg("svg", {
		attr: { viewBox: "0 0 7 10", "shape-rendering": "crispEdges", fill: "currentColor" },
	});
	for (const [x, y] of FLAME_ICON_CELLS) {
		svg.createSvg("rect", { attr: { x, y, width: 1, height: 1 } });
	}
}
