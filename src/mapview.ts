/** Canvas renderer for the learning graph, powered by d3-force — the same physics engine
 * Obsidian's own graph view uses. d3-force handles the simulation (many-body repulsion,
 * link springs, centring, collision) and the drag model; this module owns the canvas layer:
 * pan / zoom / hover (with neighbour highlight) / click, mastery colours, zoom-adaptive
 * labels, and the scope-highlight glow.
 *
 * The plugin's canvas idiom (`celebrate()` in sfx.ts) is followed: the canvas's own window
 * is used so it keeps working in a popped-out pane.
 */

import {
	forceSimulation,
	forceManyBody,
	forceLink,
	forceX,
	forceY,
	forceCollide,
	type Simulation,
	type SimulationNodeDatum,
	type SimulationLinkDatum,
} from "d3-force";
import type { LearningGraph, GraphNode, EdgeTier } from "./graph";
import { nodeRadius, gradeScore, formatGrade, type GradeFormat } from "./graph";

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
	/** The canvas's own backdrop colour. Used for a thin ring around every node, so a
	 * node stays legible where it overlaps an edge or another node, instead of a stroke
	 * that would add data-weight ink of its own. */
	surface: string;
}

/** What a node's colour encodes. "mastery" is the original 4-state status; the rest are
 * continuous 0-1 metrics rendered as a gradient between two palette colours. */
export type ColorMode = "mastery" | "recency" | "dueness" | "misconceptions";

/** Numeric overlay next to each node: off, or a formatted grade score. */
export type NumberMode = "off" | GradeFormat;

/** Parse any CSS colour canvas would accept (#hex, #rgb, rgb(), rgba()) into 0-255 components.
 * getComputedStyle resolves CSS custom properties to rgb()/rgba(), not the hex literals the
 * palette's fallbacks use, so a gradient lerp needs to handle both forms, not just hex. */
