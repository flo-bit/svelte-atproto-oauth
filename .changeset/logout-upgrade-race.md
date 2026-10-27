---
"@svelte-atproto/oauth": patch
---

Bind server permission upgrades to a persistent login generation and serialize logout revocation/deletion with refreshes and authorization commits. Pending upgrades cannot recreate a logged-out session or overwrite a later login for the same DID. Failed remote revocation still deletes the local session, and rejected callbacks consume their state, revoke their new tokens, and do not issue login cookies.

Session adapters must preserve the additional `svelteAtprotoSessionId` field alongside request history. Legacy sessions acquire it when starting an upgrade without inventing requested-scope history.
