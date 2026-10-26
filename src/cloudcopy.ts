/** What Grill Cloud says about itself: the offer of the monthly plan, and what to know
 * before starting. Kept apart from the code so the words can be read and changed in one
 * place. */

import { cloud } from "./cloud";

/** The plan's offer: a headline over the price, what it gets you under it, and the
 * terms in small print under the button. */
export const PLAN_HEADLINE = "All of Grill. No setup.";
export const PLAN_LEAD = "No Claude or ChatGPT subscription needed. Less than half the price of one.";
export const PLAN_PERKS = ["Tests written from your own notes", "A chat that knows what you got wrong", "On your phone too, no key needed"];
export const PLAN_LIMITS = "Usage limits reset every five hours and every week. At a limit, wait or add credits, which don't expire.";

/** Why pick it, in one line under its name: nothing to get, nothing to fill in. */
export const CLOUD_LEAD = "No API key, no sign-up, no AI subscription. One click and you're studying.";

/** The three things to know before starting, said wherever Grill Cloud is offered. */
export const CLOUD_FACTS = [
	"AI writes your questions and grades your answers.",
	cloud.plan.url ? `Free credits to start, while each day's last. Then ${cloud.plan.price} + tax a month, cancel anytime.` : "Free credits to start, while each day's last. Then credit packs from $3.99 + tax.",
	"Your notes go through Grill's server to Claude. Grill's server doesn't store them.",
];

/** The whole of it, shown before anything is sent to anyone who asks what is. */
export const CLOUD_PITCH =
	"The notes in a session, the images in them, your answers and your custom instructions go through Grill's server to Anthropic's Claude, which writes the questions and grades. " +
	"So do short excerpts of notes it checks for missing links, and a summary of what you keep getting wrong, which it uses to adapt. " +
	"Grill's server doesn't store them. Anthropic keeps them for up to 30 days to watch for abuse and doesn't train on them. " +
	"Text you have read aloud goes through Grill's server to OpenAI, which makes the voice, unless you switch to your device's voice in settings. " +
	"Don't study notes this way that you wouldn't send to an online service. For ages 18 and over.";
