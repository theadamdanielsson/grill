/** The Grill Cloud account a vault is on: its key, balance, packs and plan as the server
 * last said, buying and waiting for a purchase to land, and keeping the key safe across
 * devices and vaults. The plugin holds one; screens read it and are told when it changes. */

import { Notice } from "obsidian";
import type GrillPlugin from "./main";
import type { PluginData } from "./main";
import { cloud, CloudPack, CloudPlan, cloudAccount, cloudBalance, cloudCheckoutUrl, cloudDelete, cloudEnabled, cloudStart, creditsInWords, isCloudKey, newCloudKey } from "./cloud";
import { RefillModal } from "./refill";
import { GONE_KEYS_KEPT, isAccountId, RETIRED_KEYS_KEPT, type GrillSettings } from "./settings";

/** Where the key in use is noted for the other vaults on this device. */
const DEVICE_CLOUD_KEY = "grill-cloud-device-key";
const DEVICE_CLOUD_GONE = "grill-cloud-device-gone";


/** What the account needs of the plugin. */
export type CloudHost = Pick<GrillPlugin, "app" | "data" | "keys" | "settings" | "persist" | "registerInterval" | "loadData" | "account" | "openSettings">;

export class CloudAccount {
	constructor(private host: CloudHost) {}

	/** Grill Cloud credits left as last heard from the server; null until known. */
	cloudCredits: number | null = null;
	/** Whether Grill Cloud can read aloud in a natural voice, as it last said. */
	cloudSpeech = false;

	/** Credits the session under way has used. The view zeroes it when one starts. */
	cloudSessionSpent = 0;

	/** What has been spent since this was last asked, and start counting again. */
	takeCloudSpend(): number {
		const spent = this.cloudSessionSpent;
		this.cloudSessionSpent = 0;
		return spent;
	}

	/** A session has ended: keep what it cost, to say back later. Returns the cost, or
	 * 0 if it used nothing (not on Grill Cloud, or nothing was asked of it). */
	async noteCloudSession(extra = 0): Promise<number> {
		return this.recordCloudSession(this.takeCloudSpend() + extra);
	}

	/** Keep `used` as what a session cost, without touching the running count. */
	async recordCloudSession(used: number): Promise<number> {
		// Whole credits, and never "0" for a session that did use something.
		const spent = used > 0 ? Math.max(1, Math.round(used)) : 0;
		if (spent <= 0 || this.host.data.settings.provider !== "grillcloud") return 0;
		this.host.data.settings.cloudUsage = [...this.host.data.settings.cloudUsage, spent].slice(-10);
		await this.host.persist();
		return spent;
	}
	/** What the last look at the server found:
	 *  unknown  not asked yet            offline  couldn't be reached
	 *  ok       there is an account      refused  it answered with an error (see cloudNote)
	 *  none     it has no account for this key yet: no starter was given and nothing
	 *           has been bought. Buying credits is what opens it. */
	cloudState: "unknown" | "ok" | "offline" | "refused" | "none" = "unknown";
	/** The server's own words, when it refused. */
	cloudNote = "";
	/** Whether credits can be bought right now, as the server last said. */
	cloudSales = true;
	/** How many purchases the server has credited to this key. */
	cloudPurchases: number | null = null;
	/** The packs on sale with their checkout links for the key in use, ready so a click
	 * can open one at once. Emptied the moment the key changes, so a click can never
	 * pay into a key no longer held. */
	cloudPacks: Array<CloudPack & { link: string }> = [];
	/** The monthly plan running for the key in use, as the server last said. */
	cloudPlan: CloudPlan | null = null;
	/** Whether the plan can be bought right now, as the server last said. */
	private cloudPlans = false;
	/** The plan's checkout link for the key in use. Emptied with the packs. */
	private cloudPlanLink = "";
	/** Keys this session deleted from the server: never taken back from a stale copy. */
	private cloudGone = new Set<string>();
	/** Told whenever the balance, the key or a wait changes, so every open Grill view
	 * can redraw. (The settings tab has cloudArrived, which also carries the numbers.) */
	cloudListeners = new Set<() => void>();
	tellCloud(): void {
		for (const heard of [...this.cloudListeners]) {
			try {
				heard();
			} catch (e) {
				console.error("Grill: a screen failed to redraw", e);
			}
		}
	}

