import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFake, fakeEl, fakeSetting, net, notices, Plugin } from "obsidian";
import GrillPlugin, { GrillSettingTab } from "../src/main";
import { cloud, cloudAccount, cloudCheckoutUrl, creditsInWords, heardFromCloud, isCloudKey, lowBalance, newCloudKey, packLabel, usageInWords } from "../src/cloud";
import { KeyStash } from "../src/secrets";
import { stopSpeaking } from "../src/tts";
import { CloudError, cloudWait, offeredProviders, testModel } from "../src/llm";
import { SessionView as GrillView } from "../src/view";

// Waiting for a purchase sets a timer and a focus listener; the tests drive the checks by hand.
(globalThis as any).setInterval = () => 1;
(globalThis as any).clearInterval = () => undefined;
(globalThis as any).addEventListener = () => undefined;
(globalThis as any).removeEventListener = () => undefined;

// The window's own storage, shared by every vault on a device. Each test that cares
// starts from an empty one.
const device = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => device.get(k) ?? null,
	setItem: (k: string, v: string) => void device.set(k, v),
	removeItem: (k: string) => void device.delete(k),
};

const P = Plugin.prototype as unknown as Record<string, unknown>;
for (const m of ["addCommand", "registerView", "addRibbonIcon", "registerEvent", "registerInterval", "registerDomEvent", "registerMarkdownCodeBlockProcessor", "registerObsidianProtocolHandler", "register", "addStatusBarItem"])
	P[m] ??= () => deepFake();

const URL = "https://grill.example/cloud";
// The source ships these empty until the release commit fills them in. Tests must
// pass either way, so they say what they assume.
cloud.privacyUrl = "";
cloud.termsUrl = "";
/** The label on the larger pack's button. */
const BIG = "1,000 credits for $9.99 + tax";

/** `local` stands in for the device's own storage, which outlives a reload and is
 * not part of the synced settings file. */
async function boot(settings: Record<string, unknown> = {}, local: Record<string, unknown> = {}, secretStorage: unknown = undefined, sameDevice = false) {
	if (!sameDevice) device.clear();
	const disk = { data: { settings } as any };
	const adapter = deepFake({ exists: async () => false, read: async () => "{}", write: async () => undefined });
	const vault = deepFake({ adapter, getMarkdownFiles: () => [], getFiles: () => [], getAbstractFileByPath: () => null });
	const plugin = new (GrillPlugin as any)() as any;
	plugin.app = deepFake({
		vault,
		appId: "abc123",
		secretStorage,
		loadLocalStorage: (k: string) => local[k] ?? null,
		saveLocalStorage: (k: string, v: unknown) => void (local[k] = JSON.parse(JSON.stringify(v))),
	});
	plugin.loadData = async () => JSON.parse(JSON.stringify(disk.data));
	plugin.saveData = async (d: unknown) => {
		disk.data = JSON.parse(JSON.stringify(d));
	};
	let tab: GrillSettingTab | null = null;
	plugin.addSettingTab = (t: GrillSettingTab) => {
		tab = t;
	};
	await plugin.onload();
	return { plugin, disk, tab: tab as unknown as GrillSettingTab };
}

const rows = (tab: GrillSettingTab): string[] =>
	(tab.getSettingDefinitions() as any[]).flatMap((d) => d.items).filter((it: any) => it.visible()).map((it: any) => it.name);

interface Fake {
	credits: number;
	/** Whether any key has an account; `known`, when set, decides per key instead. */
	account: boolean;
	known?: Set<string>;
	purchases: number;
	sales: boolean;
	granted: boolean;
	starters: boolean;
	/** The server can't be reached at all. */
	down?: boolean;
	/** The server answers everything with this error. */
	refuse?: { status: number; message: string; code?: string };
}

/** A stand-in server: answers /start, /balance, /account and /chat/completions the way
 * the real one does, and keeps what it was sent. */
function server(over: Partial<Fake> = {}) {
	const state: Fake = { credits: 25, account: false, purchases: 0, sales: true, granted: true, starters: true, ...over };
	const seen: Array<{ path: string; url: string; method: string; auth: string; body: any }> = [];
	net.handler = async (req) => {
		const path = req.url.replace(cloud.url.replace(/\/$/, ""), "");
		const auth = req.headers?.authorization ?? "";
		seen.push({ path, url: req.url, method: req.method ?? "GET", auth, body: req.body ? JSON.parse(req.body) : null });
		if (state.down) throw new Error("offline");
		if (state.refuse)
			return { status: state.refuse.status, json: { error: { message: state.refuse.message, code: state.refuse.code } }, text: "" };
		const has = state.known ? state.known.has(auth) : state.account;
		if (path === "/start") {
			if (state.known) state.known.add(auth);
			else state.account = true;
			return { status: 200, json: { credits: state.credits, granted: state.granted, starters: state.starters }, text: "" };
		}
		if (path === "/balance")
			return { status: 200, json: { credits: has ? state.credits : 0, account: has, purchases: has ? state.purchases : 0, sales: state.sales }, text: "" };
		if (path === "/account" && req.method === "DELETE") {
			if (state.known) state.known.delete(auth);
			else state.account = false;
			return { status: 200, json: { deleted: true }, text: "" };
		}
		if (path === "/chat/completions")
			return { status: 200, headers: { "X-Grill-Credits": "9" }, json: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }, text: "" } as any;
		return { status: 404, json: null, text: "" };
	};
	return { seen, state };
}

test("with no server configured, Grill Cloud isn't offered anywhere and nothing is ever sent", async () => {
	cloud.url = "";
	cloud.packs = [];
	const { seen } = server();
	assert.ok(!offeredProviders().some(([id]) => id === "grillcloud"));
	const { plugin, tab } = await boot();
	assert.ok(!rows(tab).includes("Grill Cloud") && !rows(tab).includes("Account"));
	assert.match(await plugin.startCloud(), /isn't available/);
	assert.equal(plugin.data.settings.apiKeys.grillcloud, "", "no key is made");
	// Even a settings file that somehow names it can't make a request.
	plugin.data.settings.provider = "grillcloud";
	plugin.data.settings.apiKeys.grillcloud = newCloudKey();
	assert.equal(plugin.llmConfig(), null);
	await plugin.refreshCloud();
	plugin.openCloudCheckout();
	assert.equal(plugin.cloudWaitingFrom, null);
	assert.equal(seen.length, 0);
});

test("a cloud key is 256 random bits, and only its hash ever goes in a link", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const a = newCloudKey();
	assert.ok(isCloudKey(a));
	assert.notEqual(a, newCloudKey());
	const url = await cloudCheckoutUrl(a, "https://buy.stripe.com/abc");
	assert.equal(url, `https://buy.stripe.com/abc?client_reference_id=${await cloudAccount(a)}`);
	assert.ok(!url.includes(a.slice(6)));
	assert.match(await cloudAccount(a), /^[0-9a-f]{64}$/);
	assert.ok((await cloudCheckoutUrl(a, "https://x/buy?embed=1")).includes("?embed=1&client_reference_id="));
	// A balance is credits. What a session costs depends on the notes, so no number of
	// sessions is ever promised: what this vault's own sessions cost is said back instead.
	assert.equal(creditsInWords(1316), "1,316 credits left");
	assert.equal(creditsInWords(1), "1 credit left");
	assert.equal(creditsInWords(0), "No credits left");
	assert.match(usageInWords([]), /usually uses 5 to 40 credits, depending on how long your notes are/);
	assert.equal(usageInWords([11]), "Your last session used 11 credits.");
	assert.equal(usageInWords([9, 14, 11]), "Your last session used 11 credits.");
	assert.deepEqual([lowBalance([]), lowBalance([9, 31, 11])], [12, 31]);
	// The price is said with tax to come, since the checkout adds it.
	assert.equal(packLabel(cloud.packs[1]), "1,000 credits for $9.99 + tax");
	assert.equal(packLabel({ credits: 1100, price: "$9.99", url: "", note: "10% extra" }), "1,100 credits for $9.99 + tax (10% extra)");
});

