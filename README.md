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
| `/server` | `createAtprotoAuth`, types |
| `/server/stores/memory` | `memory()` |
| `/server/stores/cloudflare` | `cloudflareKV(bindingName \| namespace, opts?)` |
| `/server/stores/upstash` | `upstashRedis({ url, token })` |
| `/client` | `login(handle)`, `signup()`, `logout()` — imperative client helpers |
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
| `createTID()` | TID rkey |
| `readThroughCache(cache, key, load)` | the generic cache wrapper used internally |

### Slingshot / UFO options

By default, identity lookups go through slingshot (`https://slingshot.microcosm.blue`) and recent firehose lookups go through UFO (`https://ufos-api.microcosm.blue`). Both are part of [microcosm-rs](https://github.com/at-microcosm/microcosm-rs) ([tangled](https://tangled.org/microcosm.blue/microcosm-rs)) and are pluggable per call:

```ts
loadHandle(did, { slingshot: false });             // skip slingshot, use PLC + describeRepo
loadHandle(did, { slingshot: 'https://my.host' }); // self-hosted slingshot
recentRecords('xyz.statusphere.status', { ufo: 'https://my.host' });
```

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