	/** Whether buying credits would work right now. With no account yet ("none") it
	 * does: a purchase is what opens one. Not while the server can't be reached or is
	 * refusing: what it last said about sales may no longer hold. */
	get cloudCanBuy(): boolean {
		return this.cloudPacks.length > 0 && this.cloudSales && this.cloudState !== "offline" && this.cloudState !== "refused";
	}

	/** Whether subscribing would work right now: the plan is on sale and this key has none. */
	get cloudCanSubscribe(): boolean {
		return this.cloudPlanLink !== "" && this.cloudPlans && this.cloudPlan === null && (this.cloudState === "ok" || this.cloudState === "none");
	}

	/** Whether the credit packs are offered right now. With the plan on sale they are
	 * what a subscriber reaches for once a limit is hit, and nothing else: someone
	 * without the plan is offered the plan. Where no plan is sold, packs are the offer. */
	get cloudShowPacks(): boolean {
		if (!this.cloudCanBuy) return false;
		// A subscriber needs them only at a limit. Everyone else may pay as they go: the
		// plan is offered first, not instead.
		if (this.cloudPlan !== null) return this.cloudPlan.limit !== "";
		return true;
	}

	private async linkCloudCheckout(key: string): Promise<void> {
		this.cloudPacks = [];
		this.cloudPlanLink = "";
		if (!isCloudKey(key)) return;
		const packs: Array<CloudPack & { link: string }> = [];
		for (const pack of cloud.packs) {
			if (pack.url) packs.push({ ...pack, link: await cloudCheckoutUrl(key, pack.url) });
		}
		const id = await cloudAccount(key);
		const planLink = cloud.plan.url ? await cloudCheckoutUrl(key, cloud.plan.url) : "";
		if (this.host.data.settings.apiKeys.grillcloud === key) {
			this.cloudPacks = packs;
			this.cloudPlanLink = planLink;
			this.cloudAccountId = id;
		}
	}
	/** The account id of the key in use (its hash; never the key): what to quote when
	 * asking for credits to be moved here from a lost key. */
	cloudAccountId = "";

	// A Grill Cloud key is the only handle on money already paid, and it lives in
	// data.json, a file that other devices rewrite whole: one still on Grill 6.2.0
	// blanks keys it finds there, and any device saves over what another just wrote.
	// So the key and the keys before it are also kept on this device, outside the
	// synced file, and what is on disk is read again before every save.

	private cloudBackup(): { key: string; retired: string[]; gone: string[] } {
		try {
			const raw = (this.host.app as unknown as { loadLocalStorage?: (k: string) => unknown }).loadLocalStorage?.("grill-cloud");
			const kept = (typeof raw === "string" ? JSON.parse(raw) : raw) as { key?: unknown; retired?: unknown; gone?: unknown } | null;
			return {
				key: typeof kept?.key === "string" && isCloudKey(kept.key) ? kept.key : "",
				retired: Array.isArray(kept?.retired) ? kept.retired.filter((k): k is string => typeof k === "string" && isCloudKey(k)) : [],
				gone: Array.isArray(kept?.gone) ? kept.gone.filter(isAccountId) : [],
			};
		} catch {
			return { key: "", retired: [], gone: [] };
		}
	}

	// One balance for every vault on a device. A vault's settings and Obsidian's own
	// storage are both per vault, so each vault would otherwise make its own key and
	// its own balance, and the only way to share one was to copy the key across by
	// hand. The window's storage is shared by all vaults on the device, so the key in
	// use is also noted there, and Start free in another vault picks it up.

	/** The Grill Cloud key last used on this device, in any vault, if there is one. */
	/** Whether Start free here would join a balance already on this device. */
	sharesDeviceCloud(): boolean {
		const shared = this.deviceCloudKey();
		const s = this.host.data.settings;
		return !!shared && !s.apiKeys.grillcloud && !s.retiredCloudKeys.includes(shared) && !this.cloudGone.has(shared);
	}

	deviceCloudKey(): string {
		try {
			const key = window.localStorage.getItem(DEVICE_CLOUD_KEY) ?? "";
			return isCloudKey(key) ? key : "";
		} catch {
			return "";
		}
	}