test("Start free makes a key, opens the account, and switches to it", async () => {
	cloud.url = URL;
	const { seen } = server();
	const { plugin, disk, tab } = await boot();
	// Offered first on the settings page before it is ever turned on, whatever the provider.
	assert.equal(rows(tab)[0], "Grill Cloud");
	assert.ok(rows(tab).includes("Provider") && !rows(tab).includes("Account"));
	assert.equal(await plugin.startCloud(), "Grill Cloud is on. You have 25 free credits to start.");
	const key = plugin.data.settings.apiKeys.grillcloud;
	assert.ok(isCloudKey(key));
	assert.equal(plugin.data.settings.provider, "grillcloud");
	assert.equal(disk.data.settings.provider, "grillcloud");
	assert.deepEqual([seen[0].method, seen[0].url, seen[0].auth], ["POST", `${URL}/start`, `Bearer ${key}`]);
	assert.deepEqual([plugin.cloudState, plugin.cloudCredits, plugin.cloudPurchases], ["ok", 25, 0]);
	// The settings page now shows the balance row and no model picker.
	const shown = rows(tab);
	assert.ok(shown.includes("Grill Cloud") && shown.includes("Account") && !shown.includes("API key"));
	assert.ok(!shown.includes("Model") && !shown.includes("Base URL") && !shown.includes("Ollama server"));
	// Starting again keeps the same key.
	await plugin.startCloud();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key);
});

test("only Start free opens an account: looking at the balance never does", async () => {
	cloud.url = URL;
	const key = newCloudKey();
	const { seen } = server();
	const { plugin } = await boot({ provider: "grillcloud", apiKeys: { grillcloud: key } });
	await plugin.refreshCloud();
	await plugin.refreshCloud();
	assert.ok(seen.length >= 2 && seen.every((r) => r.method === "GET" && r.path === "/balance"));
	assert.equal(plugin.cloudState, "none");
});

test("the key is saved before the server is asked, so a lost reply can't strand a starter", async () => {
	cloud.url = URL;
	server({ down: true });
	const { plugin, disk } = await boot({ provider: "openai" });
	assert.match(await plugin.startCloud(), /Couldn't reach Grill Cloud/);
	assert.equal(plugin.cloudState, "offline");
	const key = disk.data.settings.apiKeys.grillcloud;
	assert.ok(isCloudKey(key), "kept on disk");
	// Trying again asks about the same key, not a new one.
	const { seen } = server();
	assert.match(await plugin.startCloud(), /25 free credits/);
	assert.equal(seen[0].auth, `Bearer ${key}`);
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key);
});

