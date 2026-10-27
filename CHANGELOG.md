# @svelte-atproto/oauth

## 0.4.1

### Patch Changes

- ea428d9: Support SvelteKit 3 alongside SvelteKit 2. Widen the Kit peer dependency, infer hook types from the cross-version `sequence` API, and capture response cookies without replacing Kit 3's readonly `event.cookies` property. Preserve the original cookie methods after returned and thrown responses. Keep Kit 2-compatible environment imports via Kit 3's supported legacy runtime alias, with a type shim for library compilation.

  Run type checks, builds, and the full regression suite on both Kit majors in CI, and document Kit 3's declared environment variables and explicit subpath imports. Generated Kit 2/3 apps also exercise the server/browser entry points with production builds and HTTP preview smoke tests.

## 0.4.0

### Minor Changes

- b83ef16: Update all direct atcute dependencies to their latest releases, including oauth-browser-client 5.1.0, client 5.1.2, and lexicons 2.1.1. The wrapper API remains unchanged; real browser-SDK contract tests verify callback, restoration, refresh, reduced-grant, identity mismatch, and denial behavior against v5.

  Refresh development dependencies and transitive resolutions while retaining SvelteKit 2, TypeScript 6, and Changesets 2. Use Node 24 LTS development types and tsdown 0.23.

- b83ef16: Add shared network profiles and configurable PLC/actor/handle/DID resolution for server and browser OAuth, identity/repository helpers, external indexes, AppView, and CDN URLs.

  Isolated testnet profiles require explicit routing and origins, namespace helper caches and browser state, and fail closed rather than selecting production defaults. Sandbox-only transport/HTTP exceptions are separate from production configuration. Isolated browser OAuth requires an application assertion that external egress controls are active because the browser SDK cannot use the profile transport for OAuth/resource requests.

- b83ef16: Add `needsPermissions(result)` to the `/permissions` entry point. Recognize explicit insufficient-scope failures in atcute responses/errors and OAuth Bearer/DPoP challenges, without treating generic forbidden responses as missing scopes. Apps retain control over dialogs, authorization, and write retries.
- b83ef16: Add per-login scope overrides, incremental authorization helpers, conservative capability checks, sanitized permission snapshots, and explicit refresh support for server and browser OAuth. Preserve original permission-set requests separately from token grants and migrate legacy server scope cookies without mass logout.

  Valid sessions no longer sign out solely because configured scopes change. Scope removal does not revoke existing grants. Browser callbacks surface reduced grants explicitly because the underlying SDK stores the new session before returning it.

### Patch Changes

- b83ef16: Bind browser permission upgrades to a persistent login generation and coordinate lifecycle APIs across tabs with Web Locks. Logout waits for an in-flight callback and revokes/deletes its replacement before resolving; old upgrades cannot overwrite a later same-DID login. Failed remote revocation still removes the local session and generation.

  Existing browser sessions acquire a generation when starting an upgrade without inventing scope history. Callbacks without the initiating tab's pending authorization, and legacy unbound upgrades, fail closed and must be restarted. Browser OAuth requires a secure context with Web Locks, matching the browser SDK requirement.

- b83ef16: Deliver OAuth cookie mutations on responses returned directly from the SvelteKit handle hook. Use SvelteKit's public cookie serializer for logout deletions, legacy scope migration, and session cleanup; leave resolved routes and thrown redirects to SvelteKit to avoid duplicate headers.
- b83ef16: Bind server permission upgrades to a persistent login generation and serialize logout revocation/deletion with refreshes and authorization commits. Pending upgrades cannot recreate a logged-out session or overwrite a later login for the same DID. Failed remote revocation still deletes the local session, and rejected callbacks consume their state, revoke their new tokens, and do not issue login cookies.

  Session adapters must preserve the additional `svelteAtprotoSessionId` field alongside request history. Legacy sessions acquire it when starting an upgrade without inventing requested-scope history.

- b83ef16: Return undefined without network requests from all five Constellation backlinks helpers when the service is explicitly disabled outside isolated mode, whether configured per call or on a production network profile. Preserve fail-closed errors for disabled or missing services on isolated networks.
- b83ef16: Revalidate server callback error destinations after URL normalization, preventing dot-segment paths from becoming external scheme-relative redirects on denial, failure, or missing permissions.

  Browser authorization outcomes now survive a `returnTo` page reload through a one-time, tab-local handoff bound to the OAuth client, network profile, and current account. Initialization consumes the outcome on arrival; new authorization and logout clear pending outcomes.

