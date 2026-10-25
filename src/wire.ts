/** What every agent program spoken to over a line protocol shares (Codex's app-server,
 * opencode over ACP). */

/** How long a program may take to answer the opening requests, before any turn. */
export const HANDSHAKE_MS = 60_000;
/** How long a turn may go without a word from the program. Long: a test run or a build
 * can be quiet for minutes. Not a limit on the whole turn. */
export const IDLE_MS = 10 * 60_000;

/** Fails a run that has heard nothing from its program for too long. Every line from it
 * keeps the run alive, and so does a question the student is still answering (`hold` it
 * while they do). */
export function idleWatch(limit: number, fail: (quietMs: number) => void): { heard(): void; hold<T>(p: Promise<T>): Promise<T>; limit(ms: number): void; stop(): void } {
	let ms = limit;
	let held = 0;
	let timer: number | null = null;
	const arm = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = held ? null : window.setTimeout(() => fail(ms), ms);
	};
	arm();
	return {
		heard: arm,
		async hold<T>(p: Promise<T>): Promise<T> {
			held++;
			arm();
			try {
				return await p;
			} finally {
				held--;
				arm();
			}
		},
		limit(next: number): void {
			ms = next;
			arm();
		},
		stop(): void {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
			held = 1;
		},
	};
}

/** The sentence for a program that went quiet. */
export function quietError(name: string, quietMs: number): Error {
	const minutes = Math.round(quietMs / 60_000);
	return new Error(`${name} said nothing for ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(quietMs / 1000)} seconds`}, so Grill stopped waiting.`);
}
