/** What every part of Grill's settings page shares: the row they are all built from,
 * the state of the tab they are drawn in, and the small pieces more than one tab uses. */

import type { App, Setting } from "obsidian";
import type GrillPlugin from "../main";
import type { ProviderId } from "../providers";

/** The model box's entry for typing a model ID by hand. */
export const CUSTOM = "__custom__";

/** One settings row, described once. display() (Obsidian before 1.13) and
 * getSettingDefinitions() (1.13+, which is what makes the rows searchable) both render
 * from the same list, so the two can't drift apart. `build` receives a row that already
 * has its name and description set. */
export interface Row {
	name: string;
	desc?: string;
	/** Extra words the settings search should find this row by. */
	aliases?: string[];
	/** Returns whatever the builder chain returns; it's ignored. */
	build: (setting: Setting) => unknown;
}

/** The settings tab, as the rows see it: the plugin, a way to redraw, and what the tab
 * remembers while it is open. */
export interface SettingsCtx {
	app: App;
	plugin: GrillPlugin;
	/** Redraw after a change that adds, removes or rewords rows. */
	rerender(): void;
	/** Draw the page the classic way (Obsidian before 1.13). */
	display(): void;
	refreshModels(p: ProviderId): Promise<void>;
	/** Live model lists, cached per provider for the lifetime of the tab. */
	modelLists: Partial<Record<ProviderId, string[]>>;
	/** Why the last model-list fetch came back empty, when it said. */
	modelProblems: Partial<Record<ProviderId, string>>;
	showCustomModel: boolean;
	/** Whether Grill Cloud has been asked for the balance since the tab was opened. */
	cloudAsked: boolean;
	showCloudKey: boolean;
	showRetiredKeys: boolean;
	/** Whether the key row is opened up to its controls. */
	manageKey: boolean;
	/** A key being typed in from another vault; applied only by its button. */
	cloudKeyDraft: string;
	/** Set by the first press on a replacement, so the second one does it. */
	cloudKeyConfirm: boolean;
	/** The same, for deleting the account. */
	cloudDeleteConfirm: boolean;
	/** Set when a purchase has just landed: the balance to count up from on the next draw. */
	cloudCountFrom: number | null;
	/** While opencode is being downloaded from this tab. */
	opencodeBusy: boolean;
	/** Guards against attaching a duplicate voiceschanged listener on every display(). */
	voicesListenerAttached: boolean;
}

/** Run a number up from `from` to `to` in an element's text, over about a second,
 * easing out. Skipped (the final text is simply set) for people who ask for reduced
 * motion, and wherever animation frames aren't available. */
export function countUp(el: HTMLElement, from: number, to: number, text: (n: number) => string): void {
	const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (still || typeof window.requestAnimationFrame !== "function") {
		el.setText(text(to));
		return;
	}
	const started = performance.now();
	const step = (now: number): void => {
		const t = Math.min(1, (now - started) / 1100);
		const eased = 1 - Math.pow(1 - t, 3);
		el.setText(text(Math.round(from + (to - from) * eased)));
		if (t < 1) window.requestAnimationFrame(step);
	};
	window.requestAnimationFrame(step);
}

/** A slider whose current value is shown inline next to it. */
export function sliderRow(
	name: string,
	desc: string,
	min: number,
	max: number,
	value: number,
	format: (v: number) => string,
	onChange: (v: number) => Promise<void>,
): Row {
	return {
		name,
		desc: desc || undefined,
		build: (setting) => {
			// Obsidian 1.13 always shows the slider's value inline itself (setDynamicTooltip is
			// deprecated because of it) and added setDisplayFormat to customize that display —
			// so on 1.13+, adding our own value span next to it just prints the number twice.
			// Feature-detected (not a minAppVersion bump) so this still renders correctly, just
			// without the friendly formatting, on the older Obsidian versions Grill supports.
			let valueEl: HTMLSpanElement | null = null;
			setting.addSlider((sl) => {
				const hasDisplayFormat =
					typeof (sl as unknown as { setDisplayFormat?: unknown }).setDisplayFormat === "function";
				if (hasDisplayFormat) {
					(sl as unknown as { setDisplayFormat: (f: (v: number) => string) => void }).setDisplayFormat(format);
				} else {
					valueEl = setting.controlEl.createSpan({ cls: "grill-slider-value", text: format(value) });
				}
				return sl
					.setLimits(min, max, 1)
					.setValue(value)
					.onChange(async (v) => {
						valueEl?.setText(format(v));
						await onChange(v);
					});
			});
		},
	};
}
