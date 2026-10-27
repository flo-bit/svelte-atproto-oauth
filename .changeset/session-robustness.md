---
"@svelte-atproto/oauth": patch
---

Production server clients now derive `client_id` and `jwks_uri` from the configured `metadataPath` and `jwksPath` instead of always using the default paths. Apps that customized either path get a new client ID matching the document they actually serve.

A transient storage read failure during a server token refresh no longer revokes the freshly refreshed tokens; the session is kept and only its requested-scope history is dropped (recoverable with `previousScope`). Browser `getPermissions()`/`can()` notify `user` subscribers only when the session or permissions actually change, and a failed browser restore no longer clears another tab's newer current login. Server restore warnings include the error class name, and `api.requestPermissions` hides upstream errors like `startLogin`.
