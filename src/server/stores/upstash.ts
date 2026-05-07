import type { Store } from '@atcute/oauth-node-client';

export interface UpstashOptions {
	url: string;
	token: string;
	/** Per-key TTL in seconds. */
	ttl?: number;
	/** Optional namespace prefix to share a database between concerns. */
	prefix?: string;
}

class UpstashRedisStore<K extends string, V> implements Store<K, V> {
	constructor(private readonly opts: UpstashOptions) {
		if (!opts.url) throw new Error('upstash store: url is required');
		if (!opts.token) throw new Error('upstash store: token is required');
	}

	private k(key: K): string {
		return this.opts.prefix ? `${this.opts.prefix}${key}` : key;
	}

	private async cmd<T>(args: (string | number)[]): Promise<T> {
		const res = await fetch(this.opts.url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.opts.token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(args)
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`upstash error ${res.status}: ${body}`);
		}
		const data = (await res.json()) as { result?: T; error?: string };
		if (data.error) throw new Error(`upstash: ${data.error}`);
		return data.result as T;
	}

	async get(key: K): Promise<V | undefined> {
		const value = await this.cmd<string | null>(['GET', this.k(key)]);
		if (value === null || value === undefined) return undefined;
		return JSON.parse(value) as V;
	}

	async set(key: K, value: V): Promise<void> {
		const args: (string | number)[] = ['SET', this.k(key), JSON.stringify(value)];
		if (this.opts.ttl !== undefined) args.push('EX', this.opts.ttl);
		await this.cmd<string>(args);
	}

	async delete(key: K): Promise<void> {
		await this.cmd<number>(['DEL', this.k(key)]);
	}

	async clear(): Promise<void> {
		// Refuse without a prefix — calling DEL across an unscoped database
		// would wipe data this store doesn't own. Pass `prefix` to enable.
		if (!this.opts.prefix) {
			throw new Error(
				'upstash store: clear() requires a `prefix` to scope the operation. ' +
					'Without one, this would delete every key in the Redis database.'
			);
		}
		const pattern = `${this.opts.prefix}*`;
		let cursor = '0';
		do {
			const [next, keys] = await this.cmd<[string, string[]]>([
				'SCAN',
				cursor,
				'MATCH',
				pattern,
				'COUNT',
				1000
			]);
			if (keys.length > 0) await this.cmd<number>(['DEL', ...keys]);
			cursor = next;
		} while (cursor !== '0');
	}
}

export function upstashRedis<K extends string, V>(opts: UpstashOptions): Store<K, V> {
	return new UpstashRedisStore<K, V>(opts);
}