	private setDeviceCloudKey(key: string): void {
		try {
			if (key) window.localStorage.setItem(DEVICE_CLOUD_KEY, key);
			else window.localStorage.removeItem(DEVICE_CLOUD_KEY);
		} catch {
			// No shared storage here: each vault keeps its own key, as before.
		}
	}

	/** Account ids of keys deleted in any vault on this device. A vault's own record of
	 * a deletion is per vault; without this, another vault still holding the key would
	 * carry on with a dead account, and hand it to the next vault that starts. */
	private deviceCloudGone(): string[] {
		try {
			const kept = JSON.parse(window.localStorage.getItem(DEVICE_CLOUD_GONE) ?? "[]") as unknown;
			return Array.isArray(kept) ? kept.filter(isAccountId) : [];
		} catch {
			return [];
		}
	}

	private addDeviceCloudGone(id: string): void {
		try {
			window.localStorage.setItem(DEVICE_CLOUD_GONE, JSON.stringify([...new Set([...this.deviceCloudGone(), id])].slice(-GONE_KEYS_KEPT)));
		} catch {
			// This vault's own record still holds.
		}
	}

	saveCloudBackup(): void {
		const s = this.host.data.settings;
		if (isCloudKey(s.apiKeys.grillcloud)) this.setDeviceCloudKey(s.apiKeys.grillcloud);
		try {
			(this.host.app as unknown as { saveLocalStorage?: (k: string, v: unknown) => void }).saveLocalStorage?.("grill-cloud", {
				key: isCloudKey(s.apiKeys.grillcloud) ? s.apiKeys.grillcloud : "",
				retired: s.retiredCloudKeys,
				gone: s.cloudGone,
			});
		} catch {
			// The copy in data.json is still there.
		}
	}

	private keepRetired(...more: string[][]): void {
		const s = this.host.data.settings;
		const all = [...s.retiredCloudKeys, ...more.flat()].filter((k) => isCloudKey(k) && k !== s.apiKeys.grillcloud && !this.cloudGone.has(k));
		s.retiredCloudKeys = [...new Set(all)].slice(0, RETIRED_KEYS_KEPT);
	}

	private clearCloudState(): void {
		this.cloudPacks = [];
		this.cloudPlanLink = "";
		this.cloudPlan = null;
		this.cloudCredits = null;
		this.cloudPurchases = null;
		this.cloudState = "unknown";
		this.cloudNote = "";
	}

	/** Take in what was found somewhere other than memory (this device's own copy, or
	 * the settings file as another device left it): a key, earlier keys, and the ids of
	 * deleted keys. The rules, which every device applies the same way so they agree:
	 *  - a deleted key is never used again, here or anywhere it turns up;
	 *  - a blank never replaces a key;
	 *  - a key found there replaces the one here if the other side had let ours go,
	 *    or, when two devices each made a key before hearing of the other's, if it is
	 *    the smaller of the two: both sides then settle on the same one;
	 *  - whichever key loses is kept among the earlier keys, never thrown away.
	 * Returns whether the key in use changed. */
	private takeCloudKey(found: string, retired: string[], gone: string[]): Promise<boolean> {
		// One at a time: a merge reads the key, waits (hashing), then writes, and two
		// running at once from different copies of the file could each undo the other.
		const run = this.cloudMerging.then(() => this.mergeCloudKey(found, retired, gone));
		this.cloudMerging = run.catch(() => false);
		return run;
	}
	private cloudMerging: Promise<boolean> = Promise.resolve(false);

