import '@atcute/atproto';
import { parseResourceUri, type Did, type Handle } from '@atcute/lexicons';
import { isDid } from '@atcute/lexicons/syntax';
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Store } from '@atcute/oauth-node-client';
import * as TID from '@atcute/tid';

export type Collection = `${string}.${string}.${string}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cache = Store<string, any>;

export async function readThroughCache<T>(
	cache: Cache | undefined,
	key: string,
	load: () => Promise<T | undefined>
): Promise<T | undefined> {
	if (cache) {
		try {
			const hit = (await cache.get(key)) as T | undefined;
			if (hit !== undefined) return hit;
		} catch (e) {
			console.error('[atproto-oauth] cache get failed:', e);
		}
	}

	const value = await load();

	if (cache && value !== undefined) {
		// Some `Store` implementations (e.g. atcute's `MemoryStore`) return
		// `void` synchronously rather than a Promise. Wrap with `Promise.resolve`
		// to handle both, fire-and-forget so the response isn't blocked on cache writes.
		Promise.resolve(cache.set(key, value)).catch((e: unknown) => {
			console.error('[atproto-oauth] cache set failed:', e);
		});
	}

	return value;
}

const DEFAULT_DOH = 'https://mozilla.cloudflare-dns.com/dns-query';
const DEFAULT_SLINGSHOT = 'https://slingshot.microcosm.blue';
const DEFAULT_UFO = 'https://ufos-api.microcosm.blue';
const DEFAULT_CONSTELLATION = 'https://constellation.microcosm.blue';

// --- Microcosm health: per-host circuit breaker + request timeout -----------
// Internal. After N consecutive failures (5xx, network errors, timeouts) the
// breaker opens for `MICROCOSM_COOLDOWN_MS`; further calls fail fast until
// cooldown expires. 4xx is treated as application-level (caller decides),
// not a host-health signal.

const MICROCOSM_FAILURE_THRESHOLD = 3;
const MICROCOSM_COOLDOWN_MS = 60_000;
const MICROCOSM_TIMEOUT_MS = 5_000;

const microcosmFailures = new Map<string, number>();
const microcosmOpenUntil = new Map<string, number>();

function microcosmIsOpen(host: string): boolean {
	const until = microcosmOpenUntil.get(host);
	if (until === undefined) return false;
	if (Date.now() >= until) {
		microcosmOpenUntil.delete(host);
		microcosmFailures.delete(host);
		return false;
	}
	return true;
}

function microcosmRecordSuccess(host: string): void {
	microcosmFailures.delete(host);
	microcosmOpenUntil.delete(host);
}

function microcosmRecordFailure(host: string): void {
	const n = (microcosmFailures.get(host) ?? 0) + 1;
	microcosmFailures.set(host, n);
	if (n >= MICROCOSM_FAILURE_THRESHOLD) {
		microcosmOpenUntil.set(host, Date.now() + MICROCOSM_COOLDOWN_MS);
	}
}

async function fetchMicrocosm(url: string): Promise<Response> {
	const host = new URL(url).origin;
	if (microcosmIsOpen(host)) {
		throw new Error(`microcosm: circuit open for ${host}`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MICROCOSM_TIMEOUT_MS);
	try {
		const r = await fetch(url, { signal: controller.signal });
		if (r.status >= 500) {
			microcosmRecordFailure(host);
			throw new Error(`microcosm: ${host} returned ${r.status}`);
		}
		microcosmRecordSuccess(host);
		return r;
	} catch (e) {
		microcosmRecordFailure(host);
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Pass `slingshot: false` to disable, or a URL to use a different (e.g.
 * self-hosted) instance. Default: `https://slingshot.microcosm.blue`.
 */
export interface SlingshotOptions {
	slingshot?: false | string;
}

export interface MiniDoc {
	did: Did;
	handle: string;
	pds: string;
	signing_key?: string;
}

/**
 * Direct call to slingshot's `blue.microcosm.identity.resolveMiniDoc` for a
 * handle or DID. Returns `undefined` on any failure (including
 * `slingshot: false`). No caching, no fallback — use `loadMiniDoc` for that.
 */
