/** Out of credits, said where it happens: a pop-up over the question with the packs on
 * it, so buying is one press away instead of a trip to settings. It stays up until a
 * pack is bought or it is put away, and while checkout is open in the browser it says
 * so and waits, the way the card in settings does.
 */

import { Modal } from "obsidian";
import type GrillPlugin from "./main";

/** What the pop-up says for each way credits fall short. The server's own sentences
 * point at settings, which is no longer where this is fixed, so these are said here. */
export function refillWords(code: string): { title: string; body: string } {
	if (code === "not_enough") return { title: "Not enough credits", body: "This request needs more than you have left. Add credits, or study a shorter note." };
	if (code === "free_paused") return { title: "Free use is paused", body: "Free use of Grill Cloud is paused for today. Add credits to keep going, or try again tomorrow." };
	return { title: "Out of credits", body: "Add credits to keep going." };
}

export class RefillModal extends Modal {
	/** The one that is up, if any: several refused requests in a row are one pop-up. */
	private static up: RefillModal | null = null;

	static show(plugin: GrillPlugin, code: string, tail = ""): void {
		if (RefillModal.up) return;
		new RefillModal(plugin, code, tail).open();
	}

	/** Which face is drawn, so a look at the server during a wait doesn't redraw it. */
	private face: "buy" | "wait" | null = null;
	/** The balance when checkout was opened: more than this afterwards is an arrival. */
	private before = 0;

	private constructor(
		private plugin: GrillPlugin,
		private code: string,
		private tail: string,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		RefillModal.up = this;
		this.modalEl.addClass("grill-refill-modal");
		this.plugin.cloudListeners.add(this.heard);
		this.draw();
	}

	onClose(): void {
		if (RefillModal.up === this) RefillModal.up = null;
		this.plugin.cloudListeners.delete(this.heard);
		this.contentEl.empty();
	}

	private heard = (): void => {
		const waiting = this.plugin.cloudWaitingFrom !== null;
		// The wait is over and there is more than there was: the purchase arrived.
		if (this.face === "wait" && !waiting && (this.plugin.cloudCredits ?? 0) > this.before) {
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

		if (this.plugin.cloudWaitingFrom !== null) {
			this.face = "wait";
			card.createEl("h3", { cls: "grill-refill-title", text: "Checkout is open in your browser" });
			card.createDiv({ cls: "grill-meta", text: "Credits show up here a few seconds after you pay." });
			const stop = card.createEl("button", { cls: "grill-refill-stop", text: "Stop checking" });
			stop.onclick = () => this.plugin.stopCloudWatch();
			return;
		}

		this.face = "buy";
		const words = refillWords(this.code);
		card.createEl("h3", { cls: "grill-refill-title", text: words.title });
		card.createDiv({ cls: "grill-meta", text: this.tail ? `${words.body} ${this.tail}` : words.body });
		const packs = card.createDiv({ cls: "grill-refill-packs" });
		const onSale = this.plugin.cloudCanBuy ? this.plugin.cloudPacks : [];
		for (const pack of onSale) {
			const b = packs.createEl("button", { cls: "grill-refill-pack" });
			b.createSpan({ text: `${pack.credits.toLocaleString("en-US")} credits` });
			b.createSpan({ cls: "grill-refill-price", text: `${pack.price} + tax${pack.note ? `, ${pack.note}` : ""}` });
			if (pack === onSale[onSale.length - 1]) b.addClass("mod-cta");
			b.onclick = () => {
				this.before = this.plugin.cloudCredits ?? 0;
				this.plugin.openCloudCheckout(pack.link);
			};
		}
		if (onSale.length) card.createDiv({ cls: "grill-cloud-card-foot", text: "Checkout by Stripe. Credits arrive here in a few seconds." });
		const links = card.createDiv({ cls: "grill-refill-links" });
		links.createEl("a", { text: "Not now" }).onclick = () => this.close();
		links.createEl("a", { text: "Use your own key" }).onclick = () => {
			this.close();
			this.plugin.openSettings();
		};
	}
}
