/** Drawing a reply while it is written, without the screen jumping.
 *
 * Drawing the whole reply again as Markdown each time more arrived made it jump: a
 * half-written list or `**` changed shape on every redraw, so the reply's height went up
 * and down, and the pane snapped to the bottom each time. Here what is finished stays
 * drawn: a paragraph is drawn as Markdown once, when the blank line after it arrives, and
 * is not touched again. The paragraph still being written is shown as plain text, updated
 * once a frame. The reply never gets shorter while it is written. The full reply is drawn
 * properly once it is done (see askLearn). */

/** Where the finished part of `text` ends: just after the last blank line that is not
 * inside a code block. 0 when no paragraph is finished yet. */
export function finishedUpTo(text: string): number {
	let fenced = false;
	let end = 0;
	let at = 0;
	let blankBefore = false;
	for (const line of text.split("\n")) {
		const next = at + line.length + 1;
		if (next > text.length) break; // the last line is still being written
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const blank = line.trim() === "";
		if (blank && !fenced && !blankBefore && at > 0) end = next;
		blankBefore = blank;
		at = next;
	}
	return end;
}

export interface StreamDrawer {
	/** The whole reply so far. Cheap to call often: drawing happens once a frame. */
	update(soFar: string): void;
	/** Stop drawing; the caller draws the finished reply. */
	stop(): void;
}

/** Keeps `body` showing the reply as it is written. `render` draws Markdown into an
 * element; `pane` is the scrolling pane, kept at its bottom only for someone who was
 * already reading the bottom. */
export function streamDrawer(
	body: HTMLElement,
	pane: HTMLElement,
	render: (markdown: string, into: HTMLElement) => Promise<void>,
): StreamDrawer {
	let latest = "";
	let doneUpTo = 0; // how much of the reply is drawn as Markdown
	let rendering = false;
	let frame = 0;
	let stopped = false;
	let started = false;
	let tallest = 0;
	const done = createDiv({ cls: "grill-stream-done" });
	const tail = createDiv({ cls: "grill-stream-tail" });

	const atFoot = (): boolean => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
	const keepFoot = (follow: boolean): void => {
		// Never shorter while it is written: a paragraph drawn as Markdown can take less
		// room than its raw text did, and the space closing up is itself a jump.
		const h = body.offsetHeight;
		if (h > tallest) {
			tallest = h;
			body.style.minHeight = `${h}px`;
		}
		if (follow) pane.scrollTop = pane.scrollHeight;
	};

	const renderFinished = async (): Promise<void> => {
		if (rendering) return;
		rendering = true;
		try {
			for (;;) {
				const end = finishedUpTo(latest);
				if (stopped || end <= doneUpTo || !body.isConnected) break;
				const part = latest.slice(doneUpTo, end);
				const block = createDiv({ cls: "grill-stream-block" });
				await render(part, block);
				if (stopped || !body.isConnected) break;
				const follow = atFoot();
				done.appendChild(block);
				doneUpTo = end;
				tail.setText(latest.slice(doneUpTo));
				keepFoot(follow);
			}
		} finally {
			rendering = false;
		}
	};

	const draw = (): void => {
		frame = 0;
		if (stopped || !body.isConnected) return;
		const follow = atFoot();
		if (!started) {
			started = true;
			body.removeClass("grill-meta");
			body.replaceChildren(done, tail);
		}
		tail.setText(latest.slice(doneUpTo));
		keepFoot(follow);
		void renderFinished();
	};

	return {
		update(soFar: string): void {
			if (stopped) return;
			latest = soFar;
			if (!frame) frame = window.requestAnimationFrame(draw);
		},
		stop(): void {
			stopped = true;
			if (frame) window.cancelAnimationFrame(frame);
			frame = 0;
		},
	};
}
