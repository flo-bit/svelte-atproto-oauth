---
'@svelte-atproto/oauth': minor
---

Add Constellation backlinks helpers + per-host circuit breaker for microcosm calls.

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
