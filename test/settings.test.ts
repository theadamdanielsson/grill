import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFake, fakeSetting, settingNames } from "./obsidian-stub";
import GrillPlugin, { GrillSettingTab } from "../src/main";
import { KeyStash, type ApiKeys, type SecretStore } from "../src/secrets";
import { cloud } from "../src/cloud";
import { sectionDefs } from "./fixtures";



// These tests are about the settings page as it is without Grill Cloud. The source
// ships with it switched off and the release commit switches it on, so the state is
// set here, not assumed. (Grill Cloud's own rows are tested in cloud.test.ts.)
const withoutCloud = (): void => {
	cloud.url = "";
	cloud.privacyUrl = "";
	cloud.termsUrl = "";
};
withoutCloud();

const noKeys = (): ApiKeys => ({ anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "", custom: "" }) as ApiKeys;
const VAULT = "2fe04f6f57789abb";
const sid = (p: string): string => `grill-${VAULT}-${p}`;

/** Obsidian's keychain, as far as Grill uses it. Like the real one, a write lands in
 * memory at once; `durable: false` models the write to disk failing silently. */
function keychain(seed: Record<string, string> = {}, durable = true) {
	const disk = { ...seed };
	const kc = {
		secrets: { ...disk },
		disk,
		getSecret: (id: string) => (id in kc.secrets ? kc.secrets[id] : null),
		setSecret: (id: string, v: string) => {
			if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) throw new Error("invalid id");
			kc.secrets[id] = v;
			if (durable) disk[id] = v;
		},
		deleteSecret: (id: string) => {
			delete disk[id];
			return delete kc.secrets[id];
		},
		/** Quit and reopen Obsidian: only what reached disk comes back. */
		restart: () => {
			kc.secrets = { ...disk };
		},
	};
	return kc as typeof kc & SecretStore;
}

test("a key leaves data.json only after the keychain kept it across a restart", () => {
	const kc = keychain();
	const keys = { ...noKeys(), anthropic: "sk-ant-1" };
	// Launch 1 (the upgrade): copied to the keychain, still in data.json.
	const first = new KeyStash(kc, VAULT);
	const live = first.load(keys);
	assert.deepEqual(first.stash(live), keys);
	assert.equal(kc.secrets[sid("anthropic")], "sk-ant-1");
	// Launch 2: the keychain still has it, so data.json lets go.
	kc.restart();
	const second = new KeyStash(kc, VAULT);
	const forData = second.stash(second.load(keys));
	assert.deepEqual(forData, noKeys());
	// Launch 3: nothing in data.json, the key comes from the keychain.
	kc.restart();
	assert.equal(new KeyStash(kc, VAULT).load(forData).anthropic, "sk-ant-1");
});

test("a keychain write that never reaches disk costs nothing", () => {
	const kc = keychain({}, false);
	const keys = { ...noKeys(), anthropic: "sk-ant-1" };
	for (let launch = 0; launch < 3; launch++) {
		const stash = new KeyStash(kc, VAULT);
		const live = stash.load(keys);
		assert.equal(live.anthropic, "sk-ant-1");
		assert.deepEqual(stash.stash(live), keys, "data.json keeps the key");
		kc.restart();
	}
});

test("no keychain, or one that throws, leaves keys where they were", () => {
	const keys = { ...noKeys(), anthropic: "sk-ant-1" };
	const none = new KeyStash(null, VAULT);
	assert.deepEqual(none.stash(none.load(keys)), keys);
	const broken: SecretStore = {
		getSecret: () => {
			throw new Error("locked");
		},
		setSecret: () => {
			throw new Error("Secure storage is not available.");
		},
	};
	const stash = new KeyStash(broken, VAULT);
	assert.deepEqual(stash.stash(stash.load(keys)), keys);
	assert.deepEqual(new KeyStash(broken, VAULT).load(noKeys()), noKeys());
});

test("a new key typed mid-session waits for its own restart", () => {
	const kc = keychain({ [sid("openai")]: "sk-old" });
	const stash = new KeyStash(kc, VAULT);
	const live = stash.load(noKeys());
	assert.equal(live.openai, "sk-old");
	live.openai = "sk-new";
	assert.equal(stash.stash(live).openai, "sk-new", "unconfirmed, so data.json holds it too");
	kc.restart();
	const next = new KeyStash(kc, VAULT);
	assert.equal(next.stash(next.load({ ...noKeys(), openai: "sk-new" })).openai, "");
});

