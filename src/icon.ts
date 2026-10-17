/** Grill's own icon: the pixel flame from the README and the site, in one colour so it
 * sits with Obsidian's other icons and follows the theme. Drawn on Obsidian's 100x100
 * icon grid; the open band between the outer flame and the core is the yellow of the
 * coloured flame. */
import { addIcon } from "obsidian";

export const GRILL_ICON = "grill-flame";

export function registerGrillIcon(): void {
	addIcon(GRILL_ICON, '<g fill="currentColor" stroke="none" shape-rendering="crispEdges"><rect x="46.5" y="1" width="7" height="7"/><rect x="39.5" y="8" width="21" height="7"/><rect x="39.5" y="15" width="21" height="7"/><rect x="32.5" y="22" width="35" height="7"/><rect x="25.5" y="29" width="21" height="7"/><rect x="53.5" y="29" width="21" height="7"/><rect x="25.5" y="36" width="14" height="7"/><rect x="60.5" y="36" width="14" height="7"/><rect x="18.5" y="43" width="21" height="7"/><rect x="46.5" y="43" width="7" height="7"/><rect x="60.5" y="43" width="21" height="7"/><rect x="18.5" y="50" width="14" height="7"/><rect x="39.5" y="50" width="21" height="7"/><rect x="67.5" y="50" width="14" height="7"/><rect x="11.5" y="57" width="21" height="7"/><rect x="39.5" y="57" width="21" height="7"/><rect x="67.5" y="57" width="21" height="7"/><rect x="11.5" y="64" width="14" height="7"/><rect x="32.5" y="64" width="35" height="7"/><rect x="74.5" y="64" width="14" height="7"/><rect x="11.5" y="71" width="14" height="7"/><rect x="39.5" y="71" width="21" height="7"/><rect x="74.5" y="71" width="14" height="7"/><rect x="11.5" y="78" width="21" height="7"/><rect x="46.5" y="78" width="7" height="7"/><rect x="67.5" y="78" width="21" height="7"/><rect x="18.5" y="85" width="21" height="7"/><rect x="60.5" y="85" width="21" height="7"/><rect x="25.5" y="92" width="49" height="7"/></g>');
}
