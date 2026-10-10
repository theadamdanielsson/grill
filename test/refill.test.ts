import { test } from "node:test";
import assert from "node:assert/strict";
import { RefillModal, refillWords } from "../src/refill";

/** An element that remembers what was put in it, so the pop-up's faces can be read. */
function rec(tag = "div", o: { cls?: string; text?: string } = {}): any {
	const el: any = { tag, cls: o.cls ?? "", text: o.text ?? "", kids: [] as any[], onclick: null as null | (() => void) };
	const add = (t: string, opts?: { cls?: string; text?: string }) => {
		const kid = rec(t, opts);
		el.kids.push(kid);
		return kid;
	};
	el.createDiv = (opts?: any) => add("div", opts);
	el.createSpan = (opts?: any) => add("span", opts);
	el.createEl = (t: string, opts?: any) => add(t, opts);
	el.addClass = (c: string) => void (el.cls += ` ${c}`);
	el.empty = () => void (el.kids = []);
	el.all = (): any[] => el.kids.flatMap((k: any) => [k, ...k.all()]);
	return el;
}

function fakePlugin() {
	const opened: string[] = [];
	const plugin: any = {
		app: {},
		cloudListeners: new Set<() => void>(),
		cloudWaitingFrom: null as number | null,
		cloudCredits: 0,
		cloudCanBuy: true,
		cloudPacks: [
			{ credits: 400, price: "$3.99", link: "small" },
			{ credits: 1100, price: "$9.99", note: "10% extra", link: "large" },
		],
		settingsOpened: 0,
		openSettings: () => void plugin.settingsOpened++,
		openCloudCheckout: (link: string) => {
			opened.push(link);
			plugin.cloudWaitingFrom = plugin.cloudCredits;
			tell();
		},
		stopCloudWatch: () => {
			plugin.cloudWaitingFrom = null;
			tell();
		},
	};
	const tell = () => [...plugin.cloudListeners].forEach((heard: () => void) => heard());
	return { plugin, opened, tell };
}

/** Put the pop-up up and hand back its card, drawn into an element that can be read. */
function show(plugin: any, code: string, tail = "") {
	RefillModal.show(plugin, code, tail);
	const modal = (RefillModal as any).up;
	modal.contentEl = rec();
	modal.draw();
	return { modal, card: () => modal.contentEl.kids[0] };
}
const texts = (card: any): string[] => card.all().map((k: any) => k.text).filter(Boolean);
const buttons = (card: any): any[] => card.all().filter((k: any) => k.tag === "button");

test("each way of running short has its own words, none of them pointing at settings", () => {
	assert.equal(refillWords("out_of_credits").title, "Out of credits");
	assert.equal(refillWords("").title, "Out of credits", "a 402 with no code reads as out of credits");
	assert.equal(refillWords("not_enough").title, "Not enough credits");
	assert.equal(refillWords("free_paused").title, "Free use is paused");
	for (const code of ["out_of_credits", "not_enough", "free_paused"]) assert.doesNotMatch(refillWords(code).body, /settings/i);
});

test("the pop-up offers every pack, opens checkout, waits, and closes when credits arrive", () => {
	const { plugin, opened, tell } = fakePlugin();
	const { modal, card } = show(plugin, "out_of_credits", "Your answer is still in the box.");
	assert.equal(plugin.cloudListeners.size, 1);
	assert.ok(texts(card()).includes("Add credits to keep going. Your answer is still in the box."));
	const packs = buttons(card());
	assert.deepEqual(packs.map((b) => b.kids.map((k: any) => k.text)), [
		["400 credits", "$3.99 + tax"],
		["1,100 credits", "$9.99 + tax, 10% extra"],
	]);
	assert.match(packs[1].cls, /mod-cta/, "the largest pack is the main button");
	assert.doesNotMatch(packs[0].cls, /mod-cta/);

	// A second refused request while it is up changes nothing.
	RefillModal.show(plugin, "not_enough");
	assert.equal((RefillModal as any).up, modal);

	packs[0].onclick();
	assert.deepEqual(opened, ["small"]);
	assert.ok(texts(card()).includes("Checkout is open in your browser"));

	// A look at the server that finds nothing new leaves the waiting face as it is.
	const waitingCard = card();
	tell();
	assert.equal(card(), waitingCard);

	// The purchase lands: the wait ends with more credits than before.
	plugin.cloudWaitingFrom = null;
	plugin.cloudCredits = 400;
	tell();
	assert.equal((RefillModal as any).up, null);
	assert.equal(plugin.cloudListeners.size, 0);
});

test("stopping the wait brings the packs back, and the links put it away", () => {
	const { plugin } = fakePlugin();
	const { card } = show(plugin, "free_paused");
	buttons(card())[1].onclick();
	buttons(card()).find((b) => b.text === "Stop checking").onclick();
	assert.ok(texts(card()).includes("Free use is paused"), "nothing arrived, so the offer is back");
	assert.equal((RefillModal as any).up !== null, true);

	const link = (text: string) => card().all().find((k: any) => k.tag === "a" && k.text === text);
	link("Use your own key").onclick();
	assert.equal(plugin.settingsOpened, 1);
	assert.equal((RefillModal as any).up, null);

	const again = show(plugin, "out_of_credits");
	again.card().all().find((k: any) => k.tag === "a" && k.text === "Not now").onclick();
	assert.equal((RefillModal as any).up, null);
	assert.equal(plugin.cloudListeners.size, 0);
});