test("clearing a key clears the keychain's copy, so it doesn't come back", () => {
	for (const withDelete of [true, false]) {
		const kc = keychain({ [sid("gemini")]: "AIza-old" });
		if (!withDelete) delete (kc as SecretStore).deleteSecret;
		const stash = new KeyStash(kc, VAULT);
		const live = stash.load(noKeys());
		assert.equal(live.gemini, "AIza-old");
		live.gemini = "";
		assert.equal(stash.stash(live).gemini, "");
		assert.equal(new KeyStash(kc, VAULT).load(noKeys()).gemini, "");
	}
});

test("two vaults on one device keep separate keys", () => {
	// On phones every vault shares one keychain.
	const kc = keychain();
	const a = new KeyStash(kc, "aaaa");
	const b = new KeyStash(kc, "bbbb");
	a.stash(a.load({ ...noKeys(), anthropic: "sk-personal" }));
	b.stash(b.load({ ...noKeys(), anthropic: "sk-work" }));
	kc.restart();
	assert.equal(new KeyStash(kc, "aaaa").load(noKeys()).anthropic, "sk-personal");
	assert.equal(new KeyStash(kc, "bbbb").load(noKeys()).anthropic, "sk-work");
	// Every id the keychain will be asked to hold is one it accepts.
	for (const p of Object.keys(noKeys())) assert.match(new KeyStash(kc, VAULT).id(p as any), /^[a-z0-9-]{1,64}$/);
});

test("edits made on Obsidian's Keychain page: a changed key is taken, a deleted one dropped", () => {
	const kc = keychain({ [sid("anthropic")]: "sk-1" });
	const stash = new KeyStash(kc, VAULT);
	const live = stash.load({ ...noKeys(), openai: "sk-only-in-data" });
	kc.secrets[sid("anthropic")] = "sk-rotated";
	assert.equal(stash.adopt(live), false);
	assert.equal(live.anthropic, "sk-rotated");
	delete kc.secrets[sid("anthropic")];
	assert.equal(stash.adopt(live), true);
	assert.equal(live.anthropic, "");
	// A key the keychain was never seen holding is not "deleted" by its absence.
	assert.equal(live.openai, "sk-only-in-data");
	// And its own writes never trigger it.
	const noisy = keychain();
	const s2 = new KeyStash(noisy, VAULT);
	const l2 = s2.load({ ...noKeys(), anthropic: "a", gemini: "" });
	const set = noisy.setSecret;
	noisy.setSecret = (id, v) => {
		set(id, v);
		assert.equal(s2.adopt(l2), false);
	};
	s2.stash(l2);
	assert.equal(l2.anthropic, "a");
});

// ---- the plugin itself, loaded against an in-memory data.json -------------------

async function boot(disk: { data: any }, kc: SecretStore | null, failFirstSave = false) {
	const adapter = deepFake({ exists: async () => false, read: async () => "{}", write: async () => undefined });
	const vault = deepFake({ adapter, getMarkdownFiles: () => [], getFiles: () => [], getAllFolders: () => [], getAbstractFileByPath: () => null });
	const app = deepFake({ vault, appId: VAULT, secretStorage: kc ?? undefined });
	const plugin = new (GrillPlugin as any)() as any;
	plugin.app = app;
	plugin.loadData = async () => (disk.data === null ? null : JSON.parse(JSON.stringify(disk.data)));
	plugin.saveData = async (d: unknown) => {
		if (failFirstSave) {
			failFirstSave = false;
			throw new Error("disk full");
		}
		disk.data = JSON.parse(JSON.stringify(d));
	};
	let tab: GrillSettingTab | null = null;
	plugin.addSettingTab = (t: GrillSettingTab) => {
		tab = t;
	};
	await plugin.onload();
	return { plugin, tab: tab as unknown as GrillSettingTab };
}

