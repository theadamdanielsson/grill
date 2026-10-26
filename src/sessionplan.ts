/** Changes to a session's plan while it runs. */

/** "Add context": every question not yet shown goes back into the plan to be written
 * again, and with `rewriteCurrent` the one on screen too. Questions aren't positionally
 * tied to targets (see planCursor in view.ts), so each dropped question is matched back
 * to a consumed target of the same concept, latest first; one with no match stays as it
 * is rather than being lost. The requeued targets go in at `planCursor`, without the
 * defect that may have been recorded on them. Both arrays are changed in place. Returns
 * how many questions will be written again. */
export function requeueForContext<Q extends { conceptId?: string; node: string }, T extends { conceptId: string; note: string; lastDefectReason?: string }>(
	questions: Q[],
	targets: T[],
	idx: number,
	planCursor: number,
	rewriteCurrent: boolean,
): number {
	const dropped = questions.splice(rewriteCurrent ? idx : idx + 1);
	const used = new Set<number>();
	const again: T[] = [];
	for (const q of dropped) {
		let at = -1;
		for (let i = planCursor - 1; i >= 0; i--) {
			const t = targets[i];
			if (!used.has(i) && t.conceptId === q.conceptId && t.note === q.node) {
				at = i;
				break;
			}
		}
		if (at < 0) {
			questions.push(q);
			continue;
		}
		used.add(at);
		const { lastDefectReason: _d, ...t } = targets[at];
		again.push(t as T);
	}
	targets.splice(planCursor, 0, ...again);
	return again.length;
}
