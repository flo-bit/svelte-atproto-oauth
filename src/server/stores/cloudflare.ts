import type { Store } from '@atcute/oauth-node-client';
import { getRequestEvent } from '$app/server';

/**
 * Minimal structural type for Cloudflare's `KVNamespace`. Avoids a peer
 * dependency on `@cloudflare/workers-types` while remaining assignable
 * from the real binding.
 */
export interface KVNamespaceLike {
	get(key: string, type: 'text'): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number }
	): Promise<void>;
	delete(key: string): Promise<void>;
	list(options?: { cursor?: string }): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}>;
}

export interface CloudflareKVOptions {
	/** Per-key TTL in seconds. Cloudflare KV requires `expirationTtl >= 60`. */
	ttl?: number;
}

class CloudflareKVStore<K extends string, V> implements Store<K, V> {
	constructor(
		private readonly kv: KVNamespaceLike,
		private readonly ttl: number | undefined
	) {}

	async get(key: K): Promise<V | undefined> {
		const value = await this.kv.get(key, 'text');
		if (value === null) return undefined;
		return JSON.parse(value) as V;
	}

	async set(key: K, value: V): Promise<void> {
		await this.kv.put(key, JSON.stringify(value), {
			expirationTtl: this.ttl
		});
	}

	async delete(key: K): Promise<void> {
		await this.kv.delete(key);
	}

	async clear(): Promise<void> {
		let cursor: string | undefined;
		do {
			const r = await this.kv.list({ cursor });
			for (const k of r.keys) await this.kv.delete(k.name);
			cursor = r.list_complete ? undefined : r.cursor;
		} while (cursor);
	}
}

/**
 * Wrap a Cloudflare KV namespace as a `Store`.
 *
 * Two forms:
 * - `cloudflareKV(bindingName)` — factory that reads
 *   `event.platform.env[bindingName]` per request. Returns `undefined` when
 *   the binding is missing (typical in dev without wrangler), so the lib's
 *   in-memory fallback kicks in. **Recommended.**
 * - `cloudflareKV(namespace)` — direct: pass the binding yourself.
 */
export function cloudflareKV<K extends string, V>(
	bindingName: string,
	opts?: CloudflareKVOptions
): () => Store<K, V> | undefined;
export function cloudflareKV<K extends string, V>(
	namespace: KVNamespaceLike,
	opts?: CloudflareKVOptions
): Store<K, V>;
export function cloudflareKV<K extends string, V>(
	arg: string | KVNamespaceLike,
	opts: CloudflareKVOptions = {}
): Store<K, V> | (() => Store<K, V> | undefined) {
	if (typeof arg === 'string') {
		return () => {
			const env = getRequestEvent().platform?.env as
				| Record<string, KVNamespaceLike | undefined>
				| undefined;
			const ns = env?.[arg];
			return ns ? new CloudflareKVStore<K, V>(ns, opts.ttl) : undefined;
		};
	}
	return new CloudflareKVStore<K, V>(arg, opts.ttl);
}
