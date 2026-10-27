---
"@svelte-atproto/oauth": patch
---

Deliver OAuth cookie mutations on responses returned directly from the SvelteKit handle hook. Use SvelteKit's public cookie serializer for logout deletions, legacy scope migration, and session cleanup; leave resolved routes and thrown redirects to SvelteKit to avoid duplicate headers.
