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
import type { OAuthSession, Client, Did } from '@svelte-atproto/oauth/server';

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
- `POST /oauth/permissions` — request additional scopes without dropping previous request tokens

Per request, `event.locals.{ did, session, client }` is populated for any signed-in user.

## Entry points

| Subpath | What it ships |
|---|---|
| `/server` | `createAtprotoAuth`, types — server (confidential / loopback) flow |
| `/server/stores/memory` | `memory()` |
| `/server/stores/cloudflare` | `cloudflareKV(bindingName \| namespace, opts?)` |
| `/server/stores/upstash` | `upstashRedis({ url, token })` |
| `/client` | `login(handle, options?)`, `signup(options?)`, `requestPermissions(scope, options?)`, `logout()` — helpers for the **server** flow |
| `/browser` | `createAtprotoBrowserAuth` — full **browser-only** flow for static-site deploys (GH Pages, etc.) |
| `/permissions` | Pure `hasCapability`, `hasScopes`, `needsPermissions`, normalization and incremental-request utilities |
| `/network` | Shared endpoint profiles and actor/handle/DID resolver factories |
| `/helper` | atproto utilities (handle/PDS resolution, listRecords, getRecord, …) |
| `/bsky` | bsky-specific (`loadBskyProfile`, `loadBskyProfiles`, CDN URL, …) |

## Server API

`createAtprotoAuth(config)` returns:

```ts
atproto.handle                    // mount as your SvelteKit `handle`
atproto.handlers.{metadata,jwks,callback,login,permissions,logout}  // raw RequestHandlers
atproto.api.startLogin({ handle?, signup?, scope?, returnTo? })  // → { url }
atproto.api.requestPermissions({ scope, requirements?, previousScope?, returnTo? }) // → { url: string | null }
atproto.api.getPermissions({ refresh? }) // → { did, requestedScope, grantedScope }
atproto.api.can({ type: 'repo', collection, action: 'create' }) // → boolean
atproto.api.logout()              // revokes session + clears cookies
atproto.api.getSession()          // → { did, session, client } from event.locals
```

`returnTo` must be a local absolute path (for example `/compose?draft=1`); unsafe paths are rejected. It is stored per authorization flow, so tabs cannot overwrite each other's destinations. The hook delivers cookie changes on intercepted responses, including logout deletions.

`POST /oauth/login` accepts `scope` in JSON or repeated form fields. `POST /oauth/permissions` accepts `{ scope, requirements?, previousScope?, returnTo? }` and returns `{ url: string | null }`.

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
| `redirectPath` / `metadataPath` / `jwksPath` / `loginPath` / `logoutPath` / `permissionsPath` | `/oauth/...` | Override path defaults |
| `requestLock` | Process-local lock | Multi-worker deployments need a distributed lock **and strongly consistent session storage** |
| `plc` / `doh` | Public PLC / Cloudflare DoH | Override identity endpoints |
| `actorResolver` / `handleResolver` / `didDocumentResolver` | Local resolution | Inject atcute-compatible resolvers; actor override failures do not retry the defaults |
| `fetch` / `network` | Global fetch / public endpoints | Custom server transport or shared network profile (configure transport on the profile when using both) |

## Network configuration and private testnets

Server OAuth, browser identity resolution, `/helper`, and `/bsky` share endpoint/resolver configuration. For a simple override, pass `plc`, `doh`, or an atcute-compatible `actorResolver` directly. A shared `/network` profile also configures Slingshot, UFO, Constellation, AppView, and CDN.

Production profiles retain public defaults. **Use `mode: 'isolated'` for a private testnet**: missing services fail when used rather than selecting public defaults; origins discovered from DID/OAuth metadata must be allowed; redirects and URL credentials are rejected. Private DNS misses do not fall through to public well-known resolution. Disabled/unavailable external helpers and AppView errors throw instead of silently returning empty data or using public fallbacks.

