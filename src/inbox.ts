/** Answers graded by other agents (through grill-mcp) join the record here, the same
 * as answers given in Grill: each moves its concept's schedule, counts for its note, and
 * the misconception it showed is added to the registry. Every agent session also gets a
 * session note. The plugin decides when to fold and keeps open panes in step around it. */

import type { TFile } from "obsidian";
import { applyResults, type InboxResult, type RecordState } from "./record";
import type { GrillStore, SessionEntry } from "./store";

/** An agent session's note so far. */
export interface AgentSessionNote {
	file: TFile;
	entries: SessionEntry[];
	startedAt: Date;
}

/** What folding reads and writes. */
export interface InboxHost {
	store: GrillStore;
	/** The record the open panes hold, as it is when asked: the folded answers are
	 * applied to it in place. */
	record(): RecordState;
	settings: { desiredRetention: number; linkSessions: boolean };
	/** Each agent session's note so far, by session, while Obsidian is open. */
	sessionNotes: Map<string, AgentSessionNote>;
}

/** Fold the answers waiting in the inbox into the record. Run inside the store's record
 * edit. Returns the answers that were added; those that couldn't be are set aside. */
export async function foldAnswers(inbox: Array<{ path: string; result: InboxResult }>, host: InboxHost): Promise<InboxResult[]> {
	// Applied to copies: nothing in memory changes unless all of it is saved, so a
	// fold that stops part way can't leave answers counted that will be counted
	// again when it is tried next.
	const applied0 = await host.store.loadAppliedInbox();
	const seen = new Set(applied0);
	const state = {
		concepts: structuredClone(host.record().concepts),
		mastery: structuredClone(host.record().mastery),
		registry: await host.store.loadRegistry(),
	};
	const opts = { allowNew: false, desiredRetention: host.settings.desiredRetention / 100 };
	const { applied, failed } = applyResults(
		state,
		inbox.map((i) => i.result),
		{ ...opts, seen },
	);
	if (applied.length) {
		await host.store.saveConcepts(state.concepts);
		await host.store.saveMastery(state.mastery);
		await host.store.saveRegistry(state.registry);
		await host.store.saveAppliedInbox([...applied0, ...applied.map((r) => r.id)]);
		// The same answers, applied to the maps the open panes hold, in place. Not
		// replaced with the copies: an answer given in a pane while the copies were
		// being saved is in these maps and not in the copies, and the pane saves
		// these next. Applying is synchronous, so nothing comes in between.
		applyResults(host.record(), applied, { ...opts, seen });
	}
	// From here on the answers are in the record: a session note that can't be
	// written is a note missing, never an answer counted twice.
	const sessions = new Map<string, InboxResult[]>();
	for (const r of applied) sessions.set(r.session, [...(sessions.get(r.session) ?? []), r]);
	for (const [id, rs] of sessions) {
		// Answers arrive one at a time: a session already written to gets its
		// note rewritten with every answer so far, not a note per answer.
		const was = host.sessionNotes.get(id);
		const entries = [
			...(was?.entries ?? []),
			...rs.map((r) => ({
				node: r.note,
				question: r.question,
				answer: r.answer,
				verdict: r.verdict,
				gaveUp: false,
				feedback: r.feedback ?? "",
				modelAnswer: r.modelAnswer ?? "",
			})),
		];
		const startedAt = was?.startedAt ?? new Date(rs[0].at);
		const file = await host.store
			.writeSessionNote(entries, { provider: rs[0].via, model: "grill-mcp", startedAt }, host.settings.linkSessions, undefined, [], was?.file)
			.catch(() => null);
		if (file) host.sessionNotes.set(id, { file, entries, startedAt });
	}
	for (const r of failed) console.warn(`Grill: set aside an answer from ${r.via} on ${r.note}: ${r.why}`);
	const bad = new Set(failed.map((r) => r.id));
	for (const i of inbox) await (bad.has(i.result.id) ? host.store.setAsideInboxFile(i.path) : host.store.removeInboxFile(i.path));
	await host.store.removeEmptyInbox();
	return applied;
}