	private async mergeCloudKey(found: string, retired: string[], gone: string[]): Promise<boolean> {
		const s = this.host.data.settings;
		s.cloudGone = [...new Set([...s.cloudGone, ...gone.filter(isAccountId)])].slice(-GONE_KEYS_KEPT);
		const deleted = async (k: string): Promise<boolean> => isCloudKey(k) && (this.cloudGone.has(k) || s.cloudGone.includes(await cloudAccount(k)));
		let changed = false;
		if (await deleted(s.apiKeys.grillcloud)) {
			this.stopCloudWatch();
			s.apiKeys.grillcloud = "";
			this.clearCloudState();
			changed = true;
		}
		const mine = s.apiKeys.grillcloud;
		let theirs = retired;
		if (isCloudKey(found) && found !== mine && !s.retiredCloudKeys.includes(found) && !(await deleted(found))) {
			if (!isCloudKey(mine) || retired.includes(mine) || found < mine) {
				this.stopCloudWatch();
				s.apiKeys.grillcloud = found;
				if (isCloudKey(mine)) s.retiredCloudKeys = [mine, ...s.retiredCloudKeys];
				this.clearCloudState();
				changed = true;
			} else {
				theirs = [...retired, found];
			}
		}
		this.keepRetired(theirs);
		const kept: string[] = [];
		for (const k of s.retiredCloudKeys) if (!(await deleted(k))) kept.push(k);
		s.retiredCloudKeys = kept;
		return changed;
	}

	/** Called once at load, after the settings are read. */
	async restoreCloudKey(): Promise<boolean> {
		if (!cloudEnabled()) return false;
		const kept = this.cloudBackup();
		const s = this.host.data.settings;
		const before = JSON.stringify([s.retiredCloudKeys, s.cloudGone, s.apiKeys.grillcloud]);
		// A key Grill 6.2.0 left in the keychain that isn't the one in use is kept too.
		const rescued = this.host.keys.rescuedKey && this.host.keys.rescuedKey !== s.apiKeys.grillcloud ? [this.host.keys.rescuedKey] : [];
		// The key this device kept is always handed over: used if the file has none, and
		// otherwise kept among the earlier keys. (Left out, a different key in the file
		// would simply replace this device's record of it, and the only copy of a key
		// that may hold paid credits would be gone.)
		const mine = isCloudKey(kept.key) ? [kept.key] : [];
		await this.takeCloudKey(isCloudKey(s.apiKeys.grillcloud) ? "" : kept.key, [...kept.retired, ...rescued, ...mine], [...kept.gone, ...this.deviceCloudGone()]);
		this.saveCloudBackup();
		return JSON.stringify([s.retiredCloudKeys, s.cloudGone, s.apiKeys.grillcloud]) !== before;
	}

	/** Read the key as the settings file holds it right now. */
	async mergeCloudFromDisk(): Promise<boolean> {
		if (!cloudEnabled()) return false;
		let onDisk: Partial<GrillSettings> | undefined;
		try {
			onDisk = ((await this.host.loadData()) as Partial<PluginData> | null)?.settings;
		} catch {
			return false;
		}
		const key = onDisk?.apiKeys?.grillcloud;
		const retired = Array.isArray(onDisk?.retiredCloudKeys) ? onDisk.retiredCloudKeys.filter((k) => typeof k === "string") : [];
		// Deletions made in another vault on this device count here too.
		const gone = [...(Array.isArray(onDisk?.cloudGone) ? onDisk.cloudGone : []), ...this.deviceCloudGone()];
		return this.takeCloudKey(typeof key === "string" ? key : "", retired, gone);
	}

	/** Look at the balance. Asks nothing of the server but to look. */
	async refreshCloud(): Promise<void> {
		const key = this.host.data.settings.apiKeys.grillcloud;
		if (!cloudEnabled() || !isCloudKey(key)) return;
		if (!this.cloudPacks.length) await this.linkCloudCheckout(key);
		const r = await cloudBalance(key);
		// The key was replaced or deleted while the server was answering.
		if (this.host.data.settings.apiKeys.grillcloud !== key) return;
		if (!r.ok) {
			this.cloudState = r.offline ? "offline" : "refused";
			this.cloudNote = r.message;
			return;
		}
		this.cloudCredits = r.data.credits;
		this.cloudPurchases = r.data.purchases;
		this.cloudSales = r.data.sales;
		this.cloudPlan = r.data.plan ?? null;
		this.cloudPlans = r.data.plans === true;
		this.cloudSpeech = r.data.speech === true;
		cloud.streams = r.data.streams === true;
		cloud.tools = r.data.tools === true;
		cloud.search = r.data.search === true;
		this.cloudState = r.data.account ? "ok" : "none";
		this.cloudNote = "";
	}

