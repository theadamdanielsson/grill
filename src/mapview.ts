/** Canvas renderer for the learning graph. UI-only: it draws a laid-out `LearningGraph`
 * onto an HTML canvas, handles pan / zoom / hover / click, and can highlight a subset of
 * nodes (the picked scope). Positions come pre-laid-out from `graph.ts`; this maps world
 * coordinates to the screen and draws.
 *
 * Follows the plugin's existing canvas idiom (see `celebrate()` in sfx.ts): the canvas's own
 * document/window is used so it keeps working in a popped-out pane. Draws are coalesced with
 * requestAnimationFrame; there is no continuous animation loop (kept light).
 */

import type { LearningGraph, GraphNode } from "./graph";
import { nodeRadius } from "./graph";

export interface MapPalette {
	unpracticed: string;
	inProgress: string;
	struggling: string;
	known: string;
	edge: string;
	edgeInherited: string;
	edgeProven: string;
	text: string;
	ring: string;
}

function nodeColour(state: GraphNode["state"], p: MapPalette): string {
	switch (state) {
		case "known":
			return p.known;
		case "struggling":
			return p.struggling;
		case "in-progress":
			return p.inProgress;
		default:
			return p.unpracticed;
	}
}

export class LearningMap {
	private ctx: CanvasRenderingContext2D;
	private win: Window;
	private dpr = 1;
	private scale = 1;
	private ox = 0;
	private oy = 0;
	private highlight: Set<string> | null = null;
	private hover: GraphNode | null = null;
	private dragging = false;
	private moved = false;
	private lastX = 0;
	private lastY = 0;
	private raf = 0;
	private ro: ResizeObserver | null = null;
	private disposed = false;

	constructor(
		private canvas: HTMLCanvasElement,
		private graph: LearningGraph,
		private palette: MapPalette,
		private onOpenNote: (id: string) => void,
	) {
		this.win = canvas.ownerDocument.defaultView ?? window;
		this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		this.attach();
		this.resize();
		this.fit();
		this.requestDraw();
	}

	setHighlight(ids: Set<string> | null): void {
		this.highlight = ids;
		this.requestDraw();
	}

	dispose(): void {
		this.disposed = true;
		if (this.raf) this.win.cancelAnimationFrame(this.raf);
		this.ro?.disconnect();
		this.canvas.onpointerdown = null;
		this.canvas.onpointermove = null;
		this.canvas.onpointerup = null;
		this.canvas.onpointerleave = null;
		this.canvas.onwheel = null;
	}

	// ---------------------------------------------------------------- geometry

	private resize(): void {
		const rect = this.canvas.getBoundingClientRect();
		const w = Math.max(1, rect.width);
		const h = Math.max(1, rect.height);
		this.dpr = this.win.devicePixelRatio || 1;
		this.canvas.width = Math.round(w * this.dpr);
		this.canvas.height = Math.round(h * this.dpr);
	}