- b83ef16: Production server clients now derive `client_id` and `jwks_uri` from the configured `metadataPath` and `jwksPath` instead of always using the default paths. Apps that customized either path get a new client ID matching the document they actually serve.

  A transient storage read failure during a server token refresh no longer revokes the freshly refreshed tokens; the session is kept and only its requested-scope history is dropped (recoverable with `previousScope`). Browser `getPermissions()`/`can()` notify `user` subscribers only when the session or permissions actually change, and a failed browser restore no longer clears another tab's newer current login. Server restore warnings include the error class name, and `api.requestPermissions` hides upstream errors like `startLogin`.

## 0.3.0

### Minor Changes

- 3b5e577: Upgrade to the latest atcute majors: `@atcute/client` v5, `@atcute/oauth-node-client` v2, `@atcute/oauth-browser-client` v4, `@atcute/identity-resolver` v2, `@atcute/lexicons` v2, `@atcute/atproto` v4, `@atcute/bluesky` v4.

  The public helper/server/browser/bsky API is unchanged. The one internal touch was `parseUri`: `@atcute/lexicons` v2's `parseResourceUri` now returns the parsed object directly (and throws on invalid input) instead of an `{ ok, value }` result. `parseUri` keeps the same contract — returns the parsed parts or `undefined` for invalid input — and the parsed result now also carries a `fragment` field.

## 0.2.0

### Minor Changes

- 4bdb9b2: Add Constellation backlinks helpers + per-host circuit breaker for microcosm calls.

  **Constellation (`/helper`)** — five new functions hitting [`constellation.microcosm.blue`](https://constellation.microcosm.blue/), the at-microcosm backlinks index:

  - `countBacklinks(target, { collection, path }, opts?)` — `Promise<number | undefined>`
  - `countDistinctBacklinkers(target, { collection, path }, opts?)` — distinct-DID count
  - `listBacklinks(target, source, { did?, limit?, reverse?, cursor? })` — paginated `{ records, cursor, total }`
  - `listDistinctBacklinkers(target, source, { limit?, cursor? })` — paginated `{ dids, cursor, total }`
  - `backlinksRollup(target, opts?)` — `{ [collection]: { [path]: { records, distinct_dids } } }`

  `target` is an AT URI or DID. `{ collection, path }` describes the linking record (e.g. `{ collection: 'app.bsky.feed.like', path: '.subject.uri' }` for like-counts; `{ collection: 'app.bsky.graph.follow', path: '.subject' }` for follower-counts). Pass `constellation: 'https://my.host'` to use a self-hosted instance.

  **`UfoOptions` / `ConstellationOptions` no longer accept `false`** — there's no fallback for either service (unlike slingshot, where `false` skips straight to PLC), so disabling the call just gave you `[]`/`undefined`, which is identical to not calling the function. The option is now just a URL override (`ufo?: string` / `constellation?: string`). `slingshot: false` keeps working since it has a real fallback.

  **Circuit breaker (internal)** — all microcosm calls (slingshot, UFO, constellation) now go through a per-host breaker: 3 consecutive failures (5xx, network errors, or 5s timeout) opens the circuit for 60s, then half-opens to test recovery. Slingshot outages now fail fast and immediately fall through to the existing PLC + `describeRepo` path instead of waiting on each request individually.

  No behavior change in the happy path. Existing `slingshot: false | string` and `ufo: false | string` options unchanged.

## 0.1.0

### Minor Changes

- 6ccfc2a: Add `@svelte-atproto/oauth/browser` entry — browser-only OAuth flow using `@atcute/oauth-browser-client`. For static-site deployments (GitHub Pages, Cloudflare Pages, etc.) where there's no server runtime: tokens live in browser localStorage, the DPoP key in IndexedDB, and the only thing that needs to be served is a prerendered `oauth-client-metadata.json`.

  Public API:

  ```ts
  import { createAtprotoBrowserAuth } from "@svelte-atproto/oauth/browser";

  export const atproto = createAtprotoBrowserAuth({
    origin: "https://my-app.example",
    scope: "atproto",
    signupPDS: "https://pds.rip/",
  });

  // In root +layout.svelte:
  import { onMount } from "svelte";
  onMount(() => atproto.init());

  // In components:
  $atproto.user; // Readable<UserState> — { did, agent, client, isLoggedIn, isInitializing }
  atproto.login(handle);
  atproto.signup();
  atproto.logout();

  // In src/routes/oauth-client-metadata.json/+server.ts:
  import { atproto } from "$lib/atproto";
  import { json } from "@sveltejs/kit";
  export const prerender = true;
  export const GET = () => json(atproto.metadata);
  ```

  Reactivity is via `svelte/store` `writable` so the entry works without preprocessor configuration. In dev, the lib uses a loopback `client_id` automatically — no public URL or metadata route required for local testing.

## 0.0.2

### Patch Changes

- 4593942: test changeset release