test("upgrading keeps the key working and moves it out of data.json on the next launch", async () => {
	const disk = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" }, models: { anthropic: "claude-sonnet-5" } } } };
	const kc = keychain();
	const first = await boot(disk, kc);
	assert.equal(first.plugin.llmConfig().apiKey, "sk-ant-live");
	assert.equal(kc.secrets[sid("anthropic")], "sk-ant-live");
	assert.equal(disk.data.settings.apiKeys.anthropic, "sk-ant-live", "kept until the keychain proves itself");
	// The former default moved to the current one, exactly once.
	assert.equal(first.plugin.llmConfig().model, "claude-sonnet-5-5");
	assert.ok(first.plugin.data.settings.migrated.includes("modelsMigrated62"));
	assert.equal((disk.data.settings as Record<string, unknown>).modelsMigrated62, true, "still written for an older Grill");

	kc.restart();
	const second = await boot(disk, kc);
	assert.equal(second.plugin.llmConfig().apiKey, "sk-ant-live");
	assert.equal(disk.data.settings.apiKeys.anthropic, "", "data.json no longer holds the key");
	// A model picked back by hand after the migration is left alone.
	second.plugin.data.settings.models.anthropic = "claude-sonnet-5";
	await second.plugin.persist();

	kc.restart();
	const third = await boot(disk, kc);
	assert.equal(third.plugin.llmConfig().model, "claude-sonnet-5");
	assert.equal(third.plugin.llmConfig().apiKey, "sk-ant-live");
});

test("a keychain that silently drops writes never costs the key", async () => {
	const disk = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" } } } };
	const kc = keychain({}, false);
	for (let launch = 0; launch < 3; launch++) {
		const { plugin } = await boot(disk, kc);
		assert.equal(plugin.llmConfig().apiKey, "sk-ant-live");
		await plugin.persist();
		assert.equal(disk.data.settings.apiKeys.anthropic, "sk-ant-live");
		kc.restart();
	}
});

test("a failed save while moving the key doesn't stop the plugin loading", async () => {
	const disk = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" } } } };
	const { plugin } = await boot(disk, keychain(), true);
	assert.equal(plugin.llmConfig().apiKey, "sk-ant-live");
});

test("a key edited on Obsidian's Keychain page is picked up; a deleted one is dropped and stays dropped", async () => {
	const disk = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" } } } };
	const kc = keychain() as ReturnType<typeof keychain> & { on: (name: string, cb: () => void) => unknown };
	let changed = (): void => undefined;
	kc.on = (_name, cb) => {
		changed = cb;
		return {};
	};
	const { plugin } = await boot(disk, kc);
	kc.setSecret(sid("anthropic"), "sk-ant-rotated");
	changed();
	assert.equal(plugin.llmConfig().apiKey, "sk-ant-rotated");
	kc.deleteSecret!(sid("anthropic"));
	changed();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(plugin.llmConfig(), null);
	await plugin.persist();
	assert.equal(kc.getSecret(sid("anthropic")), null, "not written back");
	assert.equal(disk.data.settings.apiKeys.anthropic, "");
});

test("without a keychain the key stays in data.json, as before", async () => {
	const disk = { data: { settings: { provider: "openai", apiKeys: { openai: "sk-live" } } } };
	const { plugin } = await boot(disk, null);
	assert.equal(plugin.llmConfig().apiKey, "sk-live");
	await plugin.persist();
	assert.equal(disk.data.settings.apiKeys.openai, "sk-live");
});

test("a fresh install with no data loads cleanly", async () => {
	const disk = { data: null as any };
	const { plugin } = await boot(disk, keychain());
	assert.equal(plugin.llmConfig(), null);
});

// ---- the settings tab ---------------------------------------------------------

function names(items: any[]): string[] {
	const out: string[] = [];
	for (const it of items) {
		if (it.type === "group" || it.type === "page") out.push(...names(it.items ?? []));
		else if (it.name) out.push(it.name);
	}
	return out;
}

test("with Grill Cloud on, it has the first section and the page still has no duplicate rows", async () => {
	cloud.url = "https://grill.example/cloud";
	cloud.privacyUrl = "https://grill.example/privacy";
	cloud.termsUrl = "https://grill.example/terms";
	try {
		for (const provider of ["anthropic", "ollama", "custom", "grillcloud"]) {
			const { tab } = await boot({ data: { settings: { provider } } }, keychain());
			const defs = sectionDefs(tab);
			assert.deepEqual(
				defs.map((d) => d.heading ?? d.name),
				["Grill Cloud", "Chat", "Learn more", "Your own key or Ollama", "Programs on this computer", "Other agents", "Tools and skills", "Studying", "Exams", "Folders", "From other AI chats", "Your profile", "Tuning", "Data"],
			);
			const every = names(defs);
			assert.equal(new Set(every).size, every.length, `duplicate row names (${provider})`);
			// Privacy and terms are small print on the card, not a row of their own.
			assert.ok(!every.includes("Privacy and terms"));
		}
	} finally {
		withoutCloud();
	}
});

