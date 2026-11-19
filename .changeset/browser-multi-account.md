---
'@svelte-atproto/oauth': minor
---

Browser OAuth: retain multiple accounts and switch between them. Adds an `accounts` store, `switchAccount(did)`, `logout({ did })`, `logoutAll()` and `AccountSwitchError`; the active account now stays in sync across tabs.
