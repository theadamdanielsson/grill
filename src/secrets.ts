/** API keys live in Obsidian's keychain (SecretStorage, Obsidian 1.11.4+) instead of
 * the plugin's data.json, which is plaintext and travels with whatever syncs or backs
 * up the vault's .obsidian folder. The keychain belongs to one device.
 *
 * Feature-detected, not a minAppVersion bump: on an older Obsidian, or anywhere secure
 * storage is unavailable, keys stay in data.json exactly as before.
 *
 * The move takes two launches on purpose. Writing to the keychain only updates
 * Obsidian's in-memory copy at once; the write to disk happens later and its failure is
 * never reported, so reading a key straight back proves nothing. A key is therefore
 * blanked in data.json only when the keychain already held that exact key at startup,
 * which means it survived a restart. Until then it sits in both places.
 */

import type { App } from "obsidian";
import type { ProviderId } from "./llm";

/** The slice of Obsidian's SecretStorage this needs. `deleteSecret` exists in the app
 * but is not in the public typings, so it's optional here. */
export interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	deleteSecret?: (id: string) => boolean;
}

export type ApiKeys = Record<ProviderId, string>;

export function secretStore(app: App): SecretStore | null {
	const st = (app as unknown as { secretStorage?: SecretStore }).secretStorage;
	return st && typeof st.getSecret === "function" && typeof st.setSecret === "function" ? st : null;
}

/** The vault's id, which goes into each secret's name: on phones every vault on the
 * device shares one keychain, and two vaults must not overwrite each other's key. */
export function vaultId(app: App): string {
	const id = (app as unknown as { appId?: unknown }).appId;
	return typeof id === "string" ? id.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

export class KeyStash {
	/** What the keychain held when this session started. */
	private atStartup: Partial<ApiKeys> = {};
	/** The last value the keychain was seen holding, this session. */
	private seen: Partial<ApiKeys> = {};
	/** True while stash() is writing, so its own "changed" events are ignored. */
	stashing = false;

	constructor(
		private store: SecretStore | null,
		private vault: string,
	) {}

	get available(): boolean {
		return this.store !== null;
	}

	/** Lowercase letters, digits and dashes only, 64 at most: the keychain rejects
	 * anything else. */
	id(provider: ProviderId): string {
		return this.vault ? `grill-${this.vault}-${provider}` : `grill-${provider}-api-key`;
	}

	private held(provider: ProviderId): string {
		try {
			return this.store?.getSecret(this.id(provider)) ?? "";
		} catch {
			return "";
		}
	}

	/** The keys to run on, given what data.json holds. Call once, at load. A key still
	 * in data.json wins: it's from before the move, or not yet confirmed, or one the
	 * keychain refused. Otherwise the keychain's copy is used. */
	load(fromData: ApiKeys): ApiKeys {
		const keys = { ...fromData };
		for (const p of Object.keys(keys) as ProviderId[]) {
			const held = this.held(p);
			if (held) this.atStartup[p] = this.seen[p] = held;
			if (!keys[p]) keys[p] = held;
		}
		return keys;
	}

	/** Put the live keys in the keychain and return what data.json should hold: blank
	 * for a key the keychain held at startup, the key itself for any other. */
	stash(keys: ApiKeys): ApiKeys {
		const forData = { ...keys };
		const store = this.store;
		if (!store) return forData;
		this.stashing = true;
		try {
			for (const p of Object.keys(forData) as ProviderId[]) {
				const id = this.id(p);
				const key = forData[p];
				try {
					if (key) {
						if (store.getSecret(id) !== key) store.setSecret(id, key);
						if (store.getSecret(id) === key) {
							this.seen[p] = key;
							if (this.atStartup[p] === key) forData[p] = "";
						}
					} else {
						// The user cleared the key: clear the keychain's copy too, or it
						// would come straight back on the next load.
						if (store.getSecret(id)) {
							if (typeof store.deleteSecret === "function") store.deleteSecret(id);
							else store.setSecret(id, "");
						}
						delete this.seen[p];
						delete this.atStartup[p];
					}
				} catch {
					// Leave forData[p] as the key: data.json keeps it, nothing is lost.
				}
			}
		} finally {
			this.stashing = false;
		}
		return forData;
	}

	/** The keychain changed outside Grill (Obsidian's own Keychain page). Take an edited
	 * key, and drop one that was deleted there. A missing entry only counts as deleted
	 * if the keychain was seen holding that key; otherwise it may live in data.json
	 * alone and must be left be. Returns whether a key was dropped. */
	adopt(live: ApiKeys): boolean {
		if (!this.store || this.stashing) return false;
		let dropped = false;
		for (const p of Object.keys(live) as ProviderId[]) {
			const held = this.held(p);
			if (held) {
				live[p] = this.seen[p] = held;
			} else if (live[p] && this.seen[p] === live[p]) {
				live[p] = "";
				delete this.seen[p];
				delete this.atStartup[p];
				dropped = true;
			}
		}
		return dropped;
	}
}
