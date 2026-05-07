import { MemoryStore, type Store } from '@atcute/oauth-node-client';

export interface MemoryStoreOptions {
	/** TTL in milliseconds. Default: no expiry for sessions, 600_000 for states. */
	ttl?: number;
}

export function memory<K extends string, V>(opts: MemoryStoreOptions = {}): Store<K, V> {
	return new MemoryStore<K, V>(opts.ttl !== undefined ? { ttl: opts.ttl } : undefined);
}
