import '@atcute/bluesky';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { AppBskyActorDefs } from '@atcute/bluesky';
import type { Did } from '@atcute/lexicons';
import type { Store } from '@atcute/oauth-node-client';
import { describeRepo, readThroughCache } from '../helper/index.js';

const DEFAULT_APPVIEW = 'https://public.api.bsky.app';
const DEFAULT_CDN = 'https://cdn.bsky.app';

export type BskyProfile = AppBskyActorDefs.ProfileViewDetailed;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cache = Store<string, any>;

export interface LoadBskyProfileOptions {
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
	const appview = options.appview ?? DEFAULT_APPVIEW;

	return readThroughCache(options.cache, did, async () => {
		const client = new Client({ handler: simpleFetchHandler({ service: appview }) });
		try {
			const r = await client.get('app.bsky.actor.getProfile', { params: { actor: did } });
			if (!r.ok) return await fallbackProfile(did);
			if (r.data.handle === 'handle.invalid') return await fallbackProfile(did);
			return r.data;
		} catch (e) {
			console.error('[atproto-oauth/bsky] loadBskyProfile failed:', e);
			return await fallbackProfile(did);
		}
	});
}

async function fallbackProfile(did: Did): Promise<BskyProfile | undefined> {
	try {
		const repo = await describeRepo({ did });
		if (!repo) return;
		return { did, handle: repo.handle ?? 'handle.invalid' } as BskyProfile;
	} catch {
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
					const hit = (await cache.get(did)) as BskyProfile | undefined;
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
		const appview = options.appview ?? DEFAULT_APPVIEW;
		const client = new Client({ handler: simpleFetchHandler({ service: appview }) });

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
							Promise.resolve(cache.set(did, profile)).catch((e: unknown) => {
								console.error('[atproto-oauth/bsky] cache set failed:', e);
							});
						}
					}
				}
			} catch (e) {
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
	appview = DEFAULT_APPVIEW,
	client
}: {
	did: Did;
	appview?: string;
	client?: Client;
}): Promise<BskyProfile | undefined> {
	client ??= new Client({ handler: simpleFetchHandler({ service: appview }) });
	const r = await client.get('app.bsky.actor.getProfile', { params: { actor: did } });
	if (!r.ok) return;
	return r.data;
}

/** Search Bluesky actors with typeahead. */
export async function searchActorsTypeahead({
	q,
	limit = 10,
	appview = DEFAULT_APPVIEW
}: {
	q: string;
	limit?: number;
	appview?: string;
}): Promise<{ actors: AppBskyActorDefs.ProfileViewBasic[]; q: string }> {
	const client = new Client({ handler: simpleFetchHandler({ service: appview }) });
	const r = await client.get('app.bsky.actor.searchActorsTypeahead', {
		params: { q, limit }
	});
	if (!r.ok) return { actors: [], q };
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
	cdn = DEFAULT_CDN,
	preset = 'feed_thumbnail'
}: {
	did: string;
	blob: { $type: 'blob'; ref: { $link: string } };
	cdn?: string;
	preset?: CDNPreset;
}): string {
	return `${cdn}/img/${preset}/plain/${did}/${blob.ref.$link}@webp`;
}
