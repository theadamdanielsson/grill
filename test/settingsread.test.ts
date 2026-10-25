import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, readSettings, restoredSettings } from "../src/settings";
import { migrateRecord, migrateSettings } from "../src/migrations";

test("a stored setting that can't be read is its default, and the rest are kept", () => {
	const s = readSettings({
		provider: "nonsense",
		questionsPerSession: 12,
		folder: "  Study  ",
		ollamaUrl: "   ",
		questionFormats: "essay",
		easyDays: [0, 7, "1", 6],
		excludedFolders: ["A", 3, "B"],
		naturalVoice: true,
		models: { openai: "gpt-x" },
		cloudRing: { full: -5, last: 3 },
		fsrsPersonalization: { weights: [1, "2"], fitAt: "x" },
		localEmbedContext: true,
		localEmbedModel: "an-older-model",
	});
	const d = defaultSettings();
	assert.equal(s.provider, d.provider);
	assert.equal(s.questionsPerSession, 12);
	assert.equal(s.folder, "Study");
	assert.equal(s.ollamaUrl, d.ollamaUrl);
	assert.equal(s.questionFormats, "mixed");
	assert.deepEqual(s.easyDays, [0, 6]);
	assert.deepEqual(s.excludedFolders, ["A", "B"]);
	assert.equal(s.naturalVoice, true);
	assert.equal(s.models.openai, "gpt-x");
	assert.equal(s.models.anthropic, d.models.anthropic);
	assert.deepEqual(s.cloudRing, { full: 0, last: 3 });
	assert.equal(s.fsrsPersonalization, null);
	assert.equal(s.localEmbedContext, false, "an acceptance for another model asks again");
	assert.equal(readSettings({ naturalVoice: false }).naturalVoice, false);
});

test("Restore defaults keeps credentials, folders and one-time records, and resets preferences", () => {
	const s = { ...defaultSettings(), provider: "openai" as const, folder: "Study", questionsPerSession: 30, sounds: false, onboarded: true, migrated: ["modelsMigrated62", "noteCountsRestored"], exams: [{ folders: ["A"], date: "2026-12-01" }] };
	const r = restoredSettings(s);
	assert.equal(r.provider, "openai");
	assert.equal(r.folder, "Study");
	assert.equal(r.onboarded, true);
	assert.deepEqual(r.migrated, ["modelsMigrated62"], "except the steps Restore runs again");
	assert.deepEqual(r.exams, s.exams);
	assert.equal(r.questionsPerSession, 5);
	assert.equal(r.sounds, true);
});

test("an older settings file's one-time flags are read as done, and a step marked done never runs again", () => {
	const old = { graphNumberMode: "off", newConceptsPerDay: 0, legacyDefaultsMigrated: true, newConceptsCapMigrated: true, conceptsMigrated: true, intensityMigrated: false };
	const s = readSettings(old);
	assert.deepEqual([...s.migrated].sort(), ["conceptsMigrated", "legacyDefaultsMigrated", "newConceptsCapMigrated"]);
	migrateSettings(s);
	assert.equal(s.graphNumberMode, "off", "a choice made after the upgrade sticks");
	assert.equal(s.newConceptsPerDay, 0);
	assert.ok(s.migrated.includes("intensityMigrated"));
	assert.ok(s.migrated.includes("modelsMigrated62"));
	const fresh = readSettings({ graphNumberMode: "off" });
	migrateSettings(fresh);
	assert.equal(fresh.graphNumberMode, "percent");
});

test("a record step that fails is tried again later and doesn't stop the others", async () => {
	const s = { migrated: [] as string[] };
	const ran: string[] = [];
	const quiet = console.error;
	console.error = () => undefined;
	try {
		await migrateRecord(
			s,
			[
				{ id: "sessionsFilled", doing: "x", run: async () => { throw new Error("locked"); } },
				{ id: "missesFilled", doing: "y", run: async () => void ran.push("misses") },
			],
			async () => undefined,
		);
	} finally {
		console.error = quiet;
	}
	assert.deepEqual(s.migrated, ["missesFilled"]);
	assert.deepEqual(ran, ["misses"]);
});