	/** Turn Grill Cloud on for this vault: make a key, switch to it, open its account.
	 * The key is saved before the server is asked, so a lost reply can't leave a
	 * starter spent on a key nobody kept. Returns a line to show the user. */
	async startCloud(): Promise<string> {
		if (!cloudEnabled()) return "Grill Cloud isn't available in this version of Grill.";
		const s = this.host.data.settings;
		// Another device may have made this vault's key a moment ago.
		await this.mergeCloudFromDisk();
		let reused = false;
		if (!isCloudKey(s.apiKeys.grillcloud)) {
			// Another vault on this device may already have a key: use that one, so there
			// is one balance on the device and nothing to copy across. Not a key this
			// vault deliberately let go of or deleted.
			const shared = this.deviceCloudKey();
			const sharedId = shared ? await cloudAccount(shared) : "";
			const usable = shared && !s.retiredCloudKeys.includes(shared) && !this.cloudGone.has(shared) && !s.cloudGone.includes(sharedId) && !this.deviceCloudGone().includes(sharedId);
			s.apiKeys.grillcloud = usable ? shared : newCloudKey();
			reused = !!usable;
		}
		const was = { provider: s.provider };
		await this.host.settings.update({ provider: "grillcloud" });
		// That save reads the file first, and may have found another device's key there.
		const key = s.apiKeys.grillcloud;
		await this.linkCloudCheckout(key);
		const r = await cloudStart(key);
		if (!r.ok) {
			// Not reached: the key is kept (asking again uses it), but how Grill studies
			// goes back to what it was, so nobody is left on a mode that can't work.
			Object.assign(s, was);
			await this.host.persist();
			this.cloudState = r.offline ? "offline" : "refused";
			this.cloudNote = r.message;
			this.tellCloud();
			return r.message;
		}
		await this.refreshCloud();
		this.tellCloud();
		const credits = r.data.credits;
		if (r.data.granted) return `Grill Cloud is on. You have ${credits} free credits to start.`;
		// The free credits come once per computer: another vault here already had them.
		if (reused) return credits > 0 ? `Grill Cloud is on, with this computer's account. ${creditsInWords(credits)}.` : "Grill Cloud is on, with this computer's account. It has no credits left. Add credits in settings to begin.";
		if (credits > 0) return `Grill Cloud is on. ${creditsInWords(credits)}.`;
		return "Grill Cloud is on, with no free credits this time. Add credits in settings to begin.";
	}

	/** Put the key in use aside (never thrown away: it may still hold a balance). */
	private retireCloudKey(): void {
		const s = this.host.data.settings;
		const old = s.apiKeys.grillcloud;
		s.apiKeys.grillcloud = "";
		if (isCloudKey(old)) s.retiredCloudKeys = [old, ...s.retiredCloudKeys.filter((k) => k !== old)];
		this.keepRetired();
		// A copy Grill 6.2.0 left in the keychain must not bring it back.
		this.host.keys.dropUnkept();
		this.cloudPacks = [];
		this.cloudPlanLink = "";
		this.cloudPlan = null;
		this.cloudCredits = null;
		this.cloudPurchases = null;
		this.cloudState = "unknown";
		this.cloudNote = "";
	}

	/** Switch this vault to a key made elsewhere, to share that balance. Only a key the
	 * server already has an account for: a mistyped one would otherwise quietly become
	 * a new, empty account. Returns what went wrong, or null. */
	async useCloudKey(key: string): Promise<string | null> {
		if (this.cloudGone.has(key) || this.host.data.settings.cloudGone.includes(await cloudAccount(key))) {
			return "That key's account was deleted from this vault, so it can't be used again. Start free makes a new one.";
		}
		const r = await cloudBalance(key);
		if (!r.ok) return r.message;
		if (!r.data.account) return "No Grill Cloud account has that key. Check it was copied whole.";
		this.stopCloudWatch();
		this.retireCloudKey();
		const s = this.host.data.settings;
		s.apiKeys.grillcloud = key;
		// A key being brought back is in use again, not an earlier one.
		s.retiredCloudKeys = s.retiredCloudKeys.filter((k) => k !== key);
		this.cloudGone.delete(key);
		await this.host.persist();
		this.cloudCredits = r.data.credits;
		this.cloudPurchases = r.data.purchases;
		this.cloudSales = r.data.sales;
		this.cloudPlan = r.data.plan ?? null;
		this.cloudPlans = r.data.plans === true;
		this.cloudSpeech = r.data.speech === true;
		cloud.streams = r.data.streams === true;
		cloud.tools = r.data.tools === true;
		cloud.search = r.data.search === true;
		this.cloudState = "ok";
		await this.linkCloudCheckout(key);
		this.tellCloud();
		return null;
	}

