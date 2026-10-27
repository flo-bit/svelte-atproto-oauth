<script lang="ts">
  let { data, form } = $props();
</script>
<h1>Progressive permissions — server</h1>
<p>Only sanitized scopes are shown. No writes happen unless you explicitly run a probe.</p>
{#if data.error}<p role="alert">Authorization outcome: {data.error}</p>{/if}
{#if form}<pre>{JSON.stringify(form, null, 2)}</pre>{/if}
<section>
  <h2>Current authorization</h2>
  <pre>{JSON.stringify(data.permissions, null, 2)}</pre>
  <pre>{JSON.stringify({ message: `Incoming auth cookies: did=${data.hasDidCookie}, scope=${data.hasScopeCookie}` })}</pre>
  <p>Create test record: {data.canWrite ? 'granted' : 'not granted'} · Upload PNG: {data.canUpload ? 'granted' : 'not granted'}</p>
  <form method="POST" action="?/refresh"><button>Force refresh and compare grant</button></form>
  <form method="POST" action="?/logout"><button>Sign out</button></form>
  <form method="POST" action="/oauth/logout"><button>Sign out via intercepted hook</button></form>
</section>
<section>
  <h2>Exact login request</h2>
  <form method="POST" action="?/login">
    <label>Handle (optional if signed in) <input name="handle" placeholder="test.bsky.social" /></label>
    <input type="hidden" name="scope" value="atproto" />
    <p>Identity is always requested. Leave everything else unchecked for identity-only login.</p>
    {#each data.declaredScope.filter((s) => s !== 'atproto') as scope}
      <label><input type="checkbox" name="scope" value={scope} />{scope}</label>
    {/each}
    <button>Start login with selected scopes</button>
  </form>
</section>
<section>
  <h2>Incremental upgrade</h2>
  <form method="POST" action="?/upgrade">
    {#each data.declaredScope.filter((s) => s !== 'atproto') as scope}
      <label><input type="checkbox" name="scope" value={scope} />Add {scope}</label>
    {/each}
    <button disabled={!data.permissions.did}>Request additional permissions</button>
  </form>
</section>
<section>
  <h2>Actual operations — test account only</h2>
  <p>Service-auth probes request a short-lived JWT from the PDS but never display or forward it.</p>
  {#each ['allowed', 'wrongMethod', 'wrongAudience'] as variant}
    <form method="POST" action="?/probeServiceAuth">
      <input type="hidden" name="variant" value={variant} />
      <button disabled={!data.permissions.did}>Test service auth {variant}</button>
    </form>
  {/each}
  <p>A test record is public and may reach the firehose even if immediately deleted. Uploads consume PDS storage and have no direct delete endpoint.</p>
  <form method="POST" action="?/probeRecord">
    <label><input type="checkbox" name="confirm" value="yes" required />I approve creating and deleting one public test record.</label>
    <button disabled={!data.permissions.did}>Test create + cleanup</button>
  </form>
  <form method="POST" action="?/probeUpdate">
    <label>Diagnostic record key <input name="rkey" required /></label>
    <label>Original record CID <input name="cid" required /></label>
    <label><input type="checkbox" name="confirm" value="yes" required />I approve updating this diagnostic record.</label>
    <button disabled={!data.permissions.did}>Test update</button>
  </form>
  <form method="POST" action="?/probeUpload" enctype="multipart/form-data">
    <input name="image" type="file" accept="image/*" required />
    <label><input type="checkbox" name="confirm" value="yes" required />I approve uploading this image (maximum 1 MiB).</label>
    <button disabled={!data.permissions.did}>Test upload</button>
  </form>
  <form method="POST" action="?/cleanup">
    <label>Record key from an uncleaned test URI <input name="rkey" required /></label>
    <label><input type="checkbox" name="confirm" value="yes" required />Delete this test record from my repository.</label>
    <button disabled={!data.permissions.did}>Manual cleanup</button>
  </form>
</section>
