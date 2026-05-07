# @svelte-atproto/oauth

## 0.1.0

### Minor Changes

- 6ccfc2a: Add `@svelte-atproto/oauth/browser` entry — browser-only OAuth flow using `@atcute/oauth-browser-client`. For static-site deployments (GitHub Pages, Cloudflare Pages, etc.) where there's no server runtime: tokens live in browser localStorage, the DPoP key in IndexedDB, and the only thing that needs to be served is a prerendered `oauth-client-metadata.json`.

  Public API:

  ```ts
  import { createAtprotoBrowserAuth } from "@svelte-atproto/oauth/browser";

  export const atproto = createAtprotoBrowserAuth({
    origin: "https://my-app.example",
    scope: "atproto",
    signupPDS: "https://pds.rip/",
  });

  // In root +layout.svelte:
  import { onMount } from "svelte";
  onMount(() => atproto.init());

  // In components:
  $atproto.user; // Readable<UserState> — { did, agent, client, isLoggedIn, isInitializing }
  atproto.login(handle);
  atproto.signup();
  atproto.logout();

  // In src/routes/oauth-client-metadata.json/+server.ts:
  import { atproto } from "$lib/atproto";
  import { json } from "@sveltejs/kit";
  export const prerender = true;
  export const GET = () => json(atproto.metadata);
  ```

  Reactivity is via `svelte/store` `writable` so the entry works without preprocessor configuration. In dev, the lib uses a loopback `client_id` automatically — no public URL or metadata route required for local testing.

## 0.0.2

### Patch Changes

- 4593942: test changeset release
