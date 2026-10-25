/** The one-time upgrades Grill runs on an install. Each is recorded by name in
 * `settings.migrated` once it has run and never runs again, so a deliberate choice made
 * after it sticks. Steps are independent: one that fails is retried on the next launch
 * without holding the others back, and none runs twice (running the scheduling reset a
 * second time would throw away the schedule). */

import { migrateLegacyModels, type ProviderId } from "./providers";
import { intensityOf, type IntensityNumbers, type StudyIntensity } from "./settingstools";

export const MIGRATIONS = [
	"legacyDefaultsMigrated",
	"newConceptsCapMigrated",
	"intensityMigrated",
	"modelsMigrated61",
	"modelsMigrated62",
	"sessionsBaseMade",
	"sessionsFilled",
	"conceptsMigrated",
	"noteCountsRestored",
	"missesFilled",
	"arcBackfilled",
] as const;
export type MigrationId = (typeof MIGRATIONS)[number];

/** Restore defaults runs these again. */
export const RERUN_ON_RESTORE: readonly MigrationId[] = ["noteCountsRestored", "missesFilled"];

/** What the settings steps read and change. */
interface MigratingSettings extends IntensityNumbers {
	migrated: string[];
	graphNumberMode: string;
	studyIntensity: StudyIntensity;
	models: Record<ProviderId, string>;
}

const SETTINGS_STEPS: Array<{ id: MigrationId; run(s: MigratingSettings): void }> = [
	{
		// persist() writes the whole settings object, so an existing user had the old
		// shipped defaults saved to disk; changing the defaults alone never reached them.
		// Percentages visible on the graph, and a sane new-concepts cap.
		id: "legacyDefaultsMigrated",
		run: (s) => {
			if (s.graphNumberMode === "off") s.graphNumberMode = "percent";
			if (s.newConceptsPerDay === 0) s.newConceptsPerDay = 20;
		},
	},
	{
		// 0 stopped meaning "no daily cap" and started meaning zero. Installs that had
		// already run the step above need their untouched 0 carried forward too, or they
		// go from unlimited new material to none with no signal.
		id: "newConceptsCapMigrated",
		run: (s) => {
			if (s.newConceptsPerDay === 0) s.newConceptsPerDay = 20;
		},
	},
	{
		// The four scheduling numbers, read back into the preset the settings tab asks
		// about: an exact match, or "custom", so no one is rescheduled by the picker.
		id: "intensityMigrated",
		run: (s) => {
			s.studyIntensity = intensityOf(s);
		},
	},
	// Every install holds the model that was the default when it was set up. Former
	// defaults move to the current ones; a model picked by hand is kept. One step per
	// change of default, since installs that ran an earlier one are marked done.
	{ id: "modelsMigrated61", run: (s) => void migrateLegacyModels(s.models) },
	{ id: "modelsMigrated62", run: (s) => void migrateLegacyModels(s.models) },
];

export const isDone = (s: { migrated: string[] }, id: MigrationId): boolean => s.migrated.includes(id);

export function markDone(s: { migrated: string[] }, id: MigrationId): void {
	if (!s.migrated.includes(id)) s.migrated.push(id);
}

/** The steps that only change settings, run as they are read. */
export function migrateSettings(s: MigratingSettings): void {
	for (const step of SETTINGS_STEPS) {
		if (isDone(s, step.id)) continue;
		step.run(s);
		markDone(s, step.id);
	}
}

/** A step on the record: what it does, in words for the console, and the work. */
export interface RecordStep {
	id: MigrationId;
	doing: string;
	run(): Promise<void>;
}

/** Runs each record step not yet done, saving after each one that succeeds. A step that
 * fails is logged and tried again on the next launch. */
export async function migrateRecord(s: { migrated: string[] }, steps: RecordStep[], save: () => Promise<void>): Promise<void> {
	for (const step of steps) {
		if (isDone(s, step.id)) continue;
		try {
			await step.run();
			markDone(s, step.id);
			await save();
		} catch (e) {
			console.error(`Grill: couldn't ${step.doing}; will retry next launch`, e);
		}
	}
}

/** Settings files before 8.8 kept one flag per step. They are read into `migrated`, and
 * still written, so an install taken back to an older Grill doesn't run a step again. */
export function readLegacyFlags(stored: Record<string, unknown>): MigrationId[] {
	return MIGRATIONS.filter((id) => stored[id] === true);
}

export function legacyFlags(migrated: string[]): Partial<Record<MigrationId, true>> {
	return Object.fromEntries(MIGRATIONS.filter((id) => migrated.includes(id)).map((id) => [id, true]));
}
