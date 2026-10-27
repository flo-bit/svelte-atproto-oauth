---
"@svelte-atproto/oauth": patch
---

Bind browser permission upgrades to a persistent login generation and coordinate lifecycle APIs across tabs with Web Locks. Logout waits for an in-flight callback and revokes/deletes its replacement before resolving; old upgrades cannot overwrite a later same-DID login. Failed remote revocation still removes the local session and generation.

Existing browser sessions acquire a generation when starting an upgrade without inventing scope history. Callbacks without the initiating tab's pending authorization, and legacy unbound upgrades, fail closed and must be restarted. Browser OAuth requires a secure context with Web Locks, matching the browser SDK requirement.
