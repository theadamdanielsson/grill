/** What Grill Cloud says before it is started, wherever it is offered (onboarding, the
 * home screen's offer, settings): why pick it, what to know, exactly what is sent, and
 * what starting agrees to. One block, so the places can't drift apart. */

import { cloud } from "./cloud";
import { CLOUD_FACTS, CLOUD_PITCH } from "./cloudcopy";

/** Draws the pitch into `body`. `shared` says this device's other vaults already use
 * Grill Cloud, so starting here uses the same balance. */
export function drawCloudPitch(body: HTMLElement, shared: boolean): void {
	if (shared) body.createDiv({ cls: "grill-meta", text: "You already use Grill Cloud in another vault on this device. Starting here uses the same balance." });
	const facts = body.createDiv({ cls: "grill-cloud-facts" });
	for (const fact of CLOUD_FACTS) facts.createDiv({ cls: "grill-cloud-fact", text: fact });
	const more = body.createEl("details", { cls: "grill-cloud-more" });
	more.createEl("summary", { text: "What exactly is sent?" });
	more.createEl("p", { text: CLOUD_PITCH });
}

/** For ages 18 and over, and the terms and privacy policy, beside the start button. */
export function drawCloudAgreement(at: HTMLElement): void {
	if (!cloud.privacyUrl && !cloud.termsUrl) return;
	const legal = at.createDiv({ cls: "grill-cloud-agree grill-meta" });
	legal.appendText("For ages 18 and over. By starting you agree to the ");
	if (cloud.termsUrl) legal.createEl("a", { text: "terms", href: cloud.termsUrl });
	if (cloud.privacyUrl && cloud.termsUrl) legal.appendText(" and the ");
	if (cloud.privacyUrl) legal.createEl("a", { text: "privacy policy", href: cloud.privacyUrl });
	legal.appendText(".");
}
