# @svelte-atproto/oauth

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
