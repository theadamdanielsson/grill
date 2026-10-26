/** The Advanced tab: the scheduling numbers under Tuning, and the Data rows. */

import { Notice } from "obsidian";
import { configureFSRSWeights } from "../mastery";
import { countTrainableReviews, MIN_REVIEWS_FOR_OPTIMIZATION } from "../optimizer";
import { restoredSettings } from "../settings";
import { sliderRow, type Row, type SettingsCtx } from "./ctx";

/** The escape hatch: every number the engine schedules on, reachable but never asked
 * about. They live on the Advanced tab, which the page never opens on, so the other
 * tabs stay short. The last two rows, Grill folder and Restore, are not tuning: they
 * are drawn under a heading of their own (see dataRows). */
export function tuningRows(ctx: SettingsCtx): Row[] {
	const s = ctx.plugin.data.settings;

	/** Editing any raw scheduling number means the preset no longer describes them. */
	const toCustom = async (): Promise<void> => {
		await ctx.plugin.settings.update({ studyIntensity: "custom" });
	};

	const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

	return [
		sliderRow(
			"Review frequency",
			"How sure Grill wants you to be when a concept comes back. Higher means more reviews.",
			70,
			97,
			Math.min(Math.max(s.desiredRetention, 70), 97),
			(v) => `${v}%`,
			async (v) => {
				s.desiredRetention = v;
				await toCustom();
			},
		),
		sliderRow(
			"New concepts per day",
			"The most untested concepts a day. Tests on a note or folder you pick aren't capped. 0 means review only.",
			0,
			100,
			Math.min(Math.max(s.newConceptsPerDay, 0), 100),
			(v) => (v === 0 ? "None" : `${v}/day`),
			async (v) => {
				s.newConceptsPerDay = v;
				await toCustom();
			},
		),
		sliderRow(
			"New material share",
			"The most of one session that new material can take.",
			0,
			100,
			Math.min(Math.max(s.freshContentShare, 0), 100),
			(v) => `${v}%`,
			async (v) => {
				s.freshContentShare = v;
				await toCustom();
			},
		),
		{
			name: "Always guarantee new material",
			desc: "Keep room for new material even when reviews are piling up.",
			build: (setting) =>
				setting.addToggle((t) =>
					t.setValue(s.freshContentAlwaysGuarantee).onChange(async (v) => {
						s.freshContentAlwaysGuarantee = v;
						await toCustom();
					}),
				),
		},
		{
			name: "Light review days",
			desc: `Weekdays to steer new reviews away from. Order: ${WEEKDAY_NAMES.join(", ")}.`,
			aliases: ["easy days", "weekend"],
			build: (setting) => {
				WEEKDAY_NAMES.forEach((full, weekday) => {
					setting.addToggle((t) =>
						t
							.setTooltip(full)
							.setValue(s.easyDays.includes(weekday))
							.onChange(async (v) => {
								await ctx.plugin.settings.update({ easyDays: v ? [...new Set([...s.easyDays, weekday])] : s.easyDays.filter((d) => d !== weekday) });
							}),
					);
				});
			},
		},
		sliderRow(
			"Grade weighting",
			"A note's score on the map: how well you recall it (left) or how much of it you've covered (right).",
			0,
			100,
			s.graphCoverageWeight,
			(v) => `${v}% coverage`,
			async (v) => {
				await ctx.plugin.settings.update({ graphCoverageWeight: v });
				ctx.plugin.refreshMapDisplay();
			},
		),
		// Fitting runs itself once there's enough review history (see
		// GrillPlugin.maybeAutoOptimizeFsrs) — there's no "Optimize now" button here
		// because being asked to press it was the setting. What's left is the status, so
		// "personalized" isn't a black box, and a way back to the shared defaults.
		{
			name: "Personalized FSRS weights",
			desc: "Scheduling fitted to your own review history.",
			build: (setting) => {
				// Read here, not when the rows are listed: the definitions are first built
				// while the plugin is still loading, before the concept store exists.
				const trainable = countTrainableReviews(ctx.plugin.concepts);
				const fp = s.fsrsPersonalization;
				setting.setDesc(
					fp
						? `Active: fit from ${fp.reviewCount} reviews on ${new Date(fp.fitAt).toLocaleDateString()}, ` +
								`${fp.improvementPct.toFixed(1)}% tighter fit than the library defaults on this vault's own data at the time. ` +
								"Refits itself as more review history accumulates."
						: `Not yet: scheduling runs on FSRS-6's library defaults, fit across a large pooled population, not this vault. ` +
								`Grill fits your own weights automatically at ${MIN_REVIEWS_FOR_OPTIMIZATION} real reviews (${trainable} so far).`,
				);
				setting.addButton((b) => {
					b.setButtonText("Reset to library defaults").setDisabled(!fp);
					if (fp) {
						b.onClick(async () => {
							s.fsrsPersonalization = null;
							configureFSRSWeights(null);
							await ctx.plugin.persist();
							new Notice("Grill: FSRS parameters reset to the library defaults.");
							ctx.rerender();
						});
					}
					return b;
				});
			},
		},
	];
}

/** Where Grill keeps its files, and the way back to the recommended settings. */
export function dataRows(ctx: SettingsCtx): Row[] {
	const s = ctx.plugin.data.settings;
	return [
		{
			name: "Grill folder",
			desc: "Where Grill keeps its data and session notes.",
			build: (setting) =>
				setting.addText((t) =>
					t
						.setPlaceholder("Grill")
						.setValue(s.folder)
						.onChange(async (v) => {
							await ctx.plugin.settings.update({ folder: v.trim() || "Grill" });
						}),
				),
		},
		{
			name: "Record in note properties",
			desc: "Adds status, due date, last tested and confusions to each studied note, for Bases and other agents. This edits your notes.",
			aliases: ["properties", "frontmatter", "bases", "yaml"],
			build: (setting) =>
				setting.addToggle((t) =>
					t.setValue(s.noteProperties).onChange(async (v) => {
						await ctx.plugin.settings.update({ noteProperties: v });
						await ctx.plugin.syncNoteProperties(v);
					}),
				),
		},
		{
			name: "Restore recommended settings",
			desc: "Reset to defaults. Keys, provider and folders are kept.",
			aliases: ["reset"],
			build: (setting) => setting.addButton((b) => b.setButtonText("Restore").onClick(() => void restoreDefaults(ctx))),
		},
	];
}

/** Reset the behavioural settings to the recommended defaults, keeping the user's
 * credentials, provider, and folder choices.
 *
 * The record of which one-time upgrades have run is kept (see restoredSettings): they
 * aren't preferences, and running one again would undo a choice made after Restore. */
export async function restoreDefaults(ctx: SettingsCtx): Promise<void> {
	const s = ctx.plugin.data.settings;
	ctx.plugin.data.settings = restoredSettings(s);
	// defaultSettings() nulls fsrsPersonalization, but the fitted weights are also
	// held in ts-fsrs' own module-level config — without this they stay live for the
	// rest of the session and only actually reset on the next Obsidian reload. The
	// dedicated reset button does this; Restore has to as well.
	configureFSRSWeights(null);
	await ctx.plugin.persist();
	new Notice("Grill: restored the recommended settings.");
	ctx.rerender();
}