	/** Erase this vault's Grill Cloud account on the server and forget its key. Any
	 * credits left on it are gone. The key is only dropped once the server confirms
	 * (or says there is no such account). Returns what went wrong, or null. */
	async deleteCloud(): Promise<string | null> {
		const s = this.host.data.settings;
		const key = s.apiKeys.grillcloud;
		if (!isCloudKey(key)) return "There's no Grill Cloud key in this vault.";
		const r = await cloudDelete(key);
		if (!r.ok) return r.message;
		this.stopCloudWatch();
		// Deleted for good, so it isn't kept among the earlier keys either, and a stale
		// copy of it elsewhere is never taken back.
		this.cloudGone.add(key);
		if (this.deviceCloudKey() === key) this.setDeviceCloudKey("");
		const goneId = await cloudAccount(key);
		this.addDeviceCloudGone(goneId);
		s.cloudGone = [...new Set([...s.cloudGone, goneId])].slice(-GONE_KEYS_KEPT);
		s.apiKeys.grillcloud = "";
		this.keepRetired();
		this.host.keys.dropUnkept();
		this.clearCloudState();
		// This device's own record first: it holds even if the shared file can't be saved.
		this.saveCloudBackup();
		try {
			await this.host.persist();
		} catch (e) {
			console.error("Grill: couldn't save settings after deleting the Grill Cloud account", e);
		}
		this.tellCloud();
		return null;
	}

	/** Stop using the key in this vault without touching the server. It is kept among
	 * the earlier keys. */
	async forgetCloudKey(): Promise<void> {
		this.stopCloudWatch();
		this.retireCloudKey();
		await this.host.persist();
		this.tellCloud();
	}

	/** Offer the packs in a pop-up, where credits ran short: `code` is the server's
	 * reason, `tail` anything worth adding (an answer that was kept). False when
	 * nothing is on sale right now, so the caller can say it some other way. */
	offerRefill(code: string, tail = ""): boolean {
		if (!this.cloudShowPacks && !this.cloudCanSubscribe) return false;
		RefillModal.show(this.host, code, tail);
		return true;
	}

	/** Open the checkout page for one pack (the largest, if none is named) for this
	 * vault's Grill Cloud account, then keep an eye on the server so the credits show
	 * up by themselves when the payment lands. */
	openCloudCheckout(link?: string): void {
		if (!this.cloudCanBuy) return;
		// A link from a screen drawn before the key changed opens nothing.
		const pack = link === undefined ? this.cloudPacks[this.cloudPacks.length - 1] : this.cloudPacks.find((p) => p.link === link);
		if (!pack) return;
		window.open(pack.link);
		this.watchCloudTopUp();
		this.tellCloud();
	}

	/** Open the checkout page for the monthly plan for this vault's Grill Cloud account,
	 * and watch for it to start the way a pack's arrival is watched for. */
	openCloudPlanCheckout(): void {
		if (!this.cloudCanSubscribe) return;
		window.open(this.cloudPlanLink);
		this.watchCloudTopUp();
		this.tellCloud();
	}

	/** Set while a purchase is being waited for: the balance when the wait began. */
	cloudWaitingFrom: number | null = null;
	/** The purchase count when the wait began (null until the server has said). A
	 * purchase arriving is this count going up; nothing else moves it. */
	private cloudWaitingPurchases: number | null = null;
	/** Whether the balance the wait is measured from was a real one. */
	private cloudWaitingKnown = false;
	/** Whether a plan was already running when the wait began. */
	private cloudWaitingPlan = false;
	/** Told when a waited-for purchase arrives (or the wait ends), so the settings tab
	 * can redraw and count the number up. */
	cloudArrived: ((from: number, to: number) => void) | null = null;
	private cloudWatchTimer: number | null = null;
	private cloudChecking = false;

