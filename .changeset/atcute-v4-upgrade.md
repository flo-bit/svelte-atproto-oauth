---
'@svelte-atproto/oauth': minor
---

Upgrade to the latest atcute majors: `@atcute/client` v5, `@atcute/oauth-node-client` v2, `@atcute/oauth-browser-client` v4, `@atcute/identity-resolver` v2, `@atcute/lexicons` v2, `@atcute/atproto` v4, `@atcute/bluesky` v4.

The public helper/server/browser/bsky API is unchanged. The one internal touch was `parseUri`: `@atcute/lexicons` v2's `parseResourceUri` now returns the parsed object directly (and throws on invalid input) instead of an `{ ok, value }` result. `parseUri` keeps the same contract — returns the parsed parts or `undefined` for invalid input — and the parsed result now also carries a `fragment` field.
