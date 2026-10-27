---
"@svelte-atproto/oauth": minor
---

Add per-login scope overrides, incremental authorization helpers, conservative capability checks, sanitized permission snapshots, and explicit refresh support for server and browser OAuth. Preserve original permission-set requests separately from token grants and migrate legacy server scope cookies without mass logout.

Valid sessions no longer sign out solely because configured scopes change. Scope removal does not revoke existing grants. Browser callbacks surface reduced grants explicitly because the underlying SDK stores the new session before returning it.
