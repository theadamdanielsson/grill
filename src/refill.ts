/** Out of credits, said where it happens: a pop-up over the question with the packs on
 * it, so buying is one press away instead of a trip to settings. It stays up until a
 * pack is bought or it is put away, and while checkout is open in the browser it says
 * so and waits, the way the card in settings does.
 */

import { App, Modal } from "obsidian";
import type { CloudAccount } from "./cloudaccount";

/** What the pop-up needs of the plugin. */
export type RefillHost = { app: App; account: CloudAccount; openSettings(): void };
import { cloud, CloudPlan, PLAN_HEADLINE, PLAN_LEAD, PLAN_LIMITS, PLAN_PERKS, packPurpose, planBack, planLabel, planUsage } from "./cloud";

/** What the pop-up says for each way credits fall short. The server's own sentences
 * point at settings, which is no longer where this is fixed, so these are said here. */
export function refillWords(code: string): { title: string; body: string } {
	if (code === "not_enough") return { title: "Not enough credits", body: "This request needs more than you have left. Add credits, or study a shorter note." };
	if (code === "plan_limit") return { title: "Plan limit reached", body: "Your plan's usage limit is reached for now. Add credits to keep going, or wait for it to free up." };
	if (code === "free_paused") return { title: "Free use is paused", body: "Free use of Grill Cloud is paused for today. Add credits to keep going, or try again tomorrow." };
	return { title: "Out of credits", body: "Add credits to keep going." };
}

/** Where an offer's buy buttons go: the plan's column, and each pack's, in pack order. */
export interface OfferSlots {
	plan: HTMLElement;
	packs: HTMLElement[];
}

/** The plan and the packs as one row of prices, the plan in the middle and lit: what
 * Grill Cloud is and gets you above it, the terms below. Packs come smallest first;
 * the smallest stands left of the plan as the way to try it, the rest right of it.
 * The buttons are the caller's, put in the slots. */
export function drawOffers(parent: HTMLElement, packs: Array<{ credits: number; price: string }>, brief = false): OfferSlots {
	const offer = parent.createDiv({ cls: "grill-plan-offer" });
	// In the pop-up its own title says why it is up; the pitch would only repeat it.
	if (!brief) {
		offer.createDiv({ cls: "grill-plan-headline", text: PLAN_HEADLINE });
		offer.createDiv({ cls: "grill-plan-lead", text: PLAN_LEAD });
	}
	const perks = offer.createEl("ul", { cls: "grill-plan-perks" });
	for (const perk of PLAN_PERKS) perks.createEl("li", { text: perk });
	const tiers = offer.createDiv({ cls: "grill-tiers" });
	// One row however narrow: the plan reads as the middle of a set only beside the packs.
	if (tiers.style) tiers.style.gridTemplateColumns = `repeat(${packs.length + 1}, minmax(0, 1fr))`;
	const tier = (name: string, price: string, unit: string, extra: string, best = false): HTMLElement => {
		const t = tiers.createDiv({ cls: best ? "grill-tier is-best" : "grill-tier" });
		t.createDiv({ cls: "grill-tier-flag", text: best ? "BEST VALUE" : "" });
		t.createDiv({ cls: "grill-tier-name", text: name });
		t.createDiv({ cls: "grill-tier-price", text: price });
		t.createDiv({ cls: "grill-tier-unit", text: unit });
		t.createDiv({ cls: "grill-tier-extra", text: extra });
		return t.createDiv({ cls: "grill-tier-go" });
	};
	const credits = (n: number): string => `${n.toLocaleString("en-US")} credits`;
	const packTier = (i: number): HTMLElement =>
		tier(packPurpose(i, packs.length, true) === "try it" ? "Try it" : "No subscription", packs[i].price, "one time", credits(packs[i].credits));
	const slots: HTMLElement[] = [];
	if (packs.length > 1) slots[0] = packTier(0);
	const allowance = (cloud.plan as { credits?: number }).credits;
	const plan = tier("Monthly", cloud.plan.price, "a month", allowance ? `up to ${credits(allowance)}` : "", true);
	for (let i = packs.length > 1 ? 1 : 0; i < packs.length; i++) slots[i] = packTier(i);
	offer.createDiv({ cls: "grill-plan-fine", text: "Prices plus tax. Credits never expire. Cancel the plan anytime. Secure checkout by Stripe." });
	const limits = offer.createEl("details", { cls: "grill-plan-limits" });
	limits.createEl("summary", { text: "How the plan's limits work" });
	limits.createEl("p", { text: PLAN_LIMITS });
	return { plan, packs: slots };
}

/** What a pack's button says in the row of prices; its price is above it. */
export function packGo(pack: { credits: number }): string {
	return `Get ${pack.credits.toLocaleString("en-US")} credits`;
}

/** A running plan's limits as bars: how much of each is used. Nothing when the
 * server didn't say. */
export function drawPlanUsage(parent: HTMLElement, plan: CloudPlan): void {
	const rows = planUsage(plan);
	if (!rows.length) return;
	const box = parent.createDiv({ cls: "grill-plan-usage" });
	for (const r of rows) {
		const row = box.createDiv({ cls: "grill-plan-usage-row" });
		row.createSpan({ cls: "grill-plan-usage-name", text: r.name });
		const bar = row.createDiv({ cls: "grill-plan-usage-bar" });
		bar.createDiv({ cls: "grill-plan-usage-fill" }).style.width = `${Math.round(r.used * 100)}%`;
		row.createSpan({ cls: "grill-plan-usage-pct", text: `${Math.round(r.used * 100)}% used` });
	}
}

