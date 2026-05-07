# `@svelte-atproto/oauth`

atproto OAuth for SvelteKit — confidential or loopback OAuth client, with pluggable session storage and slingshot/UFO integration for fast identity + firehose lookups.

```sh
pnpm add @svelte-atproto/oauth
```

For one-shot setup of a fresh SvelteKit project, use the [`@svelte-atproto/sv`](https://www.npmjs.com/package/@svelte-atproto/sv) add-on:

```sh
npx sv add @svelte-atproto
```

## Quick start (manual)

```ts
// src/lib/atproto/index.ts
import { createAtprotoAuth } from '@svelte-atproto/oauth/server';
import { cloudflareKV } from '@svelte-atproto/oauth/server/stores/cloudflare';
import { env } from '$env/dynamic/private';

export const atproto = createAtprotoAuth({
  origin: env.ORIGIN,
  cookieSecret: env.COOKIE_SECRET,
  clientAssertionKey: env.CLIENT_ASSERTION_KEY,
  scope: 'atproto',
  sessions: cloudflareKV('OAUTH_SESSIONS'),
  states: cloudflareKV('OAUTH_STATES', { ttl: 600 })
});
```

```ts
// src/hooks.server.ts
import { atproto } from '$lib/atproto';
export const handle = atproto.handle;
```

```ts
// src/app.d.ts
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';

declare global {
  namespace App {
    interface Locals {
      session: OAuthSession | null;
      client: Client | null;
      did: Did | null;
    }
  }
}
export {};
```

Generate dev secrets:

```sh
npx atproto-oauth setup   # writes COOKIE_SECRET + CLIENT_ASSERTION_KEY into .env
```

That's it. `atproto.handle` mounts:

- `GET /oauth-client-metadata.json` — OAuth client metadata
- `GET /oauth/jwks.json` — JWKS
- `GET /oauth/callback` — completes the OAuth round-trip
- `POST /oauth/login` — start a login (returns `{ url }`)
- `POST /oauth/logout` — revoke + clear cookies

Per request, `event.locals.{ did, session, client }` is populated for any signed-in user.

## Entry points

| Subpath | What it ships |
|---|---|
| `/server` | `createAtprotoAuth`, types — server (confidential / loopback) flow |
| `/server/stores/memory` | `memory()` |
| `/server/stores/cloudflare` | `cloudflareKV(bindingName \| namespace, opts?)` |
| `/server/stores/upstash` | `upstashRedis({ url, token })` |
| `/client` | `login(handle)`, `signup()`, `logout()` — imperative client helpers for the **server** flow |
| `/browser` | `createAtprotoBrowserAuth` — full **browser-only** flow for static-site deploys (GH Pages, etc.) |
| `/helper` | atproto utilities (handle/PDS resolution, listRecords, getRecord, …) |
| `/bsky` | bsky-specific (`loadBskyProfile`, `loadBskyProfiles`, CDN URL, …) |

## Server API

`createAtprotoAuth(config)` returns:

```ts
atproto.handle                    // mount as your SvelteKit `handle`
atproto.handlers.{metadata,jwks,callback,login,logout}  // raw RequestHandlers
atproto.api.startLogin({ handle, signup?, returnTo? })  // → { url }
atproto.api.logout()              // revokes session + clears cookies
atproto.api.getSession()          // → { did, session, client } from event.locals
```

### Config (selected fields)

| Field | Default | Notes |
|---|---|---|
| `origin` | — | Required outside dev. Empty in dev → loopback (`http://127.0.0.1:5173`) |
| `cookieSecret` | — | Required outside dev. HMAC for signed cookies |
| `clientAssertionKey` | — | JSON-encoded JWK; required when `origin` is set |
| `scope` | `'atproto'` | String or `string[]`. Use atcute's `scope.repo({...})` helpers |
| `signupPDS` | — | Set to a PDS URL to enable signup; unset = signup disabled |
| `sessions` | in-memory | Any `Store<Did, StoredSession>` |
| `states` | in-memory (10m TTL) | Any `Store<string, StoredState>` |
| `redirectPath` / `metadataPath` / `jwksPath` / `loginPath` / `logoutPath` | `/oauth/...` | Override path defaults |

## Helpers (`/helper`)

Pure atproto utilities — no auth state, no `event.locals` magic. Pass `did` explicitly.

| Function | Notes |
|---|---|
| `parseUri(uri)` | AT URI → `{ repo, collection, rkey }` |
| `resolveHandle({ handle, doh?, slingshot? })` | handle → DID |
| `actorToDid(actor, opts?)` | handle or DID → DID |
| `loadMiniDoc(identifier, opts?)` | `{ did, handle, pds }` via slingshot, fallback PLC + describeRepo |
| `loadHandle(did, opts?)` | DID → handle (cached) |
| `loadHandles(dids, opts?)` | parallel batch |
| `getPDS(did, opts?)` | DID → PDS endpoint |
| `getPDSClient({ did }, opts?)` | unauthenticated atcute Client |
| `listRecords({ did, collection, ... })` | repo records |
| `getRecord({ did, collection, rkey?, ... })` | single record |
| `getRecordByUri(uri, opts?)` | record by AT URI (slingshot or fallback) |
| `describeRepo({ did, ... })` | repo metadata |
| `getBlobURL({ did, blob })` | direct PDS blob URL |
| `recentRecords(collection, opts?)` | recent records by collection from UFO firehose |
| `countBacklinks(target, source, opts?)` | constellation: like-count, follower-count, etc. |
| `countDistinctBacklinkers(target, source, opts?)` | constellation: distinct-DID count |
| `listBacklinks(target, source, opts?)` | constellation: paginated linking records |
| `listDistinctBacklinkers(target, source, opts?)` | constellation: paginated distinct DIDs |
| `backlinksRollup(target, opts?)` | constellation: all sources rolled up |
| `createTID()` | TID rkey |
| `readThroughCache(cache, key, load)` | the generic cache wrapper used internally |

### Microcosm services (slingshot / UFO / constellation)

By default, three [microcosm-rs](https://github.com/at-microcosm/microcosm-rs) services back the helpers ([tangled mirror](https://tangled.org/microcosm.blue/microcosm-rs)):

| Service | Default URL | Used by |
|---|---|---|
| Slingshot | `slingshot.microcosm.blue` | identity (handle ↔ DID ↔ PDS), `getRecordByUri` |
| UFO | `ufos-api.microcosm.blue` | `recentRecords` (firehose by collection) |
| Constellation | `constellation.microcosm.blue` | backlinks (likes, follows, replies, …) |

All three default URLs are swappable to a self-hosted instance per call:

```ts
loadHandle(did, { slingshot: 'https://my.host' });
recentRecords('xyz.statusphere.status', { ufo: 'https://my.host' });
countBacklinks(uri, source, { constellation: 'https://my.host' });
```

Slingshot also accepts `slingshot: false` — disables the call and falls straight through to the PLC + `describeRepo` fallback (useful when slingshot is degraded for a particular case, or for testing the fallback path). UFO and Constellation have no fallback (no other index gives the same data), so they don't accept `false` — just don't call them if you don't want firehose / backlinks.

All microcosm calls go through a per-host **circuit breaker** (3 consecutive failures → 60s open, then half-open) and a **5s request timeout**, so an outage fails fast — slingshot skips straight to the fallback, UFO/Constellation return empty/`undefined` immediately instead of hanging.

### Constellation: backlinks

Given a target (AT URI or DID) and a `{ collection, path }` source describing what links you're looking for, [Constellation](https://constellation.microcosm.blue/) answers "who linked to this":

```ts
import { countBacklinks, listDistinctBacklinkers } from '@svelte-atproto/oauth/helper';

// like-count for a post
const likes = await countBacklinks(postUri, {
  collection: 'app.bsky.feed.like',
  path: '.subject.uri'
});

// follower-count for a DID
const followers = await countBacklinks(did, {
  collection: 'app.bsky.graph.follow',
  path: '.subject'
});

// who reposted a post
const page = await listDistinctBacklinkers(postUri, {
  collection: 'app.bsky.feed.repost',
  path: '.subject.uri'
}, { limit: 50 });
const dids = page?.dids ?? [];
```

`backlinksRollup(target)` returns a `{ [collection]: { [path]: { records, distinct_dids } } }` rollup of every source pointing at `target` — handy for a "what does the network say about this" overview.

## Browser-only flow (`/browser`)

For static-site deployments (no server runtime — GitHub Pages, Cloudflare Pages without functions, S3, etc.). Tokens live in browser `localStorage`, the DPoP key in IndexedDB. The only thing that needs to be served is a prerendered `oauth-client-metadata.json`.

```ts
// src/lib/atproto.ts
import { createAtprotoBrowserAuth } from '@svelte-atproto/oauth/browser';

export const atproto = createAtprotoBrowserAuth({
	origin: 'https://my-app.example',
	scope: 'atproto',
	signupPDS: 'https://pds.rip/' // optional
});
```

```ts
// src/routes/oauth-client-metadata.json/+server.ts
import { atproto } from '$lib/atproto';
import { json } from '@sveltejs/kit';
export const prerender = true;
export const GET = () => json(atproto.metadata);
```

```svelte
<!-- src/routes/+layout.svelte -->
<script>
	import { onMount } from 'svelte';
	import { atproto } from '$lib/atproto';
	onMount(() => atproto.init());
</script>
```

In components:

```svelte
<script>
	import { atproto } from '$lib/atproto';
	const { user, login, logout } = atproto;
</script>

{#if $user.isInitializing}
	loading…
{:else if $user.isLoggedIn}
	signed in as {$user.did}
	<button onclick={logout}>Sign out</button>
{:else}
	<button onclick={() => login('alice.bsky.social')}>Sign in</button>
{/if}
```

In dev, the lib uses a loopback `client_id` automatically — no public URL or metadata route needed for local testing.

`atproto.user` is a `svelte/store` `Readable` so components consume it via `$user.x` (auto-subscription).

## Bsky helpers (`/bsky`)

Opt-in. Anyone on a custom appview never imports this and pays nothing.

```ts
import { loadBskyProfile, loadBskyProfiles, getCDNImageBlobUrl } from '@svelte-atproto/oauth/bsky';

const profile = await loadBskyProfile(did, { cache });
const profiles = await loadBskyProfiles(dids, { cache });  // batched via app.bsky.actor.getProfiles (25/call)
const imgUrl = getCDNImageBlobUrl({ did, blob });
```

## Stores

```ts
import { memory } from '@svelte-atproto/oauth/server/stores/memory';
import { cloudflareKV } from '@svelte-atproto/oauth/server/stores/cloudflare';
import { upstashRedis } from '@svelte-atproto/oauth/server/stores/upstash';
```

Or implement your own — anything matching atcute's `Store<K, V>` interface works.

`cloudflareKV` accepts either a binding name (looks it up via `getRequestEvent().platform.env`) or a `KVNamespace` directly.

## CLI

```sh
atproto-oauth setup    # idempotent — generates COOKIE_SECRET + CLIENT_ASSERTION_KEY into .env
atproto-oauth secret   # print a fresh COOKIE_SECRET to stdout
atproto-oauth keygen   # print a fresh CLIENT_ASSERTION_KEY (JWK) to stdout
```

For production secrets, pipe into your secrets manager:

```sh
atproto-oauth secret | wrangler secret put COOKIE_SECRET
atproto-oauth keygen | wrangler secret put CLIENT_ASSERTION_KEY
```

## Status

Pre-1.0. The public API is small and unlikely to churn, but expect breaking changes until stabilized. Issues + PRs welcome at <https://github.com/flo-bit/svelte-atproto-oauth>.

## License

MIT