```ts
import { createAtprotoNetwork } from '@svelte-atproto/oauth/network';
import { createAtprotoAuth } from '@svelte-atproto/oauth/server';
import { getRecord } from '@svelte-atproto/oauth/helper';
import { loadBskyProfile } from '@svelte-atproto/oauth/bsky';

const network = createAtprotoNetwork({
  mode: 'isolated',
  namespace: 'devnet-v1',
  allowedOrigins: [
    'https://plc.sandbox.test', 'https://dns.sandbox.test',
    'https://pds.sandbox.test', 'https://as.sandbox.test',
    'https://appview.sandbox.test', 'https://cdn.sandbox.test'
  ],
  plc: 'https://plc.sandbox.test',
  doh: 'https://dns.sandbox.test/dns-query',
  slingshot: false, // use the configured DID resolver + private PDS
  ufo: false,
  constellation: false,
  appview: 'https://appview.sandbox.test',
  cdn: 'https://cdn.sandbox.test'
});

const auth = createAtprotoAuth({ network, cookieSecret: env.COOKIE_SECRET });
const record = await getRecord({ did, collection: 'app.example.post', network });
const profile = await loadBskyProfile(did, { network });
```

Supply private UFO/Constellation URLs instead of `false` when those services exist. An isolated profile needs PLC and DoH unless the corresponding resolver (or complete `actorResolver`) is supplied. Explicit per-call service overrides must still satisfy the profile's origin restrictions. A supplied resolver/client/transport is trusted application code; route its own requests through the guarded transport too.

Cache and browser-storage keys are namespaced. **Use separate server session/state stores, app origins/cookies, and credentials for each network**; the profile does not rename your storage adapter's keys or change an OAuth client ID. Changing public endpoints alone is not isolation.

### Browser and sandbox security boundaries

The browser SDK has no custom-fetch hook for OAuth metadata, token, or authenticated-resource requests. Isolated browser auth therefore requires `assertBrowserEgress(): void` in `BrowserAuthConfig`: your callback must verify that restrictive CSP/test-harness network controls are active and throw otherwise. It is checked before initialization, authorization, refresh, and signout; it does **not** install a firewall. Without the callback, isolated browser auth refuses configuration. Include fetch, WebSocket, redirects/navigation, and image/CDN requests in your test-harness policy. SDK OAuth configuration is browser-global; use separate browser contexts/origins for different networks.

Sandbox-only transport/private-address exceptions belong under the isolated profile's `sandbox`, never production config. `sandbox.fetch` supplies a test transport (for example one that explicitly permits your private IPs); `sandbox.httpOrigins` permits HTTP only for exact origins also listed in `allowedOrigins`. These options do not disable upstream OAuth HTTPS/metadata checks. Prefer trusted local HTTPS.

Origin checks are **not** a DNS/IP-level SSRF firewall. Preserve your production transport's private-address restrictions; enforce DNS/IP and all application egress policy at the transport/harness layer. This package does not configure Contrail's Jetstream/relay/repository-discovery infrastructure.

## Progressive permissions

Configured `scope` accepts a space-separated string or array, declares all requestable tokens, and remains the default login request. Requests must include `atproto`; per-login overrides request exactly the supplied subset. An omitted handle uses the signed-in DID; `requestPermissions` always targets that account.

```ts
// In createAtprotoAuth config: scope: ['atproto', 'repo:app.bsky.feed.post']
const login = await atproto.api.startLogin({ handle, scope: 'atproto', returnTo: '/compose' });
// Redirect to login.url. Later, when the user wants to post:

if (!await atproto.api.can({ type: 'repo', collection: 'app.bsky.feed.post', action: 'create' })) {
  const { url } = await atproto.api.requestPermissions({
    scope: 'repo:app.bsky.feed.post',
    returnTo: '/compose'
  });
  // Redirect if url is non-null; re-check permissions after returning.
}
```

`getPermissions()` returns `{ did, requestedScope, grantedScope }`:

- **Declared:** configured tokens the app may request.
- **Requested:** tokens from the completed authorization, including `include:` references; `null` if legacy history is unknown.
- **Granted:** the current token's actual permissions. Only these are evidence of access.

Incremental requests retain previous **request tokens** and add the new ones; they do not copy expanded grants or request every configured scope. `getPermissions({ refresh: true })` or `can(capability, { refresh: true })` forces refresh, which may pick up changed permission-set contents. AS caching can delay updates.

### Permission sets and capability checks

An `include:` reference is not proof of its contents. Supply concrete `requirements` to skip consent when the feature is already granted:

```ts
// Also declare 'include:app.bsky.authManageProfile' in configured scope.
const { url } = await atproto.api.requestPermissions({
  scope: 'include:app.bsky.authManageProfile',
  requirements: [{ type: 'repo', collection: 'app.bsky.actor.profile', action: 'update' }]
});
```

Declaring a set does not separately declare its expanded collection tokens. The AS resolves sets; this package checks the granted scope conservatively. `can()` supports:

```ts
{ type: 'repo', collection: 'app.bsky.feed.post', action: 'create' } // create/update/delete
{ type: 'blob', mimeType: 'image/png' }
{ type: 'rpc', lxm: 'app.bsky.feed.getTimeline', aud: 'did:web:api.bsky.app#bsky_appview' }
{ type: 'account', attr: 'email', action: 'read' } // email/repo/status; read/manage
{ type: 'identity', attr: 'handle' } // or '*'
```

For checks without a session, import `hasCapability(grantedScope, capability)` or `hasScopes(grantedScope, requiredScope)` from `/permissions`. Unknown/attenuated syntax fails closed: `false` can mean "not provable," not necessarily a PDS denial. Checks are advisory; the PDS enforces authorization.

### Client helpers and upgrade outcomes

For server OAuth, `/client` exports `login(handle, { scope, returnTo })`, `signup({ scope, returnTo })`, and `requestPermissions(scope, { requirements?, previousScope?, returnTo? })`. Login can omit the handle when signed in. Helpers navigate for authorization and return without navigation for an already-granted request.

Browser-only auth uses `login(handle, options)`, `signup(options)`, `requestPermissions(scope, options)`, and the same `can`/`getPermissions` methods. Its user store exposes `permissions` and `authorizationError`: `denied`, `failed`, `identity_mismatch`, `stale_upgrade`, `reduced_grant`, or `permissions_missing`. Reads/refreshes do not clear an upgrade error. When `returnTo` reloads another page, the outcome is handed off once through tab-local storage and exposed by `init()` on arrival; a later initialization or new authorization clears it.

Denial preserves the previous session. Server and browser permission upgrades are bound to the login that initiated them: logout invalidates pending upgrades, including when the same account subsequently logs in again. Browser lifecycle APIs use a shared Web Lock across tabs and require a secure context (as does the browser SDK). If a browser token exchange is already in flight, logout waits for its commit and then revokes/deletes the replacement before resolving. These guards coordinate this package's APIs, not arbitrary writes or direct operations on the underlying SDK. Server multi-worker deployments require the distributed lock and strongly consistent storage described above.

Server callbacks report `auth_denied`, `auth_failed`, or `permissions_missing`. Preserve drafts and re-check capabilities after returning. Missing-permission failures do not trigger automatic redirects or write retries; the app decides whether to show a dialog or offer an upgrade. A 403 alone does not prove a missing scope. The browser SDK commits replacement grants before returning, so a reduced grant remains the **actual new session** with `reduced_grant`, not a rolled-back grant. Offer a recovery option. Neither mode can prevent the AS from invalidating older tokens.

### Handling a failed write

