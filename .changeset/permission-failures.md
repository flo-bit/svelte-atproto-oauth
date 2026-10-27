---
"@svelte-atproto/oauth": minor
---

Add `needsPermissions(result)` to the `/permissions` entry point. Recognize explicit insufficient-scope failures in atcute responses/errors and OAuth Bearer/DPoP challenges, without treating generic forbidden responses as missing scopes. Apps retain control over dialogs, authorization, and write retries.
