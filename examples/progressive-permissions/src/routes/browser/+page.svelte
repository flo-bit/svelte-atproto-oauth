<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { auth } from '$lib/auth.browser';
  import { collection, declaredScope } from '$lib/scopes';
  import { recordProbe, updateProbe, serviceAuthProbe, uploadProbe } from '$lib/probes';
  const user = auth.user;
  let handle = $state('');
  let selected = $state<string[]>([]);
  let outcome = $state<unknown>(null);
  let confirmRecord = $state(false);
  let confirmUpload = $state(false);
  let confirmUpdate = $state(false);
  let recordKey = $state('');
  let recordCid = $state('');
  let image = $state<FileList>();
  let busy = $state(false);
  async function run(operation: () => Promise<unknown>) {
    busy = true;
    try { outcome = await operation() ?? { message: 'Completed; re-check the current grant.' }; }
    catch (error) {
      const code = error && typeof error === 'object' && 'error' in error ? error.error : null;
      const known = ['invalid_request', 'invalid_scope', 'invalid_client', 'invalid_grant', 'access_denied', 'unauthorized_client'];
      outcome = {
        error: typeof code === 'string' && known.includes(code) ? code : 'operation_failed',
        message: 'Operation failed. Verify scopes/session and inspect uncleaned test records if a write was attempted.'
      };
    }
    finally { busy = false; }
  }
  onMount(() => { void auth.init(); });
</script>
<h1>Progressive permissions — browser</h1>
<p>Separate public OAuth client. Its SDK commits the callback grant before returning; reduced grants are surfaced explicitly.</p>
{#if $user.authorizationError}<p role="alert">Authorization outcome: {$user.authorizationError}</p>{/if}
<section>
  <h2>Current authorization</h2>
  <pre>{JSON.stringify($user.permissions, null, 2)}</pre>
  <button disabled={busy || !$user.isLoggedIn} onclick={() => run(() => auth.getPermissions({ refresh: true }))}>Force refresh</button>
  <button disabled={busy} onclick={() => run(() => auth.can({ type: 'repo', collection, action: 'create' }))}>Check create capability</button>
  <button disabled={busy} onclick={() => run(() => auth.logout())}>Sign out</button>
  {#if outcome !== null}<pre>{JSON.stringify(outcome, null, 2)}</pre>{/if}
</section>
<section>
  <h2>Choose scopes</h2>
  <label>Handle <input bind:value={handle} placeholder="test.bsky.social" /></label>
  {#each declaredScope.filter((s) => s !== 'atproto') as scope}
    <label><input type="checkbox" value={scope} bind:group={selected} />{scope}</label>
  {/each}
  <button disabled={busy} onclick={() => run(() => auth.login(handle || undefined, { scope: ['atproto', ...selected], returnTo: '/browser' }))}>Exact login request</button>
  <button disabled={busy || !$user.isLoggedIn || !selected.length} onclick={() => run(() => auth.requestPermissions(selected, { returnTo: '/browser' }))}>Incremental upgrade</button>
</section>
<section>
  <h2>Actual operations — test account only</h2>
  <p>Service-auth probes request a short-lived JWT from the PDS but never display or forward it.</p>
  {#each ['allowed', 'wrongMethod', 'wrongAudience'] as variant}
    <button disabled={busy || !$user.isLoggedIn} onclick={() => run(async () => {
      const current = get(user);
      if (!current.client) throw new Error('Sign in');
      return serviceAuthProbe(current.client, variant as 'allowed' | 'wrongMethod' | 'wrongAudience');
    })}>Test service auth {variant}</button>
  {/each}
  <p>Test records are public. Uploaded images consume PDS storage and have no direct delete endpoint.</p>
  <label><input type="checkbox" bind:checked={confirmRecord} />I approve creating and deleting a public test record.</label>
  <button disabled={busy || !$user.isLoggedIn || !confirmRecord} onclick={() => run(async () => {
    const current = get(user);
    if (!current.client || !current.did) throw new Error('Sign in');
    return recordProbe(current.client, current.did);
  })}>Test create + cleanup</button>
  <label>Diagnostic record key <input bind:value={recordKey} placeholder="Record key" /></label>
  <label>Original record CID <input bind:value={recordCid} placeholder="Record CID" /></label>
  <label><input type="checkbox" bind:checked={confirmUpdate} />I approve updating or deleting this diagnostic record.</label>
  <button disabled={busy || !$user.isLoggedIn || !confirmUpdate || !recordKey || !recordCid} onclick={() => run(async () => {
    const current = get(user);
    if (!current.client || !current.did) throw new Error('Sign in');
    return updateProbe(current.client, current.did, recordKey, recordCid);
  })}>Test update</button>
  <button disabled={busy || !$user.isLoggedIn || !confirmUpdate || !recordKey} onclick={() => run(async () => {
    const current = get(user);
    if (!current.client || !current.did) throw new Error('Sign in');
    const result = await current.client.post('com.atproto.repo.deleteRecord', {
      input: { repo: current.did, collection, rkey: recordKey }
    });
    return { ok: result.ok, status: result.status, phase: 'manual cleanup' };
  })}>Manual cleanup</button>
  <input type="file" accept="image/*" bind:files={image} />
  <label><input type="checkbox" bind:checked={confirmUpload} />I approve uploading the selected image (maximum 1 MiB).</label>
  <button disabled={busy || !$user.isLoggedIn || !confirmUpload || !image?.length} onclick={() => run(async () => {
    const current = get(user);
    if (!current.client || !image?.[0]) throw new Error('Choose an image');
    return uploadProbe(current.client, image[0]);
  })}>Test upload</button>
</section>
