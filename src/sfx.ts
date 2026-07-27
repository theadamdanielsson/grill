/** Sound effects + celebration, synthesized live (no audio files, no deps).
 *
 * Tones are short Web Audio oscillator blips; the perfect-session confetti is a
 * tiny canvas particle burst. Everything is gentle and gated behind a setting.
 * Audio is created lazily on first use, which in Grill is always inside a click
 * (submit / next), so the browser autoplay policy is satisfied.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
	try {
		const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctor) return null;
		if (!ctx) ctx = new Ctor();
		if (ctx.state === "suspended") void ctx.resume();
		return ctx;
	} catch {
		return null;
	}
}

interface Tone {
	freq: number;
	/** seconds from now */
	start: number;
	/** seconds */
	dur: number;
	type?: OscillatorType;
	/** 0-1, relative to the module's gentle master level */
	gain?: number;
}

const MASTER = 0.14; // keep it soft; these fire every answer

function play(tones: Tone[]): void {
	const ac = audio();
	if (!ac) return;
	const now = ac.currentTime;
	for (const t of tones) {
		const osc = ac.createOscillator();
		const g = ac.createGain();
		osc.type = t.type ?? "sine";
		osc.frequency.value = t.freq;
		const peak = MASTER * (t.gain ?? 1);
		const t0 = now + t.start;
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.dur);
		osc.connect(g).connect(ac.destination);
		osc.start(t0);
		osc.stop(t0 + t.dur + 0.03);
	}
}

export type Sfx = "correct" | "partial" | "incorrect" | "complete" | "perfect";

/** Play one cue. Silent no-op if audio is unavailable. */
export function playSfx(kind: Sfx): void {
	switch (kind) {
		case "correct": // bright rising two-note ding
			play([
				{ freq: 660, start: 0, dur: 0.12 },
				{ freq: 990, start: 0.08, dur: 0.18 },
			]);
			return;
		case "partial": // single soft, slightly unresolved mid tone
			play([{ freq: 494, start: 0, dur: 0.2, type: "triangle" }]);
			return;
		case "incorrect": // gentle low descending blip (not a harsh buzz)
			play([
				{ freq: 300, start: 0, dur: 0.16 },
				{ freq: 190, start: 0.1, dur: 0.22 },
			]);
			return;
		case "complete": // pleasant ascending arpeggio C-E-G
			play([
				{ freq: 523, start: 0, dur: 0.14 },
				{ freq: 659, start: 0.12, dur: 0.14 },
				{ freq: 784, start: 0.24, dur: 0.24 },
			]);
			return;
		case "perfect": // triumphant fanfare C-E-G-C with a held fifth under the top
			play([
				{ freq: 523, start: 0, dur: 0.12 },
				{ freq: 659, start: 0.1, dur: 0.12 },
				{ freq: 784, start: 0.2, dur: 0.12 },
				{ freq: 1047, start: 0.3, dur: 0.35, gain: 1.1 },
				{ freq: 784, start: 0.3, dur: 0.35, gain: 0.55 },
			]);
			return;
	}
}

/** A short confetti burst over the whole window. Self-removes after ~2.2s. Pass the
 * session view's document so it lands in the right window when popped out. */
export function celebrate(doc: Document = document): void {
	const win = doc.defaultView ?? window;
	const canvas = doc.createElement("canvas");
	canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
	const w = (canvas.width = win.innerWidth);
	const h = (canvas.height = win.innerHeight);
	doc.body.appendChild(canvas);
	const c = canvas.getContext("2d");
	if (!c) {
		canvas.remove();
		return;
	}
	const colors = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#f368e0", "#ffffff"];
	const parts = Array.from({ length: 150 }, () => ({
		x: w / 2 + (Math.random() - 0.5) * w * 0.25,
		y: h * 0.32,
		vx: (Math.random() - 0.5) * 16,
		vy: Math.random() * -14 - 4,
		size: 5 + Math.random() * 6,
		color: colors[Math.floor(Math.random() * colors.length)],
		rot: Math.random() * Math.PI,
		vr: (Math.random() - 0.5) * 0.4,
	}));
	const gravity = 0.35;
	const start = win.performance?.now?.() ?? 0;
	const tick = (t: number): void => {
		const elapsed = t - start;
		c.clearRect(0, 0, w, h);
		for (const p of parts) {
			p.vy += gravity;
			p.x += p.vx;
			p.y += p.vy;
			p.rot += p.vr;
			c.save();
			c.translate(p.x, p.y);
			c.rotate(p.rot);
			c.globalAlpha = Math.max(0, 1 - elapsed / 2200);
			c.fillStyle = p.color;
			c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
			c.restore();
		}
		if (elapsed < 2200) win.requestAnimationFrame(tick);
		else canvas.remove();
	};
	win.requestAnimationFrame(tick);
}
