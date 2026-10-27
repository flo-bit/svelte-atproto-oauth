---
"@svelte-atproto/oauth": patch
---

Support SvelteKit 3 alongside SvelteKit 2. Widen the Kit peer dependency, infer hook types from the cross-version `sequence` API, and capture response cookies without replacing Kit 3's readonly `event.cookies` property. Preserve the original cookie methods after returned and thrown responses. Keep Kit 2-compatible environment imports via Kit 3's supported legacy runtime alias, with a type shim for library compilation.

Run type checks, builds, and the full regression suite on both Kit majors in CI, and document Kit 3's declared environment variables and explicit subpath imports. Generated Kit 2/3 apps also exercise the server/browser entry points with production builds and HTTP preview smoke tests.