	private cssSize(): { w: number; h: number } {
		return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr };
	}

	/** Fit the whole graph into view with padding. */
	private fit(): void {
		const { w, h } = this.cssSize();
		if (!this.graph.nodes.length) {
			this.scale = 1;
			this.ox = w / 2;
			this.oy = h / 2;
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of this.graph.nodes) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x);
			maxY = Math.max(maxY, n.y);
		}
		const gw = Math.max(1, maxX - minX);
		const gh = Math.max(1, maxY - minY);
		const pad = 40;
		this.scale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 2.5);
		if (!Number.isFinite(this.scale) || this.scale <= 0) this.scale = 1;
		this.ox = w / 2 - ((minX + maxX) / 2) * this.scale;
		this.oy = h / 2 - ((minY + maxY) / 2) * this.scale;
	}

	private toScreen(n: { x: number; y: number }): { x: number; y: number } {
		return { x: n.x * this.scale + this.ox, y: n.y * this.scale + this.oy };
	}

	private radiusFor(n: GraphNode): number {
		return nodeRadius(n.strength);
	}

	private hit(px: number, py: number): GraphNode | null {
		// Topmost (last drawn) first.
		for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
			const n = this.graph.nodes[i];
			const s = this.toScreen(n);
			const r = this.radiusFor(n) + 3;
			if ((px - s.x) ** 2 + (py - s.y) ** 2 <= r * r) return n;
		}
		return null;
	}

	// ---------------------------------------------------------------- events

	private attach(): void {
		this.canvas.onpointerdown = (e) => {
			this.dragging = true;
			this.moved = false;
			this.lastX = e.offsetX;
			this.lastY = e.offsetY;
			this.canvas.setPointerCapture(e.pointerId);
		};
		this.canvas.onpointermove = (e) => {
			if (this.dragging) {
				const dx = e.offsetX - this.lastX;
				const dy = e.offsetY - this.lastY;
				if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
				this.ox += dx;
				this.oy += dy;
				this.lastX = e.offsetX;
				this.lastY = e.offsetY;
				this.requestDraw();
				return;
			}
			const h = this.hit(e.offsetX, e.offsetY);
			if (h !== this.hover) {
				this.hover = h;
				this.canvas.style.cursor = h ? "pointer" : "grab";
				this.requestDraw();
			}
		};
		this.canvas.onpointerup = (e) => {
			this.dragging = false;
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			if (!this.moved) {
				const n = this.hit(e.offsetX, e.offsetY);
				if (n) this.onOpenNote(n.id);
			}
		};
		this.canvas.onpointerleave = () => {
			this.hover = null;
			this.requestDraw();
		};
		this.canvas.onwheel = (e) => {
			e.preventDefault();
			const factor = Math.exp(-e.deltaY * 0.0015);
			const nx = this.scale * factor;
			const clamped = Math.min(6, Math.max(0.1, nx));
			const f = clamped / this.scale;
			// Zoom around the cursor.
			this.ox = e.offsetX - (e.offsetX - this.ox) * f;
			this.oy = e.offsetY - (e.offsetY - this.oy) * f;
			this.scale = clamped;
			this.requestDraw();
		};
		if (typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(() => {
				if (this.disposed) return;
				this.resize();
				this.requestDraw();
			});
			ro.observe(this.canvas);
			this.ro = ro;
		}
	}

	// ---------------------------------------------------------------- drawing

	private requestDraw(): void {
		if (this.raf || this.disposed) return;
		this.raf = this.win.requestAnimationFrame(() => {
			this.raf = 0;
			this.draw();
		});
	}

	private draw(): void {
		const ctx = this.ctx;
		const { w, h } = this.cssSize();
		ctx.save();
		ctx.scale(this.dpr, this.dpr);
		ctx.clearRect(0, 0, w, h);

		const hi = this.highlight;
		const dim = (id: string): number => (hi && !hi.has(id) ? 0.18 : 1);

		// Edges first.
		const byId = new Map(this.graph.nodes.map((n) => [n.id, n]));
		for (const e of this.graph.edges) {
			const a = byId.get(e.a);
			const b = byId.get(e.b);
			if (!a || !b) continue;
			const sa = this.toScreen(a);
			const sb = this.toScreen(b);
			const alpha = Math.min(dim(e.a), dim(e.b));
			ctx.globalAlpha = alpha;
			if (e.tier === "proven") {
				ctx.strokeStyle = this.palette.edgeProven;
				ctx.lineWidth = 2.4;
				ctx.shadowColor = this.palette.edgeProven;
				ctx.shadowBlur = 8;
			} else if (e.tier === "inherited") {
				ctx.strokeStyle = this.palette.edgeInherited;
				ctx.lineWidth = 1.4;
				ctx.shadowBlur = 0;
			} else {
				ctx.strokeStyle = this.palette.edge;
				ctx.lineWidth = 1;
				ctx.shadowBlur = 0;
			}
			ctx.beginPath();
			ctx.moveTo(sa.x, sa.y);
			ctx.lineTo(sb.x, sb.y);
			ctx.stroke();
		}
		ctx.shadowBlur = 0;

		// Nodes.
		for (const n of this.graph.nodes) {
			const s = this.toScreen(n);
			const r = this.radiusFor(n);
			ctx.globalAlpha = dim(n.id);
			ctx.fillStyle = nodeColour(n.state, this.palette);
			ctx.beginPath();
			ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
			ctx.fill();
			if (this.hover === n) {
				ctx.globalAlpha = dim(n.id);
				ctx.strokeStyle = this.palette.ring;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.globalAlpha = 1;

		// Hover label.
		if (this.hover) {
			const s = this.toScreen(this.hover);
			const r = this.radiusFor(this.hover);
			ctx.font = "12px var(--font-interface, sans-serif)";
			const text = this.hover.id;
			const tw = ctx.measureText(text).width;
			const lx = s.x - tw / 2;
			const ly = s.y - r - 8;
			ctx.globalAlpha = 0.9;
			ctx.fillStyle = "rgba(0,0,0,0.6)";
			ctx.fillRect(lx - 4, ly - 12, tw + 8, 16);
			ctx.fillStyle = this.palette.text;
			ctx.textBaseline = "middle";
			ctx.fillText(text, lx, ly - 4);
			ctx.globalAlpha = 1;
		}
		ctx.restore();
	}
}
