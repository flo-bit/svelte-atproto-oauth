---
"@svelte-atproto/oauth": minor
---

Add shared network profiles and configurable PLC/actor/handle/DID resolution for server and browser OAuth, identity/repository helpers, external indexes, AppView, and CDN URLs.

Isolated testnet profiles require explicit routing and origins, namespace helper caches and browser state, and fail closed rather than selecting production defaults. Sandbox-only transport/HTTP exceptions are separate from production configuration. Isolated browser OAuth requires an application assertion that external egress controls are active because the browser SDK cannot use the profile transport for OAuth/resource requests.
