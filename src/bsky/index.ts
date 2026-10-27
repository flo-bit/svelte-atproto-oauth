import '@atcute/bluesky';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { AppBskyActorDefs } from '@atcute/bluesky';
import type { Did } from '@atcute/lexicons';
import type { Store } from '@atcute/oauth-node-client';
import { describeRepo, readThroughCache, type LoadMiniDocOptions } from '../helper/index.js';
import { requiredEndpoint, networkFetch, networkCacheKey, type IdentityOptions } from '../network/index.js';

export type BskyProfile = AppBskyActorDefs.ProfileViewDetailed;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cache = Store<string, any>;

export interface LoadBskyProfileOptions extends LoadMiniDocOptions {
	/** AppView URL. Default `https://public.api.bsky.app`. */
	appview?: string;
	/** Optional cache. Any `Store`. */
	cache?: Cache;
}

/**
 * Load a Bluesky profile for a DID via the public AppView. On failure or
 * `handle.invalid`, falls back to `{ did, handle }` from the user's PDS.
 *
 * Pass `options.cache` (any `Store`) for read-through caching keyed by DID.
 *
 * ```ts
 * import { loadBskyProfile } from '@svelte-atproto/oauth/bsky';
 * import { cloudflareKV } from '@svelte-atproto/oauth/server/stores/cloudflare';
 *
 * const profile = await loadBskyProfile(did, {
 *   cache: cloudflareKV('PROFILE_CACHE')
 * });
 * ```
 */
export async function loadBskyProfile(
	did: Did,
	options: LoadBskyProfileOptions = {}
): Promise<BskyProfile | undefined> {
	const appview = requiredEndpoint(options, 'appview', options.appview);

	return readThroughCache(options.cache, networkCacheKey(options, did, 'bsky-profile'), async () => {
		const client = new Client({ handler: simpleFetchHandler({ service: appview, fetch: networkFetch(options) }) });
		try {
			const r = await client.get('app.bsky.actor.getProfile', { params: { actor: did } });
			if (!r.ok) {
				if (options.network?.isolated) throw new Error(`AppView failed (${r.status})`);
				return await fallbackProfile(did, options);
			}
			if (r.data.handle === 'handle.invalid') return await fallbackProfile(did, options);
			return r.data;
		} catch (e) {
			if (options.network?.isolated) throw e;
			console.error('[atproto-oauth/bsky] loadBskyProfile failed:', e);
			return await fallbackProfile(did, options);
		}
	});
}

async function fallbackProfile(did: Did, options: LoadBskyProfileOptions): Promise<BskyProfile | undefined> {
	try {
		const repo = await describeRepo({ did, ...options });
		if (!repo) return;
		return { did, handle: repo.handle ?? 'handle.invalid' } as BskyProfile;
	} catch (e) {
		if (options.network?.isolated) throw e;
		return;
	}
}

/**
 * Batch-load Bluesky profiles for multiple DIDs via `app.bsky.actor.getProfiles`
 * (25 per request, automatically chunked). Returns an object keyed by DID, with
 * `undefined` for any DIDs that couldn't be resolved.
 *
 * Pass `cache` for read-through caching keyed by DID — cache hits skip the
 * network entirely; misses are batched.
 */
export async function loadBskyProfiles(
	dids: readonly Did[],
	options: LoadBskyProfileOptions = {}
): Promise<Record<string, BskyProfile | undefined>> {
	const result: Record<string, BskyProfile | undefined> = {};
	if (dids.length === 0) return result;

	const cache = options.cache;
	const toFetch: Did[] = [];

	if (cache) {
		await Promise.all(
			dids.map(async (did) => {
				try {
					const hit = (await cache.get(networkCacheKey(options, did, 'bsky-profile'))) as BskyProfile | undefined;
					if (hit !== undefined) result[did] = hit;
					else toFetch.push(did);
				} catch {
					toFetch.push(did);
				}
			})
		);
	} else {
		toFetch.push(...dids);
	}

	if (toFetch.length > 0) {
		const appview = requiredEndpoint(options, 'appview', options.appview);
		const client = new Client({ handler: simpleFetchHandler({ service: appview, fetch: networkFetch(options) }) });

		for (let i = 0; i < toFetch.length; i += 25) {
			const batch = toFetch.slice(i, i + 25);
			try {
				const r = await client.get('app.bsky.actor.getProfiles', {
					params: { actors: batch }
				});
				if (r.ok) {
					for (const profile of r.data.profiles) {
						const did = profile.did as string;
						result[did] = profile as BskyProfile;
						if (cache) {
							Promise.resolve(cache.set(networkCacheKey(options, did, 'bsky-profile'), profile)).catch((e: unknown) => {
								console.error('[atproto-oauth/bsky] cache set failed:', e);
							});
						}
					}
				} else if (options.network?.isolated) throw new Error(`AppView batch failed (${r.status})`);
			} catch (e) {
				if (options.network?.isolated) throw e;
				console.error('[atproto-oauth/bsky] loadBskyProfiles batch failed:', e);
			}
		}
	}

	for (const did of dids) {
		if (!(did in result)) result[did] = undefined;
	}

	return result;
}

/**
 * Direct AppView profile fetch — no fallback, no caching. Convenience for
 * one-off calls. Use `loadBskyProfile` for the cached + fallback variant.
 */
export async function getDetailedProfile({
	did,
	appview,
	client,
	...options
}: {
	did: Did;
	appview?: string;
	client?: Client;
} & IdentityOptions): Promise<BskyProfile | undefined> {
	client ??= new Client({ handler: simpleFetchHandler({ service: requiredEndpoint(options, 'appview', appview), fetch: networkFetch(options) }) });
	const r = await client.get('app.bsky.actor.getProfile', { params: { actor: did } });
	if (!r.ok) {
		if (options.network?.isolated) throw new Error(`AppView failed (${r.status})`);
		return;
	}
	return r.data;
}

/** Search Bluesky actors with typeahead. */
export async function searchActorsTypeahead({
	q,
	limit = 10,
	appview,
	...options
}: {
	q: string;
	limit?: number;
	appview?: string;
} & IdentityOptions): Promise<{ actors: AppBskyActorDefs.ProfileViewBasic[]; q: string }> {
	const client = new Client({ handler: simpleFetchHandler({ service: requiredEndpoint(options, 'appview', appview), fetch: networkFetch(options) }) });
	const r = await client.get('app.bsky.actor.searchActorsTypeahead', {
		params: { q, limit }
	});
	if (!r.ok) {
		if (options.network?.isolated) throw new Error(`AppView search failed (${r.status})`);
		return { actors: [], q };
	}
	return { actors: r.data.actors, q };
}

export type CDNPreset =
	| 'feed_thumbnail'
	| 'feed_fullsize'
	| 'avatar'
	| 'avatar_thumbnail'
	| 'banner';

/** Build a Bluesky CDN URL for an image blob (webp). */
export function getCDNImageBlobUrl({
	did,
	blob,
	cdn,
	preset = 'feed_thumbnail',
	network
}: {
	did: string;
	blob: { $type: 'blob'; ref: { $link: string } };
	cdn?: string;
	preset?: CDNPreset;
	network?: IdentityOptions['network'];
}): string {
	const base = requiredEndpoint({ network }, 'cdn', cdn);
	return `${base}/img/${preset}/plain/${did}/${blob.ref.$link}@webp`;
}