`needsPermissions(result)` recognizes explicit insufficient-scope failures in an atcute response, a caught `ClientResponseError` (when using atcute's `ok()` helper), or a fetch `Response` with a matching `WWW-Authenticate` challenge. It returns a boolean without reading response bodies or starting authorization:

```ts
import { needsPermissions } from '@svelte-atproto/oauth/permissions';

const result = await client.post('com.atproto.repo.createRecord', { input });
if (needsPermissions(result)) {
  // Show your own dialog. Its "Enable posting" button can call:
  // requestPermissions('repo:app.bsky.feed.post', {
  //   requirements: [{ type: 'repo', collection: 'app.bsky.feed.post', action: 'create' }]
  // });
} else if (!result.ok) {
  // Handle the ordinary write error.
}
```

Only explicit `insufficient_scope`/`InsufficientScope` errors on 401/403 responses or Bearer/DPoP insufficient-scope challenges match. Generic 403s, message text, and expired-token errors do not. `false` means no recognized scope-failure signal, not proof that the grant is sufficient. Your app chooses the required scope, UI, and whether to retry after reauthorization.

### Upgrading existing apps

Valid sessions no longer sign out just because configured scopes change. Legacy server scope cookies migrate automatically. Existing browser sessions acquire a login generation when starting their first upgrade, without inventing requested-scope history. Browser callbacks must return to the initiating tab with its pending authorization intact; callbacks without that state and old unbound upgrade flows fail closed and must be restarted. If an incremental request raises `PermissionHistoryUnavailableError`, provide `previousScope` with the known original request, or explicitly log in with the full desired scope; expanded sets cannot safely reconstruct legacy history.

Removing a declaration does not revoke existing access. An upgrade retaining a no-longer-declared token fails validation rather than silently dropping it. Loopback client IDs embed scopes, so changing declarations during development can still invalidate old refresh tokens.

After upgrading from 0.3.x, remove hooks that manually append `oauth_return_to` and keep passing `returnTo`. Existing scaffolded apps also need the hardened login-page return-path validator; updating the addon does not rewrite generated files.

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

Slingshot also accepts `slingshot: false` — disables the call and falls straight through to the PLC + `describeRepo` fallback (useful when slingshot is degraded for a particular case, or for testing the fallback path). UFO and Constellation have no fallback (no other index gives the same data). Setting `constellation: false` explicitly disables the index and all five backlinks helpers return `undefined` without fetching in production mode; isolated mode throws instead. Setting `ufo: false` causes `recentRecords` to throw in either mode.

All microcosm calls go through a per-host **circuit breaker** (3 consecutive failures → 60s open, then half-open) and a **5s request timeout**, so an outage fails fast. In production mode, slingshot skips to the fallback and UFO/Constellation return empty/`undefined`; isolated mode propagates failures instead.

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

For static-site deployments (no server runtime — GitHub Pages, Cloudflare Pages without functions, S3, etc.). The browser SDK stores OAuth sessions, including tokens and DPoP key material, in `localStorage`; protect the origin against XSS. The only thing that needs to be served is a prerendered `oauth-client-metadata.json`.

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

Or implement your own — anything matching atcute's `Store<K, V>` interface works. Session adapters must preserve the extra `svelteAtproto` request-history and `svelteAtprotoSessionId` login-generation fields; `/server` exports `SessionWithHistory` and `AuthorizationHistory` types.

For multiple workers, configure `requestLock(name, operation)` with a distributed lock and use strongly consistent session storage. Cloudflare KV is eventually consistent: a lock alone does not make its read-modify-write operations atomic. State storage must also support timely, single-use callback consumption.

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

## Moderation

Report and moderator-inbox helpers live in `@atmo-dev/contrail/moderation`.
Pass them the atcute `Client` from a server or browser session created here.

## Development

Use Node 24 LTS and pnpm. `pnpm test` runs type checks, builds, and regression tests. For manual server/browser testing, see the [progressive-permissions example](examples/progressive-permissions/README.md).

## Status

Pre-1.0. The public API is small and unlikely to churn, but expect breaking changes until stabilized. Issues + PRs welcome at <https://github.com/flo-bit/svelte-atproto-oauth>.

## License

MIT