test("the searchable definitions and the classic page list the same rows", async () => {
	for (const provider of ["anthropic", "openai", "gemini", "deepseek", "ollama", "custom"]) {
		const disk = { data: { settings: { provider } } };
		const { tab } = await boot(disk, keychain());
		const defs = sectionDefs(tab);
		assert.deepEqual(
			defs.map((d) => d.type),
			["group", "group", "group", "group", "group", "group", "group", "group", "group", "group", "group", "group", "group"],
		);
		assert.deepEqual(
			defs.map((d) => d.heading ?? d.name),
			["Chat", "Learn more", "AI", "Programs on this computer", "Other agents", "Tools and skills", "Studying", "Exams", "Folders", "From other AI chats", "Your profile", "Tuning", "Data"],
		);
		const every = names(defs);
		assert.equal(new Set(every).size, every.length, "duplicate row names");
		const shown = (items: any[]): string[] =>
			items.flatMap((it) => (it.items ? shown(it.items) : it.visible() ? [it.name] : []));
		const defined = shown(defs);
		assert.ok(defined.includes(provider === "ollama" ? "Ollama server" : "API key"), provider);
		assert.equal(defined.includes("Base URL"), provider === "custom");

		// Every definition renders (callbacks and all) without throwing, and never
		// renames the row Obsidian hands it.
		settingNames.length = 0;
		for (const d of defs) for (const it of d.items) it.render(fakeSetting());
		assert.deepEqual(settingNames, []);

		// The classic page draws exactly the same rows, in the same order, a tab at a time.
		const headings = ["Chat", "Learn more", "AI", "Programs on this computer", "Other agents", "Tools and skills", "Studying", "Exams", "Folders", "From other AI chats", "Your profile", "Tuning", "Data"];
		const drawn: string[] = [];
		for (const id of ["basic", "key", "agents", "study", "advanced"]) {
			(tab as any).tab = id;
			settingNames.length = 0;
			tab.display();
			drawn.push(...settingNames);
		}
		(tab as any).tab = "basic";
		// The Advanced tab's rows come last; its unnamed row is the note under Tuning.
		const tuning = names(defs.filter((d) => d.heading === "Tuning" || d.heading === "Data")).filter(Boolean);
		assert.deepEqual(
			drawn.filter((n) => !headings.includes(n)),
			[...defined.filter((n) => !tuning.includes(n)), ...tuning],
			provider,
		);
		assert.deepEqual(
			drawn.filter((n) => headings.includes(n)),
			headings,
		);
	}
});

test("definitions built once at load still show what's true when the tab is opened later", async () => {
	// Obsidian calls getSettingDefinitions() when the plugin loads and then only
	// re-renders those same definitions each time the tab is opened.
	const { plugin, tab } = await boot({ data: { settings: {} } }, keychain());
	const defs = sectionDefs(tab);
	const def = (name: string): any => defs.flatMap((d) => d.items).find((it: any) => it.name === name);
	const s = plugin.data.settings;

	// Changed from the onboarding panel, outside the tab.
	s.provider = "openai";
	s.apiKeys.openai = "sk-typed-in-onboarding";
	s.questionsPerSession = 20;
	s.models.openai = "gpt-6-luna";

	const controls = (name: string): any[] => {
		const made: any[] = [];
		const row = fakeSetting();
		for (const m of ["addDropdown", "addText", "addSlider"])
			row[m] = (cb: (c: any) => unknown) => {
				const c: any = deepFake();
				c.setValue = (v: unknown) => {
					c.value = v;
					return c;
				};
				c.setPlaceholder = (v: unknown) => {
					c.placeholder = v;
					return c;
				};
				c.setLimits = () => c;
				c.addOption = () => c;
				c.onChange = (fn: unknown) => {
					c.change = fn;
					return c;
				};
				made.push(c);
				cb(c);
				return row;
			};
		def(name).render(row);
		return made;
	};
	assert.equal(controls("Provider")[0].value, "openai");
	assert.equal(controls("API key")[0].value, "sk-typed-in-onboarding");
	assert.equal(controls("API key")[0].placeholder, "sk-...");
	assert.equal(controls("Model")[0].value, "gpt-6-luna");
	assert.equal(controls("Questions per session")[0].value, 20);
	// A key pasted now lands on the provider actually selected.
	await controls("API key")[0].change("sk-second");
	assert.equal(s.apiKeys.openai, "sk-second");
	assert.equal(s.apiKeys.anthropic, "");

	// Rows follow the live provider too, without new definitions.
	assert.equal(def("API key").visible(), true);
	assert.equal(def("Ollama server").visible(), false);
	assert.equal(def("Base URL").visible(), false);
	assert.equal(def("Custom model ID").visible(), false);
	s.provider = "ollama";
	assert.equal(def("API key").visible(), false);
	assert.equal(def("Ollama server").visible(), true);
	assert.equal(controls("API key").length, 0, "a hidden row renders nothing");
	s.provider = "custom";
	assert.equal(def("Base URL").visible(), true);
	assert.equal(def("API key").visible(), true);
});

