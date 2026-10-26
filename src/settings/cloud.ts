/** The Grill Cloud section: one card for what it is, or the balance, the plan and the
 * packs; and the account row, to show, carry or replace the key. Not there at all in a
 * build without Grill Cloud. */

import { Notice, Setting } from "obsidian";
import { drawCloudAgreement, drawCloudPitch } from "../cloudcard";
import { CLOUD_LEAD } from "../cloudcopy";
import { cloud, planInWords, planLabel, cloudEnabled, creditsInWords, isCloudKey, packLabel, usageInWords } from "../cloud";
import { drawOffers, drawPlanUsage, packGo } from "../refill";
import { countUp, type Row, type SettingsCtx } from "./ctx";

export function cloudRows(ctx: SettingsCtx, all: boolean): Row[] {
	if (!cloudEnabled()) return [];
	const s = ctx.plugin.data.settings;
	const p = s.provider;
	const cloudKey = s.apiKeys.grillcloud;
	const credits = ctx.plugin.account.cloudCredits;
	const state = ctx.plugin.account.cloudState;
	const waiting = ctx.plugin.account.cloudWaitingFrom !== null;
	const plan = ctx.plugin.account.cloudPlan;
	const usingCloud = p === "grillcloud";
	const creditsLine = (n: number): string => `${usingCloud ? "In use" : "Not in use"}. ${creditsInWords(n)}.`;
	const start = (setting: Setting, label: string, cta: boolean): void => {
		setting.addButton((b) => {
			b.setButtonText(label).onClick(async () => {
				b.setDisabled(true);
				try {
					new Notice(`Grill: ${await ctx.plugin.account.startCloud()}`, 8000);
				} finally {
					ctx.rerender();
				}
			});
			if (cta) b.setCta();
			return b;
		});
	};
	// Grill Cloud has the first section of the page to itself, whichever provider is
	// in use, drawn as one card in Grill's own colours (themes restyle settings rows,
	// and a plain row doesn't sell anything): what it is, or the balance and what
	// sessions have cost, then the packs. The row's name and description are still
	// set, for the settings search; the card says the same in its own way.
	const usage = usageInWords(s.cloudUsage);
	const cloudRow: Row = {
		name: "Grill Cloud",
		desc: !cloudKey
			? "AI questions and grading, with nothing to set up."
			: state === "offline"
				? "Couldn't reach Grill Cloud."
				: state === "refused"
					? ctx.plugin.account.cloudNote
					: state === "none"
						? "No credits yet."
						: credits === null
							? "Checking your balance..."
							: waiting
								? `${creditsInWords(credits)}. Checkout is open in your browser. Credits show up here a few seconds after you pay.`
								: creditsLine(credits) + (usingCloud ? "" : " Another provider is selected below."),
		aliases: ["credits", "hosted", "no key", "no api key", "balance", "cloud", "free", "trial", "top up", "buy", "pay", "price"],
		build: (setting) => {
			setting.settingEl.addClass("grill-cloud-hero");
			const card = setting.settingEl.createDiv({ cls: "grill-view" }).createDiv({ cls: "grill-arcade-screen grill-cloud-card" });
			// No name in the card: the section heading above already says Grill Cloud.
			const head = card.createDiv({ cls: "grill-cloud-card-head" });
			// Top right: check balance, then whether it's in use.
			const corner = head.createDiv({ cls: "grill-cloud-card-corner" });
			const body = card.createDiv({ cls: "grill-cloud-card-body" });
			// The buttons are Obsidian's own, moved into the card.
			const controls = card.createDiv({ cls: "grill-cloud-buy" });
			controls.appendChild(setting.controlEl);
			// Obsidian redraws a row in place, so the card from the last draw is still
			// here: take it away now that the buttons have moved into the new one.
			setting.settingEl.querySelectorAll(":scope > .grill-view").forEach((old) => {
				if (!old.contains(card)) old.remove();
			});
			if (!cloudKey) {
				// Said before anything is sent: what it costs, what it needs, where notes go.
				body.createDiv({ cls: "grill-cloud-panel-lead", text: CLOUD_LEAD });
				drawCloudPitch(body, ctx.plugin.account.sharesDeviceCloud());
				drawCloudAgreement(card);
				start(setting, "Start free", true);
				return;
			}
			const known = (state === "ok" || state === "none") && credits !== null;
			// An empty balance is not the headline while the plan is on offer: the offer is.
			const empty = known && (credits ?? 0) <= 0 && ctx.plugin.account.cloudCanSubscribe && !plan && !waiting;
			// No number until the server has said one: a placeholder reads as a balance.
			const figure = body.createDiv({ cls: "grill-cloud-balance" });
			if (empty) figure.hide();
			// On the plan with no credits beside it, the plan is what there is to show.
			const onPlanOnly = known && plan !== null && (credits ?? 0) <= 0;
			const number = figure.createSpan({ cls: "grill-cloud-balance-number", text: onPlanOnly ? "On" : known ? (credits ?? 0).toLocaleString("en-US") : "" });
			if (known) figure.createSpan({ cls: "grill-cloud-balance-unit", text: onPlanOnly ? "monthly plan" : "credits" });
			// Free credits used up, no plan: the balance, what sessions cost and whether
			// Cloud is in use say nothing useful. The offer is the whole card.
			card.toggleClass("grill-cloud-offering", empty);
			if (!empty) body.createDiv({
				cls: "grill-meta",
				text:
					state === "offline" || state === "refused"
						? ctx.plugin.account.cloudNote || "Couldn't reach Grill Cloud."
						: state === "none"
							? "No credits yet."
							: !known
								? "Checking your balance..."
								: waiting
									? "Checkout is open in your browser. It shows up here a few seconds after you pay."
									: plan
										? planInWords(plan)
										: usage,
			});
			if (known && plan && !waiting) drawPlanUsage(body, plan);
			card.toggleClass("grill-cloud-waiting", waiting);
			if (!usingCloud && !empty) {
				setting.addButton((b) => {
					b.setButtonText("Use Grill Cloud").onClick(async () => {
						await ctx.plugin.settings.update({ provider: "grillcloud" });
						ctx.rerender();
					});
					// One lit button in the card: the plan's, when it is on offer.
					if (!ctx.plugin.account.cloudCanSubscribe) b.setCta();
					return b;
				});
			}
			if (waiting) {
				setting.addButton((b) =>
					b.setButtonText("Stop checking").onClick(() => {
						ctx.plugin.account.stopCloudWatch();
						ctx.rerender();
					}),
				);
			} else {
				if (state === "none") start(setting, "Try free credits", false);
				const canSubscribe = ctx.plugin.account.cloudCanSubscribe;
				const packs = ctx.plugin.account.cloudShowPacks ? ctx.plugin.account.cloudPacks : [];
				if (canSubscribe) {
					// The plan and the packs as one row of prices; the buttons are Obsidian's
					// own, moved into their columns.
					const slots = drawOffers(body, packs);
					setting.addButton((b) => {
						b.setButtonText(planLabel())
							.setCta()
							.onClick(() => {
								ctx.plugin.account.openCloudPlanCheckout();
								ctx.rerender();
							});
						if (b.buttonEl) {
							b.buttonEl.addClass("grill-plan-go");
							slots.plan.appendChild(b.buttonEl);
						}
						return b;
					});
					packs.forEach((pack, i) => {
						setting.addButton((b) => {
							b.setButtonText(packGo(pack)).onClick(() => {
								ctx.plugin.account.openCloudCheckout(pack.link);
								ctx.rerender();
							});
							if (b.buttonEl) slots.packs[i].appendChild(b.buttonEl);
							return b;
						});
					});
				} else {
					for (const pack of packs) {
						setting.addButton((b) => {
							b.setButtonText(packLabel(pack)).onClick(() => {
								ctx.plugin.account.openCloudCheckout(pack.link);
								ctx.rerender();
							});
							if (usingCloud && pack === packs[packs.length - 1]) b.setCta();
							return b;
						});
					}
				}
				// The plan's offer says how checkout works under its own button.
				if (ctx.plugin.account.cloudShowPacks && !canSubscribe) {
					card.createDiv({ cls: "grill-cloud-card-foot", text: "Checkout by Stripe. Credits arrive here in a few seconds." });
				}
			}
			// The policies: there when wanted, as a line of small print, not a row of their own.
			if (cloud.privacyUrl || cloud.termsUrl) {
				const legal = card.createDiv({ cls: "grill-cloud-card-foot grill-cloud-legal" });
				if (cloud.privacyUrl) legal.createEl("a", { text: "Privacy", href: cloud.privacyUrl });
				if (cloud.termsUrl) legal.createEl("a", { text: "Terms", href: cloud.termsUrl });
			}
			setting.addExtraButton((b) => {
				b.setIcon("refresh-cw")
					.setTooltip("Check balance")
					.onClick(async () => {
						await ctx.plugin.account.refreshCloud();
						ctx.rerender();
					});
				// Up in the corner, out of the row of pack buttons, which needs its width.
				if (b.extraSettingsEl) corner.appendChild(b.extraSettingsEl);
				return b;
			});
			if (!empty) corner.createSpan({ cls: usingCloud ? "grill-cloud-chip is-on" : "grill-cloud-chip", text: usingCloud ? "In use" : "Not in use" });
			// When a purchase lands (or the wait ends) while this tab is open: redraw,
			// and count the balance up from the old number to the new one.
			ctx.plugin.account.cloudArrived = (from, to) => {
				ctx.cloudCountFrom = to > from ? from : null;
				ctx.rerender();
			};
			if (ctx.cloudCountFrom !== null && credits !== null) {
				const from = ctx.cloudCountFrom;
				ctx.cloudCountFrom = null;
				countUp(number, from, credits, (n) => n.toLocaleString("en-US"));
				card.addClass("grill-cloud-arrived");
			}
			// Ask once each time the tab is opened; a server that can't be reached
			// isn't asked again on every re-render.
			if (!ctx.cloudAsked) {
				ctx.cloudAsked = true;
				void ctx.plugin.account.refreshCloud().then(() => ctx.rerender());
			}
		},
	};
	// The key is the balance, so it is never an editable field: one stray keystroke
	// in a password box would otherwise replace it. It can be shown, to save it or
	// carry it to another vault, and replaced only by a key the server knows, on a
	// second press. A replaced key is kept, not thrown away.
	const retired = s.retiredCloudKeys.length;
	const cloudKeyRow: Row = {
		name: "Account",
		desc: !ctx.manageKey
			? "One balance for every vault on this device."
			: "Enter this key on another device to use the same balance there. Keep it private." +
				(retired ? ` ${retired} earlier ${retired === 1 ? "key" : "keys"} kept.` : ""),
		aliases: ["credits", "another device", "sync", "cloud", "delete account", "key", "grill cloud key", "backup"],
		build: (setting) => {
			setting.settingEl.addClass("grill-cloud-row");
			// One line until asked for: these controls are rarely needed and one of
			// them deletes the account.
			if (!ctx.manageKey) {
				setting.addButton((b) =>
					b.setButtonText("Manage").onClick(() => {
						ctx.manageKey = true;
						ctx.rerender();
					}),
				);
				return;
			}
			setting.settingEl.addClass("grill-cloud-key");
			setting.addButton((b) =>
				b.setButtonText("Done").onClick(() => {
					ctx.manageKey = false;
					ctx.showCloudKey = false;
					ctx.showRetiredKeys = false;
					ctx.cloudKeyConfirm = false;
					ctx.cloudDeleteConfirm = false;
					ctx.rerender();
				}),
			);
			const busy = (): boolean => {
				if (ctx.plugin.account.cloudWaitingFrom === null) return false;
				new Notice("Grill: a purchase is still on its way to this key. Wait for it, or press Stop checking first.", 8000);
				return true;
			};
			if (cloudKey && ctx.plugin.account.cloudAccountId) {
				setting.addText((t) => {
					t.setValue(ctx.plugin.account.cloudAccountId);
					t.inputEl.readOnly = true;
					t.inputEl.ariaLabel = "Your account ID, to quote to support. It is not your key.";
					t.inputEl.title = "Account ID (not your key)";
					t.inputEl.onfocus = () => t.inputEl.select();
				});
			}
			if (cloudKey) {
				if (ctx.showCloudKey) {
					setting.addText((t) => {
						t.setValue(cloudKey);
						t.inputEl.readOnly = true;
						t.inputEl.ariaLabel = "Your Grill Cloud key";
						// Select it all on focus, so one click and a copy shortcut is enough.
						t.inputEl.onfocus = () => t.inputEl.select();
					});
				}
				setting.addButton((b) =>
					b.setButtonText(ctx.showCloudKey ? "Hide" : "Show").onClick(() => {
						ctx.showCloudKey = !ctx.showCloudKey;
						ctx.rerender();
					}),
				);
			}
			setting.addText((t) => {
				t.setPlaceholder("Key from another vault")
					.setValue(ctx.cloudKeyDraft)
					.onChange((v) => {
						ctx.cloudKeyDraft = v.trim();
						ctx.cloudKeyConfirm = false;
					});
				t.inputEl.ariaLabel = "A Grill Cloud key from another vault";
			});
			setting.addButton((b) =>
				b.setButtonText(ctx.cloudKeyConfirm ? "Replace key" : "Use this key").onClick(async () => {
					const draft = ctx.cloudKeyDraft;
					if (busy()) return;
					if (!isCloudKey(draft)) {
						new Notice("Grill: that isn't a Grill Cloud key.");
						return;
					}
					if (draft === cloudKey) return;
					if (cloudKey && !ctx.cloudKeyConfirm) {
						ctx.cloudKeyConfirm = true;
						new Notice(
							"Grill: this replaces the key in use" +
								(credits ? `, which has ${credits} credits on it` : "") +
								". The old key is kept under Earlier keys, but save it yourself if it matters. Press Replace key to go ahead.",
							10000,
						);
						ctx.rerender();
						return;
					}
					const problem = await ctx.plugin.account.useCloudKey(draft);
					ctx.cloudKeyConfirm = false;
					ctx.cloudDeleteConfirm = false;
					if (problem) {
						new Notice(`Grill: ${problem}`, 8000);
					} else {
						ctx.cloudKeyDraft = "";
						ctx.showCloudKey = false;
					}
					ctx.rerender();
				}),
			);
			if (retired) {
				if (ctx.showRetiredKeys) {
					setting.addText((t) => {
						t.setValue(s.retiredCloudKeys.join(" "));
						t.inputEl.readOnly = true;
						t.inputEl.ariaLabel = "Earlier Grill Cloud keys";
						t.inputEl.onfocus = () => t.inputEl.select();
					});
				}
				setting.addButton((b) =>
					b.setButtonText(ctx.showRetiredKeys ? "Hide earlier keys" : "Earlier keys").onClick(() => {
						ctx.showRetiredKeys = !ctx.showRetiredKeys;
						ctx.rerender();
					}),
				);
			}
			if (cloudKey && state === "none") {
				// Nothing on the server to delete: the key can only be let go of here.
				setting.addButton((b) =>
					b.setButtonText("Forget this key").onClick(async () => {
						if (busy()) return;
						await ctx.plugin.account.forgetCloudKey();
						ctx.rerender();
					}),
				);
			}
			if (cloudKey && state !== "none") {
				// Erasing is permanent and forfeits the balance, so it takes two presses.
				setting.addButton((b) => {
					b.setButtonText(ctx.cloudDeleteConfirm ? "Really delete" : "Delete account").onClick(async () => {
						if (busy()) return;
						if (!ctx.cloudDeleteConfirm) {
							ctx.cloudDeleteConfirm = true;
							new Notice(
								"Grill: this deletes your Grill Cloud balance and usage from the server" +
									(credits ? `, including the ${credits} credits on it` : "") +
									". It can't be undone. Press Really delete to go ahead.",
								10000,
							);
							ctx.rerender();
							return;
						}
						ctx.cloudDeleteConfirm = false;
						const problem = await ctx.plugin.account.deleteCloud();
						new Notice(problem ? `Grill: ${problem} Nothing was deleted.` : "Grill: your Grill Cloud account is deleted.", 8000);
						ctx.rerender();
					});
					if (ctx.cloudDeleteConfirm) {
						// setDestructive is Obsidian 1.13+; setWarning is its older spelling.
						const styled = b as unknown as { setDestructive?: () => unknown; setWarning?: () => unknown };
						if (typeof styled.setDestructive === "function") styled.setDestructive();
						else styled.setWarning?.();
					}
					return b;
				});
			}
		},
	};
	const rows: Row[] = [cloudRow];
	if (all || cloudKey || s.retiredCloudKeys.length) rows.push(cloudKeyRow);
	return rows;
}