export async function resolveMiniDoc(
	identifier: string,
	options: SlingshotOptions = {}
): Promise<MiniDoc | undefined> {
	if (options.slingshot === false) return undefined;
	const base = options.slingshot ?? DEFAULT_SLINGSHOT;
	try {
		const url = `${base}/xrpc/blue.microcosm.identity.resolveMiniDoc?identifier=${encodeURIComponent(identifier)}`;
		const r = await fetchMicrocosm(url);
		if (!r.ok) return undefined;
		return (await r.json()) as MiniDoc;
	} catch (e) {
		console.error('[atproto-oauth/helper] resolveMiniDoc failed:', e);
		return undefined;
	}
}

const handleResolver = (doh: string) =>
	new CompositeHandleResolver({
		methods: {
			dns: new DohJsonHandleResolver({ dohUrl: doh }),
			http: new WellKnownHandleResolver()
		}
	});

const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver()
	}
});

async function fallbackPds(did: Did): Promise<string | undefined> {
	try {
		const doc = await didResolver.resolve(did as Did<'plc'> | Did<'web'>);
		if (!doc.service) return;
		for (const service of doc.service) {
			if (service.id === '#atproto_pds') {
				return service.serviceEndpoint.toString();
			}
		}
	} catch (e) {
		console.error('[atproto-oauth/helper] PDS resolution failed:', e);
	}
}

async function fallbackMiniDoc(
	identifier: string,
	doh: string
): Promise<MiniDoc | undefined> {
	let did: Did;
	if (isDid(identifier)) {
		did = identifier;
	} else {
		try {
			did = await handleResolver(doh).resolve(identifier as Handle);
		} catch (e) {
			console.error('[atproto-oauth/helper] handle resolution failed:', e);
			return undefined;
		}
	}

	const pds = await fallbackPds(did);
	if (!pds) return undefined;

	try {
		const client = new Client({ handler: simpleFetchHandler({ service: pds }) });
		const r = await client.get('com.atproto.repo.describeRepo', { params: { repo: did } });
		if (!r.ok) return { did, handle: 'handle.invalid', pds };
		return { did, handle: r.data.handle, pds };
	} catch {
		return { did, handle: 'handle.invalid', pds };
	}
}

export interface LoadMiniDocOptions extends SlingshotOptions {
	/** Optional cache keyed by the input identifier. */
	cache?: Cache;
	/** DoH resolver URL for the fallback path. Default Mozilla/Cloudflare. */
	doh?: string;
}

/**
 * Resolve a handle or DID to its `{ did, handle, pds }`. Tries slingshot
 * first; on failure or `slingshot: false`, falls back to PLC/did:web for
 * PDS and `describeRepo` for handle. Cacheable.
 */
export async function loadMiniDoc(
	identifier: string,
	options: LoadMiniDocOptions = {}
): Promise<MiniDoc | undefined> {
	return readThroughCache(options.cache, identifier, async () => {
		const fast = await resolveMiniDoc(identifier, options);
		if (fast) return fast;
		return fallbackMiniDoc(identifier, options.doh ?? DEFAULT_DOH);
	});
}

/**
 * Parse an AT URI (`at://did:plc:xyz/app.bsky.feed.post/abc`) into
 * `{ repo, collection, rkey }`. Returns `undefined` if not a valid AT URI.
 */
export function parseUri(uri: string) {
	const parts = parseResourceUri(uri);
	if (!parts.ok) return;
	return parts.value;
}

/**
 * Resolve a handle to a DID. Tries slingshot first, falls back to DoH +
 * `.well-known`.
 */
export async function resolveHandle({
	handle,
	doh = DEFAULT_DOH,
	slingshot
}: {
	handle: Handle;
	doh?: string;
} & SlingshotOptions): Promise<Did> {
	const mini = await resolveMiniDoc(handle, { slingshot });
	if (mini?.did) return mini.did;
	return await handleResolver(doh).resolve(handle);
}

/**
 * Normalize a handle-or-DID input into a DID.
 */
export async function actorToDid(
	actor: string,
	options: { doh?: string } & SlingshotOptions = {}
): Promise<Did> {
	if (isDid(actor)) return actor;
	return await resolveHandle({
		handle: actor as Handle,
		doh: options.doh,
		slingshot: options.slingshot
	});
}

/**
 * Look up the PDS endpoint for a DID. Tries slingshot first, falls back to
 * PLC / did:web resolution.
 */
export async function getPDS(
	did: Did,
	options: SlingshotOptions = {}
): Promise<string | undefined> {
	const mini = await resolveMiniDoc(did, options);
	if (mini?.pds) return mini.pds;
	return await fallbackPds(did);
}

/**
 * Build an unauthenticated atcute Client pointed at the user's PDS.
 */