test("the definitions never throw into Obsidian's loader", async () => {
	const { plugin, tab } = await boot({ data: { settings: {} } }, keychain());
	plugin.data = null;
	assert.deepEqual(tab.getSettingDefinitions(), []);
});

test("someone who used Grill without AI is asked before their saved key is used", async () => {
	const disk = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" }, models: { anthropic: "claude-sonnet-5-5" }, questionSource: "local", gradingMode: "self" } } as any };
	const kc = keychain();
	const first = await boot(disk, kc);
	assert.equal(first.plugin.llmConfig(), null, "nothing is sent until they say so");
	assert.equal(disk.data.settings.modelAgreed, false);
	// Still held back on the next launch, when the old settings are no longer on disk.
	const second = await boot(disk, kc);
	assert.equal(second.plugin.llmConfig(), null);
	second.plugin.data.settings.modelAgreed = true;
	assert.equal(second.plugin.llmConfig().apiKey, "sk-ant-live");
	// Someone who was using a model all along is not asked anything.
	const other = { data: { settings: { provider: "anthropic", apiKeys: { anthropic: "sk-ant-live" }, models: { anthropic: "claude-sonnet-5-5" }, questionSource: "ai", gradingMode: "ai" } } as any };
	assert.equal((await boot(other, keychain())).plugin.llmConfig().apiKey, "sk-ant-live");
});

test("an answer given while an agent's answers are being folded in is kept", async () => {
	const { plugin } = await boot({ data: { settings: {} } }, null);
	const N = "N::a";
	plugin.concepts = { [N]: { note: "N", label: "a", kind: "term", sourceHash: null, correct: 0, partial: 0, incorrect: 0, streak: 0, stability: null, difficulty: null, lastSeen: null, dueAt: null } };
	plugin.mastery = {};
	plugin.recordLoaded = true;
	plugin.app.workspace.getLeavesOfType = () => [];
	const result = { v: 1, id: "agent1", at: "2026-10-20T10:00:00.000Z", via: "Codex", session: "s", conceptId: N, note: "N", question: "q", answer: "a", verdict: "correct" };
	const saved: Record<string, unknown> = {};
	Object.assign(plugin.store, {
		readInbox: async () => [{ path: "Grill/Inbox/x.json", result }],
		loadAppliedInbox: async () => [],
		loadRegistry: async () => ({}),
		saveConcepts: async (m: unknown) => {
			saved.concepts = structuredClone(m);
			// The student answers in an open pane while the fold is saving.
			plugin.mastery.Other = { correct: 1, partial: 0, incorrect: 0, streak: 1, stability: null, difficulty: null, lastSeen: null, dueAt: null, misconceptions: {} };
		},
		saveMastery: async () => undefined,
		saveRegistry: async () => undefined,
		saveAppliedInbox: async () => undefined,
		writeSessionNote: async () => null,
		removeInboxFile: async () => undefined,
		setAsideInboxFile: async () => undefined,
		removeEmptyInbox: async () => undefined,
	});
	await plugin.foldInbox();
	assert.equal(plugin.mastery.Other?.correct, 1, "the pane's answer is still there");
	assert.equal(plugin.mastery.N?.correct, 1, "and the agent's");
	assert.equal(plugin.concepts[N].correct, 1);
	assert.deepEqual(plugin.concepts[N], (saved.concepts as Record<string, unknown>)[N], "memory matches what was saved");
});