function parseColor(c: string): [number, number, number] {
	const s = c.trim();
	if (s.startsWith("#")) {
		const hex = s.length === 4 ? s.replace(/[0-9a-f]/gi, (ch) => ch + ch) : s;
		const n = parseInt(hex.slice(1, 7), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
	if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
	return [128, 128, 128]; // unparseable: neutral grey rather than a crash
}

/** Linear-interpolate between two CSS colours, t clamped 0-1. */
function lerpColor(a: string, b: string, t: number): string {
	const ct = Math.min(1, Math.max(0, t));
	const [r1, g1, b1] = parseColor(a);
	const [r2, g2, b2] = parseColor(b);
	const r = Math.round(r1 + (r2 - r1) * ct);
	const g = Math.round(g1 + (g2 - g1) * ct);
	const bl = Math.round(b1 + (b2 - b1) * ct);
	return `rgb(${r}, ${g}, ${bl})`;
}

/** Black or white, whichever reads clearly on top of `bg` (WCAG relative luminance,
 * threshold 0.5). A number badge drawn inside a node needs this: the node's fill swings
 * from deep red to bright green to grey depending on colour mode, and a single fixed text
 * colour (the theme's normal text colour) disappears against roughly half of that range. */
function contrastText(bg: string): string {
	const [r, g, b] = parseColor(bg);
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return lum > 0.55 ? "#000000" : "#ffffff";
}

/** Display settings mirrored from the user's Obsidian graph (graph.json). Force values are
 * NOT mirrored — d3-force is its own engine and Obsidian's numbers don't translate. */
export interface GraphAppearance {
	textFade: number;
	nodeScale: number;
	lineScale: number;
}

const DEFAULT_APPEARANCE: GraphAppearance = { textFade: 0, nodeScale: 1, lineScale: 1 };

type SimNode = GraphNode & SimulationNodeDatum;
interface SimLink extends SimulationLinkDatum<SimNode> {
	tier: EdgeTier;
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

/** Days it takes a metric to fully redden, per non-mastery colour mode. Tuned so the
 * gradient actually moves within a normal study cadence: staleness maxes out around a
 * month untouched, overdue maxes out two weeks past due (FSRS intervals are usually much
 * shorter than that, so "way overdue" should read as genuinely alarming, not routine). */
const RECENCY_WINDOW_DAYS = 30;
const OVERDUE_WINDOW_DAYS = 14;
/** Misconception count that fully reddens a node. */
const MISCONCEPTION_WINDOW = 3;

const DAY_MS = 86_400_000;

/** 0 (safe/green) to 1 (urgent/red) for a non-mastery colour mode. Null for an unpracticed
 * node — the caller renders those as the plain unpracticed grey regardless of mode, since
 * "never studied" isn't a position on any of these scales. */
function badness(nd: GraphNode, mode: ColorMode, now: number): number | null {
	if (nd.state === "unpracticed") return null;
	switch (mode) {
		case "recency": {
			if (!nd.lastSeen) return null;
			const days = (now - new Date(nd.lastSeen).getTime()) / DAY_MS;
			return Math.min(1, Math.max(0, days / RECENCY_WINDOW_DAYS));
		}
		case "dueness": {
			if (!nd.dueAt) return null;
			const overdueDays = (now - new Date(nd.dueAt).getTime()) / DAY_MS;
			return Math.min(1, Math.max(0, overdueDays / OVERDUE_WINDOW_DAYS));
		}
		case "misconceptions":
			return Math.min(1, nd.misconceptions / MISCONCEPTION_WINDOW);
		case "mastery":
			return null;
	}
}

/** Resolve a node's fill colour for the active colour mode: the original 4-state mastery
 * colour, or a green-to-red gradient over a continuous metric (badness 0..1). */
function nodeFillColour(nd: GraphNode, mode: ColorMode, p: MapPalette, now: number): string {
	if (mode === "mastery") return nodeColour(nd.state, p);
	const b = badness(nd, mode, now);
	if (b === null) return p.unpracticed;
	return lerpColor(p.known, p.struggling, b);
}

export class LearningMap {
	private ctx: CanvasRenderingContext2D;
	private win: Window;
	private dpr = 1;
	private scale = 1;
	private ox = 0;
	private oy = 0;
	private fitScale = 1;

	private nodes: SimNode[];
	private links: SimLink[];
	private sim: Simulation<SimNode, SimLink>;
	private byId = new Map<string, SimNode>();
	private adj = new Map<string, Set<string>>();

	private highlight: Set<string> | null = null;
	private hover: SimNode | null = null;
	/** The node whose neighbourhood is currently drawn-highlighted; kept during fade-out. */
	private focusNode: SimNode | null = null;
	private focusSet: Set<string> | null = null;
	/** Eased hover-highlight intensity 0..1 (animated in/out, like the native graph). */
	private hoverT = 0;
	private hoverRaf = 0;
	private ro: ResizeObserver | null = null;
	private drawRaf = 0;
	private disposed = false;
	private userMoved = false;
	private ap: GraphAppearance;

	private colorMode: ColorMode = "mastery";
	private numberMode: NumberMode = "off";
	private coverageWeight = 0.6;

	// Interaction.
	private mode: "none" | "pan" | "drag" = "none";
	private drag: SimNode | null = null;
	private moved = false;
	private lastX = 0;
	private lastY = 0;
	// Smooth zoom: ease this.scale toward targetScale around the last cursor focal point.
	private targetScale = 1;
	private zx = 0;
	private zy = 0;
	private zoomRaf = 0;

	constructor(
		private canvas: HTMLCanvasElement,
		graph: LearningGraph,
		private palette: MapPalette,
		private onOpenNote: (id: string) => void,
		private onPersist?: (pos: Record<string, { x: number; y: number }>) => void,
		settled = false,
		appearance?: Partial<GraphAppearance>,
		display?: { colorMode?: ColorMode; numberMode?: NumberMode; coverageWeight?: number },
	) {
		this.ap = { ...DEFAULT_APPEARANCE, ...(appearance ?? {}) };
		if (display?.colorMode) this.colorMode = display.colorMode;
		if (display?.numberMode) this.numberMode = display.numberMode;
		if (display?.coverageWeight !== undefined) this.coverageWeight = display.coverageWeight;
		this.win = canvas.ownerDocument.defaultView ?? window;
		this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

		this.nodes = graph.nodes as SimNode[];
		for (const nd of this.nodes) this.byId.set(nd.id, nd);
		this.links = graph.edges.map((e) => ({ source: e.a, target: e.b, tier: e.tier }));
		for (const e of graph.edges) {
			(this.adj.get(e.a) ?? this.adj.set(e.a, new Set()).get(e.a)!).add(e.b);
			(this.adj.get(e.b) ?? this.adj.set(e.b, new Set()).get(e.b)!).add(e.a);
		}

		// d3-force: Obsidian-like forces. Link strength defaults to 1/min(degree), which
		// keeps hub nodes from collapsing; collision gives nodes breathing room.
		this.sim = forceSimulation<SimNode, SimLink>(this.nodes)
			.force("charge", forceManyBody<SimNode>().strength(-210).distanceMax(700))
			.force(
				"link",
				forceLink<SimNode, SimLink>(this.links)
					.id((d) => d.id)
					.distance(58),
			)
			// More padding than a bare visual gap: this graph now also carries a numeric
			// badge and (sometimes) a glow on top of each node, both of which need real
			// clearance from the neighbour, not just enough to keep two plain dots apart.
			.force("collide", forceCollide<SimNode>().radius((d) => this.radius(d) + 9).strength(0.9))
			.force("x", forceX<SimNode>(0).strength(0.055))
			.force("y", forceY<SimNode>(0).strength(0.055))
			.velocityDecay(0.4)
			// A bit hotter than before (was 0.15) on an already-settled, saved layout: the
			// collision radius just grew a fair amount (nodes now carry a badge + glow,
			// not just a bare dot), and existing saved positions were packed for the old,
			// tighter spacing. This lets it resettle into the new spacing over the next
			// couple of sessions rather than barely nudging for weeks.
			.alpha(settled ? 0.35 : 1)
			.on("tick", () => this.requestDraw())
			.on("end", () => {
				if (!this.userMoved) this.fit();
				this.requestDraw();
				this.persist();
			});

		this.attach();
		this.resize();
		this.fit();
		this.requestDraw();
		// Canvas text doesn't repaint itself when a @font-face finishes loading (unlike
		// DOM text) — if the very first draw() lands before "Grill Pixel" is decoded, the
		// numeric overlay would silently fall back to the generic monospace font and stay
		// that way until something else triggers a redraw. Force one once the font is
		// confirmed ready, so the pixel face is never a race.
		this.win.document.fonts?.load('9px "Grill Pixel"').finally(() => {
			if (!this.disposed) this.requestDraw();
		});
	}

	setHighlight(ids: Set<string> | null): void {
		this.highlight = ids;
		this.requestDraw();
	}

	/** Switch what node colour encodes. Redraws only — no re-layout, so flipping modes
	 * doesn't disturb the simulation or the user's dragged positions. */
	setColorMode(mode: ColorMode): void {
		this.colorMode = mode;
		this.requestDraw();
	}

	/** Switch the numeric overlay (off, or a grade format) and/or the coverage/mastery
	 * weighting it's computed with. Either argument may be omitted to leave it unchanged. */
	setNumberDisplay(mode?: NumberMode, coverageWeight?: number): void {
		if (mode !== undefined) this.numberMode = mode;
		if (coverageWeight !== undefined) this.coverageWeight = coverageWeight;
		this.requestDraw();
	}

	dispose(): void {
		this.disposed = true;
		this.sim.stop();
		if (this.drawRaf) this.win.cancelAnimationFrame(this.drawRaf);
		if (this.hoverRaf) this.win.cancelAnimationFrame(this.hoverRaf);
		if (this.zoomRaf) this.win.cancelAnimationFrame(this.zoomRaf);
		this.ro?.disconnect();
		this.persist();
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

	private fit(): void {
		const { w, h } = this.cssSize();
		if (!this.nodes.length) {
			this.scale = 1;
			this.ox = w / 2;
			this.oy = h / 2;
			this.fitScale = 1;
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const nd of this.nodes) {
			const x = nd.x ?? 0;
			const y = nd.y ?? 0;
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
		const gw = Math.max(1, maxX - minX);
		const gh = Math.max(1, maxY - minY);
		const pad = 48;
		this.scale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 2.5);
		if (!Number.isFinite(this.scale) || this.scale <= 0) this.scale = 1;
		this.ox = w / 2 - ((minX + maxX) / 2) * this.scale;
		this.oy = h / 2 - ((minY + maxY) / 2) * this.scale;
		this.fitScale = this.scale;
		this.targetScale = this.scale;
	}

	private sx(nd: SimNode): number {
		return (nd.x ?? 0) * this.scale + this.ox;
	}
	private sy(nd: SimNode): number {
		return (nd.y ?? 0) * this.scale + this.oy;
	}
	private worldX(px: number): number {
		return (px - this.ox) / this.scale;
	}
	private worldY(py: number): number {
		return (py - this.oy) / this.scale;
	}
	private radius(nd: SimNode): number {
		// Gentle size range so "covered" notes are only slightly larger, not oversized.
		// A bit larger across the board when the numeric overlay is on: "78%"/"B+" needs
		// real room to sit inside the shape rather than spill past its edges.
		const [minR, maxR] = this.numberMode === "off" ? [4.5, 11] : [7, 14];
		return nodeRadius(nd.strength, minR, maxR) * this.ap.nodeScale;
	}

	/** Trace a node's shape: a rounded square for practised ("covered") notes — a filled-in
	 * cell — and a plain dot for notes not yet studied. */
	private nodePath(x: number, y: number, r: number, square: boolean): void {
		const ctx = this.ctx;
		ctx.beginPath();
		if (square) {
			const s = r * 1.8;
			const rad = Math.min(3.5, s * 0.24);
			if (typeof ctx.roundRect === "function") ctx.roundRect(x - s / 2, y - s / 2, s, s, rad);
			else ctx.rect(x - s / 2, y - s / 2, s, s);
		} else {
			ctx.arc(x, y, r, 0, Math.PI * 2);
		}
	}

	private hitNode(px: number, py: number): SimNode | null {
		for (let i = this.nodes.length - 1; i >= 0; i--) {
			const nd = this.nodes[i];
			const r = this.radius(nd) + 3;
			const dx = px - this.sx(nd);
			const dy = py - this.sy(nd);
			if (dx * dx + dy * dy <= r * r) return nd;
		}
		return null;
	}

	// ---------------------------------------------------------------- events

	private attach(): void {
		this.canvas.onpointerdown = (e) => {
			this.moved = false;
			this.lastX = e.offsetX;
			this.lastY = e.offsetY;
			const n = this.hitNode(e.offsetX, e.offsetY);
			if (n) {
				this.mode = "drag";
				this.drag = n;
				this.userMoved = true;
				n.fx = this.worldX(e.offsetX);
				n.fy = this.worldY(e.offsetY);
				this.sim.alphaTarget(0.3).restart();
			} else {
				this.mode = "pan";
			}
			this.canvas.setPointerCapture(e.pointerId);
		};
		this.canvas.onpointermove = (e) => {
			if (this.mode === "drag" && this.drag) {
				this.moved = true;
				this.drag.fx = this.worldX(e.offsetX);
				this.drag.fy = this.worldY(e.offsetY);
				return;
			}
			if (this.mode === "pan") {
				const dx = e.offsetX - this.lastX;
				const dy = e.offsetY - this.lastY;
				if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
				this.userMoved = true;
				this.ox += dx;
				this.oy += dy;
				this.lastX = e.offsetX;
				this.lastY = e.offsetY;
				this.requestDraw();
				return;
			}
			this.setHover(this.hitNode(e.offsetX, e.offsetY));
		};
		this.canvas.onpointerup = (e) => {
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			if (this.mode === "drag" && this.drag) {
				this.drag.fx = null;
				this.drag.fy = null;
				this.sim.alphaTarget(0);
				if (!this.moved) this.onOpenNote(this.drag.id);
			} else if (this.mode === "pan" && !this.moved) {
				const n = this.hitNode(e.offsetX, e.offsetY);
				if (n) this.onOpenNote(n.id);
			}
			this.mode = "none";
			this.drag = null;
		};
		this.canvas.onpointerleave = () => this.setHover(null);
		this.canvas.onwheel = (e) => {
			e.preventDefault();
			this.userMoved = true;
			const factor = Math.exp(-e.deltaY * 0.0012);
			this.targetScale = Math.min(6, Math.max(0.08, this.targetScale * factor));
			this.zx = e.offsetX;
			this.zy = e.offsetY;
			this.animateZoom();
		};
		if (typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(() => {
				if (this.disposed) return;
				this.resize();
				if (!this.userMoved) this.fit();
				this.requestDraw();
			});
			ro.observe(this.canvas);
			this.ro = ro;
		}
	}

	// ---------------------------------------------------------------- drawing

	private requestDraw(): void {
		if (this.drawRaf || this.disposed) return;
		this.drawRaf = this.win.requestAnimationFrame(() => {
			this.drawRaf = 0;
			this.draw();
		});
	}

	private setHover(n: SimNode | null): void {
		if (n === this.hover) return;
		this.hover = n;
		this.canvas.style.cursor = n ? "pointer" : "grab";
		if (n) {
			this.focusNode = n;
			this.focusSet = new Set<string>([n.id, ...(this.adj.get(n.id) ?? [])]);
		}
		this.animateHover();
	}

	/** Ease the hover-highlight intensity toward its target, redrawing each frame, so the
	 * neighbourhood fades in and out smoothly instead of snapping. */
	private animateHover(): void {
		if (this.hoverRaf || this.disposed) return;
		const tick = (): void => {
			this.hoverRaf = 0;
			const target = this.hover ? 1 : 0;
			this.hoverT += (target - this.hoverT) * 0.2;
			if (Math.abs(target - this.hoverT) < 0.012) {
				this.hoverT = target;
				if (target === 0) {
					this.focusNode = null;
					this.focusSet = null;
				}
			}
			this.draw();
			if (this.hoverT !== target && !this.disposed) this.hoverRaf = this.win.requestAnimationFrame(tick);
		};
		this.hoverRaf = this.win.requestAnimationFrame(tick);
	}

	/** Ease the zoom toward the target scale around the cursor, so the wheel feels smooth
	 * instead of jumping a step per notch. */
	private animateZoom(): void {
		if (this.zoomRaf || this.disposed) return;
		const tick = (): void => {
			this.zoomRaf = 0;
			const ns = this.scale + (this.targetScale - this.scale) * 0.3;
			const done = Math.abs(this.targetScale - ns) < 0.0008;
			const next = done ? this.targetScale : ns;
			const f = next / this.scale;
			this.ox = this.zx - (this.zx - this.ox) * f;
			this.oy = this.zy - (this.zy - this.oy) * f;
			this.scale = next;
			this.draw();
			if (!done && !this.disposed) this.zoomRaf = this.win.requestAnimationFrame(tick);
		};
		this.zoomRaf = this.win.requestAnimationFrame(tick);
	}

	private persist(): void {
		if (!this.onPersist || !this.nodes.length) return;
		const pos: Record<string, { x: number; y: number }> = {};
		for (const nd of this.nodes) pos[nd.id] = { x: Math.round((nd.x ?? 0) * 10) / 10, y: Math.round((nd.y ?? 0) * 10) / 10 };
		this.onPersist(pos);
	}

	private endpoint(v: string | number | SimNode): SimNode | undefined {
		if (typeof v === "object") return v;
		if (typeof v === "string") return this.byId.get(v);
		return this.nodes[v];
	}

	private draw(): void {
		const ctx = this.ctx;
		const { w, h } = this.cssSize();
		ctx.save();
		ctx.scale(this.dpr, this.dpr);
		ctx.clearRect(0, 0, w, h);

		const hv = this.hoverT; // eased 0..1 hover intensity
		const fset = this.focusSet;
		const fid = this.focusNode?.id ?? null;
		const ls = this.ap.lineScale;
		const now = Date.now();

		// Dim factors — deliberately gentle (Obsidian fades, it doesn't black out). Hover
		// fades non-neighbours toward NODE_DIM as hv rises; scope-pick uses a fixed dim.
		const NODE_DIM = 0.35;
		const EDGE_DIM = 0.22;
		const SCOPE_DIM = 0.18;
		const dimNode = (id: string): number => {
			if (fset) return fset.has(id) ? 1 : 1 - (1 - NODE_DIM) * hv;
			if (this.highlight) return this.highlight.has(id) ? 1 : SCOPE_DIM;
			return 1;
		};
		const litScope = (id: string): boolean => !!this.highlight && this.highlight.has(id);

		// Edges, pass 1: the graph in its normal tier colours; non-neighbour edges fade as
		// you hover a node.
		for (const e of this.links) {
			const a = this.endpoint(e.source);
			const b = this.endpoint(e.target);
			if (!a || !b) continue;
			let alpha: number;
			if (fid) {
				const incident = a.id === fid || b.id === fid;
				alpha = incident ? 1 : 1 - (1 - EDGE_DIM) * hv;
			} else {
				alpha = Math.min(dimNode(a.id), dimNode(b.id));
			}
			ctx.globalAlpha = alpha;
			if (e.tier === "proven") {
				ctx.strokeStyle = this.palette.edgeProven;
				ctx.lineWidth = 2.4 * ls;
				ctx.shadowColor = this.palette.edgeProven;
				ctx.shadowBlur = 8;
			} else if (e.tier === "inherited") {
				ctx.strokeStyle = this.palette.edgeInherited;
				ctx.lineWidth = 1.4 * ls;
				ctx.shadowBlur = 0;
			} else {
				ctx.strokeStyle = this.palette.edge;
				ctx.lineWidth = 1 * ls;
				ctx.shadowBlur = 0;
			}
			ctx.beginPath();
			ctx.moveTo(this.sx(a), this.sy(a));
			ctx.lineTo(this.sx(b), this.sy(b));
			ctx.stroke();
		}
		ctx.shadowBlur = 0;

		// Edges, pass 2: the hovered node's edges light up in the accent colour, faded in
		// with the hover intensity so it eases rather than snaps.
		if (fid && hv > 0.01) {
			ctx.globalAlpha = hv;
			ctx.strokeStyle = this.palette.ring;
			ctx.shadowBlur = 0;
			ctx.lineWidth = 1.2 * ls;
			for (const e of this.links) {
				const a = this.endpoint(e.source);
				const b = this.endpoint(e.target);
				if (!a || !b || (a.id !== fid && b.id !== fid)) continue;
				ctx.beginPath();
				ctx.moveTo(this.sx(a), this.sy(a));
				ctx.lineTo(this.sx(b), this.sy(b));
				ctx.stroke();
			}
			ctx.shadowBlur = 0;
		}

		// Nodes: practised notes are rounded squares (filled-in cells), un-practised ones
		// plain dots. Practised nodes get a soft glow in their own colour — the same
		// lit-vs-dormant language as the stat tiles and heatmap, so a "known" node reads
		// as lit up rather than just a different flat fill. Scope-highlighted nodes get a
		// brighter ring on top so it's obvious what a session covers. The numeric overlay
		// (if on) is drawn right here in the pixel face, inside the same shape, in
		// whichever of black/white actually reads against THIS node's fill colour.
		if (this.numberMode !== "off") {
			ctx.font = "9px \"Grill Pixel\", monospace";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
		}
		for (const nd of this.nodes) {
			const x = this.sx(nd);
			const y = this.sy(nd);
			const r = this.radius(nd);
			const square = nd.state !== "unpracticed";
			const fill = nodeFillColour(nd, this.colorMode, this.palette, now);
			const alpha = dimNode(nd.id);
			ctx.globalAlpha = alpha;
			ctx.fillStyle = fill;
			if (litScope(nd.id)) {
				ctx.shadowColor = this.palette.ring;
				ctx.shadowBlur = 18;
			} else if (square) {
				ctx.shadowColor = fill;
				ctx.shadowBlur = 7;
			}
			this.nodePath(x, y, r, square);
			ctx.fill();
			ctx.shadowBlur = 0;
			// Surface ring: a thin stroke in the canvas's own backdrop colour around every
			// node, so it stays legible where it overlaps an edge or another node — the
			// separation comes from this ring, not from a heavier, data-coloured border.
			ctx.strokeStyle = this.palette.surface;
			ctx.lineWidth = 1.4;
			this.nodePath(x, y, r, square);
			ctx.stroke();
			if (litScope(nd.id)) {
				ctx.strokeStyle = this.palette.ring;
				ctx.lineWidth = 2;
				this.nodePath(x, y, r + 3, square);
				ctx.stroke();
			}
			if (this.numberMode !== "off") {
				const score = gradeScore(nd, this.coverageWeight);
				if (score !== null && x >= -60 && x <= w + 60 && y >= -20 && y <= h + 20) {
					ctx.globalAlpha = alpha;
					ctx.fillStyle = contrastText(fill);
					ctx.fillText(formatGrade(score, this.numberMode), x, y + 0.5);
				}
			}
		}

		// Labels — fade in as you zoom past the fit-to-frame zoom. Only the hovered node's
		// name is forced on (faded in with the hover), like the native graph. The
		// threshold is deliberately high and the ramp slow: at a moderate zoom a dense
		// graph has dozens of nodes on screen at once, and showing all of their names
		// together is a wall of overlapping text, not a legible label — better to hold
		// off until the user has zoomed into a genuinely small cluster.
		const zoom = this.scale / (this.fitScale || 1);
		const threshold = Math.max(1.6, 2.4 - this.ap.textFade * 0.25);
		const labelAlpha = Math.max(0, Math.min(1, (zoom - threshold) / 1.1));
		if (labelAlpha > 0.02 || (fid && hv > 0.02)) {
			ctx.font = "11px var(--font-interface, sans-serif)";
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			ctx.lineWidth = 3;
			ctx.strokeStyle = this.palette.surface;
			ctx.lineJoin = "round";
			for (const nd of this.nodes) {
				const x = this.sx(nd);
				if (x < -60 || x > w + 60) continue;
				const y = this.sy(nd);
				if (y < -20 || y > h + 20) continue;
				const la = nd.id === fid ? Math.max(hv, labelAlpha * dimNode(nd.id)) : labelAlpha * dimNode(nd.id);
				if (la < 0.04) continue;
				ctx.globalAlpha = la;
				const ly = y + this.radius(nd) + 3;
				// A dark halo (stroked before the fill) so the label reads against the dot
				// grid and node glow behind it, instead of blending into a busy background.
				ctx.strokeText(nd.id, x, ly);
				ctx.fillStyle = this.palette.text;
				ctx.fillText(nd.id, x, ly);
			}
		}
		ctx.globalAlpha = 1;
		ctx.restore();
	}
}
