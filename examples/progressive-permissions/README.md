# Progressive-permissions diagnostic

A manual server/browser OAuth playground for a **disposable test account**. It shows requested/granted scopes and lets you compare capability checks with PDS enforcement.

## Run

Use Node 24 LTS and pnpm. From the package root:

```sh
pnpm install
pnpm dev:permissions
```

Open **http://127.0.0.1:5173** for server OAuth, or `/browser` for browser-only OAuth. If the port is occupied, use `PUBLIC_DEV_PORT=5189 pnpm dev:permissions` and open **http://127.0.0.1:5189**.

The dev script rebuilds the library and reinstalls the example's packaged `file:../..` dependency. To typecheck the example, run `pnpm --dir examples/progressive-permissions check`.

Server sessions use in-memory storage and can be lost on restart or hot reload. Browser sessions persist locally. This is not a production storage setup.

## Optional configuration

See `.env.example`:

- `PUBLIC_PERMISSION_SET`: a published `include:` scope, for example `include:app.bsky.authManageProfile`. Its expanded grant need not cover the diagnostic collection.
- `PUBLIC_RPC_SCOPE`: one exact RPC method and DID audience, for example `rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview`.
- `PUBLIC_DEV_PORT`: listener and callback port; defaults to 5173.
- `PUBLIC_ORIGIN`: browser metadata origin; defaults to loopback at that port.

## Try it

1. Log in with identity only; record creation and upload should be denied.
2. Add create, update, and delete permissions separately. **Create + cleanup** uses `tools.atmo.oauthTest.record`; if deletion fails, use the returned record key for manual cleanup after obtaining delete permission. **Update** also needs the original CID (`swapRecord`).
3. Add image permission, then explicitly upload an image (maximum 1 MiB). With an RPC scope configured, compare **service auth** for the allowed pair, a wrong method, and a wrong audience. JWTs are requested with a 60-second expiry and are never displayed or forwarded; this tests the PDS gate, not a remote service.
4. Compare grants after refresh/reload, repeat an already-granted request, decline an upgrade, and try concurrent upgrades in two tabs. Check authorization outcomes as well as the actual grant.
5. Delete remaining test records and sign out. On the server page, **Sign out via intercepted hook** tests `/oauth/logout`; the first subsequent request should show no incoming auth cookies.

Nothing writes automatically after OAuth. Records are public and may reach the firehose even if immediately deleted. Uploads consume PDS storage and have no direct blob-delete endpoint. Never save credentials, tokens, keys, callback URLs, or raw network/storage dumps in the repository or logs.