export class RefillModal extends Modal {
	/** The one that is up, if any: several refused requests in a row are one pop-up. */
	private static up: RefillModal | null = null;

	static show(plugin: RefillHost, code: string, tail = ""): void {
		if (RefillModal.up) return;
		new RefillModal(plugin, code, tail).open();
	}

	/** Which face is drawn, so a look at the server during a wait doesn't redraw it. */
	private face: "buy" | "wait" | null = null;
	/** The balance when checkout was opened: more than this afterwards is an arrival. */
	private before = 0;
	/** Whether a plan was running when checkout was opened: one starting is an arrival too. */
	private hadPlan = false;

	private constructor(
		private plugin: RefillHost,
		private code: string,
		private tail: string,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		RefillModal.up = this;
		this.modalEl.addClass("grill-refill-modal");
		this.plugin.account.cloudListeners.add(this.heard);
		this.draw();
	}

	onClose(): void {
		if (RefillModal.up === this) RefillModal.up = null;
		this.plugin.account.cloudListeners.delete(this.heard);
		this.contentEl.empty();
	}

	private heard = (): void => {
		const waiting = this.plugin.account.cloudWaitingFrom !== null;
		// The wait is over and there is more than there was: the purchase arrived.
		if (this.face === "wait" && !waiting && ((this.plugin.account.cloudCredits ?? 0) > this.before || (!this.hadPlan && this.plugin.account.cloudPlan !== null))) {
			this.close();
			return;
		}
		if ((waiting ? "wait" : "buy") !== this.face) this.draw();
	};

	private draw(): void {
		const el = this.contentEl;
		el.empty();
		const card = el.createDiv({ cls: "grill-cloud-card grill-arcade-screen grill-refill" });
		card.createDiv({ cls: "grill-arcade-mark", text: "GRILL CLOUD" });

		if (this.plugin.account.cloudWaitingFrom !== null) {
			this.face = "wait";
			card.createEl("h3", { cls: "grill-refill-title", text: "Checkout is open in your browser" });
			card.createDiv({ cls: "grill-meta", text: "It shows up here a few seconds after you pay." });
			const stop = card.createEl("button", { cls: "grill-refill-stop", text: "Stop checking" });
			stop.onclick = () => this.plugin.account.stopCloudWatch();
			return;
		}

		this.face = "buy";
		const words = refillWords(this.code);
		card.createEl("h3", { cls: "grill-refill-title", text: words.title });
		const plan = this.plugin.account.cloudPlan;
		const onSale = this.plugin.account.cloudShowPacks ? this.plugin.account.cloudPacks : [];
		// Someone without the plan is offered the plan; packs are for a subscriber at a limit.
		const offerPlan = this.plugin.account.cloudCanSubscribe;
		const body =
			this.code === "plan_limit" && plan?.limit
				? `Your plan's usage limit is reached. It frees up again ${planBack(plan)}. Add credits to keep going now.`
				: offerPlan
					? this.code === "free_paused"
						? `Free use of Grill Cloud is paused for today. ${onSale.length ? "Get the monthly plan or add credits" : "Get the monthly plan"} to keep going, or try again tomorrow.`
						: onSale.length
							? "Get the monthly plan, or add credits to keep going."
							: "Get the monthly plan to keep going."
					: words.body;
		card.createDiv({ cls: "grill-meta", text: this.tail ? `${body} ${this.tail}` : body });
		const packs = card.createDiv({ cls: "grill-refill-packs" });
		const buyPack = (b: HTMLElement, pack: (typeof onSale)[number]): void => {
			b.onclick = () => {
				this.before = this.plugin.account.cloudCredits ?? 0;
				this.hadPlan = this.plugin.account.cloudPlan !== null;
				this.plugin.account.openCloudCheckout(pack.link);
			};
		};
		if (offerPlan) {
			const slots = drawOffers(packs, onSale, true);
			const b = slots.plan.createEl("button", { cls: "grill-plan-go mod-cta", text: planLabel() });
			b.onclick = () => {
				this.before = this.plugin.account.cloudCredits ?? 0;
				this.hadPlan = this.plugin.account.cloudPlan !== null;
				this.plugin.account.openCloudPlanCheckout();
			};
			onSale.forEach((pack, i) => buyPack(slots.packs[i].createEl("button", { cls: "grill-refill-pack", text: packGo(pack) }), pack));
		} else {
			for (const pack of onSale) {
				const b = packs.createEl("button", { cls: "grill-refill-pack" });
				b.createSpan({ text: `${pack.credits.toLocaleString("en-US")} credits` });
				b.createSpan({ cls: "grill-refill-price", text: `${pack.price} + tax${pack.note ? `, ${pack.note}` : ""}` });
				if (pack === onSale[onSale.length - 1]) b.addClass("mod-cta");
				buyPack(b, pack);
			}
		}
		if (onSale.length && !offerPlan) card.createDiv({ cls: "grill-cloud-card-foot", text: "Checkout by Stripe. Credits arrive here in a few seconds." });
		const links = card.createDiv({ cls: "grill-refill-links" });
		links.createEl("a", { text: "Not now" }).onclick = () => this.close();
		links.createEl("a", { text: "Use your own key" }).onclick = () => {
			this.close();
			this.plugin.openSettings();
		};
	}
}
