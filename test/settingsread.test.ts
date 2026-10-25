import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, readSettings, restoredSettings } from "../src/settings";

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
	const s = { ...defaultSettings(), provider: "openai" as const, folder: "Study", questionsPerSession: 30, sounds: false, onboarded: true, modelsMigrated62: true, noteCountsRestored: true, exams: [{ folders: ["A"], date: "2026-12-01" }] };
	const r = restoredSettings(s);
	assert.equal(r.provider, "openai");
	assert.equal(r.folder, "Study");
	assert.equal(r.onboarded, true);
	assert.equal(r.modelsMigrated62, true);
	assert.deepEqual(r.exams, s.exams);
	assert.equal(r.questionsPerSession, 5);
	assert.equal(r.sounds, true);
	assert.equal(r.noteCountsRestored, false);
});