export async function getPDSClient(
	{ did }: { did: Did },
	options: SlingshotOptions = {}
): Promise<Client> {
	const pds = await getPDS(did, options);
	if (!pds) throw new Error(`PDS not found for ${did}`);
	return new Client({ handler: simpleFetchHandler({ service: pds }) });
}

/**
 * List records from a repo's collection. `did` is required; pass an
 * authed `client` for private records, omit for public listings.
 */
export async function listRecords({
	did,
	collection,
	cursor,
	limit = 100,
	client,
	slingshot
}: {
	did: Did;
	collection: Collection;
	cursor?: string;
	limit?: number;
	client?: Client;
} & SlingshotOptions) {
	if (!did) throw new Error('listRecords: did is required');
	if (!collection) throw new Error('listRecords: collection is required');

	client ??= await getPDSClient({ did }, { slingshot });

	const allRecords = [];
	let currentCursor = cursor;

	do {
		const response = await client.get('com.atproto.repo.listRecords', {
			params: {
				repo: did,
				collection,
				limit: !limit || limit > 100 ? 100 : limit,
				cursor: currentCursor
			}
		});

		if (!response.ok) return allRecords;

		allRecords.push(...response.data.records);
		currentCursor = response.data.cursor;
	} while (currentCursor && (!limit || allRecords.length < limit));

	return allRecords;
}

/**
 * Fetch a single record. `rkey` defaults to `'self'`.
 */
export async function getRecord({
	did,
	collection,
	rkey = 'self',
	client,
	slingshot
}: {
	did: Did;
	collection: Collection;
	rkey?: string;
	client?: Client;
} & SlingshotOptions) {
	if (!did) throw new Error('getRecord: did is required');
	if (!collection) throw new Error('getRecord: collection is required');

	client ??= await getPDSClient({ did }, { slingshot });
	const record = await client.get('com.atproto.repo.getRecord', {
		params: { repo: did, collection, rkey }
	});
	return JSON.parse(JSON.stringify(record.data));
}

/**
 * Fetch a record by AT URI. Tries slingshot's `getRecordByUri` first;
 * falls back to parsing the URI and calling `getRecord` against the
 * resolved PDS.
 */
export async function getRecordByUri(
	uri: string,
	options: SlingshotOptions & { cid?: string; client?: Client } = {}
): Promise<{ cid: string; uri: string; value: unknown } | undefined> {
	if (options.slingshot !== false) {
		const base = options.slingshot ?? DEFAULT_SLINGSHOT;
		try {
			const params = new URLSearchParams({ at_uri: uri });
			if (options.cid) params.set('cid', options.cid);
			const r = await fetchMicrocosm(`${base}/xrpc/blue.microcosm.repo.getRecordByUri?${params}`);
			if (r.ok) {
				return (await r.json()) as { cid: string; uri: string; value: unknown };
			}
		} catch (e) {
			console.error('[atproto-oauth/helper] slingshot getRecordByUri failed:', e);
		}
	}

	const parts = parseUri(uri);
	if (!parts) return undefined;
	try {
		const data = await getRecord({
			did: parts.repo as Did,
			collection: parts.collection as Collection,
			rkey: parts.rkey,
			client: options.client,
			slingshot: options.slingshot
		});
		return data;
	} catch {
		return undefined;
	}
}

/**
 * Repo metadata (handle, signing key, available collections).
 */
export async function describeRepo({
	did,
	client,
	slingshot
}: {
	did: Did;
	client?: Client;
} & SlingshotOptions) {
	if (!did) throw new Error('describeRepo: did is required');
	client ??= await getPDSClient({ did }, { slingshot });
	const r = await client.get('com.atproto.repo.describeRepo', {
		params: { repo: did }
	});
	if (!r.ok) return;
	return r.data;
}

/**
 * Build a direct PDS blob URL (`com.atproto.sync.getBlob`). Works for any
 * blob in the user's PDS — generic, not tied to a specific CDN.
 */
export async function getBlobURL({
	did,
	blob,
	slingshot
}: {
	did: Did;
	blob: { $type: 'blob'; ref: { $link: string } };
} & SlingshotOptions): Promise<string> {
	const pds = await getPDS(did, { slingshot });
	return `${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${blob.ref.$link}`;
}

/**
 * Generate a TID (timestamp-based identifier) for use as a record rkey.
 */
export function createTID(): string {
	return TID.now();
}

