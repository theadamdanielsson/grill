/** Minimal stand-in for the `obsidian` module, which only exists inside the app.
 * Tests bundle src/ with esbuild aliasing `obsidian` to this file (see run.mjs).
 * Elements are Proxies that accept any builder call, so view code that renders can
 * run headless; tests assert on state and on the store calls, not on the DOM. */

type Anyish = Record<string | symbol, unknown>;

export function fakeEl(): any {
	const target: Anyish = { style: {}, children: [] };
	return new Proxy(target, {
		get(t, prop) {
			if (prop in t) return t[prop];
			// Never look like a promise, or `await el` would hang.
			if (prop === "then" || typeof prop === "symbol") return undefined;
			return () => fakeEl();
		},
		set(t, prop, value) {
			t[prop] = value;
			return true;
		},
	});
}

const g = globalThis as unknown as Anyish;
if (!g.window) g.window = globalThis;
if (!g.document) g.document = { visibilityState: "visible", createElement: () => fakeEl() };
g.createFragment = (fn?: (f: unknown) => void) => {
	const f = fakeEl();
	fn?.(f);
	return f;
};

/** Every Notice shown, newest last. Tests read and reset this. */
export const notices: string[] = [];
export class Notice {
	constructor(message: unknown) {
		notices.push(typeof message === "string" ? message : "[fragment]");
	}
	hide(): void {}
	setMessage(): this {
		return this;
	}
}

export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: true };

export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "md";
	stat = { mtime: 0, size: 0, ctime: 0 };
	constructor(path = "") {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		const dot = this.name.lastIndexOf(".");
		this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
		this.extension = dot === -1 ? "" : this.name.slice(dot + 1);
	}
}
export class TFolder {
	path = "";
	children: unknown[] = [];
}
export class App {}
export class WorkspaceLeaf {}

export class ItemView {
	app: any;
	leaf: any;
	contentEl: any = fakeEl();
	containerEl: any = fakeEl();
	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf?.app;
	}
	registerDomEvent(): void {}
	registerEvent(): void {}
	registerInterval(): number {
		return 0;
	}
	register(): void {}
}

export class Plugin {
	app: any;
	manifest: any = { id: "grill" };
}
export class PluginSettingTab {
	app: any;
	containerEl: any = fakeEl();
	constructor(app: any) {
		this.app = app;
	}
}
export class Setting {
	constructor() {
		return fakeEl();
	}
}
export class Modal {
	contentEl: any = fakeEl();
	open(): void {}
	close(): void {}
}

export const MarkdownRenderer = { render: async () => undefined, renderMarkdown: async () => undefined };
export function setIcon(): void {}
export function normalizePath(p: string): string {
	return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export function getAllTags(): string[] {
	return [];
}
export async function loadPdfJs(): Promise<unknown> {
	throw new Error("pdf.js is not available in tests");
}

export type RequestUrlParam = { url: string; method?: string; body?: string; headers?: Record<string, string>; throw?: boolean };
export type RequestUrlResponse = { status: number; json: unknown; text: string };
/** Tests replace this to script network responses. */
export const net: { handler: (req: RequestUrlParam) => Promise<RequestUrlResponse> } = {
	handler: async () => {
		throw new Error("no network in tests");
	},
};
export function requestUrl(req: RequestUrlParam): Promise<RequestUrlResponse> {
	return net.handler(req);
}
