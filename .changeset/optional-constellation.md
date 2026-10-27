---
"@svelte-atproto/oauth": patch
---

Return undefined without network requests from all five Constellation backlinks helpers when the service is explicitly disabled outside isolated mode, whether configured per call or on a production network profile. Preserve fail-closed errors for disabled or missing services on isolated networks.