export interface LoadHandleOptions {
	/** Optional cache keyed by DID. Any `Store` (memory, cloudflareKV, upstashRedis, …). */
	cache?: Cache;
	/** Slingshot instance URL, or `false` to disable. Default `https://slingshot.microcosm.blue`. */
	slingshot?: false | string;
	/** DoH resolver URL for the fallback path. Default Mozilla/Cloudflare. */
	doh?: string;
}

/**
 * Look up just the handle for a DID. Tries slingshot first, falls back to
 * PDS `describeRepo`. Pass `cache` for read-through caching keyed by DID,
 * `slingshot: false` to skip slingshot, or `slingshot: 'https://...'` to
 * use a different instance.
 */
export async function loadHandle(
	did: Did,
	options: LoadHandleOptions = {}
): Promise<string | undefined> {
	const mini = await loadMiniDoc(did, options);
	return mini?.handle;
}

/**
 * Batch-resolve handles for multiple DIDs. Returns an object keyed by DID,
 * with `undefined` for any DIDs that couldn't be resolved. Each lookup
 * uses `loadHandle` (slingshot-first, cache-aware), running in parallel.
 */
export async function loadHandles(
	dids: readonly Did[],
	options: LoadHandleOptions = {}
): Promise<Record<string, string | undefined>> {
	const entries = await Promise.all(
		dids.map(async (did) => [did, await loadHandle(did, options)] as const)
	);
	return Object.fromEntries(entries);
}

export interface UfoOptions {
	/** UFO instance URL. Default `https://ufos-api.microcosm.blue`. */
	ufo?: string;
}

export interface UfoRecord {
	did: Did;
	collection: string;
	rkey: string;
	record: { $type: string; [k: string]: unknown };
	time_us: number;
}

/**
 * Recent records seen on the firehose for a given collection, via UFO.
 * Returns `[]` on failure. Pass a different `ufo` URL to use a self-hosted instance.
 *
 * ```ts
 * const recent = await recentRecords('xyz.statusphere.status');
 * // → [{ did, collection, rkey, record: {...}, time_us }, …]
 * ```
 */
export async function recentRecords(
	collection: string,
	options: UfoOptions = {}
): Promise<UfoRecord[]> {
	const base = options.ufo ?? DEFAULT_UFO;
	try {
		const url = `${base}/records?collection=${encodeURIComponent(collection)}`;
		const r = await fetchMicrocosm(url);
		if (!r.ok) return [];
		return (await r.json()) as UfoRecord[];
	} catch (e) {
		console.error('[atproto-oauth/helper] recentRecords failed:', e);
		return [];
	}
}

// --- Constellation: backlinks index -----------------------------------------
// `https://constellation.microcosm.blue` indexes the firehose by *what links
// to what*: given a target (AT URI or DID) and a {collection, path} source,
// it answers "who linked to me" — likes, reposts, follows, replies, etc.
// All calls are wrapped by `fetchMicrocosm` (5s timeout + circuit breaker).

export interface ConstellationOptions {
	/** Constellation instance URL. Default `https://constellation.microcosm.blue`. */
	constellation?: string;
}

export interface BacklinkSource {
	/** Collection NSID of the linking record, e.g. `app.bsky.feed.like`. */
	collection: Collection;
	/** JSON path within the linking record, e.g. `.subject.uri` or `.subject`. */
	path: string;
}

export interface BacklinkRecord {
	did: Did;
	collection: string;
	rkey: string;
}

export interface BacklinksPage {
	total: number;
	records: BacklinkRecord[];
	cursor?: string;
}

export interface DistinctBacklinkersPage {
	total: number;
	dids: Did[];
	cursor?: string;
}

/** All sources rolled up: `{ [collection]: { [path]: { records, distinct_dids } } }`. */
export interface BacklinksRollup {
	[collection: string]: {
		[path: string]: { records: number; distinct_dids: number };
	};
}

function constellationParams(target: string, source: BacklinkSource): URLSearchParams {
	const path = source.path.startsWith('.') ? source.path : `.${source.path}`;
	return new URLSearchParams({ target, collection: source.collection, path });
}

/**
 * Count records that link to `target` from `source`. E.g. like-count for a
 * post, follower-count for a DID. Returns `undefined` if Constellation is
 * unavailable (`constellation: false`, circuit open, or upstream failure).
 *
 * ```ts
 * const likes = await countBacklinks(postUri, {
 *   collection: 'app.bsky.feed.like',
 *   path: '.subject.uri'
 * });
 * ```
 */