test("a server that answers with an error is quoted, not blamed on the connection", async () => {
	cloud.url = URL;
	server({ refuse: { status: 503, message: "Grill Cloud is paused for maintenance." } });
	const { plugin, tab } = await boot();
	assert.equal(await plugin.startCloud(), "Grill Cloud is paused for maintenance.");
	assert.equal(plugin.cloudState, "refused");
	assert.equal(draw(tab, "Grill Cloud").desc(), "Grill Cloud is paused for maintenance.");
	server({ down: true });
	await plugin.refreshCloud();
	assert.match(draw(tab, "Grill Cloud").desc(), /Couldn't reach Grill Cloud/);
});

test("a Grill Cloud key never goes to the keychain: it stays with the vault", () => {
	const secrets: Record<string, string> = {};
	const kc = { getSecret: (id: string) => secrets[id] ?? null, setSecret: (id: string, v: string) => void (secrets[id] = v) };
	const keys = { anthropic: "sk-ant-1", openai: "", gemini: "", deepseek: "", ollama: "", custom: "", grillcloud: newCloudKey() };
	for (let launch = 0; launch < 3; launch++) {
		const stash = new KeyStash(kc, "vault1");
		const forData = stash.stash(stash.load(keys));
		assert.equal(forData.grillcloud, keys.grillcloud, "still in data.json");
		assert.equal(stash.adopt({ ...keys }), false);
	}
	assert.deepEqual(Object.keys(secrets), ["grill-vault1-anthropic"]);
});

test("a cloud key that Grill 6.2.0 moved into a keychain is taken back into the vault", () => {
	const mine = newCloudKey();
	const secrets: Record<string, string> = { "grill-vault1-grillcloud": mine };
	const kc = { getSecret: (id: string) => secrets[id] ?? null, setSecret: (id: string, v: string) => void (secrets[id] = v) };
	const blanked = { anthropic: "", openai: "", gemini: "", deepseek: "", ollama: "", custom: "", grillcloud: "" };
	const stash = new KeyStash(kc, "vault1");
	const live = stash.load(blanked);
	assert.equal(live.grillcloud, mine);
	assert.equal(stash.stash(live).grillcloud, mine, "written back to data.json");
	// A key in the vault wins over whatever a keychain holds.
	const other = newCloudKey();
	assert.equal(new KeyStash(kc, "vault1").load({ ...blanked, grillcloud: other }).grillcloud, other);
});

test("when there's no free starter the message says which kind of none", async () => {
	cloud.url = URL;
	server({ credits: 0, granted: false, starters: true });
	assert.match(await (await boot()).plugin.startCloud(), /with no free credits this time/);
	server({ credits: 0, granted: false, starters: false });
	assert.match(await (await boot()).plugin.startCloud(), /with no free credits this time/);
	server({ credits: 300, granted: false });
	assert.equal(await (await boot()).plugin.startCloud(), "Grill Cloud is on. 300 credits left.");
});

test("a model call goes to Grill Cloud in the shape its server accepts", async () => {
	cloud.url = URL + "/";
	const { seen, state } = server();
	const { plugin } = await boot();
	await plugin.startCloud();
	const cfg = plugin.llmConfig();
	assert.equal(cfg.provider, "grillcloud");
	assert.equal(cfg.model, "Grill Cloud");
	assert.equal(await testModel(cfg), null);
	const sent = seen.at(-1)!;
	assert.equal(sent.url, `${URL}/chat/completions`);
	assert.equal(sent.auth, `Bearer ${plugin.data.settings.apiKeys.grillcloud}`);
	assert.deepEqual(Object.keys(sent.body).sort(), ["max_tokens", "messages", "model", "response_format"]);
	assert.deepEqual(sent.body.messages.map((m: any) => m.role), ["system", "user"]);
	// The schema travels as a schema, not as text in the prompt.
	assert.equal(sent.body.messages[1].content, "Reply with ok set to true.");
	assert.equal(sent.body.response_format.type, "json_schema");
	assert.deepEqual(sent.body.response_format.json_schema.schema.required, ["ok"]);
	// The reply carried the balance; no second request was needed to know it.
	assert.equal(plugin.cloudCredits, 9);
	heardFromCloud({ "x-grill-credits": "not a number" });
	heardFromCloud(undefined);
	assert.equal(plugin.cloudCredits, 9);
	heardFromCloud({ "x-grill-credits": "4" });
	assert.equal(plugin.cloudCredits, 4);
	// What a session used is what each reply says it cost, not how far the balance fell:
	// another request's hold is in the balance while it is in flight.
	plugin.cloudSessionSpent = 0;
	heardFromCloud({ "x-grill-credits": "366", "X-Grill-Cost": "0.5" });
	heardFromCloud({ "x-grill-credits": "398", "x-grill-cost": "1.75" });
	heardFromCloud({ "x-grill-cost": "nonsense" });
	assert.equal(plugin.cloudSessionSpent, 2.25);
	assert.equal(await plugin.noteCloudSession(), 2);
	heardFromCloud({ "x-grill-cost": "0.2" });
	assert.equal(await plugin.noteCloudSession(), 1, "a session that used something never reads as 0");
	plugin.data.settings.cloudUsage = [];

	// An error comes back in the server's own words, with whether credits would fix it.
	state.refuse = { status: 402, message: "You're out of credits.", code: "no_credits" };
	assert.equal(await testModel(cfg), "You're out of credits.");
	assert.equal(new CloudError(402, { error: { message: "x" } }).needsCredits, true);
	assert.equal(new CloudError(429, { error: { message: "x", code: "free_paused" } }).needsCredits, true);
	assert.equal(new CloudError(429, { error: { message: "x", code: "busy" } }).needsCredits, false);
	assert.equal(new CloudError(500, null).message, "Grill Cloud answered with an error (500).");
});

test("a custom endpoint still gets the widest-compatibility request, untouched by Grill Cloud", async () => {
	cloud.url = URL;
	const sent: any[] = [];
	net.handler = async (req) => {
		sent.push({ url: req.url, auth: req.headers?.authorization, body: JSON.parse(req.body ?? "{}") });
		return { status: 200, json: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }, text: "" };
	};
	assert.equal(await testModel({ provider: "custom", apiKey: "sk-x", model: "some/model", baseUrl: "https://openrouter.ai/api/v1/" } as any), null);
	assert.equal(sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
	assert.equal(sent[0].auth, "Bearer sk-x");
	assert.equal(sent[0].body.model, "some/model");
	assert.deepEqual(sent[0].body.response_format, { type: "json_object" });
	assert.equal(typeof sent[0].body.messages[1].content, "string");
	assert.match(sent[0].body.messages[1].content, /Respond ONLY with a json object matching this JSON Schema/);
});

/** The key row, opened up to its controls (it is one line until Manage key is pressed). */
function keyRow(tab: GrillSettingTab) {
	const closed = draw(tab, "Account");
	closed.button("Manage")?.click();
	return draw(tab, "Account");
}

/** Render one settings row the way Obsidian does, and hand back its controls. */
function draw(tab: GrillSettingTab, name: string) {
	const def = (tab.getSettingDefinitions() as any[]).flatMap((d) => d.items).find((it: any) => it.name === name);
	const buttons: any[] = [];
	const texts: any[] = [];
	const row = fakeSetting();
	let desc = "";
	row.setDesc = (d: string) => {
		desc = d;
		return row;
	};
	row.addButton = (cb: (b: any) => unknown) => {
		const b: any = deepFake();
		for (const m of ["setButtonText", "setCta", "setDisabled", "setWarning"]) b[m] = (v: unknown) => ((b[m + "Value"] = v), b);
		b.onClick = (fn: () => unknown) => ((b.click = fn), b);
		buttons.push(b);
		cb(b);
		return row;
	};
	row.addText = (cb: (c: any) => unknown) => {
		const c: any = deepFake({ inputEl: {} });
		c.setValue = (v: unknown) => ((c.value = v), c);
		c.setPlaceholder = () => c;
		c.onChange = (fn: (v: string) => unknown) => ((c.change = fn), c);
		texts.push(c);
		cb(c);
		return row;
	};
	// Everything the row writes into itself beyond the description (its card).
	const said: string[] = [];
	const el: any = deepFake();
	const note = (o?: { text?: string }): any => {
		if (o?.text) said.push(o.text);
		return el;
	};
	el.createEl = (_tag: string, o?: { text?: string }) => note(o);
	el.createDiv = note;
	el.createSpan = note;
	row.infoEl = el;
	row.settingEl = el;
	def.render(row);
	const button = (label: string): any => buttons.find((b) => b.setButtonTextValue === label);
	return { buttons, texts, button, desc: () => desc, said, visible: def.visible() as boolean };
}

test("settings: Grill Cloud has the first section, says what it is before it starts, then shows the balance and the packs", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const { state } = server({ credits: 42, granted: false });
	const { plugin, tab } = await boot({ provider: "openai" });
	const sections = (): Array<{ heading: string; names: string[] }> =>
		(tab.getSettingDefinitions() as any[]).filter((d) => d.type === "group").map((d) => ({ heading: d.heading, names: d.items.filter((it: any) => it.visible()).map((it: any) => it.name) }));
	// Before it is ever turned on, with another provider in use: first on the page,
	// and nothing but the offer.
	assert.deepEqual(sections()[0], { heading: "Grill Cloud", names: ["Grill Cloud"] });
	assert.equal(sections()[1].heading, "Your own key or Ollama");
	assert.ok(sections().find((sec) => sec.heading === "Studying")!.names[0] === "Study mode");
	const before = draw(tab, "Grill Cloud");
	assert.match(before.desc(), /nothing to set up/);
	// What it costs, what it needs and where notes go are said before anything is sent.
	assert.ok(before.said.some((x) => /Free credits to start, while each day's last\. Then credit packs from \$3\.99 \+ tax/.test(x)));
	assert.ok(before.said.some((x) => /go through Grill's server to Claude/.test(x)));
	assert.ok(before.said.some((x) => /Anthropic keeps them for up to 30 days/.test(x) && /18 and over/.test(x)));
	await before.button("Start free").click();
	assert.ok(isCloudKey(plugin.data.settings.apiKeys.grillcloud));
	assert.equal(plugin.data.settings.provider, "grillcloud");
	assert.deepEqual(sections()[0].names, ["Grill Cloud", "Account"]);
	const on = draw(tab, "Grill Cloud");
	assert.equal(on.desc(), "In use. 42 credits left.");
	// The card: the name, that it's in use, the balance, and what a session costs said
	// as a range, since this vault has no sessions of its own to go by yet.
	assert.ok(["GRILL CLOUD", "In use", "42", "credits"].every((x) => on.said.includes(x)), on.said.join(" | "));
	assert.ok(on.said.some((x) => /usually uses 5 to 40 credits/.test(x)));
	assert.ok(!on.said.concat(on.desc()).some((x) => /about \d+ sessions/.test(x)), "no number of sessions is promised");
	// Once it has, they are said back instead.
	plugin.cloudSessionSpent = 11;
	assert.equal(await plugin.noteCloudSession(), 11);
	assert.equal(await plugin.noteCloudSession(), 0, "counted once");
	assert.ok(draw(tab, "Grill Cloud").said.includes("Your last session used 11 credits."));

	// One button per pack, each opening its own link for this key, ready before the click.
	const opened: string[] = [];
	(globalThis as any).open = (u: string) => opened.push(u);
	const mine = plugin.data.settings.apiKeys.grillcloud;
	const buy = draw(tab, "Grill Cloud");
	assert.ok(buy.said.some((x) => /Checkout by Stripe/.test(x)));
	assert.ok(buy.button("400 credits for $3.99 + tax"));
	buy.button(BIG).click();
	assert.deepEqual(opened, [await cloudCheckoutUrl(mine, "https://buy.stripe.com/abc")]);
	// While waiting, the only button is Stop checking: nothing can be bought twice from here.
	const waiting = draw(tab, "Grill Cloud");
	assert.match(waiting.desc(), /Checkout is open in your browser/);
	assert.equal(waiting.button(BIG), undefined);
	waiting.button("Stop checking").click();
	assert.equal(plugin.cloudWaitingFrom, null);
	// When the server says sales are off there is no button, and no way to open the page.
	state.sales = false;
	await plugin.refreshCloud();
	assert.equal(draw(tab, "Grill Cloud").button(BIG), undefined);
	plugin.openCloudCheckout();
	assert.equal(opened.length, 1);
	// With no checkout link configured there is no button either.
	state.sales = true;
	cloud.packs = [];
	plugin.cloudPacks = [];
	await plugin.refreshCloud();
	assert.equal(draw(tab, "Grill Cloud").button(BIG), undefined);
	assert.equal(plugin.cloudCanBuy, false);

	// With another provider picked, the section stays, says so, and offers the way back.
	cloud.packs = [{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" }];
	plugin.data.settings.provider = "openai";
	await plugin.refreshCloud();
	assert.equal(sections()[0].heading, "Grill Cloud");
	const idle = draw(tab, "Grill Cloud");
	assert.match(idle.desc(), /^Not in use\. 42 credits left/);
	await idle.button("Use Grill Cloud").click();
	assert.equal(plugin.data.settings.provider, "grillcloud");

	// The key is one line until asked for.
	const closed = draw(tab, "Account");
	assert.deepEqual(closed.buttons.map((b) => b.setButtonTextValue), ["Manage"]);
	assert.equal(closed.texts.length, 0);
	assert.ok(keyRow(tab).button("Delete account"));
	tab.hide();
	assert.deepEqual(draw(tab, "Account").buttons.map((b) => b.setButtonTextValue), ["Manage"]);
});

test("a key that got no free starter can still buy, try again, or be let go of", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const { state, seen } = server({ credits: 0, granted: false });
	const { plugin, disk, tab } = await boot();
	// The day's starters are gone: the server opens no account.
	state.account = false;
	const real = net.handler;
	net.handler = async (req) => {
		const r = await real(req);
		if (req.url.endsWith("/start")) state.account = false;
		return r;
	};
	assert.match(await plugin.startCloud(), /with no free credits this time/);
	const key = plugin.data.settings.apiKeys.grillcloud;
	assert.equal(plugin.cloudState, "none");
	assert.equal(plugin.cloudCanBuy, true);
	assert.match(draw(tab, "Grill Cloud").desc(), /No credits yet/);
	const row = draw(tab, "Grill Cloud");
	// Buying is what opens the account: the pack buttons are there, for this key.
	const opened: string[] = [];
	(globalThis as any).open = (u: string) => opened.push(u);
	row.button("400 credits for $3.99 + tax").click();
	assert.deepEqual(opened, [await cloudCheckoutUrl(key, "https://buy.stripe.com/small")]);
	assert.equal(await plugin.checkCloudTopUp(), false);
	state.account = true;
	state.credits = 400;
	state.purchases = 1;
	notices.length = 0;
	assert.equal(await plugin.checkCloudTopUp(), true);
	assert.ok(notices.some((n) => n.includes("400 credits added. You have 400.")), notices.join(" | "));
	assert.equal(plugin.cloudState, "ok");

	// Or ask for the starter again another day, on the same key.
	state.account = false;
	await plugin.refreshCloud();
	const before = seen.length;
	await draw(tab, "Grill Cloud").button("Try free credits").click();
	assert.deepEqual([seen[before].path, seen[before].auth], ["/start", `Bearer ${key}`]);
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key);

	// Or let go of it, from the key row: there is nothing on the server to delete.
	net.handler = real;
	state.account = false;
	await plugin.refreshCloud();
	assert.equal(keyRow(tab).button("Delete account"), undefined);
	await keyRow(tab).button("Forget this key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, "");
	assert.deepEqual(disk.data.settings.retiredCloudKeys, [key]);
	assert.ok(draw(tab, "Grill Cloud").button("Start free"));
	// The earlier key can be read back out of the settings page.
	keyRow(tab).button("Earlier keys").click();
	assert.ok(keyRow(tab).texts.some((x) => x.value === key));
});

test("the key can be shown but not typed over; replacing it takes a key the server knows and a second press", async () => {
	cloud.url = URL;
	cloud.packs = [];
	const known = new Set<string>();
	server({ credits: 500, granted: false, known });
	const { plugin, disk, tab } = await boot();
	await plugin.startCloud();
	const mine = plugin.data.settings.apiKeys.grillcloud;
	assert.equal(draw(tab, "API key").visible, false, "no editable key field for Grill Cloud");

	// Hidden until asked for, then read-only.
	let row = keyRow(tab);
	assert.ok(!row.texts.some((t) => t.value === mine));
	row.button("Show").click();
	row = keyRow(tab);
	const shown = row.texts.find((t) => t.value === mine);
	assert.equal(shown.inputEl.readOnly, true);

	// Typing in the box changes nothing by itself, and a partial key is refused.
	const entry = row.texts.find((t) => t.value !== mine);
	entry.change("grill_abc");
	assert.equal(plugin.data.settings.apiKeys.grillcloud, mine);
	await keyRow(tab).button("Use this key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, mine);

	// A well-formed key the server has never seen (a typo, say): refused, nothing replaced.
	const other = newCloudKey();
	keyRow(tab).texts.at(-1).change(other);
	await keyRow(tab).button("Use this key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, mine, "the first press only warns");
	notices.length = 0;
	await keyRow(tab).button("Replace key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, mine);
	assert.ok(notices.some((n) => n.includes("No Grill Cloud account has that key")));

	// A real key from another vault: first press warns, second replaces, the old one is kept.
	known.add(`Bearer ${other}`);
	await keyRow(tab).button("Use this key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, mine);
	await keyRow(tab).button("Replace key").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, other);
	assert.equal(disk.data.settings.apiKeys.grillcloud, other);
	assert.deepEqual(disk.data.settings.retiredCloudKeys, [mine]);
	assert.deepEqual(plugin.cloudPacks, [], "no checkout link is configured in this test");

	// Closing the tab hides the key again and drops a half-made replacement.
	keyRow(tab).button("Show").click();
	keyRow(tab).texts.at(-1).change(newCloudKey());
	tab.hide();
	row = keyRow(tab);
	assert.ok(!row.texts.some((t) => t.value === other));
	assert.equal(row.texts.at(-1).value, "");
});

test("the checkout link always belongs to the key in use", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const known = new Set<string>();
	server({ known });
	const { plugin } = await boot();
	await plugin.startCloud();
	const mine = plugin.data.settings.apiKeys.grillcloud;
	const links = (): string[] => plugin.cloudPacks.map((p: any) => p.link);
	assert.deepEqual(links(), [await cloudCheckoutUrl(mine, "https://buy.stripe.com/small"), await cloudCheckoutUrl(mine, "https://buy.stripe.com/abc")]);
	const other = newCloudKey();
	known.add(`Bearer ${other}`);
	assert.equal(await plugin.useCloudKey(other), null);
	assert.deepEqual(links(), [await cloudCheckoutUrl(other, "https://buy.stripe.com/small"), await cloudCheckoutUrl(other, "https://buy.stripe.com/abc")]);
	await plugin.forgetCloudKey();
	assert.deepEqual(links(), []);
	const opened: string[] = [];
	(globalThis as any).open = (u: string) => opened.push(u);
	plugin.openCloudCheckout();
	assert.deepEqual(opened, []);
});

test("deleting the account takes two presses, and the key is only dropped once the server confirms", async () => {
	cloud.url = URL;
	const { seen, state } = server({ credits: 120, granted: false });
	const { plugin, disk, tab } = await boot();
	await plugin.startCloud();
	const key = plugin.data.settings.apiKeys.grillcloud;

	await keyRow(tab).button("Delete account").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key, "the first press only warns");
	assert.ok(!seen.some((r) => r.method === "DELETE"));

	// The server can't be reached: nothing is forgotten, and the user is told so.
	state.down = true;
	notices.length = 0;
	await keyRow(tab).button("Really delete").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key);
	assert.ok(notices.some((n) => n.includes("Nothing was deleted")));

	state.down = false;
	await keyRow(tab).button("Delete account").click();
	await keyRow(tab).button("Really delete").click();
	assert.deepEqual(seen.filter((r) => r.method === "DELETE").map((r) => r.auth), [`Bearer ${key}`, `Bearer ${key}`]);
	assert.equal(plugin.data.settings.apiKeys.grillcloud, "");
	assert.equal(disk.data.settings.apiKeys.grillcloud, "");
	assert.deepEqual(disk.data.settings.retiredCloudKeys, [], "a deleted key isn't kept");
	assert.equal(keyRow(tab).button("Delete account"), undefined);
});

test("after Top up the balance is watched, and a purchase announces itself when it lands", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const { state } = server({ credits: 316, granted: false });
	const { plugin, tab } = await boot();
	await plugin.startCloud();
	(globalThis as any).open = () => undefined;

	draw(tab, "Grill Cloud").button(BIG).click();
	assert.equal(plugin.cloudWaitingFrom, 316);
	assert.match(draw(tab, "Grill Cloud").desc(), /Checkout is open in your browser/);

	// Nothing yet.
	assert.equal(await plugin.checkCloudTopUp(), false);
	assert.equal(plugin.cloudWaitingFrom, 316);

	// The balance going up by itself (a held charge handed back) is not a purchase.
	state.credits = 330;
	assert.equal(await plugin.checkCloudTopUp(), false);
	assert.notEqual(plugin.cloudWaitingFrom, null);
	state.credits = 316;

	// The payment lands: the purchase count goes up.
	state.credits = 1316;
	state.purchases = 1;
	const heard: number[][] = [];
	let viewTold = 0;
	plugin.cloudArrived = (from: number, to: number) => heard.push([from, to]);
	plugin.cloudListeners.add(() => viewTold++);
	notices.length = 0;
	assert.equal(await plugin.checkCloudTopUp(), true);
	assert.deepEqual(heard, [[316, 1316]]);
	assert.equal(viewTold, 1);
	// It says what arrived, and asks nothing of the user: there is no key to go and save.
	assert.deepEqual(notices, ["Grill: 1,000 credits added. You have 1,316."]);
	// A later one just says what arrived.
	plugin.openCloudCheckout();
	state.credits = 1716;
	state.purchases = 2;
	notices.length = 0;
	assert.equal(await plugin.checkCloudTopUp(), true);
	assert.deepEqual(notices, ["Grill: 400 credits added. You have 1,716."]);
	state.credits = 1316;
	await plugin.refreshCloud();
	assert.equal(plugin.cloudWaitingFrom, null, "the wait is over");
	assert.equal(await plugin.checkCloudTopUp(), false);
	assert.equal(draw(tab, "Grill Cloud").desc(), "In use. 1,316 credits left.");
});

test("the purchase watcher: one look at a time, spending meanwhile doesn't skew it, pressing twice announces once", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const { seen, state } = server({ credits: 316, granted: false });
	const { plugin, tab } = await boot();
	await plugin.startCloud();
	(globalThis as any).open = () => undefined;
	plugin.openCloudCheckout();
	assert.equal(plugin.cloudWaitingFrom, 316);

	// The timer and a return to the window ask at the same moment: one request, one answer.
	const before = seen.length;
	const both = await Promise.all([plugin.checkCloudTopUp(), plugin.checkCloudTopUp()]);
	assert.deepEqual(both, [false, false]);
	assert.equal(seen.length - before, 1);

	// A session spends 20 credits while waiting; the purchase is still announced as 1000.
	heardFromCloud({ "x-grill-credits": "296" });
	assert.equal(plugin.cloudWaitingFrom, 296);
	// Top up pressed a second time (from a notice, say) restarts the wait, nothing more.
	plugin.openCloudCheckout();
	assert.equal(plugin.cloudWaitingFrom, 296);
	state.credits = 1296;
	state.purchases = 1;
	notices.length = 0;
	assert.equal(await plugin.checkCloudTopUp(), true);
	assert.equal(await plugin.checkCloudTopUp(), false);
	assert.equal(notices.filter((n) => n.includes("1,000 credits added. You have 1,296.")).length, 1, notices.join(" | "));

	// While a purchase is on its way the key can't be swapped or the account deleted.
	plugin.openCloudCheckout();
	const key = plugin.data.settings.apiKeys.grillcloud;
	const row = keyRow(tab);
	row.texts.at(-1).change(newCloudKey());
	await keyRow(tab).button("Use this key").click();
	await keyRow(tab).button("Delete account").click();
	assert.equal(plugin.data.settings.apiKeys.grillcloud, key);
	assert.ok(!seen.some((r) => r.method === "DELETE"));

	// Unloading the plugin ends the wait.
	plugin.onunload();
	assert.equal(plugin.cloudWaitingFrom, null);
	assert.equal(await plugin.checkCloudTopUp(), false);
});

test("a wait begun before the server had answered takes its first answer as the starting point", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const key = newCloudKey();
	const { state } = server({ credits: 500, account: true, purchases: 2, granted: false });
	const { plugin } = await boot({ provider: "grillcloud", apiKeys: { grillcloud: key } });
	(globalThis as any).open = () => undefined;
	// The link is made, but the balance has never been fetched.
	await plugin.linkCloudCheckout(key);
	plugin.openCloudCheckout();
	notices.length = 0;
	assert.equal(await plugin.checkCloudTopUp(), false, "two old purchases are not an arrival");
	assert.equal(notices.length, 0);
	state.credits = 1500;
	state.purchases = 3;
	assert.equal(await plugin.checkCloudTopUp(), true);
	assert.ok(notices.some((n) => n.includes("1,000 credits added. You have 1,500.")), notices.join(" | "));
});

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

test("the onboarding panel and the home screen ask for the balance without ever looping or opening an account", async () => {
	cloud.url = URL;
	cloud.packs = [{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" }];
	const key = newCloudKey();
	const { seen } = server({ credits: 4, account: true, granted: false });
	const { plugin } = await boot({ provider: "grillcloud", apiKeys: { grillcloud: key } });
	const view = new (GrillView as any)(deepFake({ app: plugin.app }), plugin) as any;
	plugin.cloudListeners.add(view.onCloud);
	// Every step of first run draws without a hitch, and only the cloud step asks.
	view.renderOnboarding(1);
	view.renderOnboarding(3);
	assert.equal(seen.length, 0);
	view.renderOnboarding(2);
	await settle();
	assert.equal(plugin.cloudState, "ok");
	assert.equal(seen.length, 1, "asked once, then drawn from what it heard");
	view.cloudCounter(fakeEl());
	await settle();
	assert.equal(seen.length, 2);
	assert.ok(seen.every((r) => r.method === "GET" && r.path === "/balance"));
	// A change to the balance reaches whichever screen is up.
	let redrawn = 0;
	view.cloudRedraw = () => redrawn++;
	(globalThis as any).open = () => undefined;
	plugin.openCloudCheckout();
	plugin.stopCloudWatch();
	assert.equal(redrawn, 2);

	// A key that isn't one (a hand-edited settings file) asks nothing and doesn't spin.
	plugin.data.settings.apiKeys.grillcloud = "junk";
	plugin.cloudState = "unknown";
	view.renderOnboarding(2);
	view.cloudCounter(fakeEl());
	await settle();
	assert.equal(seen.length, 2);

	// No key yet: the panel says what Grill Cloud is and sends nothing.
	plugin.data.settings.apiKeys.grillcloud = "";
	view.renderOnboarding(2);
	view.renderCloudPanel(fakeEl());
	view.whatsNew(fakeEl());
	await settle();
	assert.equal(seen.length, 2);

	// The panel for a key of one's own never shows Grill Cloud, and moves off it.
	// Looking at the own-key step changes nothing for someone on Grill Cloud.
	plugin.data.settings.provider = "grillcloud";
	view.renderOnboarding(2, true);
	assert.equal(plugin.data.settings.provider, "grillcloud");
	// Run again by someone already set up, it starts from the folders they have.
	plugin.data.settings.includedFolders = ["School/Stats"];
	view.showOnboarding();
	assert.deepEqual([...view.onboardFolders], ["School/Stats"]);
	// And a build without Grill Cloud still has its two-way choice.
	cloud.url = "";
	view.renderOnboarding(2);
	cloud.url = URL;
	await view.onClose();
	assert.equal(plugin.cloudListeners.size, 0);
});

test("a key the settings file loses is brought back from this device's own copy", async () => {
	cloud.url = URL;
	server();
	const local: Record<string, unknown> = {};
	const first = await boot({}, local);
	await first.plugin.startCloud();
	const key = first.plugin.data.settings.apiKeys.grillcloud;
	assert.deepEqual(local["grill-cloud"], { key, retired: [], gone: [] });

	// Another device, still on Grill 6.2.0, blanks the key in the shared file and drops
	// what it doesn't know. This device starts again: the key is back, and written back.
	const again = await boot({ provider: "anthropic", apiKeys: { grillcloud: "" } }, local);
	assert.equal(again.plugin.data.settings.apiKeys.grillcloud, key);
	assert.equal(again.disk.data.settings.apiKeys.grillcloud, key);

	// A key the user let go of stays gone after a restart, but is kept as an earlier key.
	await again.plugin.forgetCloudKey();
	assert.deepEqual(local["grill-cloud"], { key: "", retired: [key], gone: [] });
	const third = await boot({ apiKeys: { grillcloud: "" } }, local);
	assert.equal(third.plugin.data.settings.apiKeys.grillcloud, "");
	assert.deepEqual(third.plugin.data.settings.retiredCloudKeys, [key], "earlier keys come back too");

	// A deleted key is not kept anywhere.
	const fourth = await boot({}, {});
	await fourth.plugin.startCloud();
	const doomed = fourth.plugin.data.settings.apiKeys.grillcloud;
	assert.equal(await fourth.plugin.deleteCloud(), null);
	assert.deepEqual(fourth.disk.data.settings.retiredCloudKeys, []);
	// Even if a stale copy of the settings file still has it.
	fourth.disk.data.settings.apiKeys.grillcloud = doomed;
	await fourth.plugin.persist();
	assert.equal(fourth.plugin.data.settings.apiKeys.grillcloud, "");
});

test("a save never blanks a key another device just wrote, and never makes a second key", async () => {
	cloud.url = URL;
	const { seen } = server();
	// This device loaded before the other one pressed Start free.
	const here = await boot({ provider: "openai" });
	const theirs = newCloudKey();
	here.disk.data.settings.apiKeys = { ...here.disk.data.settings.apiKeys, grillcloud: theirs };
	// Any save here (a slider, a toggle) used to write the whole file back with no key.
	here.plugin.data.settings.questionCount = 7;
	await here.plugin.persist();
	assert.equal(here.disk.data.settings.apiKeys.grillcloud, theirs);
	assert.equal(here.plugin.data.settings.apiKeys.grillcloud, theirs);

	// Start free on a device that hasn't seen the other's key uses it, not a new one.
	const late = await boot({ provider: "openai" });
	late.disk.data.settings.apiKeys = { ...late.disk.data.settings.apiKeys, grillcloud: theirs };
	await late.plugin.startCloud();
	assert.equal(late.plugin.data.settings.apiKeys.grillcloud, theirs);
	assert.ok(seen.every((r) => r.auth === `Bearer ${theirs}`));

	// A key the other device switched to on purpose (it let ours go) is followed here,
	// and ours is kept.
	const mine = late.plugin.data.settings.apiKeys.grillcloud;
	const other = newCloudKey();
	late.disk.data.settings.apiKeys.grillcloud = other;
	late.disk.data.settings.retiredCloudKeys = [mine];
	let told = 0;
	late.plugin.cloudListeners.add(() => told++);
	await late.plugin.onExternalSettingsChange();
	assert.equal(late.plugin.data.settings.apiKeys.grillcloud, other);
	assert.deepEqual(late.plugin.data.settings.retiredCloudKeys, [mine]);
	assert.equal(told, 1);
	// And the replaced one never comes back by itself from a stale file.
	late.disk.data.settings.apiKeys.grillcloud = mine;
	await late.plugin.persist();
	assert.equal(late.plugin.data.settings.apiKeys.grillcloud, other);
	assert.equal(late.disk.data.settings.apiKeys.grillcloud, other);
	// A blank in the file never clears a key held here.
	late.disk.data.settings.apiKeys.grillcloud = "";
	await late.plugin.onExternalSettingsChange();
	assert.equal(late.plugin.data.settings.apiKeys.grillcloud, other);
});

test("a key Grill 6.2.0 left in the keychain is moved back once, and can't return after being let go of", async () => {
	cloud.url = URL;
	server({ account: true, credits: 700, granted: false });
	const key = newCloudKey();
	const secrets: Record<string, string> = { "grill-abc123-grillcloud": key };
	const kc = {
		getSecret: (id: string) => secrets[id] ?? null,
		setSecret: (id: string, v: string) => void (secrets[id] = v),
		deleteSecret: (id: string) => delete secrets[id],
	};
	const local: Record<string, unknown> = {};
	const up = await boot({ provider: "grillcloud", apiKeys: { grillcloud: "" } }, local, kc);
	assert.equal(up.plugin.data.settings.apiKeys.grillcloud, key);
	assert.equal(up.disk.data.settings.apiKeys.grillcloud, key, "back in the vault's settings");
	assert.equal(secrets["grill-abc123-grillcloud"], undefined, "and out of the keychain");
	await up.plugin.forgetCloudKey();
	const next = await boot({ provider: "grillcloud", apiKeys: { grillcloud: "" }, retiredCloudKeys: [key] }, local, kc);
	assert.equal(next.plugin.data.settings.apiKeys.grillcloud, "");
});

test("two devices that each made a key before hearing of the other's settle on the same one", async () => {
	cloud.url = URL;
	server();
	const a = await boot();
	const b = await boot();
	await a.plugin.startCloud();
	// A different device: it has none of the first one's own storage.
	device.clear();
	await b.plugin.startCloud();
	const ka = a.plugin.data.settings.apiKeys.grillcloud;
	const kb = b.plugin.data.settings.apiKeys.grillcloud;
	const winner = ka < kb ? ka : kb;
	const loser = ka < kb ? kb : ka;
	// Each device's file reaches the other.
	a.disk.data.settings.apiKeys.grillcloud = kb;
	b.disk.data.settings.apiKeys.grillcloud = ka;
	await a.plugin.onExternalSettingsChange();
	await b.plugin.onExternalSettingsChange();
	for (const d of [a, b]) {
		assert.equal(d.plugin.data.settings.apiKeys.grillcloud, winner);
		assert.deepEqual(d.plugin.data.settings.retiredCloudKeys, [loser], "the other is kept, not thrown away");
	}
	// And they stay there through further rounds of saving and syncing.
	for (let round = 0; round < 3; round++) {
		await a.plugin.persist();
		b.disk.data = JSON.parse(JSON.stringify(a.disk.data));
		await b.plugin.persist();
		a.disk.data = JSON.parse(JSON.stringify(b.disk.data));
	}
	assert.equal(a.plugin.data.settings.apiKeys.grillcloud, winner);
	assert.equal(b.plugin.data.settings.apiKeys.grillcloud, winner);
	// A key the other side deliberately replaced is still followed, whichever is smaller.
	const next = newCloudKey();
	b.disk.data.settings.apiKeys.grillcloud = next;
	b.disk.data.settings.retiredCloudKeys = [winner, loser];
	await b.plugin.onExternalSettingsChange();
	assert.equal(b.plugin.data.settings.apiKeys.grillcloud, next);
});

test("a deleted key stays deleted on every device", async () => {
	cloud.url = URL;
	server();
	const localA: Record<string, unknown> = {};
	const localB: Record<string, unknown> = {};
	const a = await boot({}, localA);
	await a.plugin.startCloud();
	const key = a.plugin.data.settings.apiKeys.grillcloud;
	// B has the same vault open, with the key in memory and in its own copy.
	const b = await boot(JSON.parse(JSON.stringify(a.disk.data.settings)), localB);
	assert.equal(b.plugin.data.settings.apiKeys.grillcloud, key);
	assert.equal(await a.plugin.deleteCloud(), null);
	assert.deepEqual(a.disk.data.settings.cloudGone, [await cloudAccount(key)], "remembered by its id, never the key");
	assert.equal((localA["grill-cloud"] as any).key, "");
	// A's file reaches B: B lets go of it instead of writing it back.
	b.disk.data = JSON.parse(JSON.stringify(a.disk.data));
	await b.plugin.persist();
	assert.equal(b.plugin.data.settings.apiKeys.grillcloud, "");
	assert.equal(b.disk.data.settings.apiKeys.grillcloud, "");
	assert.deepEqual(b.plugin.data.settings.retiredCloudKeys, []);
	// A device that was closed during the delete doesn't restore it from its own copy.
	const c = await boot(JSON.parse(JSON.stringify(a.disk.data.settings)), { "grill-cloud": { key, retired: [], gone: [] } });
	assert.equal(c.plugin.data.settings.apiKeys.grillcloud, "");
	// Nor does a stale file that still has it, even after a restart (the record is on disk).
	const d = await boot({ ...JSON.parse(JSON.stringify(a.disk.data.settings)), apiKeys: { grillcloud: key } }, {});
	assert.equal(d.plugin.data.settings.apiKeys.grillcloud, "");
	// A device still on 6.2.0 dropped the record from the shared file: this device's own copy has it.
	const e = await boot({ apiKeys: { grillcloud: key } }, localA);
	assert.equal(e.plugin.data.settings.apiKeys.grillcloud, "");
});

test("a Start free that doesn't get through leaves things as they were, and asking again gets the free credits", async () => {
	cloud.url = URL;
	const { state, seen } = server({ down: true });
	const { plugin } = await boot({ provider: "openai", questionSource: "local", gradingMode: "self" });
	assert.match(await plugin.startCloud(), /Couldn't reach Grill Cloud/);
	const s = plugin.data.settings;
	assert.deepEqual([s.provider, s.questionSource, s.gradingMode], ["openai", "local", "self"], "not left on a mode that can't work");
	assert.ok(isCloudKey(s.apiKeys.grillcloud), "the key is kept for the next try");
	state.down = false;
	assert.match(await plugin.startCloud(), /25 free credits/);
	assert.deepEqual([s.provider, s.questionSource, s.gradingMode], ["grillcloud", "ai", "ai"]);
	assert.equal(seen.filter((r) => r.path === "/start").length, 2);
});

test("a request told to wait behind another asks again quietly; a stale buy button opens nothing", async () => {
	cloud.url = URL;
	cloud.packs = [
		{ credits: 400, price: "$3.99", url: "https://buy.stripe.com/small" },
		{ credits: 1000, price: "$9.99", url: "https://buy.stripe.com/abc" },
	];
	const { state } = server();
	const { plugin } = await boot();
	await plugin.startCloud();
	const real = net.handler;
	let chats = 0;
	net.handler = async (req) => {
		if (req.url.endsWith("/chat/completions") && ++chats <= 2)
			return { status: 429, json: { error: { message: "Another request of yours is still running. Try again in a moment.", code: "wait" } }, text: "" };
		return real(req);
	};
	cloudWait.ms = 1;
	assert.equal(await testModel(plugin.llmConfig()), null, "the student never sees the wait");
	assert.equal(chats, 3);
	// It gives up in the end, in the server's words.
	chats = -100;
	net.handler = async (req) =>
		req.url.endsWith("/chat/completions") ? { status: 429, json: { error: { message: "Another request of yours is still running. Try again in a moment.", code: "wait" } }, text: "" } : real(req);
	assert.match((await testModel(plugin.llmConfig())) ?? "", /still running/);
	net.handler = real;
	void state;

	const opened: string[] = [];
	(globalThis as any).open = (u: string) => opened.push(u);
	plugin.openCloudCheckout("https://buy.stripe.com/small?client_reference_id=someone-elses");
	assert.deepEqual(opened, []);
	assert.equal(plugin.cloudWaitingFrom, null);
});

test("a natural voice is asked for only when switched on, fetched once per text, and falls back to the device's voice", async () => {
	cloud.url = URL;
	const { seen } = server({ credits: 300, account: true, granted: false });
	const key = newCloudKey();
	const { plugin } = await boot({ provider: "grillcloud", apiKeys: { grillcloud: key } });
	let played = 0;
	(globalThis as any).Audio = class {
		onended: (() => void) | null = null;
		play(): Promise<void> {
			played++;
			return Promise.resolve();
		}
		pause(): void {}
	};
	// The clip finishing, as far as the player is concerned.
	const finish = (): void => stopSpeaking();
	const real = net.handler;
	let audioOk = true;
	net.handler = async (req) => {
		const r = await real(req);
		if (req.url.endsWith("/balance")) return { ...r, json: { ...(r.json as object), speech: true } };
		if (req.url.endsWith("/speech")) {
			return audioOk
				? ({ status: 200, headers: { "x-grill-cost": "0.63", "x-grill-credits": "299" }, arrayBuffer: new Uint8Array([1, 2, 3]).buffer, json: null, text: "" } as any)
				: { status: 502, json: { error: { message: "The voice had a problem. You weren't charged.", code: "voice_error" } }, text: "" };
		}
		return r;
	};
	await plugin.refreshCloud();
	assert.equal(plugin.naturalVoiceSource(), "cloud");
	const speech = (): number => seen.filter((r) => r.path === "/speech").length;

	// Switched off, the text goes nowhere: the device's own voice reads it.
	plugin.data.settings.naturalVoice = false;
	await plugin.readAloud("What is the natural level of output?");
	assert.equal(speech(), 0);

	// It is on unless switched off, and nothing is sent until a speaker is pressed.
	plugin.data.settings.naturalVoice = true;
	plugin.cloudSessionSpent = 0;
	await plugin.readAloud("What is the natural level of output?");
	assert.equal(speech(), 1);
	assert.deepEqual(seen.at(-1)!.body, { text: "What is the natural level of output?" });
	assert.equal(seen.at(-1)!.auth, `Bearer ${key}`);
	assert.equal(played, 1);
	assert.equal(plugin.cloudSessionSpent, 0.63, "counted in the session's receipt");
	// The same button while it is playing is "stop": nothing is fetched, nothing is played over it.
	await plugin.readAloud("What is the natural level of output?");
	assert.deepEqual([speech(), played], [1, 1]);
	// Hearing it again afterwards is free.
	await plugin.readAloud("What is the natural level of output?");
	assert.deepEqual([speech(), played], [1, 2]);
	finish();
	// Three quick presses on a new text: one request, and the voice never doubles up.
	const three = [plugin.readAloud("Why does the CPI differ?"), plugin.readAloud("Why does the CPI differ?"), plugin.readAloud("Why does the CPI differ?")];
	await Promise.all(three);
	assert.equal(speech(), 2);
	assert.ok(played <= 3, `played ${played} times`);
	finish();

	// The voice fails: say so, and read it in the device's voice.
	audioOk = false;
	notices.length = 0;
	await plugin.readAloud("A different question entirely?");
	assert.ok(notices.some((n) => n.includes("The voice had a problem") && n.includes("device's voice")));
	// On a provider with no voice of its own, there is nothing to ask.
	plugin.data.settings.provider = "anthropic";
	assert.equal(plugin.naturalVoiceSource(), null);
	plugin.data.settings.provider = "openai";
	plugin.data.settings.apiKeys.openai = "sk-x";
	assert.equal(plugin.naturalVoiceSource(), "openai");
});

test("the device's own key is never dropped at launch, whatever the settings file says", async () => {
	cloud.url = URL;
	server();
	const local: Record<string, unknown> = {};
	const a = await boot({}, local);
	await a.plugin.startCloud();
	const mine = a.plugin.data.settings.apiKeys.grillcloud;
	// While this device was closed, another one wrote a different key into the file,
	// without having retired ours (it never saw it).
	const theirs = newCloudKey();
	const again = await boot({ provider: "grillcloud", apiKeys: { grillcloud: theirs } }, local);
	const s = again.plugin.data.settings;
	// Whichever of the two ends up in use, the other is kept, on disk and on the device.
	assert.deepEqual([s.apiKeys.grillcloud, ...s.retiredCloudKeys].sort(), [mine, theirs].sort());
	const kept = local["grill-cloud"] as { key: string; retired: string[] };
	assert.deepEqual([kept.key, ...kept.retired].sort(), [mine, theirs].sort());
	assert.deepEqual([again.disk.data.settings.apiKeys.grillcloud, ...again.disk.data.settings.retiredCloudKeys].sort(), [mine, theirs].sort());
});

test("a deleted key can't be put back into use, and says why", async () => {
	cloud.url = URL;
	const known = new Set<string>();
	server({ known });
	const { plugin } = await boot();
	await plugin.startCloud();
	const key = plugin.data.settings.apiKeys.grillcloud;
	assert.equal(await plugin.deleteCloud(), null);
	// The server might even still answer for it (a payment landed late): it stays gone.
	known.add(`Bearer ${key}`);
	assert.match((await plugin.useCloudKey(key)) ?? "", /was deleted from this vault/);
	assert.equal(plugin.data.settings.apiKeys.grillcloud, "");
});

test("a diagram can't break the session note it is written into", async () => {
	const { cleanDiagram } = await import("../src/llm");
	assert.equal(cleanDiagram("flowchart TD\n  A --> B"), "flowchart TD\n  A --> B");
	// The model wrapped it in a fence of its own: the fence comes off.
	assert.equal(cleanDiagram("```mermaid\nflowchart TD\n  A --> B\n```"), "flowchart TD\n  A --> B");
	assert.equal(cleanDiagram("```\nflowchart LR\n  A --> B\n```  "), "flowchart LR\n  A --> B");
	// One that would still close the note's fence early is dropped whole.
	assert.equal(cleanDiagram("flowchart TD\n  A --> B\n```\n## Not a heading"), "");
	assert.equal(cleanDiagram(""), "");
});

test("one balance per device: Start free in a second vault uses the key the first one made", async () => {
	cloud.url = URL;
	const { seen } = server({ credits: 814, granted: false });
	const first = await boot();
	await first.plugin.startCloud();
	const key = first.plugin.data.settings.apiKeys.grillcloud;
	// Another vault on the same device: its own settings, its own Obsidian storage.
	const second = await boot({}, {}, undefined, true);
	assert.equal(second.plugin.data.settings.apiKeys.grillcloud, "", "nothing happens until it is asked for");
	assert.equal(second.plugin.deviceCloudKey(), key);
	assert.equal(await second.plugin.startCloud(), "Grill Cloud is on. 814 credits left.");
	assert.equal(second.plugin.data.settings.apiKeys.grillcloud, key);
	assert.ok(seen.every((r) => r.auth === `Bearer ${key}`), "no second key was ever made");
	// A vault that deliberately let go of that key makes its own instead.
	await second.plugin.forgetCloudKey();
	await second.plugin.startCloud();
	assert.notEqual(second.plugin.data.settings.apiKeys.grillcloud, key);
	// Deleting the account takes the key off the device too, so no other vault picks it up.
	const third = await boot({}, {}, undefined, true);
	const shared = third.plugin.deviceCloudKey();
	await third.plugin.startCloud();
	assert.equal(third.plugin.data.settings.apiKeys.grillcloud, shared);
	assert.equal(await third.plugin.deleteCloud(), null);
	assert.equal(third.plugin.deviceCloudKey(), "");
	// A vault that still held the deleted key lets go of it when it next saves or loads,
	// and never hands it back to the device.
	const stale = await boot({ provider: "grillcloud", apiKeys: { grillcloud: shared } }, {}, undefined, true);
	assert.equal(stale.plugin.data.settings.apiKeys.grillcloud, "");
	assert.equal(stale.plugin.deviceCloudKey(), "");
	const fresh = await boot({}, {}, undefined, true);
	assert.equal(fresh.plugin.sharesDeviceCloud(), false);
	// On a device with no shared storage at all, each vault keeps its own key as before.
	const real = (globalThis as any).localStorage;
	(globalThis as any).localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
	const alone = await boot({}, {}, undefined, true);
	await alone.plugin.startCloud();
	assert.ok(isCloudKey(alone.plugin.data.settings.apiKeys.grillcloud));
	(globalThis as any).localStorage = real;
});