	/** One look during a wait. True once a purchase has been credited: the wait is
	 * over, the user is told, and whoever is listening gets the old and new balance. */
	async checkCloudTopUp(): Promise<boolean> {
		// The timer and a return to the window can both ask at once; one look at a time.
		if (this.cloudWaitingFrom === null || this.cloudChecking) return false;
		this.cloudChecking = true;
		try {
			await this.refreshCloud();
		} finally {
			this.cloudChecking = false;
		}
		// Read after the answer: the wait may have ended, or its starting point moved.
		const from = this.cloudWaitingFrom;
		const to = this.cloudCredits;
		const purchases = this.cloudPurchases;
		if (from === null || to === null || purchases === null) return false;
		// A plan that wasn't running when the wait began is the purchase arriving.
		if (!this.cloudWaitingPlan && this.cloudPlan !== null) {
			this.stopCloudWatch(true);
			new Notice("Grill: your monthly plan is on.", 6000);
			try {
				this.cloudArrived?.(to, to);
			} catch (e) {
				console.error("Grill: settings failed to redraw", e);
			}
			this.tellCloud();
			return true;
		}
		// The wait began before the server had said how many purchases there were. This
		// first answer is the starting point, unless the balance has already jumped by
		// a pack's worth: then the purchase beat the first look, and that is an arrival.
		if (this.cloudWaitingPurchases === null) {
			const smallest = Math.min(...cloud.packs.map((p) => p.credits));
			if (!(this.cloudWaitingKnown && purchases > 0 && to - from >= smallest)) {
				this.cloudWaitingPurchases = purchases;
				if (!this.cloudWaitingKnown || to < from) this.cloudWaitingFrom = to;
				this.cloudWaitingKnown = true;
				return false;
			}
		} else if (purchases <= this.cloudWaitingPurchases) return false;
		this.stopCloudWatch(true);
		const added = to - from;
		new Notice(
			added > 0 ? `Grill: ${added.toLocaleString("en-US")} credits added. You have ${to.toLocaleString("en-US")}.` : `Grill: your purchase arrived. You have ${to.toLocaleString("en-US")} credits.`,
			6000,
		);
		try {
			this.cloudArrived?.(Math.min(from, to), to);
		} catch (e) {
			console.error("Grill: settings failed to redraw", e);
		}
		this.tellCloud();
		return true;
	}

	/** End the wait, whether or not anything arrived. */
	stopCloudWatch(quiet = false): void {
		const waiting = this.cloudWaitingFrom !== null;
		this.cloudWaitingFrom = null;
		this.cloudWaitingPurchases = null;
		if (this.cloudWatchTimer !== null) window.clearInterval(this.cloudWatchTimer);
		this.cloudWatchTimer = null;
		window.removeEventListener("focus", this.cloudOnFocus);
		if (waiting && !quiet) {
			try {
				this.cloudArrived?.(this.cloudCredits ?? 0, this.cloudCredits ?? 0);
			} catch (e) {
				console.error("Grill: settings failed to redraw", e);
			}
			this.tellCloud();
		}
	}

	/** Coming back from the browser is the likeliest moment the payment has landed. */
	private cloudOnFocus = (): void => void this.checkCloudTopUp();

	/** Check every few seconds, and whenever Obsidian regains focus, for ten minutes. */
	private watchCloudTopUp(): void {
		this.stopCloudWatch(true);
		this.cloudWaitingFrom = this.cloudCredits ?? 0;
		this.cloudWaitingKnown = this.cloudCredits !== null;
		this.cloudWaitingPlan = this.cloudPlan !== null;
		this.cloudWaitingPurchases = this.cloudState === "ok" || this.cloudState === "none" ? this.cloudPurchases : null;
		let checks = 0;
		this.cloudWatchTimer = window.setInterval(() => {
			if (++checks > 150) {
				this.stopCloudWatch();
				return;
			}
			void this.checkCloudTopUp();
		}, 4000);
		this.host.registerInterval(this.cloudWatchTimer);
		window.addEventListener("focus", this.cloudOnFocus);
	}
}
