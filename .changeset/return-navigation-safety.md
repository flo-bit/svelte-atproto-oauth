---
"@svelte-atproto/oauth": patch
---

Revalidate server callback error destinations after URL normalization, preventing dot-segment paths from becoming external scheme-relative redirects on denial, failure, or missing permissions.

Browser authorization outcomes now survive a `returnTo` page reload through a one-time, tab-local handoff bound to the OAuth client, network profile, and current account. Initialization consumes the outcome on arrival; new authorization and logout clear pending outcomes.