export async function countBacklinks(
	target: string,
	source: BacklinkSource,
	options: ConstellationOptions = {}
): Promise<number | undefined> {
	const base = options.constellation ?? DEFAULT_CONSTELLATION;
	try {
		const r = await fetchMicrocosm(`${base}/links/count?${constellationParams(target, source)}`);
		if (!r.ok) return undefined;
		return ((await r.json()) as { total: number }).total;
	} catch (e) {
		console.error('[atproto-oauth/helper] countBacklinks failed:', e);
		return undefined;
	}
}

/**
 * Count *distinct* DIDs that link to `target` from `source`. E.g. for a
 * post, this is the like-count deduped by liker; for a DID, distinct
 * followers (a follow points one-to-one anyway, so usually equal to
 * `countBacklinks`).
 */
export async function countDistinctBacklinkers(
	target: string,
	source: BacklinkSource,
	options: ConstellationOptions = {}
): Promise<number | undefined> {
	const base = options.constellation ?? DEFAULT_CONSTELLATION;
	try {
		const r = await fetchMicrocosm(
			`${base}/links/count/distinct-dids?${constellationParams(target, source)}`
		);
		if (!r.ok) return undefined;
		return ((await r.json()) as { total: number }).total;
	} catch (e) {
		console.error('[atproto-oauth/helper] countDistinctBacklinkers failed:', e);
		return undefined;
	}
}

/**
 * List records (their `{ did, collection, rkey }`) that link to `target`.
 * Pass `cursor` back in to paginate. Optional `did` narrows to records from
 * a single DID; `reverse` flips the order.
 */
export async function listBacklinks(
	target: string,
	source: BacklinkSource,
	options: ConstellationOptions & {
		did?: Did;
		limit?: number;
		reverse?: boolean;
		cursor?: string;
	} = {}
): Promise<BacklinksPage | undefined> {
	const base = options.constellation ?? DEFAULT_CONSTELLATION;
	try {
		const params = constellationParams(target, source);
		if (options.did) params.set('did', options.did);
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.reverse) params.set('reverse', 'true');
		if (options.cursor) params.set('cursor', options.cursor);

		const r = await fetchMicrocosm(`${base}/links?${params}`);
		if (!r.ok) return undefined;
		const data = (await r.json()) as {
			total: number;
			linking_records: BacklinkRecord[];
			cursor: string | null;
		};
		return {
			total: data.total,
			records: data.linking_records,
			cursor: data.cursor ?? undefined
		};
	} catch (e) {
		console.error('[atproto-oauth/helper] listBacklinks failed:', e);
		return undefined;
	}
}

/**
 * List the *distinct* DIDs that link to `target` from `source`. Paginates
 * via `cursor`.
 */
export async function listDistinctBacklinkers(
	target: string,
	source: BacklinkSource,
	options: ConstellationOptions & { limit?: number; cursor?: string } = {}
): Promise<DistinctBacklinkersPage | undefined> {
	const base = options.constellation ?? DEFAULT_CONSTELLATION;
	try {
		const params = constellationParams(target, source);
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.cursor) params.set('cursor', options.cursor);

		const r = await fetchMicrocosm(`${base}/links/distinct-dids?${params}`);
		if (!r.ok) return undefined;
		const data = (await r.json()) as {
			total: number;
			linking_dids: Did[];
			cursor: string | null;
		};
		return {
			total: data.total,
			dids: data.linking_dids,
			cursor: data.cursor ?? undefined
		};
	} catch (e) {
		console.error('[atproto-oauth/helper] listDistinctBacklinkers failed:', e);
		return undefined;
	}
}

/**
 * Roll up *all* sources that link to `target` — useful for a quick "what
 * does the network say about this thing?" overview. Returns
 * `{ [collection]: { [path]: { records, distinct_dids } } }`.
 */
export async function backlinksRollup(
	target: string,
	options: ConstellationOptions = {}
): Promise<BacklinksRollup | undefined> {
	const base = options.constellation ?? DEFAULT_CONSTELLATION;
	try {
		const r = await fetchMicrocosm(`${base}/links/all?target=${encodeURIComponent(target)}`);
		if (!r.ok) return undefined;
		return ((await r.json()) as { links: BacklinksRollup }).links;
	} catch (e) {
		console.error('[atproto-oauth/helper] backlinksRollup failed:', e);
		return undefined;
	}
}
